import { stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Plugin } from "@opencode/plugin"
import pino from "pino"
import type { Logger } from "pino"
import { type ModelRef, ModelProcessor, processEnvelope } from "./ai.js"
import { createBatchWriter, loadBatches } from "./batch-store.js"
import { PassBatcher } from "./batching.js"
import { createCommand, type CommandDeps } from "./command.js"
import { loadConfig } from "./config.js"
import { createContentGuard, createDedupeStore } from "./dedupe.js"
import type { Envelope } from "./envelope.js"
import { loadImage } from "./image.js"
import { createCorrelationStore } from "./interactions/correlation.js"
import { relayCommand } from "./interactions/inbound.js"
import { identity, notifiable, reduce, sessionIDOf, type RelayEvent } from "./notify.js"
import { createOutbox, OUTBOX } from "./outbox.js"
import { handlePairReply, type PairingDeps } from "./pairing.js"
import { pluginRoot, resolvePaths, withinRoots } from "./paths.js"
import { createTransports, type Delivered, type Relay, relayGroup } from "./router.js"
import { createRelayTool, createTool } from "./tool.js"

/** Housekeeping cadence: retries, expired prompts and the Discord inbound fallback poll. */
const TICK_MS = 15_000
/** Session titles/parents kept in memory; a long-lived host can otherwise grow these forever. */
const CACHE_LIMIT = 200

/**
 * The host loads dist/ (root index.js re-exports it), so an edit without a rebuild silently runs
 * stale code. Warn rather than fail: a stale build still relays.
 */
async function warnIfStale(log: Logger): Promise<void> {
  const root = pluginRoot()
  try {
    const [built, source] = await Promise.all([
      stat(join(root, "dist", "index.js")),
      stat(join(root, "src", "index.ts")),
    ])
    if (built.mtimeMs < source.mtimeMs) {
      log.warn('stale build: dist/index.js is older than src/index.ts, run "bun run build" and restart')
    }
  } catch {
    // a dist-only install has no src to compare against
  }
}

/** Transport names as the user knows them, for the `/relay send` and tool answers. */
const LABELS: Readonly<Record<string, string>> = { whatsapp: "WhatsApp", discord: "Discord", mock: "the mock sink" }

/** Bounded LRU-ish cache write: re-insert on hit, evict the oldest key past the cap. */
function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key)
  cache.set(key, value)
  if (cache.size <= CACHE_LIMIT) return
  const oldest = cache.keys().next().value
  if (oldest !== undefined) cache.delete(oldest)
}

