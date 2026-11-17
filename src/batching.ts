import type { Envelope } from "./envelope.js"

export type PassMode = "immediate" | "batch" | "final_only"

export interface BatcherOptions {
  readonly mode: PassMode
  readonly debounceMs: number
  readonly maxWaitMs: number
}

/** One session's pending pass batch. Also the on-disk shape in `auth-state/batches.json`. */
export interface PendingBatch {
  readonly firstAt: number
  lastAt: number
  readonly items: Envelope[]
}

/** Pending batches keyed by sessionID ("" for events without a session). */
export type BatchState = Readonly<Record<string, PendingBatch>>

/** Events that flush the session's pending pass batch before they go out themselves. */
const FLUSHES: ReadonlySet<string> = new Set([
  "taskCompleted",
  "questions",
  "permissions",
  // final_only owns no timer: without these, an error or an interrupted session would rot its batch
  "errors",
  "sessionInterrupted",
])

/**
 * Per-session accumulator for `passCompleted` envelopes. Pure: the caller passes `now` and
 * owns any timer (see `nextDeadline`). One merged envelope is emitted per flush.
 */
export class PassBatcher {
  private readonly pending = new Map<string, PendingBatch>()

  constructor(private readonly options: BatcherOptions) {}

  /** Route one envelope. Returns the envelopes to send now, in order. */
  push(envelope: Envelope, now: number): Envelope[] {
    if (envelope.category === "passCompleted" && this.options.mode !== "immediate") {
      const key = envelope.sessionID ?? ""
      const batch = this.pending.get(key) ?? { firstAt: now, lastAt: now, items: [] }
      // dedupe: identical text within one batch keeps a single envelope (and its id)
      if (!batch.items.some((item) => item.text === envelope.text)) batch.items.push(envelope)
      batch.lastAt = now
      this.pending.set(key, batch)
      return []
    }
    if (FLUSHES.has(envelope.category)) {
      const flushed = this.take(envelope.sessionID ?? "")
      return flushed === undefined ? [envelope] : [flushed, envelope]
    }
    return [envelope]
  }

  /** Flush batches whose debounce or maxWait has elapsed. No-op for immediate/final_only. */
  tick(now: number): Envelope[] {
    if (this.options.mode !== "batch") return []
    const due: Envelope[] = []
    for (const [key, batch] of this.pending) {
      if (now >= this.deadline(batch)) {
        const envelope = this.take(key)
        if (envelope !== undefined) due.push(envelope)
      }
    }
    return due
  }

  /** Milliseconds until the next batch is due, or null when nothing is pending. */
  nextDeadline(now: number): number | null {
    if (this.options.mode !== "batch") return null
    let next: number | null = null
    for (const batch of this.pending.values()) {
      const ms = this.deadline(batch) - now
      next = next === null ? ms : Math.min(next, ms)
    }
    return next === null ? null : Math.max(0, next)
  }

  /** Flush pending batches: one session when `sessionID` is given, otherwise all. */
  flush(sessionID?: string): Envelope[] {
    if (sessionID !== undefined) {
      const envelope = this.take(sessionID)
      return envelope === undefined ? [] : [envelope]
    }
    const flushed: Envelope[] = []
    for (const key of [...this.pending.keys()]) {
      const envelope = this.take(key)
      if (envelope !== undefined) flushed.push(envelope)
    }
    return flushed
  }

  /** Plain-JSON copy of the pending batches, for the durable store. */
  snapshot(): BatchState {
    return Object.fromEntries(
      [...this.pending].map(([key, batch]) => [key, { ...batch, items: [...batch.items] }]),
    )
  }

  /** Replace the pending batches with persisted state. Ignored outside batch mode. */
  restore(state: BatchState): void {
    if (this.options.mode !== "batch") return
    this.pending.clear()
    for (const [key, batch] of Object.entries(state)) this.pending.set(key, batch)
  }

  private deadline(batch: PendingBatch): number {
    return Math.min(batch.lastAt + this.options.debounceMs, batch.firstAt + this.options.maxWaitMs)
  }

  private take(key: string): Envelope | undefined {
    const batch = this.pending.get(key)
    if (batch === undefined) return undefined
    this.pending.delete(key)
    const [first] = batch.items
    if (first === undefined) return undefined
    return { ...first, text: batch.items.map((item) => item.text).join("\n") }
  }
}
