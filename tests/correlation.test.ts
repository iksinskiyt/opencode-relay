import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createCorrelationStore, DEFAULT_TTL_MS, type PendingInput } from "../src/interactions/correlation.js"

const tempDir = () => mkdtemp(join(tmpdir(), "relay-correlation-"))

const input = (overrides: Partial<PendingInput> = {}): PendingInput => ({
  provider: "discord",
  externalUserID: "user-1",
  chatID: "chat-1",
  messageID: "msg-1",
  sessionID: "ses-1",
  type: "permission",
  permissionID: "per_1",
  ...overrides,
})

describe("correlation store", () => {
  it("resolves the newest live prompt for an identity", async () => {
    const store = await createCorrelationStore(await tempDir())
    await store.add(input())
    await store.add(input({ messageID: "msg-2", type: "form", formID: "frm_1" }))

    const found = store.resolve("discord", "user-1", "chat-1")
    expect(found?.messageID).toBe("msg-2")
    expect(found?.formID).toBe("frm_1")
    expect(store.resolve("discord", "user-1", "chat-2")).toBeUndefined()
  })

  it("falls back to the newest prompt in the chat when the sender differs", async () => {
    const store = await createCorrelationStore(await tempDir())
    await store.add(input())

    // Discord reports the message author, which is not the channel the prompt went to
    expect(store.resolve("discord", "someone-else", "chat-1")?.messageID).toBe("msg-1")
    expect(store.resolve("slack", "someone-else", "chat-1")).toBeUndefined()
  })

  it("dedupes on messageID", async () => {
    const store = await createCorrelationStore(await tempDir())
    const first = await store.add(input())
    const second = await store.add(input({ sessionID: "ses-2" }))

    expect(store.list()).toHaveLength(1)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.sessionID).toBe("ses-1")
  })

  it("completes a prompt once and keeps the status", async () => {
    const dir = await tempDir()
    const store = await createCorrelationStore(dir)
    await store.add(input())

    expect((await store.complete("msg-1"))?.status).toBe("resolved")
    expect(await store.complete("missing")).toBeUndefined()

    const reloaded = await createCorrelationStore(dir)
    expect(reloaded.get("msg-1")?.status).toBe("resolved")
    expect(reloaded.resolve("discord", "user-1", "chat-1")).toBeUndefined()
  })

  it("reports a just-expired prompt for the chat, even before the tick marks it", async () => {
    let clock = 1_000
    const store = await createCorrelationStore(await tempDir(), () => clock)
    await store.add(input({ type: "form", formID: "frm_1" }), 500)

    clock += 600
    // no expire() call: the answer path must not depend on the housekeeping tick
    expect(store.resolve("discord", "user-1", "chat-1")).toBeUndefined()
    expect(store.lastExpired("discord", "user-1", "chat-1")?.messageID).toBe("msg-1")

    // only a short grace window: an old prompt must not swallow ordinary messages
    clock += 11 * 60 * 1000
    expect(store.lastExpired("discord", "user-1", "chat-1")).toBeUndefined()
  })

  it("settles the transport prompt of a form answered elsewhere", async () => {
    const store = await createCorrelationStore(await tempDir())
    await store.add(input({ type: "form", formID: "frm_1", permissionID: undefined }))
    await store.add(input({ messageID: "msg-2", type: "form", formID: "frm_1", permissionID: undefined }))
    await store.add(input({ messageID: "msg-3", type: "form", formID: "frm_2", permissionID: undefined }))

    // the two prompts for that form die, the other form and the unmatched id keep going
    expect(await store.settleForm("frm_1")).toBe(2)
    expect(store.get("msg-1")?.status).toBe("resolved")
    expect(store.get("msg-2")?.status).toBe("resolved")
    expect(store.get("msg-3")?.status).toBe("pending")
    expect(await store.settleForm("frm_1")).toBe(0)
    expect(await store.settleForm("frm_missing")).toBe(0)
  })

  it("expires prompts past their ttl", async () => {
    const dir = await tempDir()
    let clock = 1_000
    const store = await createCorrelationStore(dir, () => clock)
    await store.add(input(), 500)

    expect(await store.expire()).toBe(0)
    clock += 600
    expect(await store.expire()).toBe(1)
    expect(store.get("msg-1")?.status).toBe("expired")
    expect(store.resolve("discord", "user-1", "chat-1")).toBeUndefined()

    const persisted = JSON.parse(await readFile(join(dir, "interactions.json"), "utf8")) as Array<{
      status: string
    }>
    expect(persisted[0]?.status).toBe("expired")
  })

  it("persists across instances and drops settled records after retention", async () => {
    const dir = await tempDir()
    let clock = 1_000
    const store = await createCorrelationStore(dir, () => clock)
    await store.add(input())
    const reopened = await createCorrelationStore(dir, () => clock)
    expect(reopened.get("msg-1")?.expiresAt).toBe(1_000 + DEFAULT_TTL_MS)

    await reopened.complete("msg-1")
    clock += DEFAULT_TTL_MS + 2 * 60 * 60 * 1000
    expect(await reopened.expire()).toBe(0)
    expect(reopened.list()).toHaveLength(0)
  })
})
