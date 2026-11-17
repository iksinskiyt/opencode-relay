import { mkdir } from "node:fs/promises"
import makeWASocket, {
  Browsers,
  DisconnectReason,
  jidNormalizedUser,
  useMultiFileAuthState,
  type GroupMetadata,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys"
import type { Logger } from "pino"
import qrcode from "qrcode-terminal"
import type { DedupeStore } from "../dedupe.js"
import type { Destination, Envelope, InboundMessage, Provider } from "../envelope.js"
import { loadImage, WHATSAPP_MAX_IMAGE_BYTES } from "../image.js"
import { withDeadline } from "../timeout.js"

/** WhatsApp rejects a single text message above 64 KiB, counted as UTF-8 bytes. */
export const WHATSAPP_MAX_BYTES = 65_536
/** WhatsApp clips an image caption above this many characters. */
export const WHATSAPP_CAPTION_CHARS = 1_024

const REMEMBER_LIMIT = 1_000

/** Exponential backoff for a closed socket: doubles per attempt and stops at the cap. */
export function reconnectDelayMs(attempt: number, baseMs = 1_000, maxMs = 60_000): number {
  return Math.min(baseMs * 2 ** attempt, maxMs)
}

const bytes = (text: string): number => Buffer.byteLength(text, "utf8")

/** A code block closed across a split, so every chunk stays one valid block. */
const CLOSE_FENCE = "\n```"

// WhatsApp's own markers: bold is *bold*, strike is ~strike~, `_italic_` and `code` already match.
const BOLD_STARS = /\*\*(?=\S)([\s\S]*?\S)\*\*/g
const BOLD_UNDERSCORES = /__(?=\S)([\s\S]*?\S)__/g
const STRIKE = /~~(?=\S)([\s\S]*?\S)~~/g
const HEADING = /^\s{0,3}#{1,6}\s+(.*\S)\s*$/
/** Markdown's own code-block indent: WhatsApp keeps the whitespace, so leave the text alone. */
const INDENTED = /^(?: {4}|\t)/

/** Inline Markdown -> WhatsApp, leaving anything inside a `code span` untouched. */
function inlineMarkdown(line: string): string {
  return line
    .split(/(`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(BOLD_STARS, "*$1*").replace(BOLD_UNDERSCORES, "*$1*").replace(STRIKE, "~$1~"),
    )
    .join("")
}

/**
 * Markdown -> WhatsApp syntax, outside fenced code and indented blocks only: `**bold**` and
 * `__bold__` become `*bold*`, `## Heading` becomes a bold line and `~~strike~~` becomes `~strike~`.
 * `_italic_`, `code` and ```` ``` ```` blocks are left as written because WhatsApp reads them too.
 */
export function toWhatsAppMarkdown(text: string): string {
  let fence = false
  return text
    .split("\n")
    .map((line) => {
      if (line.trimStart().startsWith("```")) {
        fence = !fence
        return line
      }
      if (fence || INDENTED.test(line)) return line
      const heading = HEADING.exec(line)
      if (heading !== null) return `*${inlineMarkdown(heading[1] ?? "")}*`
      return inlineMarkdown(line)
    })
    .join("\n")
}

/**
 * Split on newline boundaries under the byte cap, so a chunk never ends mid-line unless one line is
 * wider than the cap on its own (then it is cut between code points at the cap). A code block that
 * straddles a split is closed at the end of one chunk and reopened in the next.
 */
