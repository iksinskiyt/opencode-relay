import { join } from "node:path"
import type { Logger } from "pino"
import type { ModelRef } from "./ai.js"
import { setWhatsappTarget, type Config } from "./config.js"
import type { DedupeStore, ContentGuard } from "./dedupe.js"
import { discordToken } from "./env.js"
import type { Envelope, InboundMessage, Provider, TransportStatus } from "./envelope.js"
import { withFinalNewline } from "./envelope.js"
import {
  handleInbound,
  type Decision,
  type GroupResult,
  type PairingDeps,
  type SessionInfo,
} from "./interactions/inbound.js"
import type { CorrelationStore } from "./interactions/correlation.js"
import { createRetryQueue, type RetryQueue } from "./retry.js"
import { discordProvider } from "./providers/discord.js"
import { closeHint, type GatewayClose, type GatewaySocket } from "./providers/discord-gateway.js"
import { mockProvider } from "./providers/mock.js"
import { WhatsAppProvider } from "./providers/whatsapp.js"

/** Name of the group `/relay group` creates: reused, never duplicated. */
export const RELAY_GROUP = "Relay"

export interface ProviderDeps {
  /** Durable state root; WhatsApp auth goes to `<dataDir>/whatsapp`. */
  dataDir?: string
  /** config.json, for inbound `/relay notifications`. */
  configPath?: string
  /** Inbound replies need the correlation store; without it incoming messages are ignored. */
  store?: CorrelationStore
  /** Shared with the chat command, so `/relay select` picks the session both write into. */
  selected?: { sessionID?: string }
  /** Host session list (`ctx.session.list`) for `/relay sessions`. */
  sessions?: () => Promise<SessionInfo[]>
  /** Host model list (`ctx.model.list`) for `/relay model`. */
  models?: () => Promise<ModelRef[]>
  /** Host permission reply (`ctx.permission.reply`). */
  replyPermission?: (input: { sessionID: string; requestID: string; decision: Decision }) => Promise<void>
  /** Host session prompt (`ctx.session.prompt`), for forwarding a message from the phone. */
  prompt?: (input: { sessionID: string; text: string }) => Promise<void>
  /** Persisted inbound dedupe for transports that can redeliver. */
  dedupe?: DedupeStore
  /** Drops content that already landed on a transport, so a restart or a retry cannot repeat it. */
  guard?: ContentGuard
  /** OpenCode server base URL for form replies. */
  serverURL?: string
  /** Discord HTTP client; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Discord gateway socket; defaults to `ws`, tests inject a stub. */
  discordSocket?: (url: string) => GatewaySocket
  /** Gateway reconnect delay; tests shorten it. */
  discordBackoff?: (attempt: number) => number
  /** `/relay send` and the outbox: sends one image to every live transport, answers with the text to reply. */
  sendImage?: (input: { path: string; caption?: string }) => Promise<string>
}

const digitsOf = (value: string): string => value.replace(/\D/g, "")

/** The one place outbound text is shaped: exactly one final newline, content dedupe included. */
const outbound = (envelope: Envelope): Envelope => ({ ...envelope, text: withFinalNewline(envelope.text) })

/**
 * Pairing allowlist: full JIDs, bare international phone numbers, or Discord user IDs. A phone JID
 * carries device/agent suffixes, so two entries that are both numeric compare by digits; anything
 * else must match exactly (stripping non-digits would make every non-numeric pair compare equal).
 */
export function inboundAllowed(config: Config, id: string): boolean {
  if (!config.security.pairingRequired || config.security.allowUnpairedUsers) return true
  const bare = id.split("@")[0]?.split(":")[0] ?? id
  return config.security.allowlist.some((entry) => {
    if (entry === id || entry === bare) return true
    const entryDigits = digitsOf(entry)
    const senderDigits = digitsOf(bare)
    return entryDigits !== "" && senderDigits !== "" && entryDigits === senderDigits
  })
}

/**
 * `/relay group`: create the group (or reuse one with that name) and persist it as the target, so
 * the conversation layout survives a restart. Shared by the chat command and the phone path.
 */
export async function relayGroup(
  provider: Provider,
  configPath?: string,
  subject = RELAY_GROUP,
): Promise<GroupResult> {
  const ensure = provider.ensureGroup
  if (ensure === undefined) throw new Error("this transport has no group layout, only whatsapp does")
  const result = await ensure.call(provider, subject)
  if (configPath !== undefined) await setWhatsappTarget(configPath, result.jid)
  return { ...result, subject }
}

/** One transport that carries messages, plus its own failure queue. */
export interface LiveTransport {
  readonly name: string
  readonly provider: Provider
  readonly retry: RetryQueue
}

/** A send that went through on one transport, so its correlation can be recorded against it. */
export interface Delivered {
  readonly transport: LiveTransport
  readonly envelope: Envelope
  readonly messageID: string | void
}

/**
 * Every enabled transport runs at once: a send fans out to all of them and a failure on one is
 * queued on that transport only, so the others keep delivering.
 */