export default Plugin.define({
  id: "opencode-relay",
  async setup(ctx) {
    const log = pino({ name: "opencode-relay" })
    await warnIfStale(log)

    const paths = resolvePaths(ctx.location.directory)
    let config
    try {
      config = await loadConfig(paths.configPath)
    } catch (error) {
      log.error({ error, searched: paths.searched }, "no usable config.json, relay disabled")
      return
    }
    if (!config.enabled) {
      log.info("relay disabled by config")
      return
    }
    if (paths.migrated !== undefined) {
      log.info(
        { configPath: paths.configPath, dataDir: paths.dataDir, migratedFrom: paths.migrated },
        "copied the in-repo config.json (and its auth-state) to the data dir: delete the old copy once this run relays",
      )
    } else {
      log.info({ configPath: paths.configPath, dataDir: paths.dataDir }, "relay config loaded")
    }

    const dataDir = paths.dataDir
    const configPath = paths.configPath
    const selected: { sessionID?: string } = {}
    // archived:false is what "active" means here: a forwarded prompt must never land in a dead session
    const sessions = async () =>
      (await ctx.session.list({ limit: 10, archived: false })).data.map(({ id, title }) => ({ id, title }))
    const store = await createCorrelationStore(dataDir)
    const dedupe = await createDedupeStore(dataDir)
    // persisted content keys: the same text cannot be sent twice on one transport across a restart
    const guard = createContentGuard(dedupe)
    const models = async (): Promise<ModelRef[]> =>
      (await ctx.model.list()).data.map(({ providerID, id }) => ({ providerID, id }))

    /**
     * Registrations go out before any network work: the host's command.list does not wait for
     * plugin setup, so a command added after a slow transport or model call is missing from the
     * first list, and the TUI can cache that miss for the whole session.
     */
    let relay!: Relay
    const { mode, debounceSeconds, maxWaitSeconds } = config.notifications.passes
    const batcher = new PassBatcher({
      mode,
      debounceMs: debounceSeconds * 1000,
      maxWaitMs: maxWaitSeconds * 1000,
    })

    /** One deps object for the chat command and the agent tool: both run the same subcommands. */
    const relayDeps: CommandDeps = {
      configPath,
      provider: config.provider,
      selected,
      sessions,
      models,
      pending: () => {
        const state = batcher.snapshot()
        return {
          sessions: Object.keys(state).length,
          items: Object.values(state).reduce((total, batch) => total + batch.items.length, 0),
        }
      },
      // the live socket is attached below: registration must not wait for it
      pairing: { dataDir },
      store,
      group: () => {
        const target = relay.transports.find((transport) => transport.name === "whatsapp")?.provider
        if (target === undefined) throw new Error("group layout needs the whatsapp transport")
        return relayGroup(target, configPath)
      },
      image: (input) => sendImageEnvelope(input),
      // shortcut: CommandDefinition.execute returns void, so the answer arrives as a session
      // message; switch to a returned content channel when the plugin API grows one
      reply: async (message) => {
        await ctx.session.synthetic({ ...message, resume: false })
      },
    }

    await ctx.command.transform((editor) => editor.add(createCommand(relayDeps)))
    await ctx.tool.transform((editor) => {
      editor.add(createTool({ root: ctx.location.directory, image: (input) => sendImageEnvelope(input) }))
      // the agent gets the same dispatcher the chat command uses, so an answer cannot drift
      editor.add(createRelayTool({ command: (text, sessionID) => relayCommand(text, relayDeps, sessionID) }))
    })
    log.info("relay commands registered")

    // every enabled transport runs at once: a paired transport is never stranded by config.provider
    relay = await createTransports(config, log, process.env, {
      dataDir,
      configPath,
      store,
      dedupe,
      guard,
      selected,
      sessions,
      models,
      // branded IDs (Session.ID, Permission.ID) are compile-time only
      replyPermission: (input) => ctx.permission.reply(input as never),
      prompt: async (input) => {
        await ctx.session.prompt(input as never)
      },
      // resolved on first use: the transports this fans out to are created by this very call
      sendImage: (input) => sendImageEnvelope(input),
    })
    // the registrations above are now live: attach what only exists once the transports are up
    relayDeps.transports = relay.statuses

    let available: ModelRef[] = []
    try {
      available = await models()
    } catch (error) {
      log.warn({ error }, "model list unavailable, AI processing falls back to raw text")
    }
    const processor = new ModelProcessor(
      config,
      available,
      (input) => ctx.experimental.generate.text(input),
      configPath,
    )
    if (processor.model === null) log.info("AI processing off or model unavailable, relaying raw text")

    const whatsapp = relay.transports.find((transport) => transport.name === "whatsapp")?.provider
    const pairWhatsApp = whatsapp?.requestPairingCode?.bind(whatsapp)
    const logoutWhatsApp = whatsapp?.logout?.bind(whatsapp)
    const discord = relay.transports.find((transport) => transport.name === "discord")?.provider
    // a Discord pair done from the TUI must register the slash commands too, not only on connect
    const registerDiscord = discord?.registerCommands?.bind(discord)

    /** Shared by the pair command and the form replies it produces. */
    const pairingDeps = (): PairingDeps => ({
      dataDir,
      ...(pairWhatsApp === undefined ? {} : { whatsappCode: pairWhatsApp }),
      ...(logoutWhatsApp === undefined ? {} : { whatsappLogout: logoutWhatsApp }),
      ...(registerDiscord === undefined ? {} : { onDiscordLinked: registerDiscord }),
    })
    relayDeps.pairing = pairingDeps()

    // pending pass batches survive a restart; due ones flush on the first schedule()
    const batches = createBatchWriter(dataDir, log)
    batcher.restore(await loadBatches(dataDir, log))
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined

    /** Session titles for notification text; cached because a title rarely changes. */
    const titles = new Map<string, string>()
    /** Also the source of the identity header `deliver` prepends, so the tool can send for a session. */
    const titleFor = async (sessionID: string): Promise<string | undefined> => {
      const cached = titles.get(sessionID)
      if (cached !== undefined) return cached
      try {
        const { title } = await ctx.session.get({ sessionID })
        if (typeof title === "string" && title !== "") remember(titles, sessionID, title)
        return title
      } catch {
        return undefined
      }
    }
    const titleOf = async (event: RelayEvent): Promise<string | undefined> => {
      const sessionID = sessionIDOf(event)
      return sessionID === undefined ? undefined : titleFor(sessionID)
    }

    /**
     * Parent of the event's session, for the orchestrator-only gate; a session's parent never
     * changes, so one lookup per session sticks. `null` is a root, `undefined` means "relay".
     */
    const parents = new Map<string, string | null>()
    const parentOf = async (event: RelayEvent): Promise<string | null | undefined> => {
      if (!config.notifications.orchestratorOnly) return undefined
      // session.created carries its parent inline; seeding the cache saves the lookup for later events
      if (event.type === "session.created") {
        const inline = (event.data as { parentID?: unknown } | undefined)?.parentID
        const parent = typeof inline === "string" ? inline : null
        const created = sessionIDOf(event)
        if (created !== undefined) remember(parents, created, parent)
        return parent
      }
      const sessionID = sessionIDOf(event)
      if (sessionID === undefined) return undefined
      if (parents.has(sessionID)) return parents.get(sessionID)
      try {
        const info = await ctx.session.get({ sessionID })
        const parentID = (info as { parentID?: unknown }).parentID
        const parent = typeof parentID === "string" ? parentID : null
        remember(parents, sessionID, parent)
        return parent
      } catch {
        // a failed lookup relays: dropping the orchestrator's own notice is the worse mistake
        return undefined
      }
    }

    /** Records what a prompt message was, so an inbound reply can be matched to it. */
    const record = async ({ transport, envelope, messageID }: Delivered): Promise<void> => {
      const interaction = envelope.interaction
      if (typeof messageID !== "string" || interaction === undefined) return
      const destination = transport.provider.destination?.()
      if (destination === undefined) return
      await store.add({
        provider: transport.name,
        externalUserID: destination.externalUserID,
        chatID: destination.chatID,
        messageID,
        sessionID: envelope.sessionID ?? "",
        type: interaction.type,
        ...(interaction.formID === undefined ? {} : { formID: interaction.formID }),
        ...(interaction.permissionID === undefined ? {} : { permissionID: interaction.permissionID }),
      })
    }

    /** A state write failure must not resend a message that is already out. */
    const recordSafely = async (item: Delivered): Promise<void> => {
      try {
        await record(item)
      } catch (error) {
        const { category, sessionID, id } = item.envelope
        log.error({ error, category, sessionID, id }, "correlation record failed")
      }
    }

    const deliver = async (envelope: Envelope): Promise<Delivered[]> => {
      // the header goes on at send time: the summariser cannot swallow it, and a retry keeps it.
      // A restored batch has no cached title, and the header is part of the content dedupe key.
      const title = envelope.sessionID === undefined ? undefined : await titleFor(envelope.sessionID)
      const message: Envelope = { ...envelope, text: `${identity(title)}\n${envelope.text}` }
      // relay.send fans out; a transport that fails is queued on its own queue and never blocks the rest
      const delivered = await relay.send(message)
      for (const item of delivered) await recordSafely(item)
      return delivered
    }

    /**
     * `/relay send` and `relay_send_image`: validate locally first, so a missing or oversized file
     * answers instead of queuing.
     */
    const sendImageEnvelope = async ({
      path,
      caption,
      sessionID,
    }: {
      path: string
      caption?: string
      sessionID?: string
    }): Promise<string> => {
      // a path from a chat or a model is untrusted: only the install, the project and the outbox
      const allowed = withinRoots(path, [
        pluginRoot(),
        ctx.location.directory,
        join(dataDir, OUTBOX),
        ...config.security.imageRoots.map((root) => resolve(root)),
      ])
      if (allowed === null) {
        return `image not sent: ${path} is outside the allowed roots (install, project, outbox, security.imageRoots)`
      }
      const image = await loadImage({ path: allowed, ...(caption === undefined ? {} : { caption }) })
      // an agent send belongs to its session: the title becomes the header, as for a notification
      if (sessionID !== undefined) await titleFor(sessionID)
      const delivered = await deliver({
        id: `image:${Date.now()}`,
        category: "message",
        text: caption ?? image.name,
        createdAt: Date.now(),
        ...(sessionID === undefined ? {} : { sessionID }),
        image: { path: allowed, name: image.name, ...(caption === undefined ? {} : { caption }) },
      })
      const names = delivered.map((item) => LABELS[item.transport.name] ?? item.transport.name)
      // a transport that failed is queued for retry: say so instead of claiming a send that did not land
      if (names.length === 0) return `image not sent: every transport failed, ${image.name} is queued for retry`
      return `sent ${image.name} to ${names.join(" + ")}`
    }

    const send = async (envelopes: readonly Envelope[]): Promise<void> => {
      for (const envelope of envelopes) await deliver(envelope)
    }

    // dropped images go out on the same tick as retries and polling: no watcher, no extra process
    const outbox = createOutbox({ dir: join(dataDir, OUTBOX), send: deliver, log })

    const persist = (): void => batches.save(batcher.snapshot())

    const schedule = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      const ms = batcher.nextDeadline(Date.now())
      timer =
        ms === null
          ? undefined
          : setTimeout(() => {
              const due = batcher.tick(Date.now())
              persist()
              void send(due).then(schedule)
            }, ms)
    }

    schedule()

    const tick = async (): Promise<void> => {
      for (const item of await relay.drain()) await recordSafely(item)
      await store.expire()
      await relay.poll()
      await outbox.drain()
    }
    // a slow tick must not pile up behind itself: the next one waits for the busy one to finish
    let ticking = false
    const interval = setInterval(() => {
      if (ticking) return
      ticking = true
      void tick()
        .catch((error: unknown) => log.error({ error }, "relay tick failed"))
        .finally(() => {
          ticking = false
        })
    }, TICK_MS)
    interval.unref?.()
    // anchor a polling transport now, so the first tick already reads answers instead of history
    void relay.poll().catch((error: unknown) => log.warn({ error }, "initial poll failed"))

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "form.replied" || event.type === "form.cancelled") {
          if (event.type === "form.replied") {
            try {
              await handlePairReply(
                { id: event.data.id, sessionID: event.data.sessionID, answer: event.data.answer },
                {
                  store,
                  configPath,
                  pairing: pairingDeps(),
                  notice: async (message) => {
                    await ctx.session.synthetic({ ...message, resume: false })
                  },
                },
              )
            } catch (error) {
              log.error({ error, formID: event.data.id }, "pair form reply failed")
            }
          }
          // after the pair handler: that one still needs its record pending to run
          await store.settleForm(event.data.id)
          continue
        }
        const parentID = await parentOf(event)
        if (!notifiable(event, config, parentID)) continue
        const envelope = reduce(event, config, await titleOf(event), parentID)
        if (envelope === null) continue
        const out = batcher.push(await processEnvelope(processor, envelope), Date.now())
        persist()
        await send(out)
        schedule()
      }
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) log.error({ error }, "event stream failed")
    })

    return async () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
      clearInterval(interval)
      await batches.stop()
      await dedupe.stop()
      await relay.stop()
    }
  },
})