export function splitMessage(text: string, limit = WHATSAPP_MAX_BYTES): string[] {
  if (bytes(text) <= limit) return [text]
  const chunks: string[] = []
  let buffer = ""
  let bufferedBytes = 0
  let lines = 0 // lines held by `buffer`, so an empty first line is not swallowed
  let buffered = false
  let fence: string | null = null // language of the code block still open at the end of `buffer`

  // room a split needs for "\n```" plus the "```lang" that reopens it
  const room = (): number => Math.max(limit - (fence === null ? 0 : bytes(CLOSE_FENCE) + 3 + bytes(fence)), 1)

  const append = (line: string): void => {
    if (lines > 0) buffer += "\n"
    buffer += line
    bufferedBytes += (lines > 0 ? 1 : 0) + bytes(line)
    lines += 1
    buffered = true
    if (line.trimStart().startsWith("```")) fence = fence === null ? line.trim().slice(3).trim() : null
  }

  const flush = (): void => {
    if (!buffered) return
    chunks.push(fence === null ? buffer : `${buffer}${CLOSE_FENCE}`)
    buffer = fence === null ? "" : `\`\`\`${fence}`
    bufferedBytes = bytes(buffer)
    lines = fence === null ? 0 : 1
    buffered = fence !== null
  }

  for (const line of text.split("\n")) {
    const lineBytes = bytes(line)
    if (buffered) {
      if (bufferedBytes + 1 + lineBytes <= room()) {
        append(line)
        continue
      }
      flush()
    }
    if (lineBytes > room()) {
      // cut by code point, never by byte: half a surrogate pair would corrupt the message
      for (const char of line) {
        const charBytes = bytes(char)
        if (bufferedBytes + charBytes > room()) flush()
        buffer += char
        bufferedBytes += charBytes
        buffered = true
        lines = Math.max(lines, 1)
      }
      continue
    }
    append(line)
  }
  if (buffered) chunks.push(fence === null ? buffer : `${buffer}${CLOSE_FENCE}`)
  return chunks
}

/** Bounded set: true for the first sight of `key`, false afterwards. */
function remember(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false
  seen.add(key)
  if (seen.size > REMEMBER_LIMIT) {
    const oldest = seen.values().next().value
    if (oldest !== undefined) seen.delete(oldest)
  }
  return true
}

export interface WhatsAppOptions {
  /** Durable auth directory, e.g. `auth-state/whatsapp`. */
  authDir: string
  /** Post to our own JID (self-chat) instead of `target`. */
  selfChat: boolean
  /** Target JID used when `selfChat` is off. */
  target?: string
  log: Logger
  /** Inbound from someone other than ourselves. `false` drops it (pairingRequired). */
  allowSender?: (jid: string) => boolean
  /** Returns text to send back to the same chat, or nothing. Must not throw for control flow. */
  onInbound?: (message: InboundMessage) => string | undefined | Promise<string | undefined>
  /** Persists the message IDs this relay sent, so an echo is never read as user input. */
  dedupe?: DedupeStore
  /** Allow `envelope.image.url`: the transport fetches it locally, so this is off unless configured. */
  allowImageUrls?: boolean
  baseDelayMs?: number
  maxDelayMs?: number
  maxAttempts?: number
}

/** A socket plus its handlers, as much of WASocket as this adapter touches. */
type Socket = Pick<
  WASocket,
  "ev" | "sendMessage" | "end" | "logout" | "user" | "requestPairingCode" | "groupCreate" | "groupFetchAllParticipating"
>

/** How long a pairing socket waits for the phone to finish linking. */
const PAIRING_WINDOW_MS = 3 * 60_000
/** How long it waits for the registration handshake before giving up on a code. */
const PAIRING_READY_MS = 20_000

/** The one place socket options live: the provider and the pairing socket share them. */
async function authSocket(
  authDir: string,
  log: Logger,
  // the phone lists this name; the default (Browsers.macOS('Chrome')) would claim a Chrome on macOS
  browser = Browsers.baileys("opencode-relay"),
): Promise<{ sock: Socket; saveCreds: () => Promise<void> }> {
  await mkdir(authDir, { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(authDir)
  return { sock: makeWASocket({ auth: state, logger: log, browser }) as unknown as Socket, saveCreds }
}

/** The real reason a socket closed: Baileys hides it in `lastDisconnect.error` (a Boom). */
function describeError(error: unknown): string {
  const { message, output } = (error ?? {}) as { message?: string; output?: { statusCode?: number } }
  const statusCode = output?.statusCode
  const text = message ?? String(error ?? "connection closed")
  return statusCode === undefined ? text : `${statusCode} ${text}`
}

/** A pairing socket that closed, or hung, before a code could be asked for: worth one retry. */
export class PairingUnavailableError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = "PairingUnavailableError"
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // a pending pairing window must not hold the plugin host open
    timer.unref?.()
  })
}

