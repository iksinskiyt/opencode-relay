import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { modelSettings, setModel, type ModelRef } from "../ai.js"
import { clearDiscordTarget, disableWhatsapp } from "../config.js"
import { CATEGORIES, type Category, type InboundMessage, type TransportStatus } from "../envelope.js"
import {
  createPairForm,
  discordInvite,
  HttpError,
  linkState,
  PAIR_USAGE,
  pairChoice,
  pairText,
  request,
  serverEndpoint,
  type PairingDeps,
} from "../pairing.js"
import { identity } from "../notify.js"
import { getPreferences, setCategory, setMode, setPreset } from "../preferences.js"
import { DISCORD_STATE_FILE } from "../providers/discord.js"
import { loadListing, loadSelected, saveListing, saveSelected } from "../selection.js"
import type { CorrelationStore, PendingInteraction } from "./correlation.js"

export type { PairingDeps }

const USAGE =
  "commands: /relay status | /relay sessions | /relay select <number|sessionID> | /relay notifications [category on|off] [mode immediate|batch|final_only] [preset all|important|completion] | /relay model [providerID modelID] | /relay pair [whatsapp|discord] | /relay unpair [whatsapp|discord] | /relay invite [discord] | /relay group | /relay send <path> [caption] | /relay help"

/** Models listed by `/relay model` before it stops, so the answer stays one readable message. */
const MODEL_LINES = 25

/** Longest forwarded prompt; a pasted wall of text must not become a model request. */
const PROMPT_LIMIT = 2_000

export type Decision = "once" | "always" | "reject"

/** A form field as `GET /api/session/:id/form/:formID` reports it (see @opencode/schema Form). */
interface FormField {
  readonly key?: string
  readonly title?: string
  readonly type?: string
  readonly hidden?: boolean
  readonly required?: boolean
  readonly options?: ReadonlyArray<{ readonly value?: string; readonly label?: string }>
}

/** One answer value, the shape `session.form.reply` accepts. */
type FormValue = string | number | boolean | string[]

export interface SessionInfo {
  readonly id?: string | undefined
  readonly title?: string | undefined
}

/** What `/relay group` produced: the group JID outbound now goes to. */
export interface GroupResult {
  readonly jid: string
  readonly created: boolean
  readonly subject: string
}

export interface InboundDeps extends RelayCommandDeps {
  store: CorrelationStore
  /** Permission replies from the plugin host (`ctx.permission.reply`). */
  replyPermission?: (input: { sessionID: string; requestID: string; decision: Decision }) => Promise<void>
}

/** What the `/relay` commands read; the chat command has no store and no fetch. */
export interface RelayCommandDeps {
  /** Transport name stored on the pending prompt, e.g. "whatsapp". */
  provider: string
  /** Every configured transport, reported by `/relay status`. */
  transports?: readonly TransportStatus[]
  /** config.json, for /relay notifications. */
  configPath: string
  /** Session picked with /relay select; mirrored to auth-state/selected.json so both hosts share it. */
  selected: { sessionID?: string }
  /** Recent sessions from the plugin host (`ctx.session.list`). */
  sessions?: () => Promise<SessionInfo[]>
  /** Models from the plugin host (`ctx.model.list`), for `/relay model`. */
  models?: () => Promise<ModelRef[]>
  /** Pending pass batches, when the caller has a batcher. */
  pending?: () => { sessions: number; items: number }
  /** In-band pairing state; absent when the caller has no auth directory or socket. */
  pairing?: PairingDeps
  /** Correlation store for the `/relay pair` popup; absent when the caller has none. */
  store?: CorrelationStore
  /** OpenCode server base URL, for form replies and the pair popup. */
  serverURL?: string
  fetchImpl?: typeof fetch
  /** `/relay group`: creates or reuses the transport group and persists it as the target. */
  group?: () => Promise<GroupResult>
  /** `ctx.session.prompt`: forwards a plain inbound message into a session. */
  prompt?: (input: { sessionID: string; text: string }) => Promise<void>
  /** `/relay send`: posts one image to every live transport; absent when the caller has none. */
  image?: (input: { path: string; caption?: string }) => Promise<string>
}

