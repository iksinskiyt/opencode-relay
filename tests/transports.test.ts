import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import { configSchema } from "../src/config.js"
import { createContentGuard, createDedupeStore } from "../src/dedupe.js"
import type { Envelope } from "../src/envelope.js"
import { createCorrelationStore } from "../src/interactions/correlation.js"
import { createTransports } from "../src/router.js"

interface FakeSocket {
  ev: { on: (event: string, handler: (payload: never) => void) => void }
  sendMessage: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  user: { id: string; lid?: string; phoneNumber?: string }
  requestPairingCode: ReturnType<typeof vi.fn>
  groupCreate: ReturnType<typeof vi.fn>
  groupFetchAllParticipating: ReturnType<typeof vi.fn>
  emit: (event: string, payload: unknown) => void
}

const mock = vi.hoisted(() => {
  const sockets: FakeSocket[] = []
  const saveCreds = vi.fn(async () => undefined)
  const makeSocket = vi.fn(() => {
    const handlers: Record<string, Array<(payload: unknown) => void>> = {}
    const socket = {
      ev: {
        on: (event: string, handler: (payload: never) => void) => {
          ;(handlers[event] ??= []).push(handler)
        },
      },
      sendMessage: vi.fn(async () => ({ key: { id: "wamid.HBg" } })),
      end: vi.fn(),
      user: { id: "me@s.whatsapp.net" },
      requestPairingCode: vi.fn(async () => "M84BRQMD"),
      groupCreate: vi.fn(async () => ({ id: "1203630@g.us", subject: "Relay", participants: [] })),
      groupFetchAllParticipating: vi.fn(async () => ({}) as Record<string, unknown>),
      emit(event: string, payload: unknown) {
        for (const handler of handlers[event] ?? []) handler(payload)
      },
    }
    sockets.push(socket)
    return socket
  })
  return { sockets, saveCreds, makeSocket }
})

vi.mock("@whiskeysockets/baileys", () => ({
  default: mock.makeSocket,
  makeWASocket: mock.makeSocket,
  useMultiFileAuthState: vi.fn(async () => ({ state: {}, saveCreds: mock.saveCreds })),
  jidNormalizedUser: (jid: string | undefined) => jid ?? "",
  DisconnectReason: { loggedOut: 401 },
  Browsers: {
    baileys: (browser: string) => ["Baileys", browser, "6.5.0"],
    macOS: (browser: string) => ["Mac OS", browser, "14.4.1"],
  },
}))

const log = pino({ level: "silent" })
const example = JSON.parse(await readFile(new URL("../examples/config.example.json", import.meta.url), "utf8"))
const envelope = (text: string): Envelope => ({ id: "e1", category: "questions", text, createdAt: 0 })

const bothEnabled = () =>
  configSchema.parse({
    ...example,
    whatsapp: { enabled: true, selfChat: true },
    discord: { enabled: true, target: "channel", channelID: "42" },
    security: { allowlist: ["u1"] },
  })

interface Call {
  readonly url: string
  readonly method: string
  readonly body: unknown
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** Discord REST stub: queues the responses in order, then answers with a created message id. */
const fakeDiscord = (...responses: Response[]) => {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
    return responses.shift() ?? json({ id: "d1" })
  }) as typeof fetch
  return { calls, fetchImpl }
}

/** The transport is live from config; the socket only becomes usable once WhatsApp reports open. */
const openWhatsApp = async (): Promise<FakeSocket> => {
  await vi.waitFor(() => expect(mock.sockets).toHaveLength(1))
  const socket = mock.sockets[0] as FakeSocket
  socket.emit("connection.update", { connection: "open" })
  return socket
}

