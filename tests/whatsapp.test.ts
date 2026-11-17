import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import { configSchema, loadConfig } from "../src/config.js"
import { createDedupeStore } from "../src/dedupe.js"
import type { Envelope } from "../src/envelope.js"
import { createTransports, inboundAllowed, relayGroup } from "../src/router.js"
import { reconnectDelayMs, splitMessage, toWhatsAppMarkdown, openPairingSocket, WhatsAppProvider } from "../src/providers/whatsapp.js"

interface FakeSocket {
  ev: { on: (event: string, handler: (payload: never) => void) => void }
  sendMessage: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  logout: ReturnType<typeof vi.fn>
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
      logout: vi.fn(async () => undefined),
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
  // rc14 shape: platform, browser, version — the tuple WhatsApp shows under Linked devices
  Browsers: {
    baileys: (browser: string) => ["Baileys", browser, "6.5.0"],
    macOS: (browser: string) => ["Mac OS", browser, "14.4.1"],
  },
}))

const log = pino({ level: "silent" })
const example = JSON.parse(await readFile(new URL("../examples/config.example.json", import.meta.url), "utf8"))
const envelope = (id: string, text: string): Envelope => ({ id, category: "questions", text, createdAt: 0 })

const silent = () => {
  const lines: string[] = []
  return { log: pino({ level: "debug" }, { write: (line: string) => lines.push(line) }), lines }
}

const provider = async (overrides: Partial<ConstructorParameters<typeof WhatsAppProvider>[0]> = {}) => {
  mock.sockets.length = 0
  const authDir = await mkdtemp(join(tmpdir(), "relay-whatsapp-"))
  const instance = new WhatsAppProvider({
    authDir,
    selfChat: true,
    log,
    baseDelayMs: 50,
    maxDelayMs: 200,
    ...overrides,
  })
  await instance.start()
  return instance
}

const first = (): FakeSocket => {
  const socket = mock.sockets[0]
  if (socket === undefined) throw new Error("no socket")
  return socket
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe("splitMessage", () => {
  it("splits on newline boundaries and stays under the cap", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ${"x".repeat(20)}`)
    const text = lines.join("\n")
    const chunks = splitMessage(text, 200)

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200)
    expect(chunks.join("\n")).toBe(text)
  })

  it("hard-cuts a single line longer than the cap without losing text", () => {
    const text = "y".repeat(450)
    const chunks = splitMessage(text, 200)

    expect(chunks.map((chunk) => chunk.length)).toEqual([200, 200, 50])
    expect(chunks.join("")).toBe(text)
  })

  it("caps by UTF-8 bytes, never splitting a character", () => {
    const text = "😀".repeat(30) // 4 bytes each, 120 bytes
    const chunks = splitMessage(text, 10)

    for (const chunk of chunks) expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(10)
    expect(chunks.join("")).toBe(text)
  })

  it("keeps short text as one chunk", () => {
    expect(splitMessage("hello")).toEqual(["hello"])
  })

  it("closes and reopens a code block that straddles a split", () => {
    const code = Array.from({ length: 20 }, (_, index) => `const value${index} = compute(${index})`)
    const text = ["intro", "```ts", ...code, "```", "outro"].join("\n")
    const chunks = splitMessage(text, 200)

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(200)
      // an odd count means a block was left open: WhatsApp would show the rest as code
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0)
    }
    const kept = (lines: string[]): string[] => lines.filter((line) => !line.startsWith("```"))
    expect(kept(chunks.flatMap((chunk) => chunk.split("\n")))).toEqual(kept(text.split("\n")))
  })
})

describe("toWhatsAppMarkdown", () => {
  it("turns Markdown bold into WhatsApp bold, both spellings", () => {
    expect(toWhatsAppMarkdown("**bold** and __also bold__")).toBe("*bold* and *also bold*")
  })

  it("turns a heading into a bold line and a strike into WhatsApp's strike", () => {
    expect(toWhatsAppMarkdown("### Result")).toBe("*Result*")
    expect(toWhatsAppMarkdown("~~gone~~")).toBe("~gone~")
  })

  it("leaves italic and inline code as written", () => {
    expect(toWhatsAppMarkdown("_italic_ and `**not bold**`")).toBe("_italic_ and `**not bold**`")
  })

  it("never touches a fenced or indented block", () => {
    const text = ["**outside**", "```md", "**inside**", "## heading", "```", "    **indented**"].join("\n")

    expect(toWhatsAppMarkdown(text)).toBe(
      ["*outside*", "```md", "**inside**", "## heading", "```", "    **indented**"].join("\n"),
    )
  })

  it("leaves an unpaired asterisk alone", () => {
    expect(toWhatsAppMarkdown("2 * 3 * 4")).toBe("2 * 3 * 4")
  })
})

