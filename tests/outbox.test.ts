import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { describe, expect, it } from "vitest"
import type { Envelope } from "../src/envelope.js"
import { createOutbox, OUTBOX_SENT } from "../src/outbox.js"

const log = pino({ level: "silent" })
const PNG = Buffer.from("89504e470d0a1a0a", "hex")

const outbox = async (send: (envelope: Envelope) => Promise<unknown>) => {
  const dir = await mkdtemp(join(tmpdir(), "relay-outbox-"))
  return { dir, drain: createOutbox({ dir, send, log }).drain }
}

describe("outbox pickup", () => {
  it("sends a new image once with the file name as caption, then retires it", async () => {
    const sent: Envelope[] = []
    const { dir, drain } = await outbox(async (envelope) => {
      sent.push(envelope)
    })
    const name = "Screenshot 2026-01-01 120000.png"
    await writeFile(join(dir, name), PNG)

    expect(await drain()).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.image).toMatchObject({ path: join(dir, name), caption: name })
    expect(await readdir(join(dir, OUTBOX_SENT))).toHaveLength(1)
    // delivered once means once: the next tick has nothing to do
    expect(await drain()).toBe(0)
    expect(sent).toHaveLength(1)
  })

  it("ignores files that are not images", async () => {
    const { dir, drain } = await outbox(async () => undefined)
    await writeFile(join(dir, "notes.txt"), "hi")

    expect(await drain()).toBe(0)
  })

  it("keeps a failed image for the next tick", async () => {
    let failing = true
    const { dir, drain } = await outbox(async () => {
      if (failing) throw new Error("boom")
    })
    await writeFile(join(dir, "a.png"), PNG)

    expect(await drain()).toBe(0)
    failing = false
    expect(await drain()).toBe(1)
  })

  it("does nothing when the folder does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-outbox-"))
    const dir = join(root, "missing")
    await mkdir(root, { recursive: true })

    expect(await createOutbox({ dir, send: async () => undefined, log }).drain()).toBe(0)
  })
})
