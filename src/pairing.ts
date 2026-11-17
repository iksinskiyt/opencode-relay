import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import pino from "pino"
import qrcode from "qrcode-terminal"
import { addToAllowlist, type Config, loadConfig, setDiscordTarget, updateConfig } from "./config.js"
import { discordToken } from "./env.js"
import type { CorrelationStore } from "./interactions/correlation.js"
import { LINKED_TEXT, linkDiscord } from "./providers/discord.js"
import type { PairingSocket } from "./providers/whatsapp.js"
import { NETWORK_TIMEOUT_MS } from "./timeout.js"

/**
 * Last resort only: `opencode serve` picks an ephemeral port and records it in the service file, so
 * these are guesses. 4096 is a conventional local port; 28894 is what this project's host happened
 * to pick. The registration file, when present, is tried first.
 */
const PROBE_PORTS = [4096, 28894]
const PROBE_TIMEOUT_MS = 1_000
const MISSING_SERVER =
  "no local OpenCode server found: start `opencode serve` so it registers its URL, or set OPENCODE_SERVER_URL to that URL in the plugin's environment"
const PROVIDER_KEY = "provider"
const NUMBER_KEY = "number"
const TARGET_KEY = "target"
const DISCORD_ID_KEY = "id"
const MANUAL_NEXT =
  'whatsapp: linked, but config.json could not be updated\nset provider to "whatsapp" in config.json by hand, then restart OpenCode'
const MANUAL_DISCORD =
  'set discord.enabled true, discord.target ("channel" or "dm"), then discord.channelID or discord.dmUserID'
const LINKED_NEXT = "whatsapp: linked - provider flipped to whatsapp automatically, restart OpenCode to go live"
const RESTART_NEXT = "whatsapp: linked - restart OpenCode so the relay connects with the new credentials"
/** Appended to a link notice: the number the link proved is what a fail-closed allowlist needs. */
const allowlisted = (number: string | undefined): string =>
  number === undefined ? "" : `\nallowlisted ${number} in security.allowlist, so this chat can command the relay`
const STARTED_NEXT =
  "whatsapp: pairing started but not completed - the phone never finished the link; enter the fresh code fast"
const NOT_COMPLETED_NEXT =
  "whatsapp: phone has not completed the link yet - enter the code on the phone, then re-run /relay pair whatsapp"

export const PAIR_USAGE = "usage: /relay pair [whatsapp|discord]"
const DISCORD_API = "https://discord.com/api/v10"
/** View Channels (1024) + Send Messages (2048) + Attach Files (32768) + Read Message History (65536). */
const MINIMAL_PERMISSIONS = "101376"
const PAIR_STEPS = [
  "1. On your phone: WhatsApp > Linked devices > Link with code",
  "2. Type the code shown above",
  "the code expires within minutes; run /relay pair whatsapp again for a new one",
]
const log = pino({ name: "opencode-relay" })

/** `/relay pair` reads: where creds live, the Discord token, and the live WhatsApp socket. */
export interface PairingDeps {
  /** Auth-state root, as the provider sees it; defaults to `auth-state` next to config.json. */
  dataDir?: string
  /** Environment for the Discord token check; defaults to process.env, then HKCU\Environment. */
  env?: Record<string, string | undefined>
  /** Asks the running WhatsApp socket for a code; absent when no socket is up. */
  whatsappCode?: (phoneNumber: string) => Promise<string>
  /** Logs the WhatsApp device out server-side for `/relay unpair`; absent without a live socket. */
  whatsappLogout?: () => Promise<void>
  /** Registers the Discord slash commands after a target is linked; absent without a relay running. */
  onDiscordLinked?: () => Promise<void>
  /** Opens a socket just for pairing when the provider has none; defaults to Baileys. */
  openPairingSocket?: (authDir: string) => Promise<PairingSocket>
  /** The after-link config flip; tests swap it for one that fails. */
  flipProvider?: (configPath: string) => Promise<boolean>
  /** Where a failed flip reports the manual fallback; absent when only returned text is available. */
  notify?: (text: string) => void | Promise<void>
}

/** The token both pair paths read: injected env in tests, process env then the registry in the host. */
function pairingToken(deps: { pairing?: PairingDeps }): string | undefined {
  const env = deps.pairing?.env
  return discordToken(env === undefined ? {} : { env }).value
}

