import { describe, expect, it } from "vitest"
import { boundedFetch, withDeadline } from "../src/timeout.js"

const hang = (() => new Promise<Response>(() => {})) as unknown as typeof fetch

describe("withDeadline", () => {
  it("rejects work that never settles", async () => {
    await expect(withDeadline(new Promise(() => {}), "socket call", 5)).rejects.toThrow(
      "socket call timed out after 5ms",
    )
  })

  it("passes a settled value through", async () => {
    expect(await withDeadline(Promise.resolve("done"), "fast", 50)).toBe("done")
  })
})

describe("boundedFetch", () => {
  it("fails a request that ignores its abort signal instead of hanging", async () => {
    await expect(boundedFetch(hang, 5)("https://example.test/slow")).rejects.toThrow("timed out")
  })

  it("hands every request an abort deadline", async () => {
    const seen: Array<RequestInit | undefined> = []
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(init)
      return new Response("{}")
    }) as typeof fetch

    await boundedFetch(fetchImpl, 50)("https://example.test/ok")

    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal)
  })
})
