import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createDedupeStore, createContentGuard, DEDUPE_FILE } from "../src/dedupe.js"
import type { Envelope } from "../src/envelope.js"

const tempDir = () => mkdtemp(join(tmpdir(), "relay-dedupe-"))

const notice = (text: string, id = "e1"): Envelope => ({ id, category: "passCompleted", text, createdAt: 0 })

describe("dedupe store", () => {
  it("answers true once per key", async () => {
    const store = await createDedupeStore(await tempDir())

    expect(await store.first("discord:1")).toBe(true)
    expect(await store.first("discord:1")).toBe(false)
    expect(await store.first("discord:2")).toBe(true)
  })

  it("persists across instances", async () => {
    const dir = await tempDir()
    const store = await createDedupeStore(dir)
    await store.first("discord:1")
    await store.stop()

    const reopened = await createDedupeStore(dir)
    expect(await reopened.first("discord:1")).toBe(false)
    expect(await reopened.first("discord:2")).toBe(true)
  })

  it("stays bounded and forgets the oldest key first", async () => {
    const store = await createDedupeStore(await tempDir(), 2)
    await store.first("a")
    await store.first("b")
    await store.first("c")

    expect(await store.first("a")).toBe(true)
    expect(await store.first("c")).toBe(false)
  })

  it("forgets a key once the ttl has passed", async () => {
    let now = 1_000
    const dir = await tempDir()
    const store = await createDedupeStore(dir, undefined, { ttlMs: 100, now: () => now })
    await store.first("discord:1")

    now += 99
    expect(await store.first("discord:1")).toBe(false)
    now += 2
    expect(store.has("discord:1")).toBe(false)
    expect(await store.first("discord:1")).toBe(true)

    // the refreshed entry is what a restart reads back
    await store.stop()
    const reopened = await createDedupeStore(dir, undefined, { ttlMs: 100, now: () => now })
    expect(await reopened.first("discord:1")).toBe(false)
  })

  it("keeps recording keys of an older file, timed from the first read", async () => {
    const dir = await tempDir()
    await writeFile(join(dir, DEDUPE_FILE), `${JSON.stringify(["discord:1"])}\n`, "utf8")

    const store = await createDedupeStore(dir)
    expect(await store.first("discord:1")).toBe(false)
  })
})

describe("content guard", () => {
  it("drops the same text after a restart and lets different text through", async () => {
    const dir = await tempDir()
    const before = createContentGuard(await createDedupeStore(dir))
    expect(before.claim("whatsapp", notice("Session ses_1 finished a pass"))).toBe(true)
    await before.commit("whatsapp", notice("Session ses_1 finished a pass"))
    expect(before.claim("whatsapp", notice("Session ses_1 finished a pass", "e2"))).toBe(false)

    // a restart: new store instance over the same auth-state
    const after = createContentGuard(await createDedupeStore(dir))
    expect(after.claim("whatsapp", notice("Session ses_1 finished a pass"))).toBe(false)
    expect(after.claim("whatsapp", notice("Session ses_1 finished its task"))).toBe(true)
  })

  it("keeps each transport and each interaction apart", async () => {
    const guard = createContentGuard(await createDedupeStore(await tempDir()))
    await guard.commit("whatsapp", notice("needs your permission"))

    expect(guard.claim("discord", notice("needs your permission"))).toBe(true)
    expect(
      guard.claim("whatsapp", {
        ...notice("needs your permission"),
        interaction: { type: "permission", permissionID: "per_2" },
      }),
    ).toBe(true)
  })

  it("never suppresses a repeated image", async () => {
    const guard = createContentGuard(await createDedupeStore(await tempDir()))
    const image: Envelope = { ...notice("build passed"), category: "message", image: { name: "shot.png" } }
    await guard.commit("whatsapp", image)

    expect(guard.claim("whatsapp", image)).toBe(true)
  })

  it("holds a claim until it is committed or released", async () => {
    const guard = createContentGuard(await createDedupeStore(await tempDir()))

    // two flushes in one tick: the second one is a duplicate before the first has even landed
    expect(guard.claim("whatsapp", notice("finished a pass"))).toBe(true)
    expect(guard.claim("whatsapp", notice("finished a pass", "e2"))).toBe(false)

    // the send failed, so the claim goes back and a retry may use it
    guard.release("whatsapp", notice("finished a pass"))
    expect(guard.claim("whatsapp", notice("finished a pass", "e2"))).toBe(true)
  })

  it("re-allows the same text once the ttl has passed", async () => {
    let now = 0
    const dir = await tempDir()
    const store = await createDedupeStore(dir, undefined, { ttlMs: 1_000, now: () => now })
    const guard = createContentGuard(store)
    await guard.commit("whatsapp", notice("finished a pass"))

    now += 1_001
    expect(guard.claim("whatsapp", notice("finished a pass"))).toBe(true)
  })
})
