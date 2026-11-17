import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Logger } from "pino"
import type { Destination, Envelope, InboundMessage, Provider, QuestionDetails } from "../envelope.js"
import type { DedupeStore } from "../dedupe.js"
import { DISCORD_MAX_IMAGE_BYTES, loadImage, type LoadedImage } from "../image.js"
import { boundedFetch } from "../timeout.js"
import {
  componentText,
  createDiscordGateway,
  type DiscordGateway,
  type DiscordInteraction,
  type GatewayClose,
  type GatewaySocket,
  interactionText,
  interactionUserID,
  questionAnswer,
  registerCommands,
  RELAY_SUBCOMMANDS,
} from "./discord-gateway.js"

export const DISCORD_MAX_CHARS = 2000
/** DM channel id cache, under the state root: a restart reuses it instead of reopening the DM. */
export const DISCORD_STATE_FILE = "discord.json"
/** Last gateway READY/close, under the state root: `opencode-relay doctor` runs in another process. */
export const DISCORD_GATEWAY_FILE = "discord-gateway.json"
/** Proof message the pair form posts, so the user sees the link working. */
export const LINKED_TEXT = "Relay linked — say hi here"
/** Slash command and button answers land in the same text the typed commands parse. */
export const DISCORD_USAGE = `commands: /relay ${RELAY_SUBCOMMANDS.join(" | /relay ")}`

const API = "https://discord.com/api/v10"
const CLOSE_FENCE = "\n```"
/** Interaction responses are ephemeral: the command output is not channel business. */
const EPHEMERAL = 64
/** DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: acknowledged now, edited when the command answers. */
const DEFERRED = 5

/** The fields of a Discord message this relay reads. */
export interface DiscordMessage {
  readonly id: string
  readonly content?: string
  readonly channel_id?: string
  readonly author?: { readonly id?: string; readonly bot?: boolean }
  /** Set when the message replies to another: anchors a form answer to that prompt. */
  readonly message_reference?: { readonly message_id?: string }
}

/**
 * Split on newline boundaries under Discord's per-message cap, closing and reopening ``` blocks
 * so every chunk stays valid Markdown. Lines longer than the cap are hard-cut.
 */
export function splitMessage(text: string, limit = DISCORD_MAX_CHARS): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let buffer = ""
  let lines = 0
  let fence: string | null = null // language of the code block still open at the end of `buffer`

  // a split inside a code block needs room for "\n```" (and 3 more to reopen)
  const reserve = (): number => (fence === null ? 0 : CLOSE_FENCE.length + 3)
  const append = (line: string): void => {
    buffer += (lines++ > 0 ? "\n" : "") + line
  }
  const flush = (): void => {
    chunks.push(fence === null ? buffer : buffer + CLOSE_FENCE)
    buffer = fence === null ? "" : `\`\`\`${fence}`
    lines = fence === null ? 0 : 1
  }

  for (const line of text.split("\n")) {
    let rest = line
    let flushed = false
    for (;;) {
      const room = limit - buffer.length - (lines > 0 ? 1 : 0) - reserve()
      if (rest.length <= room) {
        append(rest)
        break
      }
      if (!flushed && lines > 0) {
        flush()
        flushed = true
        continue
      }
      // single line wider than the cap: cut at a space, else at the cap
      const space = rest.lastIndexOf(" ", room)
      const cut = space > 0 ? space : Math.max(room, 1)
      append(rest.slice(0, cut))
      rest = rest.slice(cut).replace(/^ +/, "")
      flush()
      flushed = true
    }
    if (line.trimStart().startsWith("```")) {
      fence = fence === null ? line.trim().slice(3).trim() : null
    }
  }
  if (buffer.length > 0) chunks.push(fence === null ? buffer : buffer + CLOSE_FENCE)
  return chunks
}

/**
 * Allow/Always/Reject row for a permission prompt. Discord only delivers button clicks over the
 * gateway, so the row is rendered while the gateway is live and `discord.buttons` stays as the
 * force-off switch.
 */
export function permissionButtons(): unknown[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: "Allow once", custom_id: "relay:once" },
        { type: 2, style: 2, label: "Always", custom_id: "relay:always" },
        { type: 2, style: 4, label: "Reject", custom_id: "relay:reject" },
      ],
    },
  ]
}

/** Cancel is a button on every question: the typed path accepts the word too. */
export const QUESTION_CANCEL_ID = "q:cancel"
/** Discord budgets: 5 action rows, 5 buttons or 25 select options in one, 100-char ids and values. */
const MAX_ROWS = 5
const MAX_SELECT_OPTIONS = 25
const MAX_BUTTON_LABEL = 80
const MAX_SELECT_LABEL = 100
const MAX_CUSTOM_ID = 100

