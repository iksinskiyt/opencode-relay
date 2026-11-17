import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { describe, expect, it } from "vitest"
import { configSchema } from "../src/config.js"
import type { Envelope, InboundMessage, QuestionField } from "../src/envelope.js"
import {
  DISCORD_MAX_CHARS,
  type DiscordMessage,
  discordProvider,
  LINKED_TEXT,
  linkDiscord,
  QUESTION_CANCEL_ID,
  questionComponents,
  splitMessage,
} from "../src/providers/discord.js"
import { createTransports } from "../src/router.js"
import { flush, sockets } from "./fake-socket.js"

const example = JSON.parse(await readFile(new URL("../examples/config.example.json", import.meta.url), "utf8"))
const MESSAGES = "https://discord.com/api/v10/channels/42/messages"

const envelope = (text: string, interaction?: Envelope["interaction"]): Envelope => ({
  id: "e1",
  category: interaction?.type === "permission" ? "permissions" : "questions",
  text,
  createdAt: 0,
  ...(interaction === undefined ? {} : { interaction }),
})

const capture = () => {
  const lines: string[] = []
  const log = pino({ level: "debug" }, { write: (line: string) => lines.push(line) })
  return { log, lines }
}

const config = (discord: {
  enabled: boolean
  target?: "channel" | "dm"
  channelID?: string
  dmUserID?: string
  buttons?: boolean
}) => configSchema.parse({ ...example, provider: "discord", whatsapp: { enabled: false }, discord })

