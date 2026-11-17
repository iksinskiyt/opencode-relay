import { describe, expect, it } from "vitest"
import { PassBatcher, type PassMode } from "../src/batching.js"
import type { Envelope } from "../src/envelope.js"

const envelope = (id: string, category: Envelope["category"], text: string, sessionID = "s1"): Envelope => ({
  id,
  category,
  text,
  createdAt: 0,
  sessionID,
})

const pass = (id: string, text: string, sessionID = "s1") => envelope(id, "passCompleted", text, sessionID)

const create = (mode: PassMode = "batch") =>
  new PassBatcher({ mode, debounceMs: 1000, maxWaitMs: 5000 })

describe("PassBatcher", () => {
  it("passes envelopes straight through in immediate mode", () => {
    const batcher = create("immediate")
    expect(batcher.push(pass("a", "a"), 0)).toHaveLength(1)
    expect(batcher.tick(10000)).toEqual([])
    expect(batcher.nextDeadline(0)).toBeNull()
  })

  it("flushes a pass batch after the debounce, reset by each new pass", () => {
    const batcher = create()
    expect(batcher.push(pass("a", "a"), 0)).toEqual([])
    expect(batcher.push(pass("b", "b"), 500)).toEqual([])
    expect(batcher.nextDeadline(500)).toBe(1000)
    expect(batcher.tick(1499)).toEqual([])
    const flushed = batcher.tick(1500)
    expect(flushed).toHaveLength(1)
    expect(flushed[0]?.id).toBe("a")
    expect(flushed[0]?.text).toBe("a\nb")
    expect(batcher.tick(1500)).toEqual([])
  })

  it("force-flushes at maxWait when passes keep resetting the debounce", () => {
    const batcher = create()
    batcher.push(pass("a", "a"), 0)
    batcher.push(pass("b", "b"), 4900)
    expect(batcher.tick(4999)).toEqual([])
    expect(batcher.tick(5000)).toHaveLength(1)
  })

  it("flushes the session batch before taskCompleted/questions/permissions", () => {
    const batcher = create()
    batcher.push(pass("a", "a"), 0)
    const out = batcher.push(envelope("c", "taskCompleted", "done"), 10)
    expect(out.map((item) => item.category)).toEqual(["passCompleted", "taskCompleted"])
    expect(batcher.nextDeadline(10)).toBeNull()
  })

  it("never batches questions or permissions", () => {
    const batcher = create()
    expect(batcher.push(envelope("q", "questions", "?"), 0)).toHaveLength(1)
    expect(batcher.push(envelope("p", "permissions", "ok?"), 0)).toHaveLength(1)
    expect(batcher.nextDeadline(0)).toBeNull()
  })

  it("dedupes identical text inside one batch and keeps the first id", () => {
    const batcher = create()
    batcher.push(pass("a", "same"), 0)
    batcher.push(pass("b", "same"), 10)
    const flushed = batcher.tick(5000)
    expect(flushed).toHaveLength(1)
    expect(flushed[0]?.id).toBe("a")
    expect(flushed[0]?.text).toBe("same")
  })

  it("final_only waits for a flush event and owns no timer", () => {
    const batcher = create("final_only")
    batcher.push(pass("a", "a"), 0)
    expect(batcher.tick(100000)).toEqual([])
    expect(batcher.nextDeadline(0)).toBeNull()
    expect(batcher.push(envelope("c", "taskCompleted", "done"), 10)).toHaveLength(2)
  })

  it("final_only flushes the batch before an error or an interrupted session", () => {
    const batcher = create("final_only")
    batcher.push(pass("a", "a"), 0)

    const onError = batcher.push(envelope("e", "errors", "boom"), 10)
    expect(onError.map((item) => item.category)).toEqual(["passCompleted", "errors"])

    batcher.push(pass("b", "b"), 20)
    const onInterrupt = batcher.push(envelope("i", "sessionInterrupted", "stopped"), 30)
    expect(onInterrupt.map((item) => item.category)).toEqual(["passCompleted", "sessionInterrupted"])
  })

  it("flush() drains every session when none is named", () => {
    const batcher = create()
    batcher.push(pass("a", "a", "s1"), 0)
    batcher.push(pass("b", "b", "s2"), 0)
    expect(batcher.flush().map((item) => item.sessionID)).toEqual(["s1", "s2"])
    expect(batcher.flush()).toEqual([])
  })
})