/** What the text path of `/relay pair` reads. */
export interface PairTextDeps {
  configPath: string
  pairing?: PairingDeps
}

/** Base URL and fetch override shared by the form HTTP calls. */
export interface ServerDeps {
  serverURL?: string
  fetchImpl?: typeof fetch
  /** Environment for discovery; defaults to process.env. */
  env?: Record<string, string | undefined>
}

/** A reachable local server and the auth its registration file declares. */
export interface ServerEndpoint {
  url: string
  headers: Record<string, string>
}

/** Where the interactive pair form goes. */
export interface PairFormDeps extends ServerDeps {
  store: CorrelationStore
  /** Session whose TUI shows the popup. */
  sessionID: string
}

export type FormValue = string | number | boolean | readonly string[]

/** One field of a form we create; the TUI renders `options` as a picker. */
interface FormField {
  key: string
  title: string
  type: "string"
  required?: boolean
  placeholder?: string
  options?: ReadonlyArray<{ value: string; label: string }>
}

/** The notice a form answer produces; same shape as a command reply. */
export interface PairNotice {
  sessionID: string
  text: string
  description: string
}

export interface PairReplyDeps extends PairTextDeps, ServerDeps {
  store: CorrelationStore
  notice: (message: PairNotice) => Promise<void>
}

/** The text `/relay pair` answers with, shared by the chat command and transport inbound. */
export async function pairText(args: readonly string[], deps: PairTextDeps): Promise<string> {
  const state = await whatsappState(deps)
  const { config, dir: whatsappDir, link } = state
  const token = pairingToken(deps)
  const dm = config.discord.target === "dm"
  const id = dm ? config.discord.dmUserID : config.discord.channelID
  const discord = `discord: token ${token ? "set" : "missing"}, ${dm ? "dm user" : "channel"} ${id ? "set" : "missing"}`
  const status =
    link === "linked" ? `paired (${whatsappDir})` : link === "started" ? "pairing started but not completed" : "not paired"
  const whatsapp = `whatsapp: ${status}`

  const name = args[0]?.toLowerCase()
  if (name === undefined) return [whatsapp, discord, PAIR_USAGE].join("\n")
  if (name === "discord") {
    if (token !== undefined && id !== undefined && id !== "") {
      // an existing DM target is a user ID: heal an empty allowlist on the spot, not only on a new pair
      const allowlist = dm ? await allowDiscordUser(deps.configPath, id) : ""
      return `${discord} - nothing to do, the bot is connected to that ${dm ? "DM" : "channel"}${allowlist}`
    }
    return [
      discord,
      "1. Put the bot token in the environment as DISCORD_BOT_TOKEN (never in config.json)",
      "2. Run /relay pair and pick Discord: the form asks channel vs DM, then the ID, and checks it live",
      `   by hand: ${MANUAL_DISCORD}`,
      "3. Restart OpenCode; the token itself is never echoed here",
    ].join("\n")
  }
  if (name !== "whatsapp") return PAIR_USAGE
  if (link === "linked") {
    // creds from an earlier link can exist without the flip (the pairing socket closed on 515):
    // the missing provider switch is the only thing left to finish
    if (config.provider === "whatsapp") {
      // a link that never wrote its own allowlist entry heals here instead of locking the chat out
      const number = await allowWhatsAppNumber(deps.configPath, whatsappDir)
      return `whatsapp: already paired (${whatsappDir})\nto re-pair: stop OpenCode, delete that folder, then run /relay pair whatsapp again${allowlisted(number)}`
    }
    const flipped = await (deps.pairing?.flipProvider ?? flipProvider)(deps.configPath)
    return flipped ? `${LINKED_NEXT}${allowlisted(await allowWhatsAppNumber(deps.configPath, whatsappDir))}` : MANUAL_NEXT
  }
  const phone = (config.whatsapp.target ?? "").replace(/\D/g, "")
  if (phone === "") {
    return [
      whatsapp,
      'set whatsapp.target in config.json to your international number, digits only (e.g. "491234567890"), then run /relay pair whatsapp again',
    ].join("\n")
  }
  const code = await numberCode(phone, deps, state)
  return link === "started" ? `${STARTED_NEXT}\n${code}` : code
}

