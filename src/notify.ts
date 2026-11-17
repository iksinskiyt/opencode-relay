import { randomUUID } from "node:crypto"
import type { Config } from "./config.js"
import { type Category, type Envelope, type Interaction, type QuestionDetails } from "./envelope.js"

/** Structural view of an OpenCode event; only `type` and `data` are used. */
export interface RelayEvent {
  readonly type: string
  readonly data?: unknown
}

// Spec §6.1: "important" is completion plus an interrupted session.
const IMPORTANT: readonly Category[] = [
  "questions",
  "permissions",
  "errors",
  "taskCompleted",
  "sessionInterrupted",
]

const COMPLETION: readonly Category[] = ["questions", "permissions", "errors", "taskCompleted"]

function enabledFor(config: Config, category: Category): boolean {
  const { preset, categories } = config.notifications
  switch (preset) {
    case "important":
      return IMPORTANT.includes(category)
    case "completion":
      return COMPLETION.includes(category)
    default:
      return categories[category]
  }
}

const EVENT_CATEGORY: Readonly<Record<string, Category>> = {
  "session.step.ended": "passCompleted",
  // the assistant's own words: the part of a pass the operator actually wants to read
  "session.text.ended": "passCompleted",
  "session.idle": "taskCompleted",
  "form.created": "questions",
  "permission.asked": "permissions",
  "session.execution.failed": "errors",
  "session.step.failed": "errors",
  "session.created": "sessionStarted",
  "session.execution.interrupted": "sessionInterrupted",
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function field(data: unknown, key: string): string | undefined {
  const value = record(data)?.[key]
  return typeof value === "string" && value !== "" ? value : undefined
}

/** `form.created` nests the prompt under `data.form`; `permission.asked` carries its own `id`. */
function interactionOf(category: Category, data: unknown, form: unknown): Interaction | undefined {
  if (category === "questions") {
    const formID = field(form, "id")
    return formID === undefined ? undefined : { type: "form", formID }
  }
  if (category === "permissions") {
    const permissionID = field(data, "id")
    return permissionID === undefined ? undefined : { type: "permission", permissionID }
  }
  return undefined
}

/** The session an event belongs to; `form.created` nests it under `form`. */
export function sessionIDOf(event: RelayEvent): string | undefined {
  const form = record(record(event.data)?.["form"])
  return field(event.data, "sessionID") ?? field(form, "sessionID")
}

/**
 * What happened, for events that carry no human text of their own. Without this the notification
 * body would be the raw event type (`session.step.ended`).
 */
const HAPPENED: Readonly<Record<Category, string>> = {
  passCompleted: "finished a pass",
  taskCompleted: "finished its task",
  questions: "has a question",
  permissions: "needs your permission",
  errors: "hit an error",
  sessionStarted: "started",
  sessionInterrupted: "was interrupted",
  message: "sent a message",
}

/** A form field as `form.created` carries it; only what a chat answer needs. */
interface FormFieldView {
  readonly key: string
  readonly title?: string
  readonly description?: string
  readonly required: boolean
  readonly multi: boolean
  readonly options?: ReadonlyArray<{ readonly value: string; readonly label?: string }>
}

const optionLetter = (index: number): string => String.fromCharCode(97 + index)

/** Fields a chat user can fill, in the form's own order: hidden and `external` ones are skipped. */
function formFields(form: Record<string, unknown> | undefined): FormFieldView[] {
  const raw = form?.["fields"]
  if (!Array.isArray(raw)) return []
  const fields: FormFieldView[] = []
  for (const entry of raw) {
    const field = record(entry)
    const key = field?.["key"]
    if (field === undefined || typeof key !== "string" || key === "") continue
    if (field["hidden"] === true || field["type"] === "external") continue
    const options = Array.isArray(field["options"])
      ? field["options"].flatMap((entry) => {
          const option = record(entry)
          const value = option?.["value"]
          if (typeof value !== "string") return []
          return [{ value, ...(typeof option?.["label"] === "string" ? { label: option["label"] } : {}) }]
        })
      : []
    fields.push({
      key,
      ...(typeof field["title"] === "string" ? { title: field["title"] } : {}),
      ...(typeof field["description"] === "string" ? { description: field["description"] } : {}),
      required: field["required"] === true,
      multi: field["type"] === "multiselect",
      ...(options.length === 0 ? {} : { options }),
    })
  }
  return fields
}

/** The question's fields with their options, for a transport that renders buttons or a select. */
export function questionOf(form: Record<string, unknown> | undefined, formID?: string): QuestionDetails | undefined {
  const fields = formFields(form).map((field) => ({
    key: field.key,
    label: field.title ?? field.key,
    required: field.required,
    multi: field.multi,
    options: (field.options ?? []).map((option, index) => ({
      letter: optionLetter(index),
      label: option.label ?? option.value,
      value: option.value,
    })),
  }))
  if (fields.length === 0) return undefined
  return { ...(formID === undefined ? {} : { formID }), fields }
}

/**
 * Question text for the chat: every field and its options in the form's own order. The answer is
 * typed text on every transport, so the message has to carry what the TUI picker shows.
 */
function formText(form: Record<string, unknown> | undefined, headline: string): string {
  const fields = formFields(form)
  if (fields.length === 0) return headline
  const lines = [headline]
  for (const [index, field] of fields.entries()) {
    const heading = fields.length === 1 ? "" : `${index + 1}. `
    const description = field.description === undefined ? "" : ` — ${field.description}`
    const options = (field.options ?? [])
      .map((option, position) => `${optionLetter(position)}) ${option.label ?? option.value}`)
      .join(" ")
    lines.push(`${heading}${field.title ?? field.key}${description}${options === "" ? "" : `\n   ${options}`}`)
  }
  lines.push(
    fields.length === 1
      ? 'reply with the answer; "cancel" cancels'
      : 'reply one line per field, e.g. "1: <answer>"; "cancel" cancels',
  )
  return lines.join("\n")
}

/**
 * First line of every notification: a linked device always renders its own sends on the right, so
 * the sending session has to be named in the text for one chat (or the relay group) to stay legible.
 */
export function identity(title?: string): string {
  return title === undefined || title === "" ? "🤖 Relay" : `🤖 Relay · *${title}*`
}

/**
 * The assistant's response text (`session.text.ended`), whole and unfenced: a truncated answer loses
 * the paragraphs that made it worth reading, and every transport splits a long message natively.
 * Discord renders the Markdown as written; WhatsApp converts it in its own provider. Fencing it here
 * would turn bold, italics and headings into dead literal characters.
 * With a model configured `processEnvelope` adds a summary on top; it never replaces this text.
 */
function contentOf(category: Category, data: unknown): string | undefined {
  if (category !== "passCompleted" && category !== "taskCompleted") return undefined
  const text = field(data, "text")?.trim()
  if (text === undefined || text === "") return undefined
  return text
}

/**
 * Whether `reduce` would turn this event into an envelope under this config. `parentID` is the
 * session's parent (`null`/absent for a root): with `orchestratorOnly` on, a child session — the
 * subagent an orchestrator spawned — never notifies. An unknown parentage relays.
 */
export function notifiable(event: RelayEvent, config: Config, parentID?: string | null): boolean {
  const category = EVENT_CATEGORY[event.type]
  if (category === undefined || !enabledFor(config, category)) return false
  return !config.notifications.orchestratorOnly || parentID === undefined || parentID === null
}

/** Event -> Envelope, or null when the event is not notifiable under this config. */
export function reduce(
  event: RelayEvent,
  config: Config,
  title?: string,
  parentID?: string | null,
): Envelope | null {
  const category = EVENT_CATEGORY[event.type]
  if (category === undefined || !notifiable(event, config, parentID)) return null

  const form = record(record(event.data)?.["form"])
  const sessionID = sessionIDOf(event)
  const subject =
    title !== undefined ? `Session '${title}'` : sessionID !== undefined ? `Session ${sessionID}` : "A session"
  const error = field(record(event.data)?.["error"], "message")
  const happened = `${subject} ${HAPPENED[category]}${category === "errors" && error !== undefined ? `: ${error}` : ""}`
  const headline =
    field(form, "title") ??
    field(event.data, "title") ??
    field(event.data, "question") ??
    field(event.data, "action") ??
    happened
  const content = contentOf(category, event.data)
  const text =
    category === "questions"
      ? formText(form, headline)
      : content === undefined
        ? headline
        : `${headline}\n\n${content}`
  const interaction = interactionOf(category, event.data, form)
  const question =
    category === "questions" ? questionOf(form, interaction?.type === "form" ? interaction.formID : undefined) : undefined
  return {
    id: randomUUID(),
    category,
    text,
    createdAt: Date.now(),
    ...(sessionID === undefined ? {} : { sessionID }),
    ...(interaction === undefined ? {} : { interaction }),
    ...(question === undefined ? {} : { question }),
  }
}
