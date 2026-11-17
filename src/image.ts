import { readFile, stat } from "node:fs/promises"
import { basename, extname } from "node:path"
import type { EnvelopeImage } from "./envelope.js"
import { boundedFetch } from "./timeout.js"

/** Discord's default per-file upload cap. */
export const DISCORD_MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** WhatsApp's image cap; anything bigger has to travel as a document. */
export const WHATSAPP_MAX_IMAGE_BYTES = 16 * 1024 * 1024

const MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

const mimeOf = (name: string): string | undefined => MIME[extname(name).toLowerCase()]

/** True for a file this relay sends as an image; the outbox pickup filters on it. */
export const isImagePath = (path: string): boolean => mimeOf(path) !== undefined

export interface LoadedImage {
  readonly name: string
  readonly mime: string
  readonly bytes: Buffer
}

const sizeText = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`

const tooBig = (bytes: number, limit: number): Error =>
  new Error(`image is ${sizeText(bytes)}, the limit is ${sizeText(limit)}`)

const nameOf = (image: EnvelopeImage, source: string): string => {
  if (image.name !== undefined && image.name !== "") return image.name
  try {
    return basename(source === "" ? "" : new URL(source).pathname) || "image.png"
  } catch {
    return basename(source) || "image.png"
  }
}

/** Loopback, link-local and RFC1918 literals: the addresses an SSRF would aim at. */
const localHost = (host: string): boolean =>
  host === "localhost" ||
  host === "::1" ||
  host === "0.0.0.0" ||
  /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)

/** path/url/bytes -> the bytes a transport uploads. Throws a reason the user can act on. */
export async function loadImage(
  image: EnvelopeImage,
  limit = DISCORD_MAX_IMAGE_BYTES,
  fetchImpl: typeof fetch = fetch,
  allowUrl = false,
): Promise<LoadedImage> {
  if (image.bytes !== undefined) {
    if (image.bytes.byteLength > limit) throw tooBig(image.bytes.byteLength, limit)
    const name = image.name ?? "image.png"
    return { name, mime: mimeOf(name) ?? "image/png", bytes: Buffer.from(image.bytes) }
  }
  if (image.path !== undefined) {
    const name = nameOf(image, image.path)
    if (!isImagePath(name)) throw new Error(`not an image: ${name} (png, jpg, jpeg, gif or webp)`)
    const info = await stat(image.path).catch(() => undefined)
    if (info === undefined || !info.isFile()) throw new Error(`no such file: ${image.path}`)
    if (info.size > limit) throw tooBig(info.size, limit)
    return { name, mime: mimeOf(name) ?? "image/png", bytes: await readFile(image.path) }
  }
  if (image.url !== undefined) {
    // the fetch runs on this machine: a URL from a chat or an attachment must not reach the LAN
    if (!allowUrl) throw new Error("image URLs are disabled (security.allowImageUrls)")
    const target = new URL(image.url)
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      throw new Error(`unsupported image URL scheme: ${target.protocol}`)
    }
    if (localHost(target.hostname)) throw new Error(`refusing a local image URL: ${target.hostname}`)
    const name = nameOf(image, image.url)
    const response = await boundedFetch(fetchImpl)(image.url)
    if (!response.ok) throw new Error(`image download failed: ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > limit) throw tooBig(bytes.byteLength, limit)
    return { name, mime: mimeOf(name) ?? response.headers.get("content-type") ?? "image/png", bytes }
  }
  throw new Error("image has no path, url or bytes")
}