/**
 * Text from the operator (a paired sender or the relay chat): a `/relay` command, the answer to the
 * newest pending prompt, or a prompt for the selected/only active session. Returns the text to send
 * back, or undefined when there is nothing to say.
 *
 * Every answer names the session it concerns on its first line, the way a notification does: a
 * linked device renders all of its own sends on one side, so the text has to say which session it is.
 */
export async function handleInbound(message: InboundMessage, deps: InboundDeps): Promise<string | undefined> {
  const text = message.text.trim()
  const answer = (body: string, sessionID?: string): Promise<string> => withIdentity(body, sessionID, deps)
  if (text.startsWith("/relay")) {
    // the transport path has no caller to catch this: an error still answers instead of going silent
    try {
      return await answer(await relayCommand(text, deps, deps.selected.sessionID), deps.selected.sessionID)
    } catch (error) {
      return await answer(`relay: ${(error as Error).message}`, deps.selected.sessionID)
    }
  }

  // a quoted reply anchors the answer to that prompt, so two pending forms in one chat cannot swap
  const quoted = message.quotedID === undefined ? undefined : deps.store.get(message.quotedID)
  if (quoted !== undefined && quoted.status !== "pending") {
    const id = quoted.formID ?? quoted.permissionID ?? quoted.messageID
    return await answer(`⌛ ${quoted.type} ${id} is already ${quoted.status}; nothing left to answer`, quoted.sessionID)
  }
  const pending = quoted ?? deps.store.resolve(deps.provider, message.senderID, message.chatID)
  if (pending === undefined) {
    const expired = deps.store.lastExpired(deps.provider, message.senderID, message.chatID)
    if (expired !== undefined) {
      const id = expired.formID ?? expired.permissionID ?? expired.messageID
      // never forward an answer that missed its window into the session as a fresh prompt
      return await answer(
        `⌛ ${expired.type} ${id} expired before this reply; ask the agent to raise it again`,
        expired.sessionID,
      )
    }
    return forwardPrompt(text, deps)
  }

  // an event without a session can still be answered once /relay select picked one
  const sessionID = pending.sessionID !== "" ? pending.sessionID : await selectedSession(deps)
  if (sessionID === undefined) {
    const id = pending.formID ?? pending.permissionID ?? pending.messageID
    return await answer(`⚠️ ${pending.type} ${id} has no session: /relay select <sessionID> first`)
  }
  if (pending.type === "form") {
    const outcome = await replyForm(pending, sessionID, text, deps)
    if (outcome.settled) await deps.store.complete(pending.messageID)
    return await answer(outcome.reply, sessionID)
  }
  try {
    await replyPermission(pending, sessionID, text, deps)
  } catch (error) {
    return await answer(
      `⚠️ permission ${pending.permissionID ?? ""} not answered: ${(error as Error).message}`.trim(),
      sessionID,
    )
  }
  await deps.store.complete(pending.messageID)
  return await answer(`✅ permission ${pending.permissionID ?? ""} answered`.trim(), sessionID)
}

/** The identity line in front of an answer, naming the session when the host knows its title. */
async function withIdentity(text: string, sessionID: string | undefined, deps: InboundDeps): Promise<string> {
  return `${identity(await titleOf(sessionID, deps))}\n${text}`
}

async function titleOf(sessionID: string | undefined, deps: InboundDeps): Promise<string | undefined> {
  if (sessionID === undefined || sessionID === "") return undefined
  if (deps.sessions === undefined) return sessionID
  try {
    const title = (await deps.sessions()).find((session) => session.id === sessionID)?.title
    // an untitled session is still named by its id: "which session?" must always have an answer
    return title === undefined || title === "" ? sessionID : title
  } catch {
    return sessionID
  }
}

/**
 * A plain message with nothing pending is a prompt for a session: the selected one, or the only
 * active one. Anything ambiguous gets a question instead of a guess, and a selection the host no
 * longer lists (archived or gone) is never written into.
 */
