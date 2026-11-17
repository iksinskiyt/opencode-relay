import { mkdir, readdir, rename, stat } from "node:fs/promises"
import { join } from "node:path"
import type { Logger } from "pino"
import type { Envelope } from "./envelope.js"
import { isImagePath, WHATSAPP_MAX_IMAGE_BYTES } from "./image.js"

/** `auth-state/outbox`: any image dropped here is sent once on the next tick. */
export const OUTBOX = "outbox"
/** Where a delivered (or definitively unusable) outbox file goes, so it never sends twice. */
export const OUTBOX_SENT = "sent"

export interface Outbox {
  /** Sends every new image in the folder, then moves it to `outbox/sent/`. Returns how many went out. */
  drain(now?: number): Promise<number>
}

/**
 * Tick-driven pickup: no watcher, no extra process. The caption is the file name, so a screenshot
 * arrives labelled instead of silently.
 */
export function createOutbox({
  dir,
  send,
  log,
}: {
  dir: string
  send: (envelope: Envelope) => Promise<unknown>
  log: Logger
}): Outbox {
  const move = async (name: string, path: string, now: number): Promise<void> => {
    const sent = join(dir, OUTBOX_SENT)
    await mkdir(sent, { recursive: true })
    // timestamped: two files with the same name must not overwrite each other in `sent/`
    await rename(path, join(sent, `${now}-${name}`))
  }

  return {
    async drain(now = Date.now()) {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch (error) {
        // no outbox folder is the normal case
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0
        log.warn({ error }, "outbox unreadable")
        return 0
      }
      let delivered = 0
      for (const name of names.filter(isImagePath).sort()) {
        const path = join(dir, name)
        const info = await stat(path).catch(() => undefined)
        if (info === undefined || !info.isFile()) continue
        if (info.size > WHATSAPP_MAX_IMAGE_BYTES) {
          // never sendable: retire it instead of retrying a 20 MB file on every tick
          log.warn({ name, bytes: info.size }, "outbox image too large, moved to sent/ unsent")
          await move(name, path, now)
          continue
        }
        try {
          await send({
            id: `outbox:${name}:${info.mtimeMs}`,
            category: "message",
            text: name,
            createdAt: now,
            image: { path, caption: name, name },
          })
          await move(name, path, now)
          delivered += 1
        } catch (error) {
          // a transport failure leaves the file for the next tick: it is retried, not lost
          log.error({ error, name }, "outbox image failed, retrying on the next tick")
        }
      }
      return delivered
    },
  }
}
