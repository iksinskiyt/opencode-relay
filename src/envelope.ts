export const CATEGORIES = [
  "passCompleted",
  "taskCompleted",
  "questions",
  "permissions",
  "errors",
  "sessionStarted",
  "sessionInterrupted",
  // an image sent by hand or dropped in the outbox: not an event, but it still goes out
  "message",
] as const

export type Category = (typeof CATEGORIES)[number]

/** Set on a prompt message we expect an answer to. */
export interface Interaction {
  readonly type: "form" | "permission"
  readonly formID?: string
  readonly permissionID?: string
}

/** One option of a question field, as the form lists it. */
export interface QuestionOption {
  /** Position in the question text: "a", "b", ... */
  readonly letter: string
  readonly label: string
  readonly value: string
}

/** One answerable field of a question, for a transport with native choice widgets. */
export interface QuestionField {
  readonly key: string
  readonly label: string
  readonly required: boolean
  /** `multiselect`: the answer is a list of option values. */
  readonly multi: boolean
  readonly options: readonly QuestionOption[]
}

/** A question's fields: the text stays the fallback, this lets a transport render real controls. */
export interface QuestionDetails {
  readonly formID?: string
  readonly fields: readonly QuestionField[]
}

/**
 * An image to send with the message: a local path, a URL, or bytes. Discord embeds a URL and
 * uploads the rest; WhatsApp uploads either, so it downloads a URL first.
 */
export interface EnvelopeImage {
  readonly path?: string
  readonly url?: string
  /** In-process only: the retry queue persists these bytes as base64. */
  readonly bytes?: Uint8Array
  /** File name sent to Discord and shown to the user; derived from path/url when absent. */
  readonly name?: string
  readonly caption?: string
}

/** One normalised message. Transports never see anything else. */
export interface Envelope {
  readonly id: string
  readonly category: Category
  readonly text: string
  readonly createdAt: number
  readonly sessionID?: string
  readonly interaction?: Interaction
  /** Set for `questions`: the fields behind the text, so a transport can render buttons/selects. */
  readonly question?: QuestionDetails
  readonly image?: EnvelopeImage
}

/**
 * Every outbound text ends with exactly one newline: on Discord and WhatsApp the last line of one
 * report would otherwise run into the next. Whitespace-only text stays empty (an image caption, not
 * a blank line).
 */
export function withFinalNewline(text: string): string {
  const trimmed = text.trimEnd()
  return trimmed === "" ? "" : `${trimmed}\n\n`
}

/** One inbound message from a transport, normalised for reply handling. */
export interface InboundMessage {
  readonly id: string
  readonly chatID: string
  readonly senderID: string
  readonly text: string
  /** fromMe on our own JID: the operator replying in a self-chat. */
  readonly selfChat: boolean
  /** The message this one quotes/replies to, when the transport reports it: anchors the answer. */
  readonly quotedID?: string
}

export interface Destination {
  readonly externalUserID: string
  readonly chatID: string
}

/** Why a transport is or is not carrying messages; `/relay status` reports one per transport. */
export interface TransportStatus {
  readonly name: string
  readonly state: "live" | "mocked" | "disabled"
  readonly reason?: string
}

export interface Provider {
  /** Resolves with the transport message ID when it has one, so a reply can be correlated. */
  send(envelope: Envelope): Promise<string | void>
  /** Outbound identity for correlation; absent when the transport has no inbound path. */
  destination?(): Destination | undefined
  /** Opens the transport's live inbound path; absent for transports that push already. */
  start?(): Promise<void>
  /** Host tick: pull inbound messages for a transport that has no push channel. */
  poll?(): Promise<void>
  /** Registers the transport's own chat commands; absent when it has none. */
  registerCommands?(): Promise<void>
  /** Transports that hold a connection free it here; called from the plugin cleanup. */
  readonly stop?: () => Promise<void>
  /** In-band pairing (WhatsApp code linking); absent when the transport has no such flow. */
  requestPairingCode?(phoneNumber: string): Promise<string>
  /** Server-side unlink for `/relay unpair`; absent when the transport cannot log out. */
  logout?(): Promise<void>
  /** Creates or reuses the chat group the relay posts into, then routes outbound there. */
  ensureGroup?(subject: string): Promise<{ jid: string; created: boolean }>
}