async function forwardPrompt(text: string, deps: InboundDeps): Promise<string | undefined> {
  if (text === "") return undefined
  const send = deps.prompt
  if (send === undefined) return `${identity()}\ncannot forward: the plugin host exposes no session prompt`
  const active = await activeSessions(deps)
  const selected = await selectedSession(deps)
  const chosen =
    selected === undefined
      ? active.length === 1
        ? active[0]
        : undefined
      : active.find((session) => session.id === selected)
  if (chosen?.id === undefined) return `${identity()}\n${await sessionChoices(active, deps)}`
  const name = chosen.title ?? chosen.id
  // one forward per inbound message: a redelivery never reaches here, the transport dedupes it
  try {
    await send({ sessionID: chosen.id, text: text.slice(0, PROMPT_LIMIT) })
  } catch (error) {
    return `${identity(name)}\ncould not send to '${name}': ${(error as Error).message}`
  }
  return `${identity(name)}\nsent to '${name}'`
}

/** Disk first: `/relay select` in the TUI host must reach the transport host's separate memory. */
async function selectedSession(deps: RelayCommandDeps): Promise<string | undefined> {
  return (await loadSelected(deps.configPath)) ?? deps.selected.sessionID
}

/** Active sessions only: `sessions` maps `ctx.session.list({ archived: false })`. */
async function activeSessions(deps: InboundDeps): Promise<SessionInfo[]> {
  if (deps.sessions === undefined) return []
  try {
    return await deps.sessions()
  } catch {
    return []
  }
}

async function sessionChoices(active: SessionInfo[], deps: InboundDeps): Promise<string> {
  if (active.length === 0) return "no active session to send to: /relay select <number|sessionID>"
  return `which session? reply /relay select <number>\n${await listing(deps, active)}`
}

/** `/relay sessions`: numbers follow the host order (recent first) and are saved for `/relay select`. */
async function listing(deps: RelayCommandDeps, sessions?: SessionInfo[]): Promise<string> {
  const list = sessions ?? (await listSessions(deps))
  if (list.length === 0) return "no sessions"
  await saveListing(deps.configPath, list)
  return list.map((session, index) => `${index + 1}. ${label(session)}`).join("\n")
}

function label(session: SessionInfo): string {
  const id = session.id ?? "?"
  return session.title === undefined || session.title === "" ? id : `${id} — ${session.title}`
}

/** The `/relay` subcommands. Shared by transport inbound and the chat command, so both stay in step. */
export async function relayCommand(text: string, deps: RelayCommandDeps, sessionID?: string): Promise<string> {
  const words = text.trim().split(/\s+/)
  // a chat command arrives with its arguments only; inbound arrives as "/relay ..."
  const [, name, ...args] = words[0] === "/relay" ? words : ["", ...words]
  switch (name) {
    case "help":
      return help(deps)
    case "status": {
      const prefs = await getPreferences(deps.configPath)
      const on = CATEGORIES.filter((category) => prefs.categories[category])
      const lines = [
        `provider: ${deps.provider}`,
        ...(deps.transports ?? []).map(
          (transport) =>
            `${transport.name}: ${transport.state}${transport.reason === undefined ? "" : ` (${transport.reason})`}`,
        ),
        `preset: ${prefs.preset}`,
        `mode: ${prefs.mode}`,
        `on: ${on.join(", ") || "none"}`,
      ]
      if (deps.pending !== undefined) {
        const pending = deps.pending()
        lines.push(`pending batches: ${pending.sessions} (${pending.items} messages)`)
      }
      if (prefs.preset !== "all") lines.push('note: the preset overrides the category list until preset is "all"')
      return lines.join("\n")
    }
    case "sessions":
      return listing(deps)
    case "select": {
      const arg = args[0]
      if (arg === undefined) return "usage: /relay select <number|sessionID>"
      const sessions = await listSessions(deps)
      let id = arg
      if (/^\d+$/.test(arg)) {
        // a number means the last listing both hosts printed; without one, the host's fresh order
        const target = ((await loadListing(deps.configPath)) ?? sessions)[Number(arg) - 1]
        if (target?.id === undefined) {
          return `usage: /relay select <number|sessionID>\n${await listing(deps, sessions)}`
        }
        id = target.id
      }
      deps.selected.sessionID = id
      await saveSelected(deps.configPath, id)
      const title = sessions.find((session) => session.id === id)?.title
      return `selected ${id}${title === undefined || title === "" ? "" : ` — ${title}`}`
    }
    case "notifications":
      return notifications(args, deps)
    case "model":
      return model(args, deps)
    case "pair":
      return pair(args, deps, sessionID)
    case "unpair":
      return unpair(args, deps)
    case "invite":
      return invite(args, deps)
    case "group":
      return group(deps)
    case "send":
      return sendImage(args, deps)
    default:
      return USAGE
  }
}

