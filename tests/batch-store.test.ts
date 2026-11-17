import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { describe, expect, it } from "vitest"
import { BATCH_FILE, createBatchWriter, loadBatches } from "../src/batch-store.js"
import { PassBatcher } from "../src/batching.js"
import type { Envelope } from "../src/envelope.js"

const log = pino({ level: "silent" })
const tempDir = () => mkdtemp(join(tmpdir(), "relay-batches-"))

const pass = (id: string, text: string, sessionID = "s1"): Envelope => ({
  id,
  category: "passCompleted",
  text,
  createdAt: 0,
  sessionID,
})

const batcher = () => new PassBatcher({ mode: "batch", debounceMs: 1000, maxWaitMs: 5000 })

describe("batch persistence", () => {
  it("round-trips pending batches through batches.json", async () => {
    const dir = await tempDir()
    const before = batcher()
    before.push(pass("a", "a"), 0)
    before.push(pass("b", "b"), 10)

    const writer = createBatchWriter(dir, log, 0)
    writer.save(before.snapshot())
    await writer.stop()

    const after = batcher()
    after.restore(await loadBatches(dir, log))
    const flushed = after.flush()
    expect(flushed).toHaveLength(1)
    expect(flushed[0]?.text).toBe("a\nb")
  })

  it("writes the latest state once per throttle window", async () => {
    const dir = await tempDir()
    const writer = createBatchWriter(dir, log, 60)
    const first = batcher()
    first.push(pass("a", "first"), 0)
    writer.save(first.snapshot())

    const second = batcher()
    second.push(pass("b", "second"), 10)
    writer.save(second.snapshot())
    await new Promise((resolve) => setTimeout(resolve, 150))

    const state = await loadBatches(dir, log)
    expect(state.s1?.items.map((item) => item.text)).toEqual(["second"])
  })

  it("starts empty on a corrupt file and on a missing one", async () => {
    const dir = await tempDir()
    expect(await loadBatches(dir, log)).toEqual({})

    await writeFile(join(dir, BATCH_FILE), "{ not json", "utf8")
    expect(await loadBatches(dir, log)).toEqual({})

    await writeFile(join(dir, BATCH_FILE), JSON.stringify({ s1: { firstAt: 0, lastAt: 0, items: [{ id: 1 }] } }), "utf8")
    expect(await loadBatches(dir, log)).toEqual({})
  })

  it("ignores restored state outside batch mode", () => {
    const immediate = new PassBatcher({ mode: "immediate", debounceMs: 1000, maxWaitMs: 5000 })
    immediate.restore({ s1: { firstAt: 0, lastAt: 0, items: [pass("a", "a")] } })
    expect(immediate.flush()).toEqual([])
  })
})