/**
 * `/relay invite`: the bot's install URL. The token authenticates the app-id lookup and never reaches
 * the URL or the text; a DM Discord refuses for lack of a shared guild (50278) is what it fixes.
 */
export async function discordInvite(deps: PairTextDeps & { fetchImpl?: typeof fetch }): Promise<string> {
  const token = pairingToken(deps)
  if (token === undefined) return "discord: no bot token - set DISCORD_BOT_TOKEN, then run /relay invite again"
  const config = await loadConfig(deps.configPath)
  const permissions = config.discord.permissions || MINIMAL_PERMISSIONS
  if (!/^\d+$/.test(permissions)) {
    return `discord: discord.permissions in config.json must be the digits of the permission integer, got "${permissions}"`
  }
  try {
    // the bot user's own id is the client_id the install URL takes; the token authenticates only
    const response = await (deps.fetchImpl ?? fetch)(`${DISCORD_API}/users/@me`, {
      headers: { authorization: `Bot ${token}` },
    })
    if (!response.ok) return `discord: invite unavailable - the bot token was rejected (${response.status})`
    const body = (await response.json().catch(() => ({}))) as { id?: unknown }
    if (typeof body.id !== "string" || body.id === "") {
      return "discord: invite unavailable - Discord's /users/@me answer carries no id"
    }
    const scope = "bot+applications.commands"
    return [
      `invite the bot: https://discord.com/oauth2/authorize?client_id=${body.id}&permissions=${permissions}&scope=${scope}`,
      "open the link, pick the server, authorize - the bot then shares a guild with you, so its DMs land",
      `portal instead: OAuth2 > URL Generator, tick bot + applications.commands and the same permission boxes (${permissions})`,
    ].join("\n")
  } catch (error) {
    return `discord: invite unavailable - ${(error as Error).message}`
  }
}

/**
 * The next step for a provider the user picked. A present token with no target is the normal first
 * pair, so it opens the channel-vs-DM form; the plain steps stay for callers that cannot show one.
 * Returns the text to show, or undefined when a form is now the step the user answers.
 */
export async function pairChoice(
  choice: "whatsapp" | "discord",
  sessionID: string,
  deps: PairReplyDeps,
): Promise<string | undefined> {
  const state = await whatsappState(deps)
  if (choice === "discord") {
    // no token means no live check, and a linked target has nothing left to do: text either way
    if (pairingToken(deps) === undefined || discordReady(state.config)) return pairText([choice], deps)
    await createForm(
      { store: deps.store, sessionID, ...serverOf(deps) },
      "Discord target",
      [
        {
          key: TARGET_KEY,
          title: "Where should the relay talk?",
          type: "string",
          required: true,
          options: [
            { value: "channel", label: "A server channel" },
            { value: "dm", label: "A DM with me" },
          ],
        },
      ],
      "discord-target",
    )
    return undefined
  }
  if (state.link !== "linked" && (state.config.whatsapp.target ?? "").replace(/\D/g, "") === "") {
    await createForm(
      { store: deps.store, sessionID, ...serverOf(deps) },
      "WhatsApp number",
      [
        {
          key: NUMBER_KEY,
          title: "International number, digits only",
          type: "string",
          required: true,
          placeholder: "491234567890",
        },
      ],
      "number",
    )
    return undefined
  }
  return pairText([choice], deps)
}

/** Opens the provider picker in the TUI and records the form so its reply resolves. */
export async function createPairForm(deps: PairFormDeps): Promise<string> {
  await createForm(
    deps,
    "Pair a provider",
    [
      {
        key: PROVIDER_KEY,
        title: "Provider",
        type: "string",
        required: true,
        options: [
          { value: "whatsapp", label: "WhatsApp" },
          { value: "discord", label: "Discord" },
        ],
      },
    ],
    "provider",
  )
  return "pair: choose a provider in the form"
}

/**
 * A `form.replied` event for one of our pair forms: asks for the number, or posts the code/steps
 * into the session. Returns false when the form is not a live pair form.
 */