/**
 * `/relay pair` with no argument opens the provider popup when the caller has a session and store;
 * a provider argument goes through the same next-step routing, so a missing target opens its form
 * instead of printing setup steps. Only a caller without a store keeps the chat-text path.
 */
async function pair(args: string[], deps: RelayCommandDeps, sessionID?: string): Promise<string> {
  const choice = args[0]?.toLowerCase()
  if (deps.store !== undefined && sessionID !== undefined) {
    if (args.length === 0) {
      return createPairForm({
        store: deps.store,
        sessionID,
        ...(deps.serverURL === undefined ? {} : { serverURL: deps.serverURL }),
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
        ...(deps.pairing?.env === undefined ? {} : { env: deps.pairing.env }),
      })
    }
    if (choice === "discord" || choice === "whatsapp") {
      try {
        return (
          (await pairChoice(choice, sessionID, {
            store: deps.store,
            configPath: deps.configPath,
            notice: async () => {},
            ...(deps.pairing === undefined ? {} : { pairing: deps.pairing }),
            ...(deps.serverURL === undefined ? {} : { serverURL: deps.serverURL }),
            ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
          })) ?? "pair: answer the form to continue"
        )
      } catch (error) {
        // no form could be opened: the by-hand steps are the fallback, not the first answer
        return [await pairText(args, deps), `pair form failed: ${(error as Error).message}`].join("\n")
      }
    }
  }
  return pairText(args, deps)
}

const UNPAIR_USAGE = "usage: /relay unpair <whatsapp|discord>"
const INVITE_USAGE = "usage: /relay invite [discord]"
const MOCK_NOTE =
  "no other live transport: notifications stop (envelopes go to the mock sink) until you pair again"

/**
 * `/relay unpair <transport>`: stop that transport and drop its local link state. WhatsApp logs out
 * server-side first (so the phone's Linked devices entry goes too) and deletes its auth dir; Discord
 * has no unlink call for a bot, so its config target is cleared and the DM channel cache deleted.
 * A failed logout still cleans up locally: a credential left behind would reconnect.
 */
async function unpair(args: readonly string[], deps: RelayCommandDeps): Promise<string> {
  const name = args[0]?.toLowerCase()
  if (name !== "whatsapp" && name !== "discord") return UNPAIR_USAGE
  const live = (deps.transports ?? []).filter((transport) => transport.state === "live")
  const warning = live.length === 1 && live[0]?.name === name ? `\n${MOCK_NOTE}` : ""
  const root = deps.pairing?.dataDir ?? join(dirname(deps.configPath), "auth-state")

  if (name === "whatsapp") {
    const dir = join(root, "whatsapp")
    if (linkState(dir) === "none") return "whatsapp: not paired - nothing to unpair"
    const logout = deps.pairing?.whatsappLogout
    let reported = "unpaired locally (no live WhatsApp socket to log out)"
    if (logout !== undefined) {
      try {
        await logout()
        reported = "logged out and unpaired"
      } catch (error) {
        reported = `unpaired locally, but the WhatsApp logout failed (${(error as Error).message}); the phone may still list the device`
      }
    }
    await rm(dir, { recursive: true, force: true })
    await disableWhatsapp(deps.configPath)
    return `whatsapp: ${reported} - auth-state/whatsapp removed; /relay pair whatsapp to link again${warning}`
  }

  const cache = join(root, DISCORD_STATE_FILE)
  const hadCache = existsSync(cache)
  await rm(cache, { force: true })
  await clearDiscordTarget(deps.configPath)
  const cacheNote = hadCache ? "auth-state/discord.json removed" : "no auth-state/discord.json to remove"
  return [
    `discord: unpaired - target, channelID and dmUserID cleared, enabled off, ${cacheNote}`,
    `the bot token stays in DISCORD_BOT_TOKEN; restart OpenCode to stop posting${warning}`,
  ].join("\n")
}

