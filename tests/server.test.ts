import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createCorrelationStore } from "../src/interactions/correlation.js"
import { createPairForm, serverEndpoint } from "../src/pairing.js"

interface Call {
  readonly url: string
  readonly init: RequestInit
}

/** A stub fetch: `answer` decides per URL, an Error answer rejects like a dead port. */
const stub = (answer: (url: string) => Response | Error) => {
  const calls: Call[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const result = answer(String(url))
    if (result instanceof Error) throw result
    return result
  }) as typeof fetch
  return { calls, fetchImpl }
}

const stateDir = (): Promise<string> => mkdtemp(join(tmpdir(), "relay-server-"))

/** Writes the registration file a service-shaped `opencode serve` leaves behind. */
const register = async (state: string, info: Record<string, unknown>): Promise<void> => {
  await mkdir(join(state, "opencode"), { recursive: true })
  await writeFile(join(state, "opencode", "service.json"), JSON.stringify(info), "utf8")
}

const ok = (body = "{}"): Response => new Response(body, { status: 200 })
const headers = (call: Call | undefined): Record<string, string> => call?.init.headers as Record<string, string>

describe("server discovery", () => {
  it("takes OPENCODE_SERVER_URL without a network request", async () => {
    const state = await stateDir()
    const { calls, fetchImpl } = stub(() => new Error("no request expected"))

    const endpoint = await serverEndpoint({
      env: { XDG_STATE_HOME: state, OPENCODE_SERVER_URL: "http://127.0.0.1:5555" },
      fetchImpl,
    })

    expect(endpoint).toEqual({ url: "http://127.0.0.1:5555", headers: {} })
    expect(calls).toHaveLength(0)
  })

  it("carries the registration's Basic auth onto the OPENCODE_SERVER_URL override", async () => {
    const state = await stateDir()
    await register(state, { url: "http://127.0.0.1:28894", password: "s3cret" })
    const { calls, fetchImpl } = stub(() => new Error("no request expected"))
    const auth = `Basic ${Buffer.from("opencode:s3cret").toString("base64")}`

    const local = await serverEndpoint({
      env: { XDG_STATE_HOME: state, OPENCODE_SERVER_URL: "http://127.0.0.1:5555" },
      fetchImpl,
    })
    // a remote override never gets the local password
    const remote = await serverEndpoint({
      env: { XDG_STATE_HOME: state, OPENCODE_SERVER_URL: "https://opencode.example.com" },
      fetchImpl,
    })

    expect(local.headers.authorization).toBe(auth)
    expect(remote.headers.authorization).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it("uses the registered ephemeral URL and its password", async () => {
    const state = await stateDir()
    await register(state, { url: "http://127.0.0.1:28894", password: "s3cret" })
    const { calls, fetchImpl } = stub(() => ok())

    const endpoint = await serverEndpoint({ env: { XDG_STATE_HOME: state }, fetchImpl })

    expect(endpoint.url).toBe("http://127.0.0.1:28894")
    expect(endpoint.headers.authorization).toBe(`Basic ${Buffer.from("opencode:s3cret").toString("base64")}`)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("http://127.0.0.1:28894/api/info")
  })

  it("posts the pair form to the registered URL with the registration's auth", async () => {
    const state = await stateDir()
    await register(state, { url: "http://127.0.0.1:28894", password: "s3cret" })
    const { calls, fetchImpl } = stub((url) =>
      url.endsWith("/api/info") ? ok() : ok(JSON.stringify({ data: { id: "frm_1" } })),
    )
    const store = await createCorrelationStore(join(state, "auth-state"))

    await createPairForm({ store, sessionID: "ses_1", env: { XDG_STATE_HOME: state }, fetchImpl })

    expect(calls[1]?.url).toBe("http://127.0.0.1:28894/api/session/ses_1/form")
    expect(headers(calls[1]).authorization).toBe(`Basic ${Buffer.from("opencode:s3cret").toString("base64")}`)
    expect(headers(calls[1])["content-type"]).toBe("application/json")
  })

  it("falls through a stale registration into a bounded probe, first port that answers wins", async () => {
    const state = await stateDir()
    await register(state, { url: "http://127.0.0.1:1", password: "old" })
    const { calls, fetchImpl } = stub((url) =>
      url.startsWith("http://127.0.0.1:28894/") ? ok() : new Response(null, { status: 404 }),
    )

    const endpoint = await serverEndpoint({ env: { XDG_STATE_HOME: state }, fetchImpl })

    expect(endpoint.url).toBe("http://127.0.0.1:28894")
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:1/api/info",
      "http://127.0.0.1:4096/api/info",
      "http://127.0.0.1:28894/api/info",
    ])
    // the registration's auth is carried onto the probe too, or an auth-protected port would 401
    expect(calls.every((call) => headers(call).authorization === `Basic ${Buffer.from("opencode:old").toString("base64")}`)).toBe(true)
    // every attempt is aborted on its own, so a hung port cannot stall the reply
    expect(calls.every((call) => call.init.signal instanceof AbortSignal)).toBe(true)
  })

  it("says to set OPENCODE_SERVER_URL when nothing answers", async () => {
    const state = await stateDir()
    const { calls, fetchImpl } = stub(() => new Error("ECONNREFUSED"))

    await expect(serverEndpoint({ env: { XDG_STATE_HOME: state }, fetchImpl })).rejects.toThrow(
      "OPENCODE_SERVER_URL",
    )
    expect(calls).toHaveLength(2)
  })
})