export async function handlePairReply(
  reply: { id: string; sessionID: string; answer: Readonly<Record<string, FormValue>> },
  deps: PairReplyDeps,
): Promise<boolean> {
  const record = deps.store.get(reply.id)
  if (record === undefined || record.type !== "pairing" || record.status !== "pending") return false
  const say = async (text: string): Promise<void> => {
    await deps.notice({ sessionID: reply.sessionID, text, description: text })
  }

  if (record.pair === "number") {
    const phone = String(reply.answer[NUMBER_KEY] ?? "").replace(/\D/g, "")
    const text =
      phone === "" ? PAIR_USAGE : await numberCode(phone, withNotify(deps, reply.sessionID), await whatsappState(deps))
    await say(text)
  } else if (record.pair === "discord-target") {
    const choice = reply.answer[TARGET_KEY]
    if (choice === "channel" || choice === "dm") {
      await createForm(
        { store: deps.store, sessionID: reply.sessionID, ...serverOf(deps) },
        choice === "dm" ? "Discord user ID" : "Discord channel ID",
        [
          {
            key: DISCORD_ID_KEY,
            title: choice === "dm" ? "Your Discord user ID" : "Channel ID",
            type: "string",
            required: true,
            placeholder: "123456789012345678",
          },
        ],
        choice === "dm" ? "discord-dm" : "discord-channel",
      )
    } else {
      await say(`discord: no target picked - run /relay pair again`)
    }
  } else if (record.pair === "discord-channel" || record.pair === "discord-dm") {
    await linkDiscordReply(record.pair === "discord-dm" ? "dm" : "channel", reply.answer, deps, say)
  } else {
    const choice = reply.answer[PROVIDER_KEY]
    if (choice !== "whatsapp" && choice !== "discord") {
      await say(PAIR_USAGE)
    } else {
      const text = await pairChoice(choice, reply.sessionID, withNotify(deps, reply.sessionID))
      if (text !== undefined) await say(text)
    }
  }
  await deps.store.complete(record.messageID)
  return true
}

/** A configured discord needs the id its target mode uses; the token is checked separately. */
function discordReady(config: Config): boolean {
  const id = config.discord.target === "dm" ? config.discord.dmUserID : config.discord.channelID
  return id !== undefined && id !== ""
}

/**
 * The id the user typed: check it against Discord, post the proof notice, then persist the pick.
 * A failure shows Discord's own error text; the token is never in a response body.
 */
async function linkDiscordReply(
  target: "channel" | "dm",
  answer: Readonly<Record<string, FormValue>>,
  deps: PairReplyDeps,
  say: (text: string) => Promise<void>,
): Promise<void> {
  const id = String(answer[DISCORD_ID_KEY] ?? "").trim()
  const kind = target === "dm" ? "user" : "channel"
  if (id === "") {
    await say(`discord: no ${kind} ID given - run /relay pair again`)
    return
  }
  const token = pairingToken(deps) ?? ""
  try {
    await linkDiscord(target === "dm" ? { dmUserID: id } : { channelID: id }, token, deps.fetchImpl ?? fetch)
  } catch (error) {
    // validation failed, so the by-hand config is the fallback, not the first answer
    const message = (error as Error).message
    // 50278: no shared guild, so Discord refuses the DM - the install URL is the way out
    const hint = message.includes("50278")
      ? `\n${await discordInvite(deps)}`
      : `\nby hand: ${MANUAL_DISCORD}`
    await say(`discord: not linked - ${message}${hint}`)
    return
  }
  try {
    await setDiscordTarget(deps.configPath, target, id)
  } catch (error) {
    await say(
      `discord: linked, but config.json could not be updated (${(error as Error).message}); set discord.target "${target}" and the ${kind} ID by hand`,
    )
    return
  }
  // a DM target is a user ID: the one Discord identity that can be allowlisted from a pair
  const allowlist =
    target === "dm"
      ? await allowDiscordUser(deps.configPath, id)
      : "\nallowlist: a channel pair proves no user ID - add your Discord user ID to security.allowlist by hand"
  await say(`discord: linked - posted "${LINKED_TEXT}"; restart OpenCode to go live${allowlist}`)
  // the gateway registers on connect; a pair done while polling needs the commands now
  try {
    await deps.pairing?.onDiscordLinked?.()
  } catch (error) {
    log.warn({ error }, "discord command registration after pairing failed")
  }
}