/**
 * `/relay invite [discord]`: the bot's install URL, for the DM Discord refuses with 50278 because the
 * bot shares no guild with the user. Discord is the only transport with one.
 */
async function invite(args: readonly string[], deps: RelayCommandDeps): Promise<string> {
  const name = args[0]?.toLowerCase()
  if (name !== undefined && name !== "discord") return INVITE_USAGE
  return discordInvite(deps)
}

/** `/relay group`: one group, reused by name, so the notification bubbles get a real conversation. */
async function group(deps: RelayCommandDeps): Promise<string> {
  if (deps.group === undefined) return "group layout needs the whatsapp transport"
  try {
    const result = await deps.group()
    const state = result.created ? "created" : "reusing"
    return [
      `${state} group "${result.subject}" (${result.jid}); notifications go there from now on`,
      "the group is a dedicated channel; bubbles still render on your side, a WhatsApp limitation of linked devices",
    ].join("\n")
  } catch (error) {
    return `group layout failed: ${(error as Error).message}`
  }
}

/**
 * `/relay send <path> [caption]`: a Windows screenshot path can hold spaces, so the longest prefix
 * that names an existing file is the path and the rest is the caption.
 */
async function sendImage(args: readonly string[], deps: RelayCommandDeps): Promise<string> {
  if (deps.image === undefined) return "image sending is unavailable in this host"
  if (args.length === 0) return "usage: /relay send <path> [caption]"
  let path = ""
  let last = -1
  for (const [index, word] of args.entries()) {
    path = index === 0 ? word : `${path} ${word}`
    if (existsSync(path)) last = index
  }
  if (last === -1) return `no such file: ${args.join(" ")}`
  path = args.slice(0, last + 1).join(" ")
  const caption = args.slice(last + 1).join(" ")
  try {
    return await deps.image({ path, ...(caption === "" ? {} : { caption }) })
  } catch (error) {
    return `image not sent: ${(error as Error).message}`
  }
}

/**
 * `/relay help`: every subcommand with its one-line purpose, plus the values a user asks about most
 * (provider, preset, mode, model) so the answer to "what is going on" rarely needs a second command.
 */
async function help(deps: RelayCommandDeps): Promise<string> {
  const prefs = await getPreferences(deps.configPath)
  const settings = await modelSettings(deps.configPath)
  const configured = settings.providerID !== "" && settings.modelID !== ""
  const model = configured
    ? `${settings.providerID}/${settings.modelID}${settings.enabled ? "" : " (aiProcessing disabled)"}`
    : "none"
  return [
    "commands:",
    "/relay status — provider, preset, mode, enabled categories, pending batches",
    "/relay sessions — recent sessions as a numbered list; select takes those numbers",
    "/relay select <number|sessionID> — session that prompts and answers go to",
    "/relay notifications [category on|off] [mode immediate|batch|final_only] [preset all|important|completion] — notification categories and delivery",
    "/relay model [providerID modelID] — model that summarises notifications",
    "/relay pair [whatsapp|discord] — link a transport through a form",
    "/relay unpair [whatsapp|discord] — log out and remove the transport's credentials or target",
    "/relay invite [discord] — bot install URL for a server (needed when Discord refuses the DM, 50278)",
    "/relay group - create or reuse the WhatsApp group notifications go to",
    "/relay send <path> [caption] - send an image file to the link",
    "/relay help - this list",
    `current: provider ${deps.provider}, preset ${prefs.preset}, mode ${prefs.mode}, model ${model}`,
  ].join("\n")
}