afterEach(() => {
  mock.sockets.length = 0
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe("multi-transport relay", () => {
  it("delivers every envelope to both live transports", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "relay-transports-"))
    const { calls, fetchImpl } = fakeDiscord(json({ id: "d1" }))
    const relay = await createTransports(bothEnabled(), log, { DISCORD_BOT_TOKEN: "t" }, { dataDir, fetchImpl })
    const socket = await openWhatsApp()

    const delivered = await relay.send(envelope("hi"))

    expect(delivered.map((item) => item.transport.name).sort()).toEqual(["discord", "whatsapp"])
    // every outbound text ends with a blank line, separating reports
    expect(socket.sendMessage).toHaveBeenCalledWith("me@s.whatsapp.net", { text: "hi\n\n" })
    const post = calls.find((call) => call.method === "POST")
    expect(post?.url).toBe("https://discord.com/api/v10/channels/42/messages")
    expect(post?.body).toEqual({ content: "hi\n\n" })
    await relay.stop()
  })

  it("keeps the other transport delivering when one fails, and queues the failure", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "relay-transports-"))
    const { fetchImpl } = fakeDiscord(new Response("boom", { status: 500 }))
    const relay = await createTransports(bothEnabled(), log, { DISCORD_BOT_TOKEN: "t" }, { dataDir, fetchImpl })
    const socket = await openWhatsApp()

    const delivered = await relay.send(envelope("hi"))

    expect(delivered.map((item) => item.transport.name)).toEqual(["whatsapp"])
    expect(socket.sendMessage).toHaveBeenCalledTimes(1)
    const discord = relay.transports.find((transport) => transport.name === "discord")
    expect(discord?.retry.pending()).toHaveLength(1)

    const retried = await relay.drain(Date.now() + 60_000)
    expect(retried.map((item) => item.transport.name)).toEqual(["discord"])
    expect(discord?.retry.pending()).toHaveLength(0)
    await relay.stop()
  })

  it("answers an inbound Discord message while WhatsApp is also live", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "relay-transports-"))
    const configPath = join(dataDir, "config.json")
    await writeFile(configPath, `${JSON.stringify(bothEnabled(), null, 2)}\n`, "utf8")
    const { calls, fetchImpl } = fakeDiscord(
      json([{ id: "8000", content: "old", author: { id: "u1" } }]),
      json([{ id: "9001", content: "/relay status", author: { id: "u1" } }]),
    )
    const store = await createCorrelationStore(dataDir)
    const relay = await createTransports(bothEnabled(), log, { DISCORD_BOT_TOKEN: "t" }, {
      dataDir,
      configPath,
      store,
      fetchImpl,
    })
    await openWhatsApp()
    expect(relay.statuses.map((status) => `${status.name}:${status.state}`)).toEqual([
      "whatsapp:live",
      "discord:live",
    ])

    await relay.poll()
    await relay.poll()

    const post = calls.find((call) => call.method === "POST")
    const text = (post?.body as { content?: string } | undefined)?.content ?? ""
    // the answer came from the Discord transport while WhatsApp was also live
    expect(text).toContain("provider: discord")
    expect(text).toContain("whatsapp: live")
    expect(text).toContain("discord: live")
    await relay.stop()
  })

  it("does not resend the same content after a restart, and still sends new text", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "relay-transports-"))
    const dedupe = await createDedupeStore(dataDir)
    const first = await createTransports(bothEnabled(), log, { DISCORD_BOT_TOKEN: "t" }, {
      dataDir,
      fetchImpl: fakeDiscord(json({ id: "d1" })).fetchImpl,
      dedupe,
      guard: createContentGuard(dedupe),
    })
    await openWhatsApp()
    expect(await first.send(envelope("finished a pass"))).toHaveLength(2)
    await first.stop()

    // a restart: new transports and a new store instance over the same auth-state
    mock.sockets.length = 0
    const guard = createContentGuard(await createDedupeStore(dataDir))
    const next = await createTransports(bothEnabled(), log, { DISCORD_BOT_TOKEN: "t" }, {
      dataDir,
      fetchImpl: fakeDiscord(json({ id: "d2" })).fetchImpl,
      guard,
    })
    const socket = await openWhatsApp()

    // the restored batch re-flushes the same text: nothing goes out
    expect(await next.send(envelope("finished a pass"))).toEqual([])
    expect(socket.sendMessage).not.toHaveBeenCalled()
    // different text is a new notice
    expect(await next.send(envelope("finished its task"))).toHaveLength(2)
    await next.stop()
  })

  it("skips a retry replay of content that already landed on that transport", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "relay-transports-"))
    const dedupe = await createDedupeStore(dataDir)
    const guard = createContentGuard(dedupe)
    const { calls, fetchImpl } = fakeDiscord(new Response("boom", { status: 500 }))
    const relay = await createTransports(bothEnabled(), log, { DISCORD_BOT_TOKEN: "t" }, { dataDir, fetchImpl, guard })
    await openWhatsApp()

    await relay.send(envelope("hi"))
    // the same content reached Discord by another path while this one sat in the queue; the send
    // path adds the final newlines, so the landed text is "hi\n\n"
    await guard.commit("discord", envelope("hi\n\n"))
    const retried = await relay.drain(Date.now() + 60_000)

    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1)
    expect(retried.map((item) => item.transport.name)).toEqual(["discord"])
    const discord = relay.transports.find((transport) => transport.name === "discord")
    expect(discord?.retry.pending()).toHaveLength(0)
    await relay.stop()
  })

  it("sends identical content once when two flushes race in the same tick", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "relay-transports-"))
    const guard = createContentGuard(await createDedupeStore(dataDir))
    const { calls, fetchImpl } = fakeDiscord(json({ id: "d1" }), json({ id: "d2" }))
    const relay = await createTransports(bothEnabled(), log, { DISCORD_BOT_TOKEN: "t" }, { dataDir, fetchImpl, guard })
    const socket = await openWhatsApp()

    // a debounce flush and a maxWait flush of the same batch, before either send has landed
    const [firstFlush, secondFlush] = await Promise.all([
      relay.send(envelope("finished a pass")),
      relay.send(envelope("finished a pass")),
    ])

    // one flush wins the claim on each transport; the other is a duplicate, not a second send
    expect([...firstFlush, ...secondFlush]).toHaveLength(2)
    expect(socket.sendMessage).toHaveBeenCalledTimes(1)
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1)
    await relay.stop()
  })

  it("releases the content claim when a send fails, so a retry can still land", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "relay-transports-"))
    const guard = createContentGuard(await createDedupeStore(dataDir))
    // the first Discord call fails, the next one succeeds
    const { fetchImpl } = fakeDiscord(new Response("boom", { status: 500 }), json({ id: "d1" }))
    const relay = await createTransports(bothEnabled(), log, { DISCORD_BOT_TOKEN: "t" }, { dataDir, fetchImpl, guard })
    const socket = await openWhatsApp()

    // whatsapp only: the Discord send failed
    expect(await relay.send(envelope("finished a pass"))).toHaveLength(1)

    // the failure released the claim: the transport that never got it may still send the text
    const again = await relay.send(envelope("finished a pass"))
    expect(again.map((item) => item.transport.name)).toEqual(["discord"])
    expect(socket.sendMessage).toHaveBeenCalledTimes(1)
    await relay.stop()
  })

  it("uses the mock sink when no transport is enabled", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "relay-transports-"))
    const config = configSchema.parse({ ...example, whatsapp: { enabled: false }, discord: { enabled: false } })
    const relay = await createTransports(config, log, {}, { dataDir })

    expect(relay.transports.map((transport) => transport.name)).toEqual(["mock"])
    expect(relay.statuses).toEqual([
      { name: "whatsapp", state: "disabled", reason: "whatsapp.enabled is false" },
      { name: "discord", state: "disabled", reason: "discord.enabled is false" },
      { name: "mock", state: "mocked", reason: "no transport enabled" },
    ])
    expect(await relay.send(envelope("hi"))).toHaveLength(1)
    await relay.stop()
  })

  it("times out a hanging Discord call instead of stalling the WhatsApp send", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "relay-transports-"))
    // worst case: the request never answers and the stub ignores its abort signal
    const hang = (async () => new Promise<Response>(() => {})) as typeof fetch
    const relay = await createTransports(bothEnabled(), log, { DISCORD_BOT_TOKEN: "t" }, { dataDir, fetchImpl: hang })
    const socket = await openWhatsApp()

    vi.useFakeTimers()
    const stuckPoll = relay.poll()
    const sending = relay.send(envelope("hi"))
    await vi.advanceTimersByTimeAsync(10_000)
    const delivered = await sending
    await stuckPoll
    vi.useRealTimers()

    expect(socket.sendMessage).toHaveBeenCalledWith("me@s.whatsapp.net", { text: "hi\n\n" })
    expect(delivered.map((item) => item.transport.name)).toEqual(["whatsapp"])
    // the timed-out Discord send is queued on its own retry queue, not lost with the stall
    const discord = relay.transports.find((transport) => transport.name === "discord")
    expect(discord?.retry.pending()).toHaveLength(1)
    await relay.stop()
  })
})