/**
 * The local OpenCode server the form endpoints live on. The plugin Context exposes no URL, so:
 * explicit dep -> OPENCODE_SERVER_URL -> the registration file a local `opencode serve` writes at
 * `<state>/opencode/service.json` (ephemeral URL + password) -> a bounded probe of the usual ports.
 * The registration's Basic auth is carried onto the override and the probe too: a server that
 * requires it would reject both otherwise.
 */
export async function serverEndpoint(deps: ServerDeps): Promise<ServerEndpoint> {
  const env = deps.env ?? process.env
  // parse only, no network: the password is needed even when another URL is used
  const registration = await registered(env)
  const auth = registration?.headers ?? {}
  if (deps.serverURL !== undefined) return { url: deps.serverURL, headers: localAuth(deps.serverURL, auth) }
  const override = env.OPENCODE_SERVER_URL
  if (override !== undefined && override !== "") return { url: override, headers: localAuth(override, auth) }
  if (registration !== undefined && (await alive(registration, deps))) return registration
  const found = await probe(deps, auth)
  if (found === undefined) throw new Error(MISSING_SERVER)
  return found
}

/** The registration password is local; never send it to a host the override points at remotely. */
function localAuth(url: string, auth: Record<string, string>): Record<string, string> {
  try {
    const { hostname } = new URL(url)
    return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost" ? auth : {}
  } catch {
    return {}
  }
}

/** The registration file a service-shaped `opencode serve` writes; read, not required. */
function serviceFile(env: Record<string, string | undefined>): string {
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode", "service.json")
}

async function registered(env: Record<string, string | undefined>): Promise<ServerEndpoint | undefined> {
  let info: { url?: unknown; password?: unknown }
  try {
    info = JSON.parse(readFileSync(serviceFile(env), "utf8")) as { url?: unknown; password?: unknown }
  } catch {
    return undefined
  }
  if (typeof info.url !== "string" || info.url === "") return undefined
  const headers =
    typeof info.password === "string" && info.password !== ""
      ? { authorization: `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}` }
      : {}
  return { url: info.url.replace(/\/+$/, ""), headers }
}