async function notifications(args: string[], deps: RelayCommandDeps): Promise<string> {
  if (args.length === 0) {
    const prefs = await getPreferences(deps.configPath)
    const on = CATEGORIES.filter((category) => prefs.categories[category])
    return `preset: ${prefs.preset}\nmode: ${prefs.mode}\non: ${on.join(", ") || "none"}`
  }
  const [key, value] = args
  if (key === "preset") {
    if (value === "all" || value === "important" || value === "completion") {
      const prefs = await setPreset(deps.configPath, value)
      return `preset: ${prefs.preset}`
    }
    return "preset must be all, important, or completion"
  }
  if (key === "mode") {
    if (value === "immediate" || value === "batch" || value === "final_only") {
      const prefs = await setMode(deps.configPath, value)
      return `mode: ${prefs.mode}`
    }
    return "mode must be immediate, batch, or final_only"
  }
  if (key === undefined || !CATEGORIES.includes(key as Category) || (value !== "on" && value !== "off")) {
    return USAGE
  }
  const prefs = await setCategory(deps.configPath, key as Category, value === "on")
  return `${key}: ${prefs.categories[key as Category] ? "on" : "off"}`
}

async function listSessions(deps: RelayCommandDeps): Promise<SessionInfo[]> {
  return deps.sessions === undefined ? [] : deps.sessions()
}

async function listModels(deps: RelayCommandDeps): Promise<ModelRef[]> {
  if (deps.models === undefined) return []
  try {
    return await deps.models()
  } catch {
    return []
  }
}

/** `/relay model`: show the model that summarises notifications, or set it. */
async function model(args: string[], deps: RelayCommandDeps): Promise<string> {
  if (args.length === 0) {
    const settings = await modelSettings(deps.configPath)
    const configured = settings.providerID !== "" && settings.modelID !== ""
    const current = configured ? `${settings.providerID}/${settings.modelID}` : "none"
    const lines = [`current: ${settings.enabled ? current : `${current} (aiProcessing disabled)`}`]
    const models = await listModels(deps)
    if (models.length === 0) {
      lines.push("host reported no models; set one with /relay model <providerID> <modelID>")
      return lines.join("\n")
    }
    for (const entry of models.slice(0, MODEL_LINES)) {
      const ref = `${entry.providerID}/${entry.id}`
      lines.push(configured && ref === current ? `${ref} (current)` : ref)
    }
    if (models.length > MODEL_LINES) lines.push(`... ${models.length - MODEL_LINES} more`)
    return lines.join("\n")
  }
  const [providerID, modelID] = args
  if (providerID === undefined || modelID === undefined) return "usage: /relay model <providerID> <modelID>"
  try {
    const settings = await setModel(deps.configPath, providerID, modelID, await listModels(deps))
    return `model: ${settings.providerID}/${settings.modelID} (AI summaries on)`
  } catch (error) {
    // setModel names the unknown or ambiguous candidates itself: that text is the answer
    return (error as Error).message
  }
}

/** What a reply did: `settled` means the form is answered or cancelled and can be completed. */
interface FormOutcome {
  readonly reply: string
  readonly settled: boolean
}

const CANCEL = /^cancel$/i

/** Fields a chat reply can fill: hidden ones carry server values, `external` ones are out-of-band. */
function answerable(fields: readonly FormField[]): FormField[] {
  return fields.filter(
    (field) => field.hidden !== true && typeof field.key === "string" && field.type !== "external",
  )
}

type Coerced = { readonly ok: true; readonly value: FormValue } | { readonly ok: false; readonly reason: string }

/** Forces typed text past option matching, for a select whose real answer is not on the list. */
const OTHER = /^other\s*:\s*/i

