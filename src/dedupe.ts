import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Envelope } from "./envelope.js"

export const DEDUPE_FILE = "dedupe.json"
const LIMIT = 1_000
/** A key older than this is forgotten, so a re-sent notice is not suppressed forever. */
export const DEDUPE_TTL_MS = 24 * 60 * 60 * 1_000

/** Bounded, persisted set of message IDs already handled, so a restart cannot answer twice. */
export interface DedupeStore {
  /** True the first time a key is seen, false for a repeat. */
  first(key: string): Promise<boolean>
  /** Whether the key was recorded, without recording it. */
  has(key: string): boolean
  stop(): Promise<void>
}

interface Entry {
  /** The dedupe key. */
  readonly k: string
  /** When it was recorded, in ms. */
  readonly t: number
}

async function load(file: string, ttlMs: number, now: () => number): Promise<Entry[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown
    if (!Array.isArray(parsed)) return []
    const at = now()
    return parsed.flatMap((entry): Entry[] => {
      // an older file held bare keys: their 24h start at the first read, not at some past write
      if (typeof entry === "string") return [{ k: entry, t: at }]
      const { k, t } = (entry ?? {}) as { k?: unknown; t?: unknown }
      if (typeof k !== "string" || typeof t !== "number") return []
      return at - t < ttlMs ? [{ k, t }] : []
    })
  } catch {
    // missing or corrupt state is not worth a crash: dedupe is best-effort
    return []
  }
}

export async function createDedupeStore(
  dir = "auth-state",
  limit = LIMIT,
  options: { ttlMs?: number; now?: () => number } = {},
): Promise<DedupeStore> {
  const ttlMs = options.ttlMs ?? DEDUPE_TTL_MS
  const now = options.now ?? Date.now
  const file = join(dir, DEDUPE_FILE)
  const entries = await load(file, ttlMs, now)
  const times = new Map(entries.map(({ k, t }) => [k, t]))
  const order = entries.map(({ k }) => k)
  let queue: Promise<void> = Promise.resolve()

  const save = (): Promise<void> => {
    queue = queue.then(
      async () => {
        await mkdir(dir, { recursive: true })
        const tmp = `${file}.tmp`
        const fresh = order.flatMap((k) => {
          const t = times.get(k)
          return t === undefined ? [] : [{ k, t }]
        })
        await writeFile(tmp, `${JSON.stringify(fresh)}\n`, "utf8")
        await rename(tmp, file)
      },
      async () => undefined,
    )
    return queue
  }

  const live = (key: string): boolean => {
    const at = times.get(key)
    return at !== undefined && now() - at < ttlMs
  }

  return {
    async first(key) {
      if (live(key)) return false
      if (times.delete(key)) {
        const index = order.indexOf(key)
        if (index >= 0) order.splice(index, 1)
      }
      times.set(key, now())
      order.push(key)
      while (order.length > limit) {
        const oldest = order.shift()
        if (oldest !== undefined) times.delete(oldest)
      }
      await save()
      return true
    },
    has(key) {
      return live(key)
    },
    async stop() {
      await queue
    },
  }
}

/**
 * Content identity of one envelope on one transport: category, session, the interaction it answers
 * and the text. Random envelope IDs cannot survive a restart, the content does.
 */
export function contentKey(transport: string, envelope: Envelope): string {
  const interaction = envelope.interaction?.formID ?? envelope.interaction?.permissionID ?? ""
  const digest = createHash("sha256").update(envelope.text).digest("hex")
  return `content:${transport}:${envelope.category}:${envelope.sessionID ?? ""}:${interaction}:${digest}`
}

/** Same content that already landed on a transport must not be sent again. */
export interface ContentGuard {
  /**
   * Claims the content for this transport: true when the caller may send, false when it already
   * landed or another send holds it. Synchronous on purpose: two flushes in one tick both reach the
   * check before either send lands, and only the first may proceed.
   */
  claim(transport: string, envelope: Envelope): boolean
  /** The send landed: records it, so a restart or a retry cannot repeat it. */
  commit(transport: string, envelope: Envelope): Promise<void>
  /** The send failed: drops the claim, so the retry may go again. */
  release(transport: string, envelope: Envelope): void
}

export function createContentGuard(store: DedupeStore): ContentGuard {
  // claimed but not yet delivered: in memory only, so a crash leaves nothing half-recorded
  const pending = new Set<string>()
  return {
    claim(transport, envelope) {
      // an image is a deliberate send: two identical screenshots are not a repeated notice
      if (envelope.image !== undefined) return true
      const key = contentKey(transport, envelope)
      if (pending.has(key) || store.has(key)) return false
      pending.add(key)
      return true
    },
    async commit(transport, envelope) {
      if (envelope.image !== undefined) return
      const key = contentKey(transport, envelope)
      try {
        await store.first(key)
      } catch {
        // bookkeeping only: a state write must never fail a send that already landed
      } finally {
        pending.delete(key)
      }
    },
    release(transport, envelope) {
      if (envelope.image !== undefined) return
      pending.delete(contentKey(transport, envelope))
    },
  }
}