/** A socket that exists only to pair; hidden behind an interface so tests can stand one in. */
export interface PairingSocket {
  /** Rejects with a `PairingUnavailableError` when the socket is not usable yet. */
  requestPairingCode(phoneNumber: string): Promise<string>
  /** True once the phone completed the link and the creds are on disk; false on close or timeout. */
  waitForLink(): Promise<boolean>
  /** The last QR the socket was offered; undefined until the registration handshake answers. */
  qr(): string | undefined
  close(): Promise<void>
}

/**
 * A transient socket for pairing when the configured provider has no live one (e.g. `provider:
 * "mock"`). Same auth dir and options as the provider, and it saves the creds, so a later restart
 * with `provider: "whatsapp"` connects without pairing again.
 */
export async function openPairingSocket(authDir: string, log: Logger): Promise<PairingSocket> {
  // the pairing-code hello carries the browser as `companion_platform_id`, and rc14 maps only a
  // known web-client name to a real id (Utils/companion-reg-client-utils.js); the Baileys README
  // documents a custom browser for QR only. Measured: neither tuple blocks the code request, so
  // the transient socket keeps the default and the relay name stays on the provider socket.
  const { sock, saveCreds } = await authSocket(authDir, log, Browsers.macOS("Chrome"))
  let lastQR: string | undefined
  let settleLink: (linked: boolean) => void = () => {}
  // resolves undefined once a code can be asked for, or with the reason it cannot
  let settleReady: (notReady: string | undefined) => void = () => {}
  const link = new Promise<boolean>((resolve) => {
    settleLink = resolve
  })
  const ready = new Promise<string | undefined>((resolve) => {
    settleReady = resolve
  })
  sock.ev.on("connection.update", (update) => {
    if (typeof update.qr === "string") {
      // the QR event means registration is up, so a code request is accepted from here
      lastQR = update.qr
      settleReady(undefined)
    } else if (update.connection === "open") {
      void saveCreds()
      settleLink(true)
      // a pairing socket never opens on a fresh link: these creds are already a linked device
      settleReady("already linked: auth-state/whatsapp holds credentials for an existing device")
    } else if (update.connection === "close") {
      settleLink(false)
      // fail now with the real reason instead of waiting out the readiness window
      settleReady(describeError((update.lastDisconnect as { error?: unknown } | undefined)?.error))
    }
  })
  return {
    async requestPairingCode(phoneNumber) {
      const notReady = await Promise.race([
        ready,
        pause(PAIRING_READY_MS).then(() => `no answer from WhatsApp within ${PAIRING_READY_MS / 1000}s`),
      ])
      if (notReady !== undefined) throw new PairingUnavailableError(notReady)
      try {
        return await sock.requestPairingCode(phoneNumber.replace(/\D/g, ""))
      } catch (error) {
        // a close between readiness and send: Baileys throws Boom('Connection Closed', 428)
        throw new PairingUnavailableError(describeError(error))
      }
    },
    waitForLink: () => Promise.race([link, pause(PAIRING_WINDOW_MS).then(() => false)]),
    qr: () => lastQR,
    close: async () => {
      settleLink(false)
      try {
        await saveCreds()
      } catch (error) {
        log.error({ error }, "whatsapp pairing saveCreds failed")
      }
      sock.end(undefined)
    },
  }
}

/**
 * WhatsApp sink and source over Baileys. `start()` connects and reconnects with backoff; `send()`
 * throws on failure so the caller can log it, and never takes the plugin loop down.
 */