/** An option by value, label, or `a`/`1` in the order the form lists it; undefined when none match. */
function matchOption(
  options: ReadonlyArray<{ readonly value?: string; readonly label?: string }>,
  text: string,
): string | undefined {
  const byValue = options.find((option) => option.value === text)?.value
  if (byValue !== undefined) return byValue
  const byLabel = options.find((option) => (option.label ?? "").toLowerCase() === text.toLowerCase())?.value
  if (byLabel !== undefined) return byLabel
  const index = /^[a-z]$/i.test(text) ? text.toLowerCase().charCodeAt(0) - 97 : Number(text) - 1
  return options[index]?.value
}

/**
 * Typed text -> the value the form API expects. A select is a `string` field with `options`
 * (@opencode/schema Form.Fields), so option matching comes first; text that matches no option is
 * still the answer, sent as typed, because a chat user must not be stuck with a fixed list.
 * `Other: <text>` says so explicitly. Only a boolean or a number, which the server types, is parsed.
 */
function valueOf(field: FormField, raw: string): Coerced {
  const text = raw.trim()
  if (text === "") return { ok: false, reason: `field "${field.key}" needs an answer` }
  const options = (field.options ?? []).filter(
    (option): option is { readonly value: string; readonly label?: string } => typeof option.value === "string",
  )
  if (field.type === "multiselect") {
    const parts = text.split(",").map((part) => part.trim()).filter((part) => part !== "")
    // every part is an option when one matches, else the literal text: the field is a string list
    return { ok: true, value: parts.map((part) => matchOption(options, part) ?? part) }
  }
  if (field.type === "boolean") {
    if (/^(true|yes|y|on|1)$/i.test(text)) return { ok: true, value: true }
    if (/^(false|no|n|off|0)$/i.test(text)) return { ok: true, value: false }
    return { ok: false, reason: `field "${field.key}" needs yes or no` }
  }
  if (field.type === "number" || field.type === "integer") {
    const value = Number(text)
    if (Number.isNaN(value)) return { ok: false, reason: `field "${field.key}" needs a number` }
    if (field.type === "integer" && !Number.isInteger(value)) {
      return { ok: false, reason: `field "${field.key}" needs a whole number` }
    }
    return { ok: true, value }
  }
  const other = OTHER.exec(text)
  if (other !== null) return { ok: true, value: text.slice(other[0].length) }
  return { ok: true, value: matchOption(options, text) ?? text }
}

/** How to answer the form, listing the same numbers the question text shows. */
const USAGE_LINE = 'answer one line per field, e.g. "1: <answer>"; "cancel" cancels'

function formUsage(fields: readonly FormField[]): string {
  const list = fields.map((field, index) => `${index + 1}. ${field.title ?? field.key}`).join("\n")
  return ["⚠️ could not read that as an answer", USAGE_LINE, list].join("\n")
}

/**
 * Reply text -> the fields `session.form.reply` takes from this message. One field takes the whole
 * reply; several take `1: value` (or `<key>: value`) lines, one per field. A string result is the
 * text that tells the user how to answer, and the form stays pending. Required fields are checked
 * after merging with earlier answers (see `replyForm`), so a button click can fill one at a time.
 */
function answersOf(fields: readonly FormField[], text: string): Record<string, FormValue> | string {
  const targets = answerable(fields)
  if (targets.length === 0) return "this form has no field a chat reply can fill; answer it in the TUI"

  const [only] = targets
  if (targets.length === 1 && only?.key !== undefined) {
    const value = valueOf(only, text)
    return value.ok ? { [only.key]: value.value } : `⚠️ ${value.reason}`
  }

  const answer: Record<string, FormValue> = {}
  for (const line of text.split("\n").map((part) => part.trim()).filter((part) => part !== "")) {
    const match = /^(\d+)\s*[:.)]\s*(.+)$/.exec(line) ?? /^([\w.-]+)\s*:\s*(.+)$/.exec(line)
    if (match === null) return formUsage(targets)
    const head = match[1] ?? ""
    const raw = match[2] ?? ""
    const index = /^\d+$/.test(head)
      ? Number(head) - 1
      : targets.findIndex((field) => field.key?.toLowerCase() === head.toLowerCase())
    const field = targets[index]
    if (field?.key === undefined) return formUsage(targets)
    const value = valueOf(field, raw)
    if (!value.ok) return `⚠️ ${value.reason}`
    answer[field.key] = value.value
  }
  return answer
}