describe("reconnectDelayMs", () => {
  it("doubles per attempt and caps", () => {
    expect(reconnectDelayMs(0, 100, 800)).toBe(100)
    expect(reconnectDelayMs(1, 100, 800)).toBe(200)
    expect(reconnectDelayMs(3, 100, 800)).toBe(800)
    expect(reconnectDelayMs(9, 100, 800)).toBe(800)
  })

  it("defaults to one second doubling up to a minute", () => {
    expect(reconnectDelayMs(0)).toBe(1_000)
    expect(reconnectDelayMs(2)).toBe(4_000)
    expect(reconnectDelayMs(20)).toBe(60_000)
  })
})

describe("WhatsAppProvider", () => {
  it("introduces itself to the phone as the relay, not a browser", async () => {
    await provider()

    // the Linked devices list shows platform (browser); rc14 defaults to macOS Chrome
    expect(mock.makeSocket.mock.calls[0]?.[0]).toMatchObject({ browser: ["Baileys", "opencode-relay", "6.5.0"] })
  })

  it("sends to the own JID self-chat once connected, splitting long text", async () => {
    const instance = await provider()
    first().emit("connection.update", { connection: "open" })

    const chunks = splitMessage("a".repeat(70_000))
    await instance.send(envelope("e1", "a".repeat(70_000)))

    expect(chunks.length).toBeGreaterThan(1)
    expect(first().sendMessage).toHaveBeenCalledTimes(chunks.length)
    expect(first().sendMessage).toHaveBeenNthCalledWith(1, "me@s.whatsapp.net", { text: chunks[0] })
  })

  it("sends to the configured target when selfChat is off", async () => {
    const instance = await provider({ selfChat: false, target: "491234567890@s.whatsapp.net" })
    first().emit("connection.update", { connection: "open" })

    await instance.send(envelope("e1", "hello"))
    expect(first().sendMessage).toHaveBeenCalledWith("491234567890@s.whatsapp.net", { text: "hello" })
  })

  it("dedupes a repeated envelope id", async () => {
    const instance = await provider()
    first().emit("connection.update", { connection: "open" })

    await instance.send(envelope("e1", "hello"))
    await instance.send(envelope("e1", "hello"))

    expect(first().sendMessage).toHaveBeenCalledTimes(1)
  })

  it("sends markdown as the syntax WhatsApp renders", async () => {
    const instance = await provider()
    first().emit("connection.update", { connection: "open" })

    await instance.send(envelope("e1", "## Result\n\n**done** with _this_"))

    expect(first().sendMessage).toHaveBeenCalledWith("me@s.whatsapp.net", { text: "*Result*\n\n*done* with _this_" })
  })

  it("returns the first message ID and its destination for correlation", async () => {
    const instance = await provider()
    first().emit("connection.update", { connection: "open" })

    expect(await instance.send(envelope("e1", "hello"))).toBe("wamid.HBg")
    expect(instance.destination()).toEqual({
      externalUserID: "me@s.whatsapp.net",
      chatID: "me@s.whatsapp.net",
    })
  })

  it("sends an image with its caption", async () => {
    const instance = await provider()
    first().emit("connection.update", { connection: "open" })
    const dir = await mkdtemp(join(tmpdir(), "relay-whatsapp-"))
    const path = join(dir, "shot.png")
    await writeFile(path, Buffer.from("89504e470d0a1a0a", "hex"))

    await instance.send({ ...envelope("e9", "build passed"), image: { path } })

    expect(first().sendMessage).toHaveBeenCalledWith("me@s.whatsapp.net", {
      image: expect.any(Buffer),
      caption: "build passed",
    })
  })

  it("refuses an image that is not a readable image file", async () => {
    const instance = await provider()
    first().emit("connection.update", { connection: "open" })

    await expect(
      instance.send({ ...envelope("e9", "x"), image: { path: join(tmpdir(), "relay-missing.png") } }),
    ).rejects.toThrow("no such file")
    expect(first().sendMessage).not.toHaveBeenCalled()
  })

  it("has no destination before the socket knows its own JID", async () => {
    const instance = await provider()
    expect(instance.destination()).toBeUndefined()

    const targeted = await provider({ selfChat: false, target: "491234567890@s.whatsapp.net" })
    expect(targeted.destination()).toEqual({
      externalUserID: "491234567890@s.whatsapp.net",
      chatID: "491234567890@s.whatsapp.net",
    })
  })

  it("throws when sending before the socket is connected", async () => {
    const instance = await provider()
    await expect(instance.send(envelope("e1", "hello"))).rejects.toThrow("whatsapp target unknown")
  })

  it("persists creds on update and on shutdown", async () => {
    const instance = await provider()
    first().emit("creds.update", {})
    await instance.stop()

    expect(mock.saveCreds).toHaveBeenCalledTimes(2)
    expect(first().end).toHaveBeenCalled()
  })

  it("reconnects with backoff after an unexpected close", async () => {
    const instance = await provider({ baseDelayMs: 5, maxDelayMs: 20 })

    first().emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    })
    expect(mock.sockets).toHaveLength(1)

    await vi.waitFor(() => expect(mock.sockets).toHaveLength(2), { timeout: 1_000 })
    await instance.stop()
  })

  it("does not reconnect after logout", async () => {
    const instance = await provider({ baseDelayMs: 5, maxDelayMs: 20 })

    first().emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(mock.sockets).toHaveLength(1)
    await instance.stop()
  })

  it("logs the device out server-side for /relay unpair", async () => {
    const instance = await provider()
    first().emit("connection.update", { connection: "open" })

    await instance.logout()

    expect(first().logout).toHaveBeenCalledTimes(1)
    // the socket is gone: a second unpair must not reach WhatsApp again
    await expect(instance.logout()).rejects.toThrow("not connected")
  })

  it("handles inbound self-chat text and echoes the reply", async () => {
    const received: string[] = []
    await provider({
      onInbound: (message) => {
        received.push(message.text)
        return "ok"
      },
    })
    first().emit("connection.update", { connection: "open" })

    first().emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "m1", remoteJid: "me@s.whatsapp.net", fromMe: true },
          message: { conversation: "/relay notifications" },
        },
      ],
    })

    await vi.waitFor(() => expect(received).toEqual(["/relay notifications"]))
    await vi.waitFor(() =>
      expect(first().sendMessage).toHaveBeenCalledWith("me@s.whatsapp.net", { text: "ok" }),
    )
  })

  it("treats a fromMe message in the LID form of the self-chat as operator input", async () => {
    const received: Array<{ text: string; chatID: string; selfChat: boolean }> = []
    await provider({
      onInbound: (message) => {
        received.push({ text: message.text, chatID: message.chatID, selfChat: message.selfChat })
        return "ok"
      },
    })
    // WhatsApp addresses the same conversation by phone-number JID or by LID
    first().user.lid = "999@lid"
    first().emit("connection.update", { connection: "open" })

    first().emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "m1", remoteJid: "999@lid", fromMe: true },
          message: { conversation: "/relay status" },
        },
      ],
    })

    await vi.waitFor(() =>
      expect(received).toEqual([{ text: "/relay status", chatID: "me@s.whatsapp.net", selfChat: true }]),
    )
    // the reply goes to the outbound JID the correlation store recorded
    await vi.waitFor(() =>
      expect(first().sendMessage).toHaveBeenCalledWith("me@s.whatsapp.net", { text: "ok" }),
    )
  })

  it("carries the quoted message id so an answer anchors to its prompt", async () => {
    const received: Array<string | undefined> = []
    await provider({
      onInbound: (message) => {
        received.push(message.quotedID)
        return undefined
      },
    })
    first().emit("connection.update", { connection: "open" })

    first().emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "m1", remoteJid: "me@s.whatsapp.net", fromMe: true },
          message: {
            extendedTextMessage: { text: "1: main", contextInfo: { stanzaId: "form-message-id" } },
          },
        },
      ],
    })

    await vi.waitFor(() => expect(received).toEqual(["form-message-id"]))
  })

  it("ignores the echo of its own send by message ID, so a reply cannot answer itself", async () => {
    const received: string[] = []
    const instance = await provider({
      onInbound: (message) => {
        received.push(message.text)
        return "notice from the relay"
      },
    })
    first().emit("connection.update", { connection: "open" })

    // a user message runs the command; the reply is sent and its ID recorded
    first().emit("messages.upsert", {
      type: "notify",
      messages: [
        { key: { id: "user-1", remoteJid: "me@s.whatsapp.net", fromMe: true }, message: { conversation: "/relay status" } },
      ],
    })
    await vi.waitFor(() => expect(first().sendMessage).toHaveBeenCalledTimes(1))

    // the same message comes back as an upsert of our own send (fake socket ID "wamid.HBg")
    first().emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "wamid.HBg", remoteJid: "me@s.whatsapp.net", fromMe: true },
          message: { conversation: "notice from the relay" },
        },
      ],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(received).toEqual(["/relay status"])
    expect(first().sendMessage).toHaveBeenCalledTimes(1)
    expect(await instance.send(envelope("e1", "hello"))).toBe("wamid.HBg")
  })

  it("skips a sent ID recorded in the dedupe store before a restart", async () => {
    const authDir = await mkdtemp(join(tmpdir(), "relay-whatsapp-"))
    const dedupe = await createDedupeStore(await mkdtemp(join(tmpdir(), "relay-whatsapp-sent-")))
    await dedupe.first("whatsapp:sent:wamid.old")
    const received: string[] = []
    const instance = new WhatsAppProvider({
      authDir,
      selfChat: true,
      log,
      dedupe,
      onInbound: (message) => void received.push(message.text),
    })
    await instance.start()
    first().emit("connection.update", { connection: "open" })

    first().emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "wamid.old", remoteJid: "me@s.whatsapp.net", fromMe: true },
          message: { conversation: "sent before the restart" },
        },
      ],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(received).toEqual([])
    await instance.stop()
  })

  it("rejects inbound from an unpaired sender", async () => {
    const { log: capture, lines } = silent()
    const received: string[] = []
    await provider({
      allowSender: () => false,
      log: capture,
      onInbound: (message) => {
        received.push(message.text)
      },
    })
    first().emit("connection.update", { connection: "open" })

    first().emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "m1", remoteJid: "friend@s.whatsapp.net", participant: "friend@s.whatsapp.net", fromMe: false },
          message: { conversation: "hello" },
        },
      ],
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(received).toEqual([])
    expect(lines.join("")).toContain("not paired")
  })

  it("ignores echoes of its own outgoing messages", async () => {
    const received: string[] = []
    await provider({ onInbound: (message) => void received.push(message.text) })
    first().emit("connection.update", { connection: "open" })

    first().emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "m1", remoteJid: "friend@s.whatsapp.net", fromMe: true },
          message: { conversation: "sent by us" },
        },
      ],
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(received).toEqual([])
  })

  it("drops a redelivered inbound message id", async () => {
    const received: string[] = []
    await provider({ onInbound: (message) => void received.push(message.text) })
    first().emit("connection.update", { connection: "open" })

    const payload = {
      type: "notify",
      messages: [
        {
          key: { id: "m1", remoteJid: "me@s.whatsapp.net", fromMe: true },
          message: { conversation: "hi" },
        },
      ],
    }
    first().emit("messages.upsert", payload)
    first().emit("messages.upsert", payload)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(received).toEqual(["hi"])
  })
})

