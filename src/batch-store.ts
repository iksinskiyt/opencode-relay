import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Logger } from "pino"
import type { BatchState, PendingBatch } from "./batching.js"
import { CATEGORIES, type Category, type Envelope } from "./envelope.js"

export const BATCH_FILE = "batches.json"

/** Pending batches survive a restart: missing file is normal, corrupt starts empty with a warning. */
export async function loadBatches(dir: string, log: Logger): Promise<BatchState> {
  try {
    return sanitize(JSON.parse(await readFile(join(dir, BATCH_FILE), "utf8")))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn({ error }, "batches.json unreadable, starting with no pending batches")
    }
    return {}
  }
}

export interface BatchWriter {
  /** Coalesced: at most one write per `throttleMs`, and the latest state always lands. */
  save(state: BatchState): void
  /** Write the latest state now and wait for pending writes. */
  stop(): Promise<void>
}

/** Throttled, serialised, atomic writer for `batches.json`. */
export function createBatchWriter(dir: string, log: Logger, throttleMs = 1_000): BatchWriter {
  const file = join(dir, BATCH_FILE)
  let latest: BatchState = {}
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastWrite = 0
  let queue: Promise<void> = Promise.resolve()

  const write = (): Promise<void> => {
    const state = latest
    // serialise so two writes cannot fight over the temp file; a failed write never blocks the next
    queue = queue
      .then(
        async () => {
          await mkdir(dir, { recursive: true })
          await writeFile(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`, "utf8")
          await rename(`${file}.tmp`, file)
        },
        async () => undefined,
      )
      .catch((error: unknown) => log.warn({ error }, "batches.json write failed"))
    return queue
  }

  const flush = (): void => {
    timer = undefined
    lastWrite = Date.now()
    void write()
  }

  return {
    save(state) {
      latest = state
      const wait = lastWrite + throttleMs - Date.now()
      if (wait <= 0) {
        flush()
        return
      }
      timer ??= setTimeout(flush, wait)
      timer.unref?.()
    },
    async stop() {
      if (timer !== undefined) {
        clearTimeout(timer)
        flush()
      }
      await queue
    },
  }
}

/** Drop entries that do not look like a batch: old files must never inject junk into the batcher. */
function sanitize(raw: unknown): BatchState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
  const state: Record<string, PendingBatch> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (isBatch(value)) state[key] = value
  }
  return state
}

function isBatch(value: unknown): value is PendingBatch {
  if (typeof value !== "object" || value === null) return false
  const { firstAt, lastAt, items } = value as Record<string, unknown>
  return (
    typeof firstAt === "number" &&
    typeof lastAt === "number" &&
    Array.isArray(items) &&
    items.length > 0 &&
    items.every(isEnvelope)
  )
}

export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) return false
  const { id, category, text, createdAt, sessionID } = value as Record<string, unknown>
  return (
    typeof id === "string" &&
    typeof text === "string" &&
    typeof createdAt === "number" &&
    CATEGORIES.includes(category as Category) &&
    (sessionID === undefined || typeof sessionID === "string")
  )
}
