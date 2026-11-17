import type { Logger } from "pino"
import WebSocket from "ws"
import { CATEGORIES } from "../envelope.js"
import { retryDelayMs } from "../retry.js"
import type { DiscordMessage } from "./discord.js"

const API = "https://discord.com/api/v10"
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json"
/** GUILDS (1) + GUILD_MESSAGES (512) + DIRECT_MESSAGES (4096) + MESSAGE_CONTENT (32768). */
export const GATEWAY_INTENTS = 1 | 512 | 4096 | 32768
/** Close 4000-mid: the documented "session is a zombie" reason when a heartbeat is not acked. */
const ZOMBIE = 4000
/** Auth and sharding failures: reconnecting cannot fix them, so REST polling takes over for good. */
const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014])
const EPHEMERAL = 64
const DEFAULT_HEARTBEAT_MS = 41_250

/** Why Discord (or the socket) closed the gateway: what `/relay status` and doctor report. */
export interface GatewayClose {
  readonly code: number
  /** Discord's own close text when it sent one, e.g. "Disallowed intent(s)". */
  readonly reason?: string
}

/** One line per close code, so a status line says what to fix instead of only a number. */
const CLOSE_HINTS: Readonly<Record<number, string>> = {
  4000: "unknown error, check the plugin log",
  4001: "unknown opcode, gateway client out of date",
  4002: "decode error, malformed payload",
  4003: "not authenticated, IDENTIFY before HELLO",
  4004: "authentication failed, the bot token is wrong or was reset",
  4005: "already authenticated",
  4007: "invalid sequence, the resume state is stale",
  4008: "rate limited, too many IDENTIFY attempts",
  4009: "session timed out",
  4010: "invalid shard",
  4011: "sharding required, the bot is in too many guilds",
  4012: "invalid API version",
  4013: "invalid intents, the requested intents are rejected",
  4014: "disallowed intents, enable MESSAGE_CONTENT in the Discord developer portal",
}

/** `4014 Disallowed intent(s) - disallowed intents, enable MESSAGE_CONTENT ...` */
export function closeHint({ code, reason }: GatewayClose): string {
  const hint = CLOSE_HINTS[code] ?? "unknown close code, check the plugin log"
  return `${code}${reason === undefined || reason === "" ? "" : ` ${reason}`} - ${hint}`
}