const clip = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, Math.max(limit - 1, 1))}…`

/** `q:{formID}:{fieldKey}` for a select, plus `:{value}` for a button. */
const questionID = (...parts: readonly string[]): string => `q:${parts.join(":")}`

/**
 * Native controls for a question: a primary button row for up to four short options, a string
 * select for anything longer or wider, buttons first then selects when both occur. The body text
 * (with its typed-answer line) is unchanged, so a field that does not fit — or a click the gateway
 * missed — still answers by typing.
 */
export function questionComponents(question: QuestionDetails | undefined): unknown[] | undefined {
  if (question === undefined) return undefined
  const rows: unknown[] = []
  for (const field of question.fields) {
    // the last row stays free for Cancel
    if (rows.length >= MAX_ROWS - 1) break
    const options = field.options.slice(0, MAX_SELECT_OPTIONS)
    if (options.length === 0) continue
    // a value too long for a component slot cannot round-trip: that field stays typed-only
    if (options.some((option) => option.value.length > MAX_SELECT_LABEL)) continue
    const buttons = options.length <= 4 && options.every((option) => option.label.length <= MAX_BUTTON_LABEL)
    if (buttons) {
      const ids = options.map((option) => questionID(question.formID ?? "", field.key, option.value))
      if (ids.some((id) => id.length > MAX_CUSTOM_ID)) continue
      rows.push({
        type: 1,
        components: options.map((option, index) => ({
          type: 2,
          style: 1,
          label: clip(option.label, MAX_BUTTON_LABEL),
          custom_id: ids[index],
        })),
      })
      continue
    }
    const id = questionID(question.formID ?? "", field.key)
    if (id.length > MAX_CUSTOM_ID) continue
    rows.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: id,
          placeholder: clip(field.label, MAX_SELECT_LABEL),
          min_values: 1,
          max_values: field.multi ? options.length : 1,
          options: options.map((option) => ({ label: clip(option.label, MAX_SELECT_LABEL), value: option.value })),
        },
      ],
    })
  }
  if (rows.length === 0) return undefined
  rows.push({ type: 1, components: [{ type: 2, style: 2, label: "Cancel", custom_id: QUESTION_CANCEL_ID }] })
  return rows
}

/** The channel the bot posts into, or the user whose DM it opens. */
export type DiscordDest = { channelID: string } | { dmUserID: string }

export interface DiscordOptions {
  /** Discord bot token. Never logged. */
  token: string
  dest: DiscordDest
  log: Logger
  fetchImpl?: typeof fetch
  /** Root for the DM channel cache; defaults to `auth-state`. */
  dataDir?: string
  /** Force the permission button row off; the gateway renders it by default while live. */
  buttons?: boolean
  /** Inbound sender gate (security.allowlist); false drops a message or interaction. */
  allowSender?: (senderID: string) => boolean
  /** Allow `envelope.image.url` uploads: the provider fetches the URL locally unless it is an embed. */
  allowImageUrls?: boolean
  /** Inbound text from the channel; the returned text is posted back. */
  onInbound?: (message: InboundMessage) => string | undefined | Promise<string | undefined>
  /** Cross-restart inbound dedupe; without it a redelivered message could be answered twice. */
  dedupe?: DedupeStore
  /** Messages fetched per poll (Discord caps this at 100). */
  pollLimit?: number
  /** Live gateway inbound path; absent keeps REST polling only. */
  gateway?: {
    /** Socket factory; defaults to `ws`. Tests stub it. */
    socket?: (url: string) => GatewaySocket
    /** Reconnect delay override; tests shorten it. */
    backoff?: (attempt: number) => number
    /** Current inbound path, reported by `/relay status`; `close` is why it fell back to polling. */
    onMode?: (mode: "gateway" | "polling", close?: GatewayClose) => void
  }
}

/** Status plus Discord's own error body; no response contains the bot token. */
const failure = async (response: Response): Promise<string> =>
  `${response.status} ${await response.text().catch(() => "")}`

/** POST /users/@me/channels opens the DM (or returns the open one) and yields its channel id. */
async function openDM(dmUserID: string, token: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(`${API}/users/@me/channels`, {
    method: "POST",
    headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ recipient_id: dmUserID }),
  })
  if (!response.ok) throw new Error(`discord DM open failed: ${await failure(response)}`)
  const body = (await response.json().catch(() => ({}))) as { id?: string }
  if (typeof body.id !== "string" || body.id === "") throw new Error("discord DM open returned no channel id")
  return body.id
}

/** The cached channel for that user; a different user means a different channel. */
async function cachedDM(file: string, dmUserID: string): Promise<string | undefined> {
  try {
    const cached = JSON.parse(await readFile(file, "utf8")) as { dmUserID?: unknown; channelID?: unknown }
    return cached.dmUserID === dmUserID && typeof cached.channelID === "string" ? cached.channelID : undefined
  } catch {
    return undefined
  }
}

/** Atomic like batch-store: a crash mid-write must not leave a file the next start trusts. */
async function cacheDM(file: string, dmUserID: string, channelID: string, log: Logger): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(`${file}.tmp`, `${JSON.stringify({ dmUserID, channelID }, null, 2)}\n`, "utf8")
    await rename(`${file}.tmp`, file)
  } catch (error) {
    // a cache that cannot be written only costs one DM lookup after the next restart
    log.warn({ error }, "discord DM channel cache write failed")
  }
}

/**
 * Last gateway state, so a terminal `opencode-relay doctor` can name the close reason the live
 * process saw. Unreadable or absent means no gateway has run against this state root yet.
 */
export async function gatewayState(dir: string): Promise<{ at: string; close?: GatewayClose } | undefined> {
  try {
    const state = JSON.parse(await readFile(join(dir, DISCORD_GATEWAY_FILE), "utf8")) as {
      at?: unknown
      close?: GatewayClose
    }
    if (typeof state.at !== "string") return undefined
    return { at: state.at, ...(state.close === undefined ? {} : { close: state.close }) }
  } catch {
    return undefined
  }
}

/** Fire-and-forget: a status file that cannot be written costs one doctor line, never a relay. */
function recordGateway(dir: string, log: Logger, close?: GatewayClose): void {
  const body = `${JSON.stringify({ at: new Date().toISOString(), ...(close === undefined ? {} : { close }) }, null, 2)}\n`
  void mkdir(dir, { recursive: true })
    .then(() => writeFile(join(dir, DISCORD_GATEWAY_FILE), body, "utf8"))
    .catch((error: unknown) => log.warn({ error }, "discord gateway state write failed"))
}

/**
 * Live check for `/relay pair`: the channel answers, or the DM opens, and the proof notice lands.
 * Throws Discord's own error text, which never carries the token.
 */
export async function linkDiscord(
  dest: DiscordDest,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  // pairing runs inside a command: the same deadline keeps a hung check from freezing it
  fetchImpl = boundedFetch(fetchImpl)
  const auth = { authorization: `Bot ${token}` }
  let channelID: string
  if ("channelID" in dest) {
    const response = await fetchImpl(`${API}/channels/${encodeURIComponent(dest.channelID)}`, { headers: auth })
    if (!response.ok) throw new Error(`discord channel check failed: ${await failure(response)}`)
    channelID = dest.channelID
  } else {
    channelID = await openDM(dest.dmUserID, token, fetchImpl)
  }
  const response = await fetchImpl(`${API}/channels/${channelID}/messages`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ content: LINKED_TEXT }),
  })
  if (!response.ok) throw new Error(`discord test notice failed: ${await failure(response)}`)
}

/**
 * Discord sink and source: outbound over the REST API, inbound over the gateway websocket while it
 * is live and by `GET /channels/{id}/messages` polling while it is not. The first poll only anchors,
 * so history is never answered; in DM mode the channel id is opened once and cached, so sends, polls
 * and gateway dispatches all use the same resolved channel.
 */
export function discordProvider({
  token,
  dest,
  log,
  fetchImpl = fetch,
  dataDir = "auth-state",
  buttons = false,
  allowSender,
  onInbound,
  dedupe,
  pollLimit = 50,
  gateway: gatewayOption,
}: DiscordOptions): Provider {
  // every call on this path is on the relay tick: a hung request must fail, not stall the loop
  fetchImpl = boundedFetch(fetchImpl)
  const auth = { authorization: `Bot ${token}` }
  const cacheFile = join(dataDir, DISCORD_STATE_FILE)
  let resolved: string | undefined = "channelID" in dest ? dest.channelID : undefined
  let opening: Promise<string> | undefined
  let lastID: string | undefined
  let primed = false
  let gateway: DiscordGateway | undefined

  /** Channel mode uses the id as given; DM mode opens once, then serves the cache and this promise. */
  const channel = (): Promise<string> => {
    if (resolved !== undefined) return Promise.resolve(resolved)
    if (!("dmUserID" in dest)) return Promise.reject(new Error("discord destination missing"))
    const dmUserID = dest.dmUserID
    opening ??= (async () => {
      const cached = await cachedDM(cacheFile, dmUserID)
      if (cached !== undefined) return cached
      const opened = await openDM(dmUserID, token, fetchImpl)
      await cacheDM(cacheFile, dmUserID, opened, log)
      return opened
    })().then(
      (id) => (resolved = id),
      (error: unknown) => {
        // one failed open must not poison every later send
        opening = undefined
        throw error
      },
    )
    return opening
  }

  const post = async (content: string, components?: unknown[], embeds?: unknown[]): Promise<Response> =>
    fetchImpl(`${API}/channels/${await channel()}/messages`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        content,
        ...(components === undefined ? {} : { components }),
        ...(embeds === undefined ? {} : { embeds }),
      }),
    })

  /** Multipart upload: `payload_json` names the attachment, `files[0]` carries it. */
  const upload = async (content: string, image: LoadedImage, components?: unknown[]): Promise<Response> => {
    const form = new FormData()
    form.append(
      "payload_json",
      JSON.stringify({
        content,
        ...(components === undefined ? {} : { components }),
        attachments: [{ id: 0, filename: image.name }],
      }),
    )
    form.append("files[0]", new Blob([image.bytes], { type: image.mime }), image.name)
    // no content-type header: fetch writes the multipart boundary itself
    return fetchImpl(`${API}/channels/${await channel()}/messages`, { method: "POST", headers: auth, body: form })
  }

  /** Shared by the poll and the gateway, so a redelivery on either path is answered once. */
  const accept = async (message: DiscordMessage, chatID: string): Promise<void> => {
    const senderID = message.author?.id
    const text = (message.content ?? "").trim()
    // our own posts come from a bot account, and the bot cannot answer itself
    if (message.author?.bot === true || senderID === undefined || text === "") return
    // fail closed: an unlisted sender is dropped before it can spend dedupe state or reach a handler
    if (allowSender?.(senderID) === false) {
      log.warn({ senderID, messageID: message.id }, "discord inbound rejected: sender is not paired")
      return
    }
    // record only what the relay acts on; without a handler this message would be remembered for nothing
    if (onInbound !== undefined && dedupe !== undefined && !(await dedupe.first(`discord:${message.id}`))) return
    try {
      const quotedID = message.message_reference?.message_id
      const reply = await onInbound?.({
        id: message.id,
        chatID,
        senderID,
        text,
        selfChat: false,
        ...(typeof quotedID === "string" && quotedID !== "" ? { quotedID } : {}),
      })
      if (typeof reply === "string" && reply !== "") await post(reply)
    } catch (error) {
      log.error({ error, messageID: message.id }, "discord inbound handling failed")
    }
  }

  /** Gateway dispatch: only this conversation, and it doubles as the cursor for the poll fallback. */
  const onGatewayMessage = async (message: DiscordMessage): Promise<void> => {
    let chatID: string
    try {
      chatID = await channel()
    } catch (error) {
      log.warn({ error, messageID: message.id }, "discord gateway message without a channel")
      return
    }
    if (message.channel_id !== undefined && message.channel_id !== chatID) return
    lastID = message.id
    primed = true
    await accept(message, chatID)
  }

  /** Acknowledge first: a command can touch the network (sessions, models) past the 3s deadline. */
  const deferInteraction = async (interaction: DiscordInteraction): Promise<void> => {
    await fetchImpl(`${API}/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: DEFERRED, data: { flags: EPHEMERAL } }),
    }).catch((error: unknown) => log.warn({ error }, "discord interaction defer failed"))
  }

  /** Slash commands and button clicks are inbound text: same correlation, same handlers, same reply. */
  const interact = async (interaction: DiscordInteraction): Promise<void> => {
    const senderID = interactionUserID(interaction)
    if (senderID === undefined || gateway === undefined) return
    // same gate as messages: an unlisted user cannot command, answer or prompt
    if (allowSender?.(senderID) === false) {
      log.warn({ senderID, interactionID: interaction.id }, "discord interaction rejected: sender is not paired")
      return
    }
    await deferInteraction(interaction)
    let reply: string
    const text = interactionText(interaction) ?? questionAnswer(interaction) ?? componentText(interaction)
    if (text === undefined) {
      reply = DISCORD_USAGE
    } else {
      try {
        reply =
          (await onInbound?.({
            id: interaction.id,
            chatID: interaction.channel_id ?? resolved ?? "",
            senderID,
            text,
            selfChat: false,
          })) ?? "done"
      } catch (error) {
        reply = `relay: ${(error as Error).message}`
      }
    }
    await gateway.answer(interaction, splitMessage(reply))
  }

  return {
    async send(envelope) {
      const image = envelope.image
      // a URL-only image stays an embed: Discord fetches it, so nothing is uploaded
      const remote =
        image !== undefined && image.url !== undefined && image.path === undefined && image.bytes === undefined
          ? image.url
          : undefined
      const file =
        image === undefined || remote !== undefined ? undefined : await loadImage(image, DISCORD_MAX_IMAGE_BYTES, fetchImpl)
      const text = envelope.text !== "" ? envelope.text : (image?.caption ?? "")
      // force-off flag first: clicks only arrive over a live gateway, elsewhere a row is noise
      const components =
        buttons === true || gateway?.live() !== true
          ? undefined
          : envelope.interaction?.type === "permission"
            ? permissionButtons()
            : envelope.interaction?.type === "form"
              ? questionComponents(envelope.question)
              : undefined
      let firstID: string | undefined
      for (const [index, content] of splitMessage(text).entries()) {
        // controls and the image belong to the message that carries the prompt: later chunks are overflow
        const controls = index === 0 ? components : undefined
        const attempt = (): Promise<Response> =>
          index !== 0
            ? post(content, controls)
            : file !== undefined
              ? upload(content, file, controls)
              : post(content, controls, remote === undefined ? undefined : [{ image: { url: remote } }])
        let response = await attempt()
        if (response.status === 429) {
          const body = (await response.json().catch(() => ({}))) as { retry_after?: number }
          const waitMs = Math.min((body.retry_after ?? 1) * 1000, 5000)
          log.warn({ waitMs }, "discord rate limited, retrying once")
          await new Promise((resolve) => setTimeout(resolve, waitMs))
          response = await attempt()
        }
        if (!response.ok) {
          // response body only: the Authorization header never reaches a log or an error message
          throw new Error(`discord send failed: ${await failure(response)}`)
        }
        const created = (await response.json().catch(() => ({}))) as { id?: string }
        firstID ??= created.id
      }
      return firstID
    },

    // one private channel: the user varies (the author), the chat is the resolved channel
    destination(): Destination {
      const chat = resolved ?? ""
      return { externalUserID: chat, chatID: chat }
    },

    async start() {
      if (gateway !== undefined || gatewayOption === undefined) return
      const option = gatewayOption
      gateway = createDiscordGateway({
        token,
        log,
        fetchImpl,
        ...(option.socket === undefined ? {} : { socket: option.socket }),
        ...(option.backoff === undefined ? {} : { backoff: option.backoff }),
        onMessage: (message) => onGatewayMessage(message),
        onInteraction: (interaction) => interact(interaction),
        onReady: () => {
          recordGateway(dataDir, log)
          option.onMode?.("gateway")
        },
        onDown: (close) => {
          // the close names the fix: 4014 is a portal intent, 4004 is a bad token
          recordGateway(dataDir, log, close)
          option.onMode?.("polling", close)
        },
      })
      gateway.start()
    },

    async stop() {
      gateway?.stop()
    },

    /** `/relay pair discord` success: the commands must exist without a host restart. */
    async registerCommands() {
      if (gateway !== undefined) return gateway.register()
      await registerCommands(token, fetchImpl)
    },

    async poll() {
      // the gateway is the inbound path while it is up; polling resumes when it drops
      if (gateway?.live() === true) return
      let chatID: string
      try {
        chatID = await channel()
      } catch (error) {
        log.warn({ error }, "discord poll failed")
        return
      }
      const query = lastID === undefined ? "limit=1" : `after=${lastID}&limit=${pollLimit}`
      const response = await fetchImpl(`${API}/channels/${chatID}/messages?${query}`, { headers: auth })
      if (!response.ok) {
        log.warn({ status: response.status }, "discord poll failed")
        return
      }
      const body = (await response.json().catch(() => [])) as DiscordMessage[]
      if (!Array.isArray(body) || body.length === 0) return
      // snowflake IDs sort as strings: same length, same order
      const ordered = [...body].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      lastID = ordered[ordered.length - 1]?.id ?? lastID
      if (!primed) {
        primed = true
        return
      }
      for (const message of ordered) await accept(message, chatID)
    },
  }
}