export class WhatsAppProvider implements Provider {
  private sock: Socket | undefined
  private ownJID: string | undefined
  /** Every JID WhatsApp may report for this account: phone-number JID, LID and device JID. */
  private ownJIDs = new Set<string>()
  private saveCreds: (() => Promise<void>) | undefined
  private attempt = 0
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly sent = new Set<string>()
  /** WhatsApp message IDs this relay produced; their echo must never become inbound input. */
  private readonly sentIDs = new Set<string>()
  private readonly received = new Set<string>()

  constructor(private readonly options: WhatsAppOptions) {}

  /** Where notifications go: our own JID in self-chat mode, the configured target otherwise. */
  private get outbound(): string | undefined {
    return this.options.selfChat ? this.ownJID : this.options.target
  }

  /** Self-chat: sender and chat are the same JID. Target mode: the reply comes from the target. */
  destination(): Destination | undefined {
    const chatID = this.outbound
    return chatID === undefined ? undefined : { externalUserID: chatID, chatID }
  }

  /** Code typed on the phone (WhatsApp > Linked devices > Link with code); needs a live socket. */
  async requestPairingCode(phoneNumber: string): Promise<string> {
    const sock = this.sock
    // the caller falls back to a transient pairing socket when this throws
    if (sock === undefined) throw new Error("whatsapp socket not running")
    return withDeadline(sock.requestPairingCode(phoneNumber.replace(/\D/g, "")), "whatsapp pairing code")
  }

  /** `/relay unpair whatsapp`: server-side unlink ends the socket and does not reconnect. */
  async logout(): Promise<void> {
    const sock = this.sock
    if (sock === undefined) throw new Error("whatsapp not connected")
    this.stopped = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    try {
      await withDeadline(sock.logout(), "whatsapp logout")
    } finally {
      // even a failed logout leaves these creds unusable; the caller deletes the directory
      this.sock = undefined
      this.ownJID = undefined
      this.ownJIDs = new Set()
    }
  }

  /**
   * `/relay group`: join or create the group named `subject` and route every outbound message there.
   * Reusing by name keeps a second `/relay group` from creating a second group.
   */
  async ensureGroup(subject: string): Promise<{ jid: string; created: boolean }> {
    const sock = this.sock
    // ownJID is only set once the connection is open: a group call before that would just fail
    if (sock === undefined || this.ownJID === undefined) throw new Error("whatsapp not connected: link the device first")
    // a fetch failure only costs the reuse: creating is still the fallback
    let groups: Readonly<Record<string, GroupMetadata>> = {}
    try {
      groups = await withDeadline(sock.groupFetchAllParticipating(), "whatsapp group list")
    } catch (error) {
      this.options.log.warn({ error }, "whatsapp group list unavailable")
    }
    const existing = Object.values(groups).find((group) => group.subject === subject)
    const own = this.selfJID()
    const jid =
      existing?.id ??
      (await withDeadline(sock.groupCreate(subject, own === undefined ? [] : [own]), "whatsapp group create")).id
    this.options.selfChat = false
    this.options.target = jid
    return { jid, created: existing === undefined }
  }

  /** Our own phone-number JID: the member a created group is addressed to. */
  private selfJID(): string | undefined {    const user = this.sock?.user
    const jid = user?.phoneNumber ?? user?.id
    return typeof jid === "string" && jid !== "" ? jidNormalizedUser(jid) : undefined
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const sock = this.sock
    this.sock = undefined
    this.ownJID = undefined
    this.ownJIDs = new Set()
    try {
      await this.saveCreds?.()
    } catch (error) {
      this.options.log.error({ error }, "whatsapp saveCreds failed on shutdown")
    }
    sock?.end(undefined)
  }

