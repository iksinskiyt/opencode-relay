import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

export type InteractionType = "form" | "permission" | "pairing"

/** One answer value, the shape `session.form.reply` accepts. */
export type PartialAnswer = string | number | boolean | string[]

/** One outbound prompt we are waiting on a reply for. */
export interface PendingInteraction {
  provider: string
  externalUserID: string
  chatID: string
  /** id of the message we sent, the dedupe key and the quoted-reply anchor. */
  messageID: string
  sessionID: string
  formID?: string
  permissionID?: string
  type: InteractionType
  /** Popup stage on a `pairing` record; unset for transport prompts. */
  pair?: "provider" | "number" | "discord-target" | "discord-channel" | "discord-dm"
  createdAt: number
  expiresAt: number
  status: "pending" | "resolved" | "expired"
  /** Form fields answered so far: a button fills one at a time, the form stays pending between. */
  partial?: Readonly<Record<string, PartialAnswer>>
}

export interface PendingInput {
  provider: string
  externalUserID: string
  chatID: string
  messageID: string
  sessionID: string
  formID?: string
  permissionID?: string
  type: InteractionType
  pair?: "provider" | "number" | "discord-target" | "discord-channel" | "discord-dm"
}

export interface CorrelationStore {
  /** Idempotent on messageID: a redelivered send does not create a second entry. */
  add(input: PendingInput, ttlMs?: number): Promise<PendingInteraction>
  get(messageID: string): PendingInteraction | undefined
  /**
   * Newest live prompt for that identity, for transports that cannot quote the message. Falls back
   * to any user in the same chat, because a transport may report a different sender on replies.
   */
  resolve(provider: string, externalUserID: string, chatID: string): PendingInteraction | undefined
  complete(messageID: string): Promise<PendingInteraction | undefined>
  /** Saves the fields answered so far, so the next click continues the same form. */
  partial(messageID: string, answer: Readonly<Record<string, PartialAnswer>>): Promise<PendingInteraction | undefined>
  /**
   * Newest prompt for that identity that timed out a moment ago, so an answer that missed it gets
   * "expired" instead of being forwarded as a fresh prompt.
   */
  lastExpired(provider: string, externalUserID: string, chatID: string): PendingInteraction | undefined
  /** Marks timed-out entries expired and drops old settled ones. Returns how many just expired. */
  expire(now?: number): Promise<number>
  /**
   * Settles the record of a form answered or cancelled elsewhere (the TUI, another chat), so an
   * answer from chat cannot land on a dead form. Returns how many records it settled.
   */
  settleForm(formID: string): Promise<number>
  list(): PendingInteraction[]
}

export const DEFAULT_TTL_MS = 15 * 60 * 1000
const RETENTION_MS = 60 * 60 * 1000
/**
 * How long after expiry a missed answer is still called "expired". Longer would swallow ordinary
 * prompts for the rest of the retention window.
 */
const EXPIRED_NOTICE_MS = 10 * 60 * 1000
const FILE = "interactions.json"

const load = async (file: string): Promise<Map<string, PendingInteraction>> => {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as PendingInteraction[]
    return new Map(parsed.map((record) => [record.messageID, record]))
  } catch {
    // missing or corrupt state is not worth a crash: correlation is best-effort
    return new Map()
  }
}

export async function createCorrelationStore(
  dir = "auth-state",
  now: () => number = Date.now,
): Promise<CorrelationStore> {
  const file = join(dir, FILE)
  const records = await load(file)
  let queue: Promise<void> = Promise.resolve()

  // serialise writes so two concurrent mutations cannot fight over the temp file
  const save = (): Promise<void> => {
    queue = queue.then(
      async () => {
        await mkdir(dir, { recursive: true })
        const tmp = `${file}.tmp`
        await writeFile(tmp, `${JSON.stringify([...records.values()], null, 2)}\n`, "utf8")
        await rename(tmp, file)
      },
      async () => undefined,
    )
    return queue
  }

  /** Newest record matching the predicate, preferring an exact sender over the same chat. */
  const find = (
    provider: string,
    externalUserID: string,
    chatID: string,
    matches: (record: PendingInteraction, at: number) => boolean,
  ): PendingInteraction | undefined => {
    const at = now()
    let exact: PendingInteraction | undefined
    let sameChat: PendingInteraction | undefined
    for (const record of records.values()) {
      if (record.provider !== provider || record.chatID !== chatID || !matches(record, at)) continue
      if (record.externalUserID === externalUserID) {
        if (exact === undefined || record.createdAt >= exact.createdAt) exact = record
      } else if (sameChat === undefined || record.createdAt >= sameChat.createdAt) {
        sameChat = record
      }
    }
    return exact ?? sameChat
  }

  return {
    async add(input, ttlMs = DEFAULT_TTL_MS) {
      const existing = records.get(input.messageID)
      if (existing !== undefined) return existing
      const createdAt = now()
      const record: PendingInteraction = {
        provider: input.provider,
        externalUserID: input.externalUserID,
        chatID: input.chatID,
        messageID: input.messageID,
        sessionID: input.sessionID,
        type: input.type,
        createdAt,
        expiresAt: createdAt + ttlMs,
        status: "pending",
      }
      if (input.formID !== undefined) record.formID = input.formID
      if (input.permissionID !== undefined) record.permissionID = input.permissionID
      if (input.pair !== undefined) record.pair = input.pair
      records.set(record.messageID, record)
      await save()
      return record
    },

    get(messageID) {
      return records.get(messageID)
    },

    resolve(provider, externalUserID, chatID) {
      return find(
        provider,
        externalUserID,
        chatID,
        (record, at) => record.status === "pending" && record.expiresAt > at,
      )
    },

    lastExpired(provider, externalUserID, chatID) {
      // a prompt past its expiry counts before the tick marks it, so a race never forwards an answer
      return find(
        provider,
        externalUserID,
        chatID,
        (record, at) =>
          (record.status === "expired" || (record.status === "pending" && record.expiresAt <= at)) &&
          record.expiresAt >= at - EXPIRED_NOTICE_MS,
      )
    },

    async complete(messageID) {
      const record = records.get(messageID)
      if (record === undefined) return undefined
      if (record.status === "pending") record.status = "resolved"
      await save()
      return record
    },

    async partial(messageID, answer) {
      const record = records.get(messageID)
      if (record === undefined) return undefined
      record.partial = answer
      await save()
      return record
    },

    async expire(at = now()) {
      let expired = 0
      let changed = false
      for (const [id, record] of records) {
        if (record.status === "pending" && record.expiresAt <= at) {
          record.status = "expired"
          expired++
          changed = true
        } else if (record.status !== "pending" && record.expiresAt < at - RETENTION_MS) {
          records.delete(id)
          changed = true
        }
      }
      if (changed) await save()
      return expired
    },

    async settleForm(formID) {
      let settled = 0
      for (const record of records.values()) {
        if (record.formID !== formID || record.status !== "pending") continue
        record.status = "resolved"
        settled++
      }
      // pairs are settled by the pair handler; this catches transport prompts answered elsewhere
      if (settled > 0) await save()
      return settled
    },

    list() {
      return [...records.values()]
    },
  }
}