describe("relay group", () => {
  it("creates the group addressed to our own number and sends there afterwards", async () => {
    const instance = await provider()
    first().user.phoneNumber = "491234567890@s.whatsapp.net"
    first().emit("connection.update", { connection: "open" })

    expect(await instance.ensureGroup("Relay")).toEqual({ jid: "1203630@g.us", created: true })
    expect(first().groupCreate).toHaveBeenCalledWith("Relay", ["491234567890@s.whatsapp.net"])

    await instance.send(envelope("e1", "hello"))
    expect(first().sendMessage).toHaveBeenCalledWith("1203630@g.us", { text: "hello" })
  })

  it("reuses a group that already carries the name instead of creating a second one", async () => {
    const instance = await provider()
    first().emit("connection.update", { connection: "open" })
    first().groupFetchAllParticipating.mockResolvedValueOnce({
      "999@g.us": { id: "999@g.us", subject: "Relay", participants: [] },
    })

    expect(await instance.ensureGroup("Relay")).toEqual({ jid: "999@g.us", created: false })
    expect(first().groupCreate).not.toHaveBeenCalled()
  })

  it("refuses to create a group before the socket is connected", async () => {
    const instance = await provider()

    await expect(instance.ensureGroup("Relay")).rejects.toThrow("not connected")
  })

  it("persists the group as the target, so a restart keeps the layout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-group-"))
    const path = join(dir, "config.json")
    await copyFile(new URL("../examples/config.example.json", import.meta.url), path)
    const instance = await provider()
    first().emit("connection.update", { connection: "open" })

    expect(await relayGroup(instance, path)).toEqual({ jid: "1203630@g.us", created: true, subject: "Relay" })

    const saved = await loadConfig(path)
    expect(saved.whatsapp.selfChat).toBe(false)
    expect(saved.whatsapp.target).toBe("1203630@g.us")

    // a fresh provider built from that file routes to the group before the socket even opens
    const restarted = new WhatsAppProvider({
      authDir: join(dir, "auth"),
      selfChat: saved.whatsapp.selfChat,
      target: saved.whatsapp.target,
      log,
    })
    expect(restarted.destination()).toEqual({ externalUserID: "1203630@g.us", chatID: "1203630@g.us" })
  })

  it("reports a transport without groups instead of pretending", async () => {
    await expect(relayGroup({ send: async () => undefined })).rejects.toThrow("no group layout")
  })

  it("accepts an inbound message in the relay group as operator input", async () => {
    const received: string[] = []
    await provider({ selfChat: false, target: "1203630@g.us", onInbound: (message) => void received.push(message.text) })
    first().emit("connection.update", { connection: "open" })

    first().emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "m1", remoteJid: "1203630@g.us", participant: "me@s.whatsapp.net", fromMe: true },
          message: { conversation: "run the tests" },
        },
      ],
    })

    await vi.waitFor(() => expect(received).toEqual(["run the tests"]))
  })
})