describe("splitMessage", () => {
  it("keeps short text as one chunk", () => {
    expect(splitMessage("hello")).toEqual(["hello"])
  })

  it("splits on newline boundaries and stays under the cap", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(8)}`)
    const text = lines.join("\n")
    const chunks = splitMessage(text)

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MAX_CHARS)
      expect(chunk.endsWith("x")).toBe(true)
    }
    expect(chunks.join("\n")).toBe(text)
  })

  it("hard-cuts a single line longer than the cap", () => {
    const chunks = splitMessage("y".repeat(DISCORD_MAX_CHARS * 2 + 10))
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(DISCORD_MAX_CHARS)
    expect(chunks.join("")).toBe("y".repeat(DISCORD_MAX_CHARS * 2 + 10))
  })

  it("closes and reopens code blocks so every chunk is balanced markdown", () => {
    const text = ["intro", "```ts", ...Array.from({ length: 400 }, () => "const value = compute()"), "```", "outro"].join(
      "\n",
    )
    const chunks = splitMessage(text)

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MAX_CHARS)
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0)
    }
    expect(chunks[0]?.startsWith("intro")).toBe(true)
    expect(chunks.at(-1)?.endsWith("outro")).toBe(true)
  })
})

describe("questionComponents", () => {
  const field = (key: string, labels: readonly string[], multi = false): QuestionField => ({
    key,
    label: key,
    required: false,
    multi,
    options: labels.map((label, index) => ({ letter: String.fromCharCode(97 + index), label, value: `v${index}` })),
  })

  type Row = { type: number; components: Array<Record<string, unknown>> }

  it("renders up to four short options as a primary button row plus cancel", () => {
    const rows = questionComponents({ formID: "frm_1", fields: [field("branch", ["Release", "Feature"])] }) as Row[]

    expect(rows).toHaveLength(2)
    expect(rows[0]?.type).toBe(1)
    expect(rows[0]?.components.map((button) => [button.style, button.label, button.custom_id])).toEqual([
      [1, "Release", "q:frm_1:branch:v0"],
      [1, "Feature", "q:frm_1:branch:v1"],
    ])
    expect(rows[1]?.components.map((button) => button.custom_id)).toEqual([QUESTION_CANCEL_ID])
  })

  it("renders more than four options as a string select, multi-select when the field allows it", () => {
    const labels = Array.from({ length: 7 }, (_, index) => `option ${index}`)
    const rows = questionComponents({ formID: "frm_1", fields: [field("branch", labels, true)] }) as Row[]

    const select = rows[0]?.components[0] ?? {}
    expect(select.type).toBe(3)
    expect(select.custom_id).toBe("q:frm_1:branch")
    expect(select.max_values).toBe(7)
    expect((select.options as unknown[]).length).toBe(7)
  })

  it("caps a select at 25 options and truncates labels with an ellipsis", () => {
    const labels = Array.from({ length: 30 }, (_, index) => `${index} ${"x".repeat(120)}`)
    const rows = questionComponents({ formID: "frm_1", fields: [field("branch", labels)] }) as Row[]

    const select = rows[0]?.components[0] ?? {}
    const options = select.options as Array<{ label: string; value: string }>
    expect(options).toHaveLength(25)
    expect(options[0]?.label.length).toBe(100)
    expect(options[0]?.label.endsWith("…")).toBe(true)
    expect(options[0]?.value).toBe("v0")
  })

  it("buttons first, then a select, and never more than five rows including cancel", () => {
    const rows = questionComponents({
      formID: "frm_1",
      fields: [
        field("one", ["a", "b"]),
        field("two", ["a", "b"]),
        field("three", ["a", "b"]),
        field("four", ["a", "b"]),
        field("five", ["a", "b"]),
      ],
    }) as Row[]

    expect(rows).toHaveLength(5)
    expect(rows.slice(0, 4).map((row) => row.components[0]?.custom_id)).toEqual([
      "q:frm_1:one:v0",
      "q:frm_1:two:v0",
      "q:frm_1:three:v0",
      "q:frm_1:four:v0",
    ])
    expect(rows[4]?.components[0]?.custom_id).toBe(QUESTION_CANCEL_ID)

    const mixed = questionComponents({
      formID: "frm_1",
      fields: [field("one", ["a", "b"]), field("many", Array.from({ length: 6 }, (_, i) => `o${i}`))],
    }) as Row[]
    expect(mixed[0]?.components[0]?.type).toBe(2)
    expect(mixed[1]?.components[0]?.type).toBe(3)
  })

  it("leaves fields without options to the typed answer and returns nothing without any", () => {
    expect(questionComponents(undefined)).toBeUndefined()
    expect(questionComponents({ formID: "frm_1", fields: [field("note", [])] })).toBeUndefined()
  })

  it("skips a field whose option cannot fit in a custom_id or a value slot", () => {
    const long = "v".repeat(120)
    const rows = questionComponents({
      formID: "frm_1",
      fields: [
        {
          key: "branch",
          label: "branch",
          required: false,
          multi: false,
          options: [{ letter: "a", label: "long", value: long }],
        },
        field("note", ["a", "b"]),
      ],
    }) as Row[]

    expect(rows).toHaveLength(2)
    expect(rows[0]?.components[0]?.custom_id).toBe("q:frm_1:note:v0")
  })
})

describe("discordProvider", () => {
  it("posts each chunk with a Bot token header", async () => {
    const { log } = capture()
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(null, { status: 204 })
    }) as typeof fetch

    const provider = discordProvider({ token: "s3cr3t", dest: { channelID: "42" }, log, fetchImpl })
    await provider.send(envelope(`${"a".repeat(1500)}\n${"b".repeat(1500)}`))

    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toBe(MESSAGES)
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bot s3cr3t")
  })

  it("returns the first message ID for correlation", async () => {
    const { log } = capture()
    const fetchImpl = (async () => new Response(JSON.stringify({ id: "msg_1" }), { status: 200 })) as typeof fetch

    const messageID = await discordProvider({ token: "t", dest: { channelID: "42" }, log, fetchImpl }).send(envelope("hi"))

    expect(messageID).toBe("msg_1")
  })

  it("uploads a local image as multipart with the caption", async () => {
    const { log } = capture()
    const calls: RequestInit[] = []
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {})
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 })
    }) as typeof fetch
    const dir = await mkdtemp(join(tmpdir(), "relay-discord-"))
    const path = join(dir, "shot.png")
    await writeFile(path, Buffer.from("89504e470d0a1a0a", "hex"))

    await discordProvider({ token: "t", dest: { channelID: "42" }, log, fetchImpl }).send({
      ...envelope("look at this"),
      image: { path },
    })

    const form = calls[0]?.body
    expect(form).toBeInstanceOf(FormData)
    const payload = JSON.parse(String((form as FormData).get("payload_json"))) as Record<string, unknown>
    expect(payload).toMatchObject({ content: "look at this", attachments: [{ id: 0, filename: "shot.png" }] })
    expect(((form as FormData).get("files[0]") as File).name).toBe("shot.png")
    // no manual content-type: fetch writes the multipart boundary
    expect((calls[0]?.headers as Record<string, string>)["content-type"]).toBeUndefined()
  })

  it("sends a URL image as an embed instead of downloading it", async () => {
    const { log } = capture()
    const calls: RequestInit[] = []
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {})
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 })
    }) as typeof fetch

    await discordProvider({ token: "t", dest: { channelID: "42" }, log, fetchImpl }).send({
      ...envelope("remote"),
      image: { url: "https://example.test/a.png" },
    })

    expect(calls).toHaveLength(1)
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      content: "remote",
      embeds: [{ image: { url: "https://example.test/a.png" } }],
    })
  })

  it("attaches components to the first chunk only", async () => {
    const { log } = capture()
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response("[]", { status: 200 })
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 })
    }) as typeof fetch
    const socket = sockets()

    const live = discordProvider({
      token: "t",
      dest: { channelID: "42" },
      log,
      fetchImpl,
      gateway: { socket: socket.factory },
    })
    await live.start()
    socket.last().open()
    await flush()
    await live.send(envelope(`Allow ${"x".repeat(2_000)}?`, { type: "permission", permissionID: "per_1" }))

    expect(bodies.length).toBeGreaterThan(1)
    expect(bodies[0]?.components).toBeDefined()
    for (const body of bodies.slice(1)) expect(body.components).toBeUndefined()
    await live.stop()
  })

  it("renders permission buttons only while the gateway is live and not forced off", async () => {
    const { log } = capture()
    const bodies: Array<{ components?: Array<{ components: Array<{ custom_id?: string }> }> }> = []
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response("[]", { status: 200 })
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 })
    }) as typeof fetch
    const socket = sockets()

    const permission = envelope("Allow rm -rf?", { type: "permission", permissionID: "per_1" })
    // polling only: a click could never arrive
    await discordProvider({ token: "t", dest: { channelID: "42" }, log, fetchImpl }).send(permission)

    const live = discordProvider({ token: "t", dest: { channelID: "42" }, log, fetchImpl, gateway: { socket: socket.factory } })
    await live.start()
    socket.last().open()
    await flush()
    await live.send(permission)

    const forced = discordProvider({
      token: "t",
      dest: { channelID: "42" },
      log,
      fetchImpl,
      buttons: true,
      gateway: { socket: socket.factory },
    })
    await forced.start()
    socket.last().open()
    await flush()
    await forced.send(permission)

    expect(bodies[0]?.components).toBeUndefined()
    expect(bodies[1]?.components?.[0]?.components.map((button) => button.custom_id)).toEqual([
      "relay:once",
      "relay:always",
      "relay:reject",
    ])
    expect(bodies[2]?.components).toBeUndefined()
    await live.stop()
    await forced.stop()
  })

  it("renders question controls on a live gateway and keeps the typed fallback in the body", async () => {
    const { log } = capture()
    const bodies: Array<{ content: string; components?: Array<{ components: Array<Record<string, unknown>> }> }> = []
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response("[]", { status: 200 })
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 })
    }) as typeof fetch
    const socket = sockets()

    const question: Envelope = {
      id: "q1",
      category: "questions",
      text: 'Pick a branch\na) Release b) Feature\nreply with the answer; "cancel" cancels',
      createdAt: 0,
      interaction: { type: "form", formID: "frm_1" },
      question: {
        formID: "frm_1",
        fields: [
          {
            key: "branch",
            label: "Branch",
            required: true,
            multi: false,
            options: [
              { letter: "a", label: "Release", value: "release" },
              { letter: "b", label: "Feature", value: "feature" },
            ],
          },
        ],
      },
    }

    // polling only: a click could not arrive, so no components
    await discordProvider({ token: "t", dest: { channelID: "42" }, log, fetchImpl }).send(question)

    const live = discordProvider({ token: "t", dest: { channelID: "42" }, log, fetchImpl, gateway: { socket: socket.factory } })
    await live.start()
    socket.last().open()
    await flush()
    await live.send(question)

    expect(bodies[0]?.components).toBeUndefined()
    expect(bodies[1]?.components?.map((row) => row.components[0]?.custom_id)).toEqual([
      "q:frm_1:branch:release",
      QUESTION_CANCEL_ID,
    ])
    expect(bodies[1]?.content).toContain('reply with the answer; "cancel" cancels')
    await live.stop()
  })

  it("fails without leaking the token into the error or the logs", async () => {
    const { log, lines } = capture()
    const fetchImpl = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch

    const provider = discordProvider({ token: "s3cr3t", dest: { channelID: "42" }, log, fetchImpl })
    const error = await provider.send(envelope("hello")).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("401")
    expect((error as Error).message).not.toContain("s3cr3t")
    expect(lines.join("")).not.toContain("s3cr3t")
  })

  it("retries once on 429", async () => {
    const { log } = capture()
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return calls === 1
        ? new Response(JSON.stringify({ retry_after: 0 }), { status: 429 })
        : new Response(null, { status: 204 })
    }) as typeof fetch

    await discordProvider({ token: "t", dest: { channelID: "42" }, log, fetchImpl }).send(envelope("hello"))
    expect(calls).toBe(2)
  })

  it("names the channel as its correlation destination", () => {
    const { log } = capture()
    const provider = discordProvider({ token: "t", dest: { channelID: "42" }, log })
    expect(provider.destination?.()).toEqual({ externalUserID: "42", chatID: "42" })
  })
})

describe("discordProvider polling", () => {
  const pages = (responses: DiscordMessage[][]) => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      if ((init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ id: "posted" }), { status: 200 })
      }
      return new Response(JSON.stringify(responses.shift() ?? []), { status: 200 })
    }) as typeof fetch
    return { calls, fetchImpl }
  }

  const seen = () => {
    const keys = new Set<string>()
    return {
      keys,
      first: async (key: string) => {
        if (keys.has(key)) return false
        keys.add(key)
        return true
      },
      stop: async () => undefined,
    }
  }

  it("anchors on the first poll and answers only newer messages", async () => {
    const { log } = capture()
    const inbound: InboundMessage[] = []
    const { calls, fetchImpl } = pages([
      [{ id: "100", author: { id: "u1" }, content: "history" }],
      [
        { id: "102", author: { id: "u1" }, content: "/relay notifications" },
        { id: "101", author: { id: "bot", bot: true }, content: "our own post" },
      ],
    ])
    const provider = discordProvider({
      token: "t",
      dest: { channelID: "42" },
      log,
      fetchImpl,
      dedupe: seen(),
      onInbound: (message) => {
        inbound.push(message)
        return "ok"
      },
    })

    await provider.poll()
    expect(inbound).toEqual([])

    await provider.poll()
    expect(inbound.map((message) => message.text)).toEqual(["/relay notifications"])
    expect(inbound[0]?.senderID).toBe("u1")
    expect(calls[0]?.url).toBe(`${MESSAGES}?limit=1`)
    expect(calls[1]?.url).toBe(`${MESSAGES}?after=100&limit=50`)
    expect(calls[2]?.init.method).toBe("POST")
  })

  it("skips a message the dedupe store already saw", async () => {
    const { log } = capture()
    const inbound: string[] = []
    const dedupe = seen()
    await dedupe.first("discord:101")
    const { fetchImpl } = pages([
      [{ id: "100", author: { id: "u1" }, content: "history" }],
      [{ id: "101", author: { id: "u1" }, content: "again" }],
    ])
    const provider = discordProvider({
      token: "t",
      dest: { channelID: "42" },
      log,
      fetchImpl,
      dedupe,
      onInbound: (message) => void inbound.push(message.text),
    })

    await provider.poll()
    await provider.poll()

    expect(inbound).toEqual([])
  })

  it("drops an unlisted sender and answers an allowlisted one", async () => {
    const { log } = capture()
    const inbound: string[] = []
    const { fetchImpl } = pages([
      [{ id: "100", author: { id: "u1" }, content: "history" }],
      [
        { id: "101", author: { id: "u2" }, content: "let me in" },
        { id: "102", author: { id: "u1" }, content: "/relay status" },
      ],
    ])
    const provider = discordProvider({
      token: "t",
      dest: { channelID: "42" },
      log,
      fetchImpl,
      dedupe: seen(),
      allowSender: (senderID) => senderID === "u1",
      onInbound: (message) => {
        inbound.push(message.text)
        return "ok"
      },
    })

    await provider.poll()
    await provider.poll()

    expect(inbound).toEqual(["/relay status"])
  })

  it("does not record a message the relay cannot act on", async () => {
    const { log } = capture()
    const dedupe = seen()
    const { fetchImpl } = pages([
      [{ id: "100", author: { id: "u1" }, content: "history" }],
      [{ id: "101", author: { id: "u1" }, content: "hi" }],
    ])
    // no onInbound: nothing would be answered, so nothing should be remembered for a restart
    const provider = discordProvider({ token: "t", dest: { channelID: "42" }, log, fetchImpl, dedupe })

    await provider.poll()
    await provider.poll()

    expect([...dedupe.keys]).toEqual([])
  })

  it("logs a failed poll without throwing", async () => {
    const { log, lines } = capture()
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch

    await discordProvider({ token: "t", dest: { channelID: "42" }, log, fetchImpl }).poll()
    expect(lines.join("")).toContain("discord poll failed")
  })
})

describe("createTransports discord routing", () => {
  const dataDir = () => mkdtemp(join(tmpdir(), "relay-transports-"))

  it("runs discord when the token and channel are present", async () => {
    const { log } = capture()
    const socket = sockets()
    const relay = await createTransports(
      config({ enabled: true, channelID: "42" }),
      log,
      { DISCORD_BOT_TOKEN: "s3cr3t" },
      { dataDir: await dataDir(), discordSocket: socket.factory, discordBackoff: () => 0 },
    )

    expect(relay.transports.map((transport) => transport.name)).toEqual(["discord"])
    expect(relay.statuses).toEqual([
      { name: "whatsapp", state: "disabled", reason: "whatsapp.enabled is false" },
      // polling until READY, then the reason flips to "gateway"
      { name: "discord", state: "live", reason: "polling" },
    ])
    socket.last().open()
    expect(relay.statuses[1]?.reason).toBe("gateway")
    await relay.stop()
  })

  it("names the close behind a polling-only discord status", async () => {
    const { log } = capture()
    const socket = sockets()
    const relay = await createTransports(
      config({ enabled: true, channelID: "42" }),
      log,
      { DISCORD_BOT_TOKEN: "s3cr3t" },
      { dataDir: await dataDir(), discordSocket: socket.factory, discordBackoff: () => 0 },
    )

    // 4014: a privileged intent is off in the portal, so polling is all this bot will ever get
    socket.last().close(4014, "Disallowed intent(s)")
    await flush()

    const reason = relay.statuses[1]?.reason ?? ""
    expect(reason).toContain("polling")
    expect(reason).toContain("4014")
    expect(reason).toContain("MESSAGE_CONTENT")
    await relay.stop()
  })

  it("reports discord mocked when the token is absent and uses the mock sink alone", async () => {
    const { log, lines } = capture()
    const relay = await createTransports(config({ enabled: true, channelID: "42" }), log, {}, {
      dataDir: await dataDir(),
    })

    expect(relay.transports.map((transport) => transport.name)).toEqual(["mock"])
    expect(relay.statuses.find((status) => status.name === "discord")).toEqual({
      name: "discord",
      state: "mocked",
      reason: "discord credentials missing (DISCORD_BOT_TOKEN, discord.channelID)",
    })
    expect(lines.join("")).toContain("DISCORD_BOT_TOKEN")
    expect(lines.join("")).not.toContain("s3cr3t")
  })

  it("reports discord disabled when discord.enabled is false", async () => {
    const { log, lines } = capture()
    const relay = await createTransports(config({ enabled: false, channelID: "42" }), log, {
      DISCORD_BOT_TOKEN: "s3cr3t",
    }, { dataDir: await dataDir() })

    expect(relay.statuses.find((status) => status.name === "discord")).toEqual({
      name: "discord",
      state: "disabled",
      reason: "discord.enabled is false",
    })
    expect(lines.join("")).not.toContain("s3cr3t")
  })

  it("reports the missing channel", async () => {
    const { log } = capture()
    const relay = await createTransports(config({ enabled: true }), log, { DISCORD_BOT_TOKEN: "s3cr3t" }, {
      dataDir: await dataDir(),
    })

    expect(relay.statuses.find((status) => status.name === "discord")?.reason).toContain("discord.channelID")
  })

  it("reports the missing dm user", async () => {
    const { log } = capture()
    const relay = await createTransports(config({ enabled: true, target: "dm" }), log, {
      DISCORD_BOT_TOKEN: "s3cr3t",
    }, { dataDir: await dataDir() })

    expect(relay.statuses.find((status) => status.name === "discord")?.reason).toContain("discord.dmUserID")
  })
})

describe("discord config", () => {
  it("treats a channelID without target as channel mode", () => {
    const parsed = configSchema.parse({ ...example, discord: { channelID: "42" } })

    expect(parsed.discord.target).toBe("channel")
    expect(parsed.discord.channelID).toBe("42")
  })
})

describe("discordProvider dm", () => {
  const API_USERS = "https://discord.com/api/v10/users/@me/channels"
  const dmChannel = "https://discord.com/api/v10/channels/dm1/messages"

  /** Opens the DM once, then posts; the open call is what the cache must save. */
  const fakeDiscord = () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      if (String(url) === API_USERS) return new Response(JSON.stringify({ id: "dm1" }), { status: 200 })
      return new Response(JSON.stringify({ id: `msg_${calls.length}` }), { status: 200 })
    }) as typeof fetch
    return { calls, fetchImpl, opens: () => calls.filter((call) => call.url === API_USERS).length }
  }

  const stateDir = () => mkdtemp(join(tmpdir(), "relay-discord-"))

  it("opens the DM once, posts into it and caches the channel across restarts", async () => {
    const { log } = capture()
    const dataDir = await stateDir()
    const discord = fakeDiscord()
    const options = { token: "t", dest: { dmUserID: "u1" }, dataDir, log, fetchImpl: discord.fetchImpl }

    // two sends on one provider: the open runs once
    const provider = discordProvider(options)
    await provider.send(envelope("hi"))
    await provider.send(envelope("hello again"))
    expect(discord.opens()).toBe(1)
    expect(discord.calls.at(-1)?.url).toBe(dmChannel)

    // a restart reads auth-state/discord.json instead of opening the DM again
    await discordProvider(options).send(envelope("after a restart"))
    expect(discord.opens()).toBe(1)
    expect(JSON.parse(await readFile(join(dataDir, "discord.json"), "utf8"))).toEqual({
      dmUserID: "u1",
      channelID: "dm1",
    })
  })

  it("opens a different channel when the configured user changes", async () => {
    const { log } = capture()
    const dataDir = await stateDir()
    const discord = fakeDiscord()
    await discordProvider({ token: "t", dest: { dmUserID: "u1" }, dataDir, log, fetchImpl: discord.fetchImpl }).send(
      envelope("hi"),
    )
    await discordProvider({ token: "t", dest: { dmUserID: "u2" }, dataDir, log, fetchImpl: discord.fetchImpl }).send(
      envelope("hi"),
    )

    expect(discord.opens()).toBe(2)
  })

  it("polls the resolved DM channel", async () => {
    const { log } = capture()
    const calls: string[] = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url))
      if (String(url) === API_USERS) return new Response(JSON.stringify({ id: "dm1" }), { status: 200 })
      return new Response(JSON.stringify([]), { status: 200 })
    }) as typeof fetch

    await discordProvider({ token: "t", dest: { dmUserID: "u1" }, dataDir: await stateDir(), log, fetchImpl }).poll()

    expect(calls).toEqual([API_USERS, `${dmChannel}?limit=1`])
  })

  it("does not cache a failed DM open and retries it on the next send", async () => {
    const { log } = capture()
    const dataDir = await stateDir()
    let opens = 0
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url) === API_USERS) {
        opens++
        return opens === 1 ? new Response("Unauthorized", { status: 401 }) : new Response(JSON.stringify({ id: "dm1" }))
      }
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 })
    }) as typeof fetch
    const provider = discordProvider({ token: "t", dest: { dmUserID: "u1" }, dataDir, log, fetchImpl })

    const error = await provider.send(envelope("hi")).catch((caught: unknown) => caught)
    expect((error as Error).message).toContain("401")
    await provider.send(envelope("hi"))

    expect(opens).toBe(2)
    expect(await readFile(join(dataDir, "discord.json"), "utf8")).toContain("dm1")
  })
})

describe("linkDiscord", () => {
  const api = (status: number, body: unknown) => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
    }) as typeof fetch
    return { calls, fetchImpl }
  }

  it("checks a channel and posts the proof notice", async () => {
    const { calls, fetchImpl } = api(200, { id: "42" })

    await linkDiscord({ channelID: "42" }, "s3cr3t", fetchImpl)

    expect(calls[0]?.url).toBe("https://discord.com/api/v10/channels/42")
    expect(calls[1]?.url).toBe("https://discord.com/api/v10/channels/42/messages")
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ content: LINKED_TEXT })
  })

  it("opens the DM before posting the proof notice", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      if (String(url).endsWith("/users/@me/channels")) return new Response(JSON.stringify({ id: "dm1" }))
      return new Response(JSON.stringify({ id: "posted" }))
    }) as typeof fetch

    await linkDiscord({ dmUserID: "u1" }, "t", fetchImpl)

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ recipient_id: "u1" })
    expect(calls[1]?.url).toBe("https://discord.com/api/v10/channels/dm1/messages")
  })

  it("surfaces Discord's error text without the token", async () => {
    const { fetchImpl } = api(403, "Missing Access")

    const error = await linkDiscord({ channelID: "42" }, "s3cr3t", fetchImpl).catch((caught: unknown) => caught)

    expect((error as Error).message).toContain("403 Missing Access")
    expect((error as Error).message).not.toContain("s3cr3t")
  })
})

describe("discordProvider gateway", () => {
  /** One provider with a fake socket and a fetch that answers commands, callbacks and posts. */
  const harness = (
    overrides: {
      buttons?: boolean
      allowSender?: (senderID: string) => boolean
      onInbound?: (message: InboundMessage) => string | undefined
    } = {},
  ) => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      if (init?.method === "PUT") return new Response("[]", { status: 200 })
      if (String(url).includes("/interactions/")) return new Response(null, { status: 204 })
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 })
    }) as typeof fetch
    const { log } = capture()
    const socket = sockets()
    const inbound: InboundMessage[] = []
    const provider = discordProvider({
      token: "t",
      dest: { channelID: "42" },
      log,
      fetchImpl,
      gateway: { socket: socket.factory, backoff: () => 60_000 },
      ...(overrides.buttons === undefined ? {} : { buttons: overrides.buttons }),
      ...(overrides.allowSender === undefined ? {} : { allowSender: overrides.allowSender }),
      onInbound: (message) => {
        inbound.push(message)
        return overrides.onInbound?.(message) ?? "answered"
      },
    })
    return {
      provider,
      calls,
      inbound,
      socket,
      puts: () => calls.filter((call) => call.init.method === "PUT"),
      callbacks: () => calls.filter((call) => String(call.url).includes("/callback")),
      edits: () => calls.filter((call) => call.init.method === "PATCH"),
      gets: () => calls.filter((call) => call.init.method === undefined),
    }
  }

  const command = (name: string, userID = "u1") => ({
    id: `i-${name}`,
    type: 2,
    token: "itok",
    channel_id: "42",
    member: { user: { id: userID } },
    data: { name },
  })

  it("routes a slash command through the typed handler and answers ephemerally", async () => {
    const test = harness({ onInbound: () => "provider: discord" })
    await test.provider.start?.()
    test.socket.last().open("app1")
    await flush()
    expect(test.puts()).toHaveLength(1)

    test.socket.last().emit({ op: 0, s: 2, t: "INTERACTION_CREATE", d: command("status") })
    await flush()

    expect(test.inbound.map((message) => message.text)).toEqual(["/relay status"])
    expect(test.inbound[0]?.senderID).toBe("u1")
    expect(test.inbound[0]?.chatID).toBe("42")
    expect(JSON.parse(String(test.callbacks()[0]?.init.body))).toEqual({ type: 5, data: { flags: 64 } })
    const edit = test.edits()[0]
    expect(edit?.url).toBe("https://discord.com/api/v10/webhooks/app1/itok/messages/@original")
    expect(JSON.parse(String(edit?.init.body))).toEqual({ content: "provider: discord", flags: 64 })
    await test.provider.stop?.()
  })

  it("answers an unknown subcommand with the usage text", async () => {
    const test = harness()
    await test.provider.start?.()
    test.socket.last().open()
    await flush()

    test.socket.last().emit({ op: 0, s: 2, t: "INTERACTION_CREATE", d: command("nope") })
    await flush()

    expect(test.inbound).toEqual([])
    expect(String(JSON.parse(String(test.edits()[0]?.init.body)).content)).toContain("/relay status")
    await test.provider.stop?.()
  })

  it("ignores an interaction from an unlisted user and answers a listed one", async () => {
    const test = harness({ allowSender: (senderID) => senderID === "u1", onInbound: () => "listed" })
    await test.provider.start?.()
    test.socket.last().open()
    await flush()

    test.socket.last().emit({ op: 0, s: 2, t: "INTERACTION_CREATE", d: command("status", "u2") })
    await flush()
    // dropped before the deferred acknowledgement: the click never reaches a handler
    expect(test.inbound).toEqual([])
    expect(test.callbacks()).toEqual([])

    test.socket.last().emit({ op: 0, s: 3, t: "INTERACTION_CREATE", d: command("status", "u1") })
    await flush()
    expect(test.inbound.map((message) => message.senderID)).toEqual(["u1"])
    await test.provider.stop?.()
  })

  it("gates a DM sender too, fail closed", async () => {
    const { log } = capture()
    const socket = sockets()
    const inbound: InboundMessage[] = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response("[]", { status: 200 })
      if (String(url).includes("/users/@me/channels")) {
        return new Response(JSON.stringify({ id: "dm42" }), { status: 200 })
      }
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 })
    }) as typeof fetch
    const provider = discordProvider({
      token: "t",
      dest: { dmUserID: "7" },
      log,
      fetchImpl,
      allowSender: () => false,
      onInbound: (message) => {
        inbound.push(message)
        return "never"
      },
      gateway: { socket: socket.factory, backoff: () => 60_000 },
    })
    await provider.start?.()
    socket.last().open()
    await flush()

    socket.last().emit({
      op: 0,
      s: 2,
      t: "MESSAGE_CREATE",
      d: { id: "101", content: "hi", author: { id: "991" } },
    })
    await flush()

    expect(inbound).toEqual([])
    await provider.stop?.()
  })

  it("turns a permission button click into the typed answer", async () => {
    const test = harness({ onInbound: () => "permission per_1 answered" })
    await test.provider.start?.()
    test.socket.last().open()
    await flush()

    test.socket.last().emit({
      op: 0,
      s: 2,
      t: "INTERACTION_CREATE",
      d: { id: "c1", type: 3, token: "ctok", channel_id: "42", user: { id: "u1" }, data: { custom_id: "relay:always" } },
    })
    await flush()

    expect(test.inbound.map((message) => message.text)).toEqual(["always"])
    expect(String(JSON.parse(String(test.edits()[0]?.init.body)).content)).toContain("permission per_1")
    await test.provider.stop?.()
  })

  it("turns a question button click and a select choice into the typed answer text", async () => {
    const test = harness({ onInbound: () => "noted branch" })
    await test.provider.start?.()
    test.socket.last().open()
    await flush()

    test.socket.last().emit({
      op: 0,
      s: 2,
      t: "INTERACTION_CREATE",
      d: { id: "q1", type: 3, token: "qtok", channel_id: "42", user: { id: "u1" }, data: { custom_id: "q:frm_1:branch:release" } },
    })
    await flush()
    test.socket.last().emit({
      op: 0,
      s: 3,
      t: "INTERACTION_CREATE",
      d: {
        id: "q2",
        type: 3,
        token: "qtok",
        channel_id: "42",
        user: { id: "u1" },
        data: { custom_id: "q:frm_1:tags", values: ["a", "b"] },
      },
    })
    await flush()

    expect(test.inbound.map((message) => message.text)).toEqual(["branch: release", "tags: a, b"])
    expect(String(JSON.parse(String(test.edits()[0]?.init.body)).content)).toBe("noted branch")
    await test.provider.stop?.()
  })

  it("answers a failing handler with its error text instead of staying silent", async () => {
    const test = harness({
      onInbound: () => {
        throw new Error("boom")
      },
    })
    await test.provider.start?.()
    test.socket.last().open()
    await flush()

    test.socket.last().emit({ op: 0, s: 2, t: "INTERACTION_CREATE", d: command("status") })
    await flush()

    expect(test.callbacks()).toHaveLength(1)
    expect(String(JSON.parse(String(test.edits()[0]?.init.body)).content)).toBe("relay: boom")
    await test.provider.stop?.()
  })

  it("takes messages from the gateway and skips the REST poll while live", async () => {
    const test = harness()
    await test.provider.start?.()
    test.socket.last().open()
    await flush()

    test.socket.last().emit({
      op: 0,
      s: 2,
      t: "MESSAGE_CREATE",
      d: { id: "101", channel_id: "42", content: "hello", author: { id: "u1" } },
    })
    await flush()
    await test.provider.poll?.()

    expect(test.inbound.map((message) => message.text)).toEqual(["hello"])
    expect(test.gets()).toEqual([])
    await test.provider.stop?.()
  })

  it("falls back to polling once the socket drops", async () => {
    const test = harness()
    await test.provider.start?.()
    test.socket.last().open()
    await flush()

    test.socket.last().close(1006)
    await flush()
    await test.provider.poll?.()

    expect(test.gets().map((call) => call.url)).toEqual([`${MESSAGES}?limit=1`])
    await test.provider.stop?.()
  })

  it("fails over to polling when the socket is dead but never closes", async () => {
    const test = harness()
    await test.provider.start?.()
    // 5ms heartbeats: the second tick finds the first unacked, which is how a zombie is detected
    test.socket.last().emit({ op: 10, d: { heartbeat_interval: 5 } })
    test.socket.last().emit({
      op: 0,
      s: 1,
      t: "READY",
      d: { session_id: "sess1", application: { id: "app1" }, user: { username: "relay" } },
    })
    await flush()
    // while it believes it is ready, the REST poll stays off
    expect(test.gets()).toEqual([])

    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(test.socket.last().closed).toBe(4000)
    await test.provider.poll?.()
    expect(test.gets().map((call) => call.url)).toEqual([`${MESSAGES}?limit=1`])
    await test.provider.stop?.()
  })
})