/** `/api/info` answers on any live server, so one cheap request tells live from stale. */
async function alive(endpoint: ServerEndpoint, deps: ServerDeps): Promise<boolean> {
  try {
    const response = await (deps.fetchImpl ?? fetch)(`${endpoint.url}/api/info`, {
      headers: endpoint.headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return response.ok
  } catch {
    return false
  }
}

/** Bounded: two ports, one second each, in parallel; the first port that answers wins. */
async function probe(deps: ServerDeps, auth: Record<string, string> = {}): Promise<ServerEndpoint | undefined> {
  const candidates: ServerEndpoint[] = PROBE_PORTS.map((port) => ({
    url: `http://127.0.0.1:${port}`,
    headers: auth,
  }))
  const live = await Promise.all(candidates.map(async (candidate) => ((await alive(candidate, deps)) ? candidate : undefined)))
  return live.find((endpoint) => endpoint !== undefined)
}

/** A non-2xx answer from the local server; the status lets a caller tell "gone" from "wrong". */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function request<T>(
  server: ServerEndpoint,
  path: string,
  init: RequestInit,
  deps: ServerDeps,
): Promise<T> {
  const url = `${server.url}${path}`
  const response = await (deps.fetchImpl ?? fetch)(url, {
    ...init,
    // the same deadline as the rest of the relay: a form answer may not hang a chat reply
    signal: init.signal ?? AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    headers: { "content-type": "application/json", ...server.headers },
  })
  if (!response.ok) throw new HttpError(response.status, `${init.method ?? "GET"} ${url} failed: ${response.status}`)
  return (response.status === 204 ? undefined : await response.json()) as T
}

interface WhatsAppState {
  config: Config
  dir: string
  link: LinkState
}

/** What creds.json proves: nothing, a started pairing, or a device WhatsApp registered. */
export type LinkState = "none" | "started" | "linked"

async function whatsappState(deps: PairTextDeps): Promise<WhatsAppState> {
  const config = await loadConfig(deps.configPath)
  const root = deps.pairing?.dataDir ?? join(dirname(deps.configPath), "auth-state")
  const dir = join(root, "whatsapp")
  return { config, dir, link: linkState(dir) }
}

/**
 * A creds file also exists after a started-but-unfinished link. Baileys writes `me` as soon as the
 * number is known and flips `registered` only when WhatsApp confirms the device, so `me` without
 * `registered` means the phone never finished; treating it as paired is a false positive.
 */
export function linkState(dir: string): LinkState {
  const { id, registered } = credentials(dir)
  if (id === undefined) return "none"
  return registered ? "linked" : "started"
}

/** `me.id` and `registered` from creds.json; a missing or corrupt file proves nothing. */
function credentials(dir: string): { id?: string; registered: boolean } {
  try {
    // the file is the creds object itself: useMultiFileAuthState writes JSON.stringify(creds)
    const creds = JSON.parse(readFileSync(join(dir, "creds.json"), "utf8")) as {
      me?: { id?: unknown }
      registered?: unknown
    }
    const id = typeof creds.me?.id === "string" && creds.me.id !== "" ? creds.me.id : undefined
    return { ...(id === undefined ? {} : { id }), registered: creds.registered === true }
  } catch {
    return { registered: false }
  }
}

/** Our own bare number from creds.json: the identity a completed link proved. */
export function ownNumber(dir: string): string | undefined {
  const { id } = credentials(dir)
  return id === undefined ? undefined : (id.split("@")[0]?.split(":")[0] ?? id)
}

/**
 * Adds the number a link proved to the allowlist and returns it for the notice. A write failure is
 * reported, never thrown: the link itself is done, and the allowlist stays editable by hand.
 */
async function allowWhatsAppNumber(configPath: string, dir: string): Promise<string | undefined> {
  const number = ownNumber(dir)
  if (number === undefined) return undefined
  try {
    await addToAllowlist(configPath, number)
  } catch (error) {
    log.warn({ error }, "whatsapp linked but the allowlist could not be updated")
  }
  return number
}

/** The notice line for a Discord allowlist entry; a failed write says the manual step instead. */
async function allowDiscordUser(configPath: string, userID: string): Promise<string> {
  try {
    await addToAllowlist(configPath, userID)
    return `\nallowlisted ${userID} in security.allowlist, so you can command the relay`
  } catch (error) {
    log.warn({ error }, "discord linked but the allowlist could not be updated")
    return "\nallowlist not updated: add your Discord user ID to security.allowlist by hand"
  }
}

/**
 * Asks for a pairing code. A live provider socket is preferred; when there is none (the transport is
 * disabled or its socket is down) a transient socket pairs and keeps the creds it saves.
 */
async function numberCode(phone: string, deps: PairTextDeps, state: WhatsAppState): Promise<string> {
  const live = deps.pairing?.whatsappCode
  if (live !== undefined) {
    try {
      return codeNotice(await live(phone), false)
    } catch {
      // no provider socket after all: the transient one below is the only path left
    }
  }
  let reason = "unknown"
  // two attempts: a socket that closed before the code was asked for (e.g. 428) deserves one retry
  for (let attempt = 0; attempt < 2; attempt++) {
    let sock: PairingSocket | undefined
    try {
      sock = await open(deps)(state.dir)
      const socket = sock
      const code = await socket.requestPairingCode(phone)
      // the phone finishes the link on this socket, so it must outlive the notice
      void socket
        .waitForLink()
        .then(async (linked) => {
          // a real link usually arrives as a 515 close (restart required), not an open event, so
          // the creds on disk decide; close() first so their write has landed
          await socket.close()
          // an open/wait flag alone is not a link: re-read, because unregistered creds mean the
          // phone started pairing and never finished, and a flip there would strand the config
          if (linkState(state.dir) !== "linked") {
            if (linked) await deps.pairing?.notify?.(NOT_COMPLETED_NEXT)
            return
          }
          // always rewrite: an earlier `/relay unpair` leaves whatsapp.enabled false, and the
          // provider flag alone would not turn the transport back on
          const already = state.config.provider === "whatsapp"
          if (!(await (deps.pairing?.flipProvider ?? flipProvider)(deps.configPath))) {
            await deps.pairing?.notify?.(MANUAL_NEXT)
            return
          }
          const number = await allowWhatsAppNumber(deps.configPath, state.dir)
          await deps.pairing?.notify?.(`${already ? RESTART_NEXT : LINKED_NEXT}${allowlisted(number)}`)
        })
        .catch(() => void socket.close())
      return codeNotice(code, true, socket.qr())
    } catch (error) {
      await sock?.close()
      reason = error instanceof Error ? error.message : String(error)
      // paired by name: importing the error class would pull Baileys into this module's graph
      if ((error as Error | undefined)?.name !== "PairingUnavailableError") break
    }
  }
  // creds that already hold a linked device make every attempt take the login path, which
  // WhatsApp terminates: only a clean auth dir can pair again
  const next =
    state.link === "linked"
      ? "auth-state/whatsapp already holds a linked device; delete that folder, then run /relay pair whatsapp again"
      : state.link === "started"
        ? "auth-state/whatsapp holds a pairing that never completed; delete that folder, then run /relay pair whatsapp again"
        : "check the connection, then run /relay pair whatsapp again"
  const status = state.link === "started" ? "pairing started but not completed" : "not paired"
  return `whatsapp: ${status}\npairing failed: ${reason}\n${next}`
}

/** Makes whatsapp the provider after our link; false when config.json cannot be written. */
export async function flipProvider(configPath: string): Promise<boolean> {
  try {
    await updateConfig(configPath, (config) => {
      config.provider = "whatsapp"
      config.whatsapp = { ...config.whatsapp, enabled: true }
    })
    return true
  } catch (error) {
    log.error({ error }, "whatsapp linked but config.json could not be updated")
    return false
  }
}

/** The form path can post a follow-up; the plain chat path only gets the returned text. */
function withNotify(deps: PairReplyDeps, sessionID: string): PairReplyDeps {
  return {
    ...deps,
    pairing: {
      ...deps.pairing,
      notify: (text) => deps.notice({ sessionID, text, description: text }),
    },
  }
}

function codeNotice(code: string, transient: boolean, qr?: string): string {
  // link instructions only: the go-live step comes with the linked notice, after the phone links
  const next = !transient
    ? "next: enter the code on the phone; the running relay picks the link up on the same socket"
    : "next: enter the code on the phone; the relay flips the provider to whatsapp once the phone finishes linking"
  const lines = [`whatsapp pairing code: ${code}`, ...PAIR_STEPS, next]
  // best effort: only the registration handshake offers a QR, the code-entry path never does
  if (qr !== undefined) lines.push("or scan these blocks with the phone camera (best effort):", qrText(qr))
  return lines.join("\n")
}

/** The QR as block characters, so it survives a text-only notice. */
function qrText(data: string): string {
  let blocks = ""
  qrcode.generate(data, { small: true }, (text) => {
    blocks = text
  })
  return blocks
}

/** The real socket is loaded only when a transient one is actually needed. */
function open(deps: PairTextDeps): (authDir: string) => Promise<PairingSocket> {
  return (
    deps.pairing?.openPairingSocket ??
    (async (authDir) => {
      const { openPairingSocket } = await import("./providers/whatsapp.js")
      return openPairingSocket(authDir, log)
    })
  )
}

/** POSTs a form to the local server and records it as the live pair step. */
async function createForm(
  deps: PairFormDeps,
  title: string,
  fields: FormField[],
  stage: "provider" | "number" | "discord-target" | "discord-channel" | "discord-dm",
): Promise<void> {
  const server = await serverEndpoint(deps)
  const created = await request<{ data?: { id?: string } }>(
    server,
    `/api/session/${encodeURIComponent(deps.sessionID)}/form`,
    { method: "POST", body: JSON.stringify({ title, fields }) },
    deps,
  )
  const formID = created.data?.id
  if (formID === undefined) throw new Error("form creation returned no id")
  await deps.store.add({
    provider: "",
    externalUserID: "",
    chatID: "",
    messageID: formID,
    sessionID: deps.sessionID,
    type: "pairing",
    formID,
    pair: stage,
  })
}

function serverOf(deps: PairReplyDeps): ServerDeps {
  return {
    ...(deps.serverURL === undefined ? {} : { serverURL: deps.serverURL }),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(deps.pairing?.env === undefined ? {} : { env: deps.pairing.env }),
  }
}
