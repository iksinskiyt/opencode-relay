import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { isImagePath, loadImage } from "../src/image.js"

/** The PNG signature: enough for a loader that only looks at the extension and the size. */
const PNG = Buffer.from("89504e470d0a1a0a", "hex")

const file = async (name: string, bytes: Buffer = PNG): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "relay-image-"))
  const path = join(dir, name)
  await writeFile(path, bytes)
  return path
}

describe("loadImage", () => {
  it("reads a local image and derives its name and mime type", async () => {
    const path = await file("shot.png")

    expect(await loadImage({ path })).toMatchObject({ name: "shot.png", mime: "image/png" })
  })

  it("refuses a file that is not an image", async () => {
    const path = await file("notes.txt")

    await expect(loadImage({ path })).rejects.toThrow("not an image")
  })

  it("refuses a missing file", async () => {
    await expect(loadImage({ path: join(tmpdir(), "relay-nope.png") })).rejects.toThrow("no such file")
  })

  it("refuses a file over the transport cap", async () => {
    const path = await file("big.png", Buffer.alloc(2048))

    await expect(loadImage({ path }, 1024)).rejects.toThrow("the limit is 1 KB")
  })

  it("takes in-memory bytes as they are", async () => {
    const loaded = await loadImage({ bytes: PNG, name: "inline.jpg" })

    expect(loaded.mime).toBe("image/jpeg")
    expect(loaded.bytes.equals(PNG)).toBe(true)
  })

  it("downloads a URL through the given fetch only when URLs are allowed", async () => {
    const url = "https://example.test/a.webp"
    const fetched = (async () => new Response(PNG)) as typeof fetch

    await expect(loadImage({ url }, undefined, fetched)).rejects.toThrow("image URLs are disabled")
    const loaded = await loadImage({ url }, undefined, fetched, true)
    expect(loaded.name).toBe("a.webp")
    expect(loaded.mime).toBe("image/webp")
  })

  it("allows only http(s) URLs, and never a local address", async () => {
    const fetched = (async () => new Response(PNG)) as typeof fetch

    await expect(loadImage({ url: "file:///C:/secret.png" }, undefined, fetched, true)).rejects.toThrow(
      "unsupported image URL scheme",
    )
    await expect(loadImage({ url: "http://127.0.0.1/a.png" }, undefined, fetched, true)).rejects.toThrow(
      "refusing a local image URL",
    )
    await expect(loadImage({ url: "http://192.168.1.10/a.png" }, undefined, fetched, true)).rejects.toThrow(
      "refusing a local image URL",
    )
  })

  it("knows which files the outbox may pick up", () => {
    expect(isImagePath("shot.PNG")).toBe(true)
    expect(isImagePath("notes.txt")).toBe(false)
  })
})
