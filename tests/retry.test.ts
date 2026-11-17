import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Envelope } from "../src/envelope.js"
import { createRetryQueue, MAX_ATTEMPTS, retryDelayMs } from "../src/retry.js"

const tempDir = () => mkdtemp(join(tmpdir(), "relay-retry-"))
const envelope = (id: string): Envelope => ({ id, category: "errors", text: "boom", createdAt: 0 })

const failing = () => {
  const state = { attempts: 0 }
  const send = async (): Promise<string> => {
    state.attempts += 1
    throw new Error("offline")
  }
  return { state, send }
}

describe("retry queue", () => {
  it("doubles the delay per attempt and caps it", () => {
    expect(retryDelayMs(1)).toBe(5_000)
    expect(retryDelayMs(2)).toBe(10_000)
    expect(retryDelayMs(9)).toBe(60_000)
  })

  it("waits for the backoff before retrying and drops the envelope after the last attempt", async () => {
    const queue = await createRetryQueue(await tempDir(), "test")
    const { state, send } = failing()
    const start = 1_000
    await queue.enqueue(envelope("e1"), start)

    await queue.drain(send, start)
    expect(state.attempts).toBe(1)
    expect(queue.pending()[0]?.attempts).toBe(1)
    expect(queue.pending()[0]?.nextAt).toBe(start + retryDelayMs(1))

    await queue.drain(send, start + 1)
    expect(state.attempts).toBe(1)

    let at = start + retryDelayMs(1)
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      await queue.drain(send, at)
      at += retryDelayMs(attempt)
    }

    expect(state.attempts).toBe(MAX_ATTEMPTS)
    expect(queue.pending()).toHaveLength(0)
  })

  it("returns what went through so the caller can record the message ID", async () => {
    const queue = await createRetryQueue(await tempDir(), "test")
    const failed = envelope("e1")
    await queue.enqueue(failed, 0)

    const delivered = await queue.drain(async () => "wamid.1", 0)

    expect(delivered).toEqual([{ envelope: failed, messageID: "wamid.1" }])
    expect(queue.pending()).toHaveLength(0)
  })

  it("persists across instances", async () => {
    const dir = await tempDir()
    const first = await createRetryQueue(dir, "test")
    await first.enqueue(envelope("e1"), 0)
    await first.stop()

    const reopened = await createRetryQueue(dir, "test")
    expect(reopened.pending().map((entry) => entry.envelope.id)).toEqual(["e1"])
  })

  it("stays bounded, dropping the oldest envelope", async () => {
    const queue = await createRetryQueue(await tempDir(), "test")
    for (let i = 0; i < 101; i++) await queue.enqueue(envelope(`e${i}`), 0)

    const pending = queue.pending()
    expect(pending).toHaveLength(100)
    expect(pending[0]?.envelope.id).toBe("e1")
  })

  it("keeps image bytes across a reload, which JSON alone would flatten", async () => {
    const dir = await tempDir()
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const first = await createRetryQueue(dir, "test")
    await first.enqueue({ ...envelope("e1"), image: { bytes, name: "a.png" } }, 0)
    await first.stop()

    const reopened = await createRetryQueue(dir, "test")
    const restored = reopened.pending()[0]?.envelope.image?.bytes

    expect(Buffer.from(restored ?? []).equals(bytes)).toBe(true)
  })
})