export interface Relay {
  /** Carries messages: every enabled transport, or the mock sink alone when none is usable. */
  readonly transports: readonly LiveTransport[]
  /** One entry per configured transport plus the mock fallback, for `/relay status`. */
  readonly statuses: readonly TransportStatus[]
  send(envelope: Envelope): Promise<Delivered[]>
  /** Retries each transport's own queue; returns the sends that went through. */
  drain(now?: number): Promise<Delivered[]>
  poll(): Promise<void>
  stop(): Promise<void>
}

interface Candidate {
  readonly status: TransportStatus
  readonly provider?: Provider
}

/** Config -> the transports to run; nothing enabled means the mock sink stands in. */
export async function createTransports(
  config: Config,
  log: Logger,
  env: Record<string, string | undefined> = process.env,
  deps: ProviderDeps = {},
): Promise<Relay> {
  const { store, configPath, sessions, models, replyPermission, serverURL, prompt, fetchImpl, guard } = deps
  const selected: { sessionID?: string } = deps.selected ?? {}
  // set by the WhatsApp branch, so /relay pair works from the phone as well as the TUI
  let pairWhatsApp: ((phoneNumber: string) => Promise<string>) | undefined
  // set by the WhatsApp branch, so /relay unpair logs the device out server-side
  let logoutWhatsApp: (() => Promise<void>) | undefined
  // set by the WhatsApp branch, so /relay group works from the phone as well as the TUI
  let groupWhatsApp: (() => Promise<GroupResult>) | undefined
  // set by the Discord branch, so /relay pair discord registers the slash commands from either host
  let registerDiscord: (() => Promise<void>) | undefined
  let statuses: readonly TransportStatus[] = []
  const pairing = (): PairingDeps => ({
    ...(deps.dataDir === undefined ? {} : { dataDir: deps.dataDir }),
    env,
    ...(pairWhatsApp === undefined ? {} : { whatsappCode: pairWhatsApp }),
    ...(logoutWhatsApp === undefined ? {} : { whatsappLogout: logoutWhatsApp }),
    ...(registerDiscord === undefined ? {} : { onDiscordLinked: registerDiscord }),
  })
  // every transport answers under its own name, so correlation and dedupe stay per transport
  const inboundFor = (name: string) => (message: InboundMessage) =>
    store === undefined
      ? undefined
      : handleInbound(message, {
          store,
          provider: name,
          selected,
          configPath: configPath ?? "config.json",
          pairing: pairing(),
          transports: statuses,
          ...(sessions === undefined ? {} : { sessions }),
          ...(models === undefined ? {} : { models }),
          ...(replyPermission === undefined ? {} : { replyPermission }),
          ...(serverURL === undefined ? {} : { serverURL }),
          ...(prompt === undefined ? {} : { prompt }),
          ...(groupWhatsApp === undefined ? {} : { group: groupWhatsApp }),
          ...(deps.sendImage === undefined ? {} : { image: deps.sendImage }),
        })

  const candidates: Candidate[] = []

  if (!config.whatsapp.enabled) {
    candidates.push({ status: { name: "whatsapp", state: "disabled", reason: "whatsapp.enabled is false" } })
  } else {
    const target = config.whatsapp.target === "" ? undefined : config.whatsapp.target
    if (!config.whatsapp.selfChat && target === undefined) {
      log.warn("whatsapp.selfChat is off and whatsapp.target is missing, using mock sink")
      candidates.push({
        status: { name: "whatsapp", state: "mocked", reason: "whatsapp.selfChat is off and whatsapp.target is missing" },
      })
    } else {
      const provider = new WhatsAppProvider({
        authDir: join(deps.dataDir ?? "auth-state", "whatsapp"),
        selfChat: config.whatsapp.selfChat,
        log,
        allowSender: (jid) => inboundAllowed(config, jid),
        ...(target === undefined ? {} : { target }),
        allowImageUrls: config.security.allowImageUrls,
        ...(store === undefined ? {} : { onInbound: inboundFor("whatsapp") }),
        // the relay's own message IDs must survive a reconnect, or its echo becomes input
        ...(deps.dedupe === undefined ? {} : { dedupe: deps.dedupe }),
      })
      pairWhatsApp = (phoneNumber) => provider.requestPairingCode(phoneNumber)
      logoutWhatsApp = () => provider.logout()
      groupWhatsApp = () => relayGroup(provider, configPath)
      candidates.push({ status: { name: "whatsapp", state: "live" }, provider })
    }
  }

  if (!config.discord.enabled) {
    candidates.push({ status: { name: "discord", state: "disabled", reason: "discord.enabled is false" } })
  } else {
    const token = discordToken({ env }).value
    const dm = config.discord.target === "dm"
    const id = dm ? config.discord.dmUserID : config.discord.channelID
    const missing = `discord credentials missing (DISCORD_BOT_TOKEN, ${dm ? "discord.dmUserID" : "discord.channelID"})`
    if (!token || !id) {
      log.warn(
        { hasToken: Boolean(token), hasTarget: Boolean(id), target: config.discord.target },
        `${missing}, using mock sink`,
      )
      candidates.push({ status: { name: "discord", state: "mocked", reason: missing } })
    } else {
      // getter, not a snapshot: the gateway takes over the moment READY arrives
      const path: { inbound: "gateway" | "polling"; close?: GatewayClose } = { inbound: "polling" }
      const provider = discordProvider({
        token,
        dest: dm ? { dmUserID: id } : { channelID: id },
        log,
        ...(deps.dataDir === undefined ? {} : { dataDir: deps.dataDir }),
        buttons: config.discord.buttons,
        // fail closed like WhatsApp: only a listed Discord user ID can command or answer
        allowSender: (senderID) => inboundAllowed(config, senderID),
        allowImageUrls: config.security.allowImageUrls,
        ...(deps.dedupe === undefined ? {} : { dedupe: deps.dedupe }),
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
        ...(store === undefined ? {} : { onInbound: inboundFor("discord") }),
        gateway: {
          ...(deps.discordSocket === undefined ? {} : { socket: deps.discordSocket }),
          ...(deps.discordBackoff === undefined ? {} : { backoff: deps.discordBackoff }),
          onMode: (mode, close) => {
            path.inbound = mode
            if (close !== undefined) path.close = close
          },
        },
      })
      registerDiscord = () => provider.registerCommands?.() ?? Promise.resolve()
      candidates.push({
        status: {
          name: "discord",
          state: "live",
          get reason() {
            // polling with a close recorded says why: "gateway closed 4014 ... enable MESSAGE_CONTENT"
            if (path.close === undefined) return path.inbound
            return `${path.inbound}, gateway closed ${closeHint(path.close)}`
          },
        },
        provider,
      })
    }
  }

  statuses = candidates.map((candidate) => candidate.status)
  const dataDir = deps.dataDir ?? "auth-state"
  const transports: LiveTransport[] = []
  for (const candidate of candidates) {
    if (candidate.provider === undefined) continue
    transports.push({
      name: candidate.status.name,
      provider: candidate.provider,
      retry: await createRetryQueue(dataDir, candidate.status.name, log),
    })
  }
  // after the transports exist: a gateway that fails logs and leaves polling in charge
  for (const transport of transports) {
    const started = transport.provider.start?.()
    void started?.catch((error: unknown) =>
      log.error({ error, transport: transport.name }, "transport start failed, continuing"),
    )
  }
  if (transports.length === 0) {
    statuses = [...statuses, { name: "mock", state: "mocked", reason: "no transport enabled" }]
    transports.push({ name: "mock", provider: mockProvider(log), retry: await createRetryQueue(dataDir, "mock", log) })
  }
  log.info({ transports: transports.map((transport) => transport.name) }, "relay transports running")

  return {
    transports,
    statuses,

    async send(incoming) {
      // shaped once up front: dedupe hashes the text that actually goes out, retries replay it as is
      const envelope = outbound(incoming)
      // the transports run side by side: one that hangs or fails never delays or drops the other
      const outcomes = await Promise.all(
        transports.map(async (transport): Promise<Delivered | undefined> => {
          // restored batches and repeated passes arrive again after a restart: same content, no resend
          if (guard?.claim(transport.name, envelope) === false) {
            log.debug({ id: envelope.id, transport: transport.name }, "duplicate content skipped")
            return undefined
          }
          try {
            const messageID = await transport.provider.send(envelope)
            await guard?.commit(transport.name, envelope)
            return { transport, envelope, messageID }
          } catch (error) {
            // released before queuing: a failed send has landed nowhere, so the retry may go again
            guard?.release(transport.name, envelope)
            log.error({ error, id: envelope.id, transport: transport.name }, "send failed, queued for retry")
            await transport.retry.enqueue(envelope)
            return undefined
          }
        }),
      )
      return outcomes.filter((item) => item !== undefined)
    },

    async drain(now = Date.now()) {
      const outcomes = await Promise.all(
        transports.map(async (transport) => {
          try {
            const sent = await transport.retry.drain(async (queued) => {
              const envelope = outbound(queued)
              // a replay is only skipped once the same content is known to have landed
              if (guard?.claim(transport.name, envelope) === false) {
                log.debug({ id: envelope.id, transport: transport.name }, "duplicate content skipped on retry")
                return
              }
              try {
                const messageID = await transport.provider.send(envelope)
                await guard?.commit(transport.name, envelope)
                return messageID
              } catch (error) {
                guard?.release(transport.name, envelope)
                throw error
              }
            }, now)
            return sent.map((item): Delivered => ({ transport, envelope: item.envelope, messageID: item.messageID }))
          } catch (error) {
            log.error({ error, transport: transport.name }, "retry drain failed")
            return []
          }
        }),
      )
      return outcomes.flat()
    },

    async poll() {
      // in parallel too: a polling transport that hangs must not hold the other one's inbound
      await Promise.all(
        transports.map(async (transport) => {
          try {
            await transport.provider.poll?.()
          } catch (error) {
            log.error({ error, transport: transport.name }, "poll failed")
          }
        }),
      )
    },

    async stop() {
      for (const transport of transports) {
        await transport.retry.stop()
        await transport.provider.stop?.()
      }
    },
  }
}