  /** Resolves with the first WhatsApp message ID of the send, for reply correlation. */
  async send(envelope: Envelope): Promise<string | void> {
    // recorded only after a full send: a failed send stays retryable, a redelivered one is skipped
    if (this.sent.has(envelope.id)) {
      this.options.log.debug({ id: envelope.id }, "whatsapp duplicate envelope skipped")
      return
    }
    const target = this.outbound
    if (target === undefined) throw new Error("whatsapp target unknown (socket not connected)")
    // Markdown the host model wrote arrives as WhatsApp's own markers, outside code blocks
    const text = toWhatsAppMarkdown(envelope.text)
    if (envelope.image !== undefined) {
      const image = await loadImage(envelope.image, WHATSAPP_MAX_IMAGE_BYTES, fetch, this.options.allowImageUrls === true)
      const body = text !== "" ? text : (envelope.image.caption ?? "")
      const messageID = await this.sendImage(target, image.bytes, body.slice(0, WHATSAPP_CAPTION_CHARS))
      // the clipped tail still has to arrive: a caption is capped, the text is not
      const rest = body.slice(WHATSAPP_CAPTION_CHARS)
      if (rest !== "") await this.sendText(target, rest)
      remember(this.sent, envelope.id)
      return messageID
    }
    // text only otherwise: a linked companion has no interactive API, so `envelope.question` is
    // answered by typing the letter/value the message body lists (buttons and selects are Discord-only)
    const messageID = await this.sendText(target, text)
    remember(this.sent, envelope.id)
    return messageID
  }

  private async sendText(chatID: string, text: string): Promise<string | void> {
    const sock = this.sock
    if (sock === undefined) throw new Error("whatsapp not connected")
    let messageID: string | undefined
    for (const chunk of splitMessage(text)) {
      // a dead socket can leave Baileys waiting for the connection: the tick gets a deadline instead
      const sent = await withDeadline(sock.sendMessage(chatID, { text: chunk }), "whatsapp send")
      const id = sent?.key?.id
      if (typeof id === "string") this.rememberSent(id)
      messageID ??= id ?? undefined
    }
    return messageID
  }

  private async sendImage(chatID: string, image: Buffer, caption: string): Promise<string | void> {
    const sock = this.sock
    if (sock === undefined) throw new Error("whatsapp not connected")
    const sent = await withDeadline(sock.sendMessage(chatID, { image, caption }), "whatsapp image send")
    const id = sent?.key?.id
    if (typeof id === "string") this.rememberSent(id)
    return id ?? undefined
  }

  /** Records a message this relay sent, in memory and (when given) durably across restarts. */
  private rememberSent(id: string): void {
    remember(this.sentIDs, id)
    // only the recording matters here: first() returns whether the key was new
    this.options.dedupe?.first(`whatsapp:sent:${id}`).catch(() => undefined)
  }

  /** True for a message ID this relay produced: its echo is not user input. */
  private wasSent(id: string): boolean {
    return this.sentIDs.has(id) || this.options.dedupe?.has(`whatsapp:sent:${id}`) === true
  }

  /** The chat the relay writes to: the self-chat, or the configured target. */
  private isOwnChat(chatID: string): boolean {
    const normalized = jidNormalizedUser(chatID)
    // self-chat may be addressed by phone-number JID or by LID; both are the same conversation
    if (this.options.selfChat) return this.ownJIDs.has(normalized)
    return this.options.target !== undefined && jidNormalizedUser(this.options.target) === normalized
  }

  private async connect(): Promise<void> {
    try {
      const { sock, saveCreds } = await authSocket(this.options.authDir, this.options.log)
      this.saveCreds = saveCreds
      this.sock = sock
      // explicit: creds.update is the only chance to persist new signal keys
      sock.ev.on("creds.update", () => void saveCreds())
      sock.ev.on("connection.update", (update) => this.onConnectionUpdate(update))
      sock.ev.on("messages.upsert", ({ messages, type }) => {
        if (type !== "notify") return
        for (const message of messages) void this.onMessage(message)
      })
    } catch (error) {
      this.options.log.error({ error }, "whatsapp connect failed")
      this.scheduleReconnect()
    }
  }