describe("openPairingSocket", () => {
  const open = async () => {
    mock.sockets.length = 0
    const authDir = await mkdtemp(join(tmpdir(), "relay-pair-socket-"))
    return { sock: await openPairingSocket(authDir, log), socket: () => first() }
  }

  it("asks for the code once the registration handshake offers a QR", async () => {
    const { sock, socket } = await open()
    const pending = sock.requestPairingCode("+49 1234 567890")

    socket().emit("connection.update", { qr: "https://wa.me/settings/linked_devices#ref" })

    expect(await pending).toBe("M84BRQMD")
    expect(socket().requestPairingCode).toHaveBeenCalledWith("491234567890")
    expect(sock.qr()).toBe("https://wa.me/settings/linked_devices#ref")
  })

  it("keeps the default web client instead of the relay name", async () => {
    await open()

    // rc14 turns the browser name into companion_platform_id in the pairing-code hello
    // (lib/Utils/companion-reg-client-utils.js: any name outside Chrome/Edge/Firefox/IE/Opera/
    // Safari maps to OTHER_WEB_CLIENT, a value no real web client sends), and its README only
    // documents a custom browser for the QR path. Measured on rc14: both tuples return a code, so
    // the pairing socket loses nothing by using the default.
    expect(mock.makeSocket.mock.calls[0]?.[0]).toMatchObject({ browser: ["Mac OS", "Chrome", "14.4.1"] })
  })

  it("reports the real close reason instead of waiting out the readiness window", async () => {
    const { sock, socket } = await open()
    const pending = sock.requestPairingCode("491234567890")

    socket().emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { message: "Connection Terminated", output: { statusCode: 428 } } },
    })

    const error = await pending.catch((rejection: Error) => rejection)
    expect(error.message).toBe("428 Connection Terminated")
    // the retry in pairing.ts hangs off this name
    expect(error.name).toBe("PairingUnavailableError")
    expect(socket().requestPairingCode).not.toHaveBeenCalled()
  })

  it("says the auth dir is already a linked device when the socket opens", async () => {
    const { sock, socket } = await open()
    const pending = sock.requestPairingCode("491234567890")

    socket().emit("connection.update", { connection: "open" })

    await expect(pending).rejects.toThrow("already linked")
  })

  it("surfaces the close reason when the socket dies between ready and send", async () => {
    const { sock, socket } = await open()
    socket().requestPairingCode.mockRejectedValueOnce(
      Object.assign(new Error("Connection Closed"), { output: { statusCode: 428 } }),
    )
    const pending = sock.requestPairingCode("491234567890")

    socket().emit("connection.update", { qr: "https://wa.me/settings/linked_devices#ref" })

    await expect(pending).rejects.toThrow("428 Connection Closed")
  })
})

