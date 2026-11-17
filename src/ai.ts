import { loadConfig, updateConfig, type Config } from "./config.js"
import type { Envelope } from "./envelope.js"

/** Matches `Model.Ref` from @opencode/schema, the shape `ctx.experimental.generate.text` takes. */
export interface ModelRef {
  readonly providerID: string
  readonly id: string
}

/** Configured AI model, or null when AI is off or that model is not available here. */
export function resolveModel(config: Config, availableModels: readonly ModelRef[]): ModelRef | null {
  if (!config.aiProcessing.enabled) return null
  const { providerID, modelID } = config.aiProcessing.model
  return availableModels.some((model) => model.providerID === providerID && model.id === modelID)
    ? { providerID, id: modelID }
    : null
}

/** What `/relay model` shows: the configured AI settings. */
export interface ModelSettings {
  readonly enabled: boolean
  readonly providerID: string
  readonly modelID: string
}

export async function modelSettings(path: string): Promise<ModelSettings> {
  const { aiProcessing } = await loadConfig(path)
  return { enabled: aiProcessing.enabled, ...aiProcessing.model }
}

/**
 * `/relay model <providerID> <modelID>`: resolve the typed ID against the host list (see
 * `matchModel`), write the resolved model to config.json and turn AI processing on. Throws with the
 * unknown/ambiguous answer when it does not resolve to exactly one model.
 */
export async function setModel(
  path: string,
  providerID: string,
  modelID: string,
  available: readonly ModelRef[] = [],
): Promise<ModelSettings> {
  // no host list (host reported none): the typed ID is written as it is
  const match: ModelMatch =
    available.length === 0
      ? { kind: "match", model: { providerID, id: modelID } }
      : matchModel(providerID, modelID, available)
  if (match.kind === "none") throw new Error(`unknown model: ${providerID}/${modelID} (see /relay model)`)
  if (match.kind === "ambiguous") {
    const refs = match.candidates.map((model) => `${model.providerID}/${model.id}`).join(", ")
    throw new Error(`ambiguous model: ${providerID}/${modelID} matches ${refs}; name one of them`)
  }
  const { providerID: provider, id } = match.model
  return updateConfig(path, (config) => {
    config.aiProcessing = { enabled: true, model: { providerID: provider, modelID: id } }
    return { enabled: true, providerID: provider, modelID: id }
  })
}

/** What a typed model ID resolved to, or why it did not resolve to one model. */
export type ModelMatch =
  | { readonly kind: "match"; readonly model: ModelRef }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly candidates: readonly ModelRef[] }

/**
 * A variant suffix a user types on top of a real ID, such as `muse-spark-1.3-contributor` for
 * `muse-spark-1.3`. Only ever stripped from the typed ID, and only as a fallback: a real ID that
 * merely ends in a token (`deepseek-v4.1-flash`) still matches exactly on the first pass.
 */
const withoutVariant = (id: string): string => id.replace(/-[^-]+$/, "")

/**
 * Typed model ID -> the model the host reports. Exact ID first, then an ID that differs only by a
 * typed variant suffix, then a prefix/contains search; several candidates are reported, never guessed.
 */
export function matchModel(
  providerID: string,
  modelID: string,
  available: readonly ModelRef[],
): ModelMatch {
  const exact = available.find((model) => model.providerID === providerID && model.id === modelID)
  if (exact !== undefined) return { kind: "match", model: exact }

  const typed = modelID.toLowerCase()
  const bare = withoutVariant(typed)
  const byBare = available.find((model) => model.providerID === providerID && model.id.toLowerCase() === bare)
  if (byBare !== undefined) return { kind: "match", model: byBare }

  const near = available.filter((model) => {
    if (model.providerID !== providerID) return false
    const known = model.id.toLowerCase()
    return known.startsWith(typed) || typed.startsWith(known) || known.includes(typed)
  })
  const [only] = near
  if (only === undefined) return { kind: "none" }
  return near.length === 1 ? { kind: "match", model: only } : { kind: "ambiguous", candidates: near }
}

export interface Processor {
  summarize(envelope: Envelope): Promise<Envelope>
}

/** `ctx.experimental.generate.text`: one stateless prompt-and-model call, no session or tools. */
export type GenerateText = (input: {
  readonly prompt: string
  readonly model: ModelRef
}) => Promise<{ readonly text: string }>

const PROMPT = (text: string): string =>
  [
    "Summarise this OpenCode progress update for a chat notification in at most three short lines.",
    "Keep file paths, commands and error messages verbatim. Reply with the summary only.",
    "",
    text,
  ].join("\n")

/**
 * One summarising model call over plain text, through the host's stateless generate API.
 * A failed call returns the original text: a summary is never worth dropping a notification for.
 */
export async function summarizePass(
  text: string,
  model: ModelRef,
  generate?: GenerateText,
): Promise<string> {
  if (generate === undefined) return text
  try {
    const summary = (await generate({ prompt: PROMPT(text), model })).text.trim()
    return summary === "" ? text : summary
  } catch {
    return text
  }
}

/** Label for the short version; the full text follows it, never the other way round. */
const SUMMARY_HEADER = "summary:"

/** Wraps the configured model; without a generator (or model) the envelope passes through. */
export class ModelProcessor implements Processor {
  /** Resolution at construction, for the host's startup log. */
  readonly model: ModelRef | null
  private config: Config
  private readonly available: readonly ModelRef[]
  private readonly generate: GenerateText | undefined
  private readonly configPath: string | undefined

  constructor(
    config: Config,
    availableModels: readonly ModelRef[] = [],
    generate?: GenerateText,
    configPath?: string,
  ) {
    this.config = config
    this.available = availableModels
    this.generate = generate
    this.configPath = configPath
    this.model = resolveModel(config, availableModels)
  }

  async summarize(envelope: Envelope): Promise<Envelope> {
    // `/relay model` rewrites config.json: honour it without a host restart
    const model = resolveModel(await this.current(), this.available)
    if (model === null) return envelope
    const summary = await summarizePass(envelope.text, model, this.generate)
    // summary first, full text below: a short read on top, never a replacement that drops paragraphs
    return summary === envelope.text
      ? envelope
      : { ...envelope, text: `${SUMMARY_HEADER} ${summary}\n\n${envelope.text}` }
  }

  /** The config on disk when there is a path; a read failure keeps the last good one. */
  private async current(): Promise<Config> {
    if (this.configPath === undefined) return this.config
    this.config = await loadConfig(this.configPath).catch(() => this.config)
    return this.config
  }
}

// Spec §18: only completion/error text is summarised. Forms and permission prompts go verbatim.
const SUMMARISED: readonly Envelope["category"][] = ["passCompleted", "taskCompleted", "errors"]

/** Envelope -> envelope to send. Questions and permissions never enter the processor. */
export function processEnvelope(processor: Processor, envelope: Envelope): Promise<Envelope> {
  return SUMMARISED.includes(envelope.category) ? processor.summarize(envelope) : Promise.resolve(envelope)
}