/** The slice of the socket API the gateway uses; tests supply their own. */
export interface GatewaySocket {
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason?: string }) => void) | null
  onerror: ((event: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

/** The fields of an INTERACTION_CREATE payload this relay reads. */
export interface DiscordInteraction {
  readonly id: string
  readonly type: number
  readonly token: string
  readonly channel_id?: string
  readonly member?: { readonly user?: { readonly id?: string } }
  readonly user?: { readonly id?: string }
  readonly data?: {
    readonly name?: string
    readonly custom_id?: string
    /** Chosen values of a select menu. */
    readonly values?: readonly string[]
    readonly options?: readonly { readonly name: string; readonly value?: unknown }[]
  }
}

interface Payload {
  readonly op: number
  readonly d?: unknown
  readonly s?: number | null
  readonly t?: string | null
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined

const textOf = (value: unknown, key: string): string | undefined => {
  const field = record(value)?.[key]
  return typeof field === "string" && field !== "" ? field : undefined
}

const numberOf = (value: unknown, key: string): number | undefined => {
  const field = record(value)?.[key]
  return typeof field === "number" ? field : undefined
}

/** Subcommands the slash command mirrors; anything else answers with the usage text. */
export const RELAY_SUBCOMMANDS = [
  "status",
  "sessions",
  "select",
  "notifications",
  "model",
  "pair",
  "unpair",
  "invite",
  "group",
  "send",
  "help",
]

/** Subcommand -> how its options become the words `/relay` parses: [option name, prefix word]. */
const SUB_OPTIONS: Readonly<Record<string, readonly (readonly [string, string?])[]>> = {
  select: [["session"]],
  // `mode`/`preset` read as "<key> <value>"; a category change carries its own two words
  notifications: [["mode", "mode"], ["preset", "preset"], ["change"]],
  model: [["providerID"], ["modelID"]],
  // path and caption are free text: the relay rejoins the words it finds a file for
  send: [["path"], ["caption"]],
  pair: [["provider"]],
  unpair: [["provider"]],
  invite: [["provider"]],
}

/** Button custom_id -> the answer the typed path already understands. */
export const BUTTON_ANSWERS: Readonly<Record<string, string>> = {
  "relay:once": "once",
  "relay:always": "always",
  "relay:reject": "reject",
}

/**
 * A slash invocation as the text `/relay` parses, so interactions and typed commands share one
 * handler. Undefined means "not a subcommand we know": the caller answers with the usage list.
 */
export function interactionText(interaction: DiscordInteraction): string | undefined {
  if (interaction.type !== 2) return undefined
  const name = interaction.data?.name
  if (name === undefined || !RELAY_SUBCOMMANDS.includes(name)) return undefined
  const given = interaction.data?.options ?? []
  const args = (SUB_OPTIONS[name] ?? []).flatMap(([key, prefix]) => {
    const value = given.find((entry) => entry.name === key)?.value
    if (typeof value !== "string" || value === "") return []
    return prefix === undefined ? value.split(/\s+/) : [prefix, value]
  })
  return ["/relay", name, ...args].join(" ")
}

/** A button click as the answer text, or undefined for a component we do not own. */
export function componentText(interaction: DiscordInteraction): string | undefined {
  if (interaction.type !== 3) return undefined
  const customID = interaction.data?.custom_id
  return customID === undefined ? undefined : BUTTON_ANSWERS[customID]
}

/**
 * A question component as the typed answer it stands for: `fieldKey: value`, which is what the form
 * reply parser already reads. A button carries its option value after the field key; a select
 * carries its choice in `values` (comma-joined for a multiselect). Cancel is its own id.
 */
export function questionAnswer(interaction: DiscordInteraction): string | undefined {
  if (interaction.type !== 3) return undefined
  const customID = interaction.data?.custom_id
  if (customID === undefined || !customID.startsWith("q:")) return undefined
  if (customID === "q:cancel") return "cancel"
  const parts = customID.split(":")
  const fieldKey = parts[2] ?? ""
  if (fieldKey === "") return undefined
  const pinned = parts.slice(3).join(":")
  const selected = interaction.data?.values ?? []
  const values = selected.length > 0 ? selected : pinned === "" ? [] : [pinned]
  return values.length === 0 ? undefined : `${fieldKey}: ${values.join(", ")}`
}

/** The user who clicked or invoked; guild interactions carry it under `member`. */
export function interactionUserID(interaction: DiscordInteraction): string | undefined {
  return interaction.member?.user?.id ?? interaction.user?.id
}

/** Discord wants `{name, value}` choices for a closed value set; the value is what `/relay` parses. */
const choiceSet = (values: readonly string[]): unknown[] => values.map((value) => ({ name: value, value }))

/** Global application commands: `/relay` with one subcommand per typed command. */
export function commandsBody(): unknown[] {
  const sub = (name: string, description: string, options?: unknown[]) => ({
    type: 1,
    name,
    description,
    ...(options === undefined ? {} : { options }),
  })
  const option = (name: string, description: string, required = false, values?: readonly string[]) => ({
    type: 3,
    name,
    description,
    required,
    ...(values === undefined ? {} : { choices: choiceSet(values) }),
  })
  const provider = (description: string) => option("provider", description, false, ["whatsapp", "discord"])
  return [
    {
      type: 1,
      name: "relay",
      description: "Relay status, sessions and notification settings",
      options: [
        sub("status", "Provider, preset, mode, enabled categories, pending batches"),
        sub("sessions", "Recent sessions as a numbered list"),
        sub("select", "Session that prompts and answers go to", [
          option("session", "Number from /relay sessions, or a session id", true),
        ]),
        sub("notifications", "Notification categories and delivery", [
          option("mode", "Delivery mode", false, ["immediate", "batch", "final_only"]),
          option("preset", "Which categories notify", false, ["all", "important", "completion"]),
          option("change", "Turn one category on or off", false, CATEGORIES.flatMap((name) => [`${name} on`, `${name} off`])),
        ]),
        sub("model", "Model that summarises notifications", [
          option("providerID", "Provider of the model"),
          option("modelID", "Model id"),
        ]),
        sub("pair", "Link a transport through a form", [provider("whatsapp or discord")]),
        sub("unpair", "Log out and remove a transport's target", [provider("whatsapp or discord")]),
        sub("invite", "Bot install URL, so it can join a server and DM you", [
          option("provider", "Transport (discord only)", false, ["discord"]),
        ]),
        sub("group", "Create or reuse the WhatsApp group notifications go to"),
        sub("send", "Send an image file from the host", [
          option("path", "Absolute file path (png, jpg, jpeg, gif or webp)", true),
          option("caption", "Caption under the image"),
        ]),
        sub("help", "Every subcommand with its purpose"),
      ],
    },
  ]
}

/** PUT the command set; the application id comes from READY, else REST. Returns the id used. */
export async function registerCommands(
  token: string,
  fetchImpl: typeof fetch = fetch,
  appID?: string,
): Promise<string> {
  const id = appID ?? (await applicationID(token, fetchImpl))
  const response = await fetchImpl(`${API}/applications/${encodeURIComponent(id)}/commands`, {
    method: "PUT",
    headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
    body: JSON.stringify(commandsBody()),
  })
  if (!response.ok) {
    // response body only: the Authorization header never reaches a log or an error message
    throw new Error(
      `discord command registration failed: ${response.status} ${await response.text().catch(() => "")}`,
    )
  }
  return id
}

/** The application the commands belong to: its own endpoint, then the bot user as a last resort. */
async function applicationID(token: string, fetchImpl: typeof fetch): Promise<string> {
  const headers = { authorization: `Bot ${token}` }
  for (const path of ["/oauth2/applications/@me", "/users/@me"]) {
    const response = await fetchImpl(`${API}${path}`, { headers })
    if (!response.ok) continue
    const body = (await response.json().catch(() => ({}))) as { id?: unknown }
    if (typeof body.id === "string" && body.id !== "") return body.id
  }
  throw new Error("discord application id unavailable (DISCORD_BOT_TOKEN not accepted)")
}

/** Edit the deferred reply, then post any overflow chunks as ephemeral followups. */
async function answerInteraction(
  interaction: DiscordInteraction,
  appID: string | undefined,
  chunks: readonly string[],
  fetchImpl: typeof fetch,
): Promise<void> {
  const base = `${API}/webhooks/${appID ?? "@me"}/${interaction.token}`
  const headers = { "content-type": "application/json" }
  for (const [index, chunk] of chunks.entries()) {
    const url = index === 0 ? `${base}/messages/@original` : base
    await fetchImpl(url, {
      method: index === 0 ? "PATCH" : "POST",
      headers,
      body: JSON.stringify({ content: chunk, flags: EPHEMERAL }),
    }).catch(() => undefined)
  }
}

export interface GatewayOptions {
  /** Bot token; sent in IDENTIFY and never logged. */
  token: string
  log: Logger
  fetchImpl?: typeof fetch
  /** Socket factory; defaults to `ws`. Tests stub it. */
  socket?: (url: string) => GatewaySocket
  /** Reconnect delay for a failed attempt; defaults to the shared retry backoff. */
  backoff?: (attempt: number) => number
  onMessage: (message: DiscordMessage) => void | Promise<void>
  onInteraction: (interaction: DiscordInteraction) => void | Promise<void>
  /** READY or RESUMED: the gateway is the inbound path again. */
  onReady?: (appID: string | undefined) => void
  /** Socket gone: REST polling carries inbound until the next READY. The close names the reason. */
  onDown?: (close?: GatewayClose) => void
}

export interface DiscordGateway {
  start(): void
  stop(): void
  live(): boolean
  /** Registers the slash commands if that has not succeeded yet. */
  register(): Promise<void>
  applicationID(): string | undefined
  /** Answer one interaction: defer ephemerally, then edit with the reply chunks. */
  answer(interaction: DiscordInteraction, chunks: readonly string[]): Promise<void>
}

/**
 * Discord gateway v10: IDENTIFY, heartbeat, RESUME on a dropped socket with the shared backoff.
 * Dispatch is handed straight to the transport's inbound pipeline, so the gateway and the poll
 * share one handler and the dedupe store keeps a double delivery from being answered twice.
 */
export function createDiscordGateway({
  token,
  log,
  fetchImpl = fetch,
  socket: socketOf = (url) => new WebSocket(url) as unknown as GatewaySocket,
  backoff = retryDelayMs,
  onMessage,
  onInteraction,
  onReady,
  onDown,
}: GatewayOptions): DiscordGateway {
  let socket: GatewaySocket | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let reconnect: ReturnType<typeof setTimeout> | undefined
  let seq: number | null = null
  let sessionID: string | undefined
  let resumeURL: string | undefined
  let appID: string | undefined
  let acknowledged = true
  let attempt = 0
  let ready = false
  let stopped = false
  let registered = false

  const send = (payload: unknown): void => {
    try {
      socket?.send(JSON.stringify(payload))
    } catch (error) {
      log.warn({ error }, "discord gateway send failed")
    }
  }

  const stopHeartbeat = (): void => {
    if (heartbeat !== undefined) clearInterval(heartbeat)
    heartbeat = undefined
  }

  const schedule = (close?: GatewayClose): void => {
    if (stopped) return
    attempt += 1
    const ms = backoff(attempt)
    log.warn({ ms, attempt, close }, "discord gateway down, polling until reconnect")
    onDown?.(close)
    reconnect = setTimeout(connect, ms)
    reconnect.unref?.()
  }

  const register = async (): Promise<void> => {
    if (registered) return
    registered = true
    try {
      appID = await registerCommands(token, fetchImpl, appID)
      log.info({ applicationID: appID }, "discord slash commands registered")
    } catch (error) {
      // a failed PUT only costs the slash surface: typed commands keep working
      registered = false
      log.warn({ error }, "discord command registration failed")
    }
  }

  const dispatch = (type: string | null | undefined, data: unknown): void => {
    if (type === "READY") {
      sessionID = textOf(data, "session_id")
      resumeURL = textOf(data, "resume_gateway_url")
      appID = textOf(record(data)?.["application"], "id") ?? appID
      attempt = 0
      ready = true
      log.info({ user: textOf(record(data)?.["user"], "username") }, "discord gateway ready")
      onReady?.(appID)
      void register()
      return
    }
    if (type === "RESUMED") {
      attempt = 0
      ready = true
      onReady?.(appID)
      return
    }
    if (type === "MESSAGE_CREATE") {
      void Promise.resolve(onMessage(data as DiscordMessage)).catch((error: unknown) =>
        log.error({ error }, "discord gateway inbound handling failed"),
      )
      return
    }
    if (type === "INTERACTION_CREATE") {
      void Promise.resolve(onInteraction(data as DiscordInteraction)).catch((error: unknown) =>
        log.error({ error }, "discord interaction handling failed"),
      )
    }
  }

  const identify = (): void => {
    send({
      op: 2,
      d: {
        token,
        intents: GATEWAY_INTENTS,
        properties: { os: process.platform, browser: "opencode-relay", device: "opencode-relay" },
      },
    })
  }

  const handle = (payload: Payload): void => {
    switch (payload.op) {
      case 10: {
        const interval = numberOf(payload.d, "heartbeat_interval") ?? DEFAULT_HEARTBEAT_MS
        stopHeartbeat()
        heartbeat = setInterval(() => {
          if (!acknowledged) {
            log.warn("discord gateway heartbeat not acked, reconnecting")
            // fail over now, not when the close handshake finishes: a half-open socket can take
            // closeTimeout to report, and readiness is what keeps polling switched off
            ready = false
            onDown?.()
            socket?.close(ZOMBIE)
            return
          }
          acknowledged = false
          send({ op: 1, d: seq })
        }, interval)
        heartbeat.unref?.()
        // a live session resumes; a fresh one identifies
        if (sessionID !== undefined) send({ op: 6, d: { token, session_id: sessionID, seq } })
        else identify()
        return
      }
      case 11:
        acknowledged = true
        return
      case 1:
        send({ op: 1, d: seq })
        return
      case 7:
        log.warn("discord gateway asked for a reconnect")
        socket?.close()
        return
      case 9: {
        // resumable=false means the session is gone: the next HELLO must identify again
        if (payload.d !== true) {
          sessionID = undefined
          resumeURL = undefined
          seq = null
        }
        socket?.close()
        return
      }
      case 0: {
        if (typeof payload.s === "number") seq = payload.s
        dispatch(payload.t, payload.d)
      }
    }
  }

  function connect(): void {
    if (stopped) return
    const url = resumeURL === undefined ? GATEWAY_URL : `${resumeURL}/?v=10&encoding=json`
    let opened: GatewaySocket
    try {
      opened = socketOf(url)
    } catch (error) {
      log.error({ error }, "discord gateway socket could not open")
      schedule()
      return
    }
    socket = opened
    opened.onmessage = (event) => {
      try {
        handle(JSON.parse(String(event.data)) as Payload)
      } catch (error) {
        log.warn({ error }, "discord gateway payload unreadable")
      }
    }
    opened.onerror = (event) => log.warn({ error: String(event) }, "discord gateway socket error")
    opened.onclose = (event) => {
      if (socket !== opened) return
      socket = undefined
      stopHeartbeat()
      ready = false
      acknowledged = true
      if (stopped) return
      const close: GatewayClose = {
        code: event.code,
        ...(event.reason === undefined || event.reason === "" ? {} : { reason: event.reason }),
      }
      if (FATAL.has(close.code)) {
        log.error({ code: close.code, hint: closeHint(close) }, "discord gateway refused the connection, polling only")
        onDown?.(close)
        return
      }
      schedule(close)
    }
  }

  return {
    start() {
      stopped = false
      if (reconnect !== undefined) clearTimeout(reconnect)
      reconnect = undefined
      connect()
    },
    stop() {
      stopped = true
      if (reconnect !== undefined) clearTimeout(reconnect)
      reconnect = undefined
      stopHeartbeat()
      const closing = socket
      socket = undefined
      ready = false
      closing?.close(1000)
    },
    live() {
      return ready
    },
    register,
    applicationID() {
      return appID
    },
    async answer(interaction, chunks) {
      await answerInteraction(interaction, appID, chunks, fetchImpl)
    },
  }
}