describe("createTransports whatsapp routing", () => {
  const config = (whatsapp: Record<string, unknown>) =>
    configSchema.parse({ ...example, provider: "whatsapp", whatsapp })

  it("starts a WhatsAppProvider when whatsapp is enabled", async () => {
    mock.sockets.length = 0
    const dataDir = await mkdtemp(join(tmpdir(), "relay-provider-"))
    const relay = await createTransports(config({ enabled: true, selfChat: true }), log, {}, { dataDir })

    expect(relay.transports[0]?.provider).toBeInstanceOf(WhatsAppProvider)
    await vi.waitFor(() => expect(mock.sockets).toHaveLength(1))
    await relay.stop()
  })

  it("reports whatsapp disabled and uses the mock sink when nothing else is enabled", async () => {
    mock.sockets.length = 0
    const relay = await createTransports(config({ enabled: false, selfChat: true }), log, {}, {
      dataDir: await mkdtemp(join(tmpdir(), "relay-provider-")),
    })

    expect(relay.transports[0]?.provider).not.toBeInstanceOf(WhatsAppProvider)
    expect(relay.transports[0]?.name).toBe("mock")
    expect(relay.statuses.find((status) => status.name === "whatsapp")).toEqual({
      name: "whatsapp",
      state: "disabled",
      reason: "whatsapp.enabled is false",
    })
    expect(mock.sockets).toHaveLength(0)
  })

  it("reports whatsapp mocked when selfChat is off without a target", async () => {
    const relay = await createTransports(config({ enabled: true, selfChat: false }), log, {}, {
      dataDir: await mkdtemp(join(tmpdir(), "relay-provider-")),
    })
    expect(relay.transports[0]?.provider).not.toBeInstanceOf(WhatsAppProvider)
    expect(relay.statuses.find((status) => status.name === "whatsapp")?.state).toBe("mocked")
  })
})

