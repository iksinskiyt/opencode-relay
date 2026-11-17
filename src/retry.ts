import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Logger } from "pino"
import { isEnvelope } from "./batch-store.js"
import type { Envelope } from "./envelope.js"

export const MAX_ATTEMPTS = 3
const MAX_ENTRIES = 100
const BASE_BACKOFF_MS = 5_000
const MAX_BACKOFF_MS = 60_000

export interface RetryEntry {
  readonly envelope: Envelope
  attempts: number
  nextAt: number
}

/** A retried envelope that went through on this drain, so its correlation can be recorded. */
export interface Delivered {
  readonly envelope: Envelope
  readonly messageID: string | void
}

/** Failed sends, one queue per transport in `auth-state/retry-<transport>.json`: bounded, 3 attempts, exponential backoff. */
export interface RetryQueue {
  enqueue(envelope: Envelope, now?: number): Promise<void>
  /** Retries entries whose backoff has elapsed. Returns the ones that went through. */
  drain(send: (envelope: Envelope) => Promise<string | void>, now?: number): Promise<Delivered[]>
  pending(): readonly RetryEntry[]
  stop(): Promise<void>
}

export function retryDelayMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)
}

async function load(file: string): Promise<RetryEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"), revive) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isEntry).slice(-MAX_ENTRIES)
  } catch {
    // missing or corrupt state is not worth a crash: a lost retry is logged, not replayed
    return []
  }
}

/** `image.bytes` is a Uint8Array, which JSON flattens into an object: persist it as base64 instead. */
const wire = (_key: string, value: unknown): unknown =>
  value instanceof Uint8Array ? { base64: Buffer.from(value).toString("base64") } : value

const revive = (_key: string, value: unknown): unknown => {
  const base64 = (value as { base64?: unknown } | null)?.base64
  return typeof base64 === "string" ? Buffer.from(base64, "base64") : value
}

function isEntry(value: unknown): value is RetryEntry {
  if (typeof value !== "object" || value === null) return false
  const { envelope, attempts, nextAt } = value as Record<string, unknown>
  return typeof attempts === "number" && typeof nextAt === "number" && isEnvelope(envelope)
}

/** `name` gives one transport its own queue: `auth-state/retry-<name>.json`. */
export async function createRetryQueue(dir: string, name: string, log?: Logger): Promise<RetryQueue> {
  const file = join(dir, `retry-${name}.json`)
  const entries = await load(file)
  let queue: Promise<void> = Promise.resolve()

  const save = (): Promise<void> => {
    queue = queue.then(
      async () => {
        await mkdir(dir, { recursive: true })
        const tmp = `${file}.tmp`
        await writeFile(tmp, `${JSON.stringify(entries, wire, 2)}\n`, "utf8")
        await rename(tmp, file)
      },
      async () => undefined,
    )
    return queue
  }

  return {
    async enqueue(envelope, now = Date.now()) {
      if (entries.length >= MAX_ENTRIES) {
        const dropped = entries.shift()
        log?.warn({ id: dropped?.envelope.id }, "retry queue full, dropped the oldest envelope")
      }
      entries.push({ envelope, attempts: 0, nextAt: now })
      await save()
    },

    async drain(send, now = Date.now()) {
      const delivered: Delivered[] = []
      for (const entry of [...entries]) {
        if (entry.nextAt > now) continue
        try {
          const messageID = await send(entry.envelope)
          entries.splice(entries.indexOf(entry), 1)
          delivered.push({ envelope: entry.envelope, messageID })
        } catch (error) {
          entry.attempts += 1
          if (entry.attempts >= MAX_ATTEMPTS) {
            entries.splice(entries.indexOf(entry), 1)
            log?.error({ error, id: entry.envelope.id, attempts: entry.attempts }, "send gave up after retries")
          } else {
            entry.nextAt = now + retryDelayMs(entry.attempts)
            log?.warn({ id: entry.envelope.id, attempts: entry.attempts }, "send failed, retry scheduled")
          }
        }
        await save()
      }
      return delivered
    },

    pending() {
      return entries
    },

    async stop() {
      await queue
    },
  }
}