/**
 * Forms go over HTTP: @opencode/plugin 2.3.0 exposes `ctx.session.list/generate/prompt/...` but no
 * form API on the plugin Context, so the only path is the local server, with these routes from
 * @opencode/protocol:
 *   GET    /api/session/{sessionID}/form/{formID}          -> { fields: Form.Fields }
 *   POST   /api/session/{sessionID}/form/{formID}/reply    body { answer: Form.Answer } -> 204
 *   DELETE /api/session/{sessionID}/form/{formID}          -> 204 (cancel)
 * The Context exposes no server URL either; `serverEndpoint` discovers it (see ../pairing.ts).
 */
async function replyForm(
  pending: PendingInteraction,
  sessionID: string,
  text: string,
  deps: InboundDeps,
): Promise<FormOutcome> {
  const formID = pending.formID
  if (formID === undefined) return { reply: `⚠️ prompt ${pending.messageID} has no formID`, settled: false }
  const path = `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}`
  try {
    const server = await serverEndpoint(deps)
    if (CANCEL.test(text)) {
      await request(server, path, { method: "DELETE" }, deps)
      return { reply: `🚫 form ${formID} cancelled`, settled: true }
    }
    const detail = await request<{ fields?: FormField[] }>(server, path, {}, deps)
    const targets = answerable(detail.fields ?? [])
    const given = answersOf(detail.fields ?? [], text)
    if (typeof given === "string") return { reply: given, settled: false }

    // a click or a short reply may cover only some fields: keep the rest pending, never submit early
    const saved = pending.partial ?? {}
    const answer: Record<string, FormValue> = {}
    for (const field of targets) {
      const key = field.key as string
      const value = given[key] ?? saved[key]
      if (value !== undefined) answer[key] = value
    }
    const missing = targets.filter((field) => answer[field.key as string] === undefined && field.required === true)
    if (missing.length > 0) {
      await deps.store.partial(pending.messageID, answer)
      const list = missing.map((field) => `${targets.indexOf(field) + 1}. ${field.title ?? field.key}`).join("\n")
      return {
        reply: `👍 noted ${Object.keys(given).join(", ")}\nstill needed:\n${list}\n${USAGE_LINE}`,
        settled: false,
      }
    }
    await request(server, `${path}/reply`, { method: "POST", body: JSON.stringify({ answer }) }, deps)
    return { reply: `✅ form ${formID} answered (${Object.keys(answer).join(", ")})`, settled: true }
  } catch (error) {
    // the form was answered or cancelled elsewhere (the TUI, another chat): the record is dead, so
    // drop it and say so in one line instead of stacking an HTTP error on top
    if (error instanceof HttpError && error.status === 404) {
      return {
        reply: `⌛ form ${formID} is already answered or cancelled elsewhere; ask the agent to raise it again`,
        settled: true,
      }
    }
    // an HTTP failure must reach the user and leave the form pending, never vanish into a log
    return { reply: `⚠️ form ${formID} not answered: ${(error as Error).message}`, settled: false }
  }
}

/** Permissions go through `ctx.permission.reply`; there is no HTTP guess left in this path. */
async function replyPermission(
  pending: PendingInteraction,
  sessionID: string,
  text: string,
  deps: InboundDeps,
): Promise<void> {
  const permissionID = pending.permissionID
  if (permissionID === undefined) throw new Error(`interaction ${pending.messageID} has no permissionID`)
  const reply = deps.replyPermission
  if (reply === undefined) {
    throw new Error("permission replies need the plugin host (ctx.permission.reply)")
  }
  await reply({ sessionID, requestID: permissionID, decision: decisionOf(text) })
}

/** "always" is explicit; anything that is not a clear yes is a reject so a typo cannot approve. */
function decisionOf(text: string): Decision {
  const word = text.trim().toLowerCase()
  if (word === "always" || word === "a") return "always"
  if (/^(once|yes|y|ok|allow)$/.test(word)) return "once"
  return "reject"
}