describe("inboundAllowed", () => {
  const config = (security: Record<string, unknown>) =>
    configSchema.parse({ ...example, security: { pairingRequired: true, allowUnpairedUsers: false, allowlist: [], ...security } })

  it("rejects unpaired senders when pairing is required", () => {
    expect(inboundAllowed(config({}), "friend@s.whatsapp.net")).toBe(false)
  })

  it("accepts an allowlisted JID or bare phone number", () => {
    expect(inboundAllowed(config({ allowlist: ["friend@s.whatsapp.net"] }), "friend@s.whatsapp.net")).toBe(true)
    expect(inboundAllowed(config({ allowlist: ["491234567890"] }), "491234567890:12@s.whatsapp.net")).toBe(true)
    expect(inboundAllowed(config({ allowlist: ["491234567890"] }), "499999999999@s.whatsapp.net")).toBe(false)
  })

  it("accepts a Discord user ID from the same allowlist", () => {
    expect(inboundAllowed(config({ allowlist: ["111222333444555666"] }), "111222333444555666")).toBe(true)
    expect(inboundAllowed(config({ allowlist: ["111222333444555666"] }), "111222333444555667")).toBe(false)
  })

  it("only digit-compares when both sides carry digits", () => {
    // non-numeric names with every digit stripped are both "": that must not read as a match
    expect(inboundAllowed(config({ allowlist: ["relay-user"] }), "someone-else")).toBe(false)
    expect(inboundAllowed(config({ allowlist: ["relay-user"] }), "relay-user")).toBe(true)
  })

  it("accepts everyone when pairing is off or unpaired users are allowed", () => {
    expect(inboundAllowed(config({ pairingRequired: false }), "anyone@s.whatsapp.net")).toBe(true)
    expect(inboundAllowed(config({ allowUnpairedUsers: true }), "anyone@s.whatsapp.net")).toBe(true)
  })
})