  private onConnectionUpdate(update: Partial<{ connection: string; qr: string; lastDisconnect: unknown }>): void {
    if (typeof update.qr === "string") {
      // rc14 removed printQRInTerminal, so the QR is rendered here from the event payload
      this.options.log.info("whatsapp: scan this QR with WhatsApp > Linked devices")
      qrcode.generate(update.qr, { small: true })
    }
    if (update.connection === "open") {
      this.attempt = 0
      const user = this.sock?.user
      this.ownJID = jidNormalizedUser(user?.id)
      // WhatsApp may address the self-chat by phone-number JID or by LID; both are "us"
      this.ownJIDs = new Set(
        [user?.id, user?.lid, user?.phoneNumber]
          .filter((jid): jid is string => typeof jid === "string" && jid !== "")
          .map((jid) => jidNormalizedUser(jid)),
      )
      this.options.log.info("whatsapp connected")
      return
    }
    if (update.connection !== "close") return

    const statusCode = (update.lastDisconnect as { error?: { output?: { statusCode?: number } } } | undefined)?.error
      ?.output?.statusCode
    this.sock = undefined
    this.ownJID = undefined
    this.ownJIDs = new Set()
    if (statusCode === DisconnectReason.loggedOut) {
      this.stopped = true
      this.options.log.error("whatsapp logged out: delete auth-state/whatsapp and scan the QR again")
      return
    }
    this.options.log.warn({ statusCode }, "whatsapp connection closed")
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    const maxAttempts = this.options.maxAttempts ?? 10
    if (this.attempt >= maxAttempts) {
      this.options.log.error({ attempts: this.attempt }, "whatsapp giving up on reconnecting")
      return
    }
    const delayMs = reconnectDelayMs(this.attempt, this.options.baseDelayMs, this.options.maxDelayMs)
    this.attempt++
    this.options.log.warn({ delayMs, attempt: this.attempt }, "whatsapp reconnect scheduled")
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.connect()
    }, delayMs)
    // the plugin host owns the lifecycle, so a pending reconnect must not hold the process open
    this.timer.unref?.()
  }

  private async onMessage(message: WAMessage): Promise<void> {
    const text = textOf(message)
    const id = message.key.id
    const chatID = message.key.remoteJid
    if (text === undefined || typeof id !== "string" || typeof chatID !== "string") return
    if (!remember(this.received, id)) return
    // the echo of our own send carries fromMe too: identity, not the flag, decides
    if (this.wasSent(id)) return

    const ownChat = this.isOwnChat(chatID)
    // fromMe outside our own chat is another linked device, not this relay's conversation
    if (message.key.fromMe === true && !ownChat) return

    // in our own chat the sender is us and re-addressed to the outbound JID, so a keyed
    // correlation entry (recorded against that JID) still matches when WhatsApp reports a LID
    const senderID = ownChat ? undefined : jidNormalizedUser(message.key.participant ?? chatID)
    if (senderID !== undefined && this.options.allowSender?.(senderID) === false) {
      this.options.log.warn("whatsapp inbound rejected: sender is not paired")
      return
    }

    const replyTo = ownChat ? (this.outbound ?? jidNormalizedUser(chatID)) : chatID
    const identity = senderID ?? replyTo
    const quoted = quotedOf(message)
    const inbound: InboundMessage = {
      id,
      chatID: identity,
      senderID: identity,
      text,
      selfChat: ownChat,
      ...(quoted === undefined ? {} : { quotedID: quoted }),
    }
    try {
      const reply = await this.options.onInbound?.(inbound)
      if (typeof reply === "string" && reply !== "") await this.sendText(replyTo, reply)
    } catch (error) {
      this.options.log.error({ error }, "whatsapp inbound handling failed")
    }
  }
}

function textOf(message: WAMessage): string | undefined {
  const content = message.message
  if (content === null || content === undefined) return undefined
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    undefined
  )
}

/** The quoted message's stanza id: a reply to a prompt anchors the answer to that prompt. */
function quotedOf(message: WAMessage): string | undefined {
  const content = message.message
  const id =
    content?.extendedTextMessage?.contextInfo?.stanzaId ??
    content?.imageMessage?.contextInfo?.stanzaId ??
    content?.videoMessage?.contextInfo?.stanzaId
  return typeof id === "string" && id !== "" ? id : undefined
}
