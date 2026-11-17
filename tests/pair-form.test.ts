import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { configSchema } from "../src/config.js"
import { createCorrelationStore, DEFAULT_TTL_MS } from "../src/interactions/correlation.js"
import { relayCommand, type RelayCommandDeps } from "../src/interactions/inbound.js"
import {
  createPairForm,
  type FormValue,
  handlePairReply,
  type PairFormDeps,
  type PairNotice,
  type PairReplyDeps,
} from "../src/pairing.js"
import { LINKED_TEXT } from "../src/providers/discord.js"
import type { PairingSocket } from "../src/providers/whatsapp.js"

const SERVER = "http://127.0.0.1:4096"
const SESSION = "ses_1"
const example = JSON.parse(await readFile(new URL("../examples/config.example.json", import.meta.url), "utf8"))

interface Call {
  readonly url: string
  readonly init: RequestInit
}

interface Options {
  target?: string
  env?: Record<string, string | undefined>
  /** Clock for the correlation store, so expiry can be forced. */
  now?: () => number
  /**
   * Which socket exists: `up` is the running provider's, `down` is a provider whose socket died,
   * `none` is provider "mock" where no Baileys socket ever exists.
   */
  socket?: "up" | "down" | "none"
  /** Stand-in for the after-link config flip; defaults to the real one. */
  flip?: (configPath: string) => Promise<boolean>
  /** What the transient socket offers as qr(): undefined = a socket that never saw a QR event. */
  qr?: string
  /**
   * Makes requestPairingCode reject. `retryable` mimics a socket that closed before the code was
   * asked for (whatsapp.ts wraps that in PairingUnavailableError); `times` bounds how many opens
   * fail before the stub succeeds.
   */
  fail?: { message: string; retryable?: boolean; times?: number }
  /** Write linked creds.json up front, as an earlier completed link would. */
  paired?: boolean
  /** Write creds a started-but-unfinished pairing leaves up front: `me`, `registered` false. */
  started?: boolean
  /**
   * How the transient socket ends: `open` resolves waitForLink and saves linked creds, `close`
   * resolves waitForLink false (515) after saving linked creds, `unfinished` resolves waitForLink
   * but leaves unregistered creds, `none` never links.
   */
  link?: "open" | "close" | "unfinished" | "none"
  /** What the Discord API answers during the pair flow; default accepts every call. */
  discord?: (call: Call) => Response
}

const harness = async (options: Options = {}) => {
  const dir = await mkdtemp(join(tmpdir(), "relay-pair-form-"))
  const configPath = join(dir, "config.json")
  const config = configSchema.parse({
    ...example,
    ...(options.socket === "none" ? { provider: "mock" } : {}),
    whatsapp: { ...example.whatsapp, target: options.target ?? "" },
  })
  await writeFile(configPath, JSON.stringify(config), "utf8")

  /** A completed link: Baileys writes the creds object straight into creds.json. */
  const writeCreds = async (registered: boolean): Promise<void> => {
    const whatsappDir = join(dir, "auth-state", "whatsapp")
    await mkdir(whatsappDir, { recursive: true })
    await writeFile(
      join(whatsappDir, "creds.json"),
      JSON.stringify({ me: { id: "491234567890@s.whatsapp.net" }, registered }),
      "utf8",
    )
  }
  const linkedCreds = (): Promise<void> => writeCreds(true)
  /** A started but unfinished pairing: `me` exists, `registered` never flipped. */
  const startedCreds = (): Promise<void> => writeCreds(false)
  if (options.paired === true) await linkedCreds()
  if (options.started === true) await startedCreds()

  const store = await createCorrelationStore(join(dir, "auth-state"), options.now)
  const calls: Call[] = []
  // a valid channel gets a channel object, a DM open gets a channel, a post gets a message
  const okDiscord = (call: Call): Response => {
    if (call.url.endsWith("/users/@me/channels")) return new Response(JSON.stringify({ id: "dm_1" }))
    if (call.url.endsWith("/messages")) return new Response(JSON.stringify({ id: "posted_1" }))
    return new Response(JSON.stringify({ id: "ch_1" }))
  }
  // each form POST answers with a fresh frm_ id, as the server does
  let formCount = 0
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    if (call.url.startsWith("https://discord.com/")) return (options.discord ?? okDiscord)(call)
    formCount++
    return new Response(JSON.stringify({ data: { id: `frm_${formCount}` } }), { status: 200 })
  }) as typeof fetch
  const notices: PairNotice[] = []
  const code = vi.fn(async (_phone: string) => "ABCD1234")
  // stand-in for the Baileys pairing socket: no network, records the open/auth dir and the close
  const closed: string[] = []
  const opened: string[] = []
  let requests = 0
  const socket = (): PairingSocket => {
    // default `open`: waitForLink resolves and the creds a real link would save land on close
    const link = options.link ?? "open"
    return {
      requestPairingCode: async (phone) => {
        requests++
        if (options.fail !== undefined && requests <= (options.fail.times ?? Number.POSITIVE_INFINITY)) {
          const error = new Error(options.fail.message)
          // paired by name, the way pairing.ts recognises a closed socket
          if (options.fail.retryable !== false) error.name = "PairingUnavailableError"
          throw error
        }
        return code(phone)
      },
      waitForLink: async () => link === "open" || link === "unfinished",
      qr: () => options.qr,
      close: async () => {
        closed.push("closed")
        // a real link saves the creds first and only then closes with 515
        if (link === "open" || link === "close") await linkedCreds()
        // the code was entered but the phone never confirmed the device: creds stay unregistered
        if (link === "unfinished") await startedCreds()
      },
    }
  }
  const openPairingSocket = vi.fn(async (authDir: string) => {
    opened.push(authDir)
    return socket()
  })
  const pairing =
    options.socket === "none"
      ? { env: options.env ?? {}, openPairingSocket, ...(options.flip === undefined ? {} : { flipProvider: options.flip }) }
      : {
          env: options.env ?? {},
          whatsappCode: options.socket === "down" ? async () => Promise.reject(new Error("socket not running")) : code,
          openPairingSocket,
          ...(options.flip === undefined ? {} : { flipProvider: options.flip }),
        }
  const forms: PairFormDeps = { store, sessionID: SESSION, serverURL: SERVER, fetchImpl }
  const replies: PairReplyDeps = {
    store,
    configPath,
    pairing,
    serverURL: SERVER,
    fetchImpl,
    notice: async (message) => {
      notices.push(message)
    },
  }
  const deps: RelayCommandDeps = {
    configPath,
    provider: options.socket === "none" ? "mock" : "whatsapp",
    selected: {},
    store,
    serverURL: SERVER,
    fetchImpl,
    pairing,
  }
  return {
    calls,
    code,
    notices,
    store,
    forms,
    replies,
    opened,
    closed,
    openPairingSocket,
    dir,
    configPath,
    run: (text: string, sessionID?: string) => relayCommand(text, deps, sessionID),
  }
}

/** One `form.replied` payload for the given form. */
const answer = (id: string, values: Record<string, FormValue>) => ({ id, sessionID: SESSION, answer: values })

describe("interactive /relay pair form", () => {
  it("creates the provider picker and records the form for replies", async () => {
    const h = await harness()

    const text = await createPairForm(h.forms)

    expect(h.calls[0]?.url).toBe(`${SERVER}/api/session/${SESSION}/form`)
    expect(h.calls[0]?.init.method).toBe("POST")
    expect(JSON.parse(String(h.calls[0]?.init.body))).toEqual({
      title: "Pair a provider",
      fields: [
        {
          key: "provider",
          title: "Provider",
          type: "string",
          required: true,
          options: [
            { value: "whatsapp", label: "WhatsApp" },
            { value: "discord", label: "Discord" },
          ],
        },
      ],
    })
    expect(text).toContain("choose a provider")
    const record = h.store.list()[0]
    expect(record?.type).toBe("pairing")
    expect(record?.pair).toBe("provider")
    expect(record?.formID).toBe("frm_1")
  })

  it("opens the form from /relay pair without arguments when a session is at hand", async () => {
    const h = await harness()

    const text = await h.run("/relay pair", SESSION)

    expect(text).toContain("choose a provider")
    expect(h.calls[0]?.url).toBe(`${SERVER}/api/session/${SESSION}/form`)
  })

  it("opens the target form for a first discord pair instead of reporting the channel missing", async () => {
    const h = await harness({ env: { DISCORD_BOT_TOKEN: "tok" } })

    const text = await h.run("/relay pair discord", SESSION)

    // a missing target is the normal first pair: the form collects it, nothing says "missing"
    expect(text).not.toContain("missing")
    expect(text).toContain("answer the form")
    const body = JSON.parse(String(h.calls[0]?.init.body)) as { title: string; fields: Array<{ key: string }> }
    expect(body.title).toBe("Discord target")
    expect(body.fields[0]?.key).toBe("target")
    expect(h.store.list().find((record) => record.pair === "discord-target")).toBeDefined()
  })

  it("asks for the number from a bare /relay pair whatsapp instead of pointing at config.json", async () => {
    const h = await harness()

    const text = await h.run("/relay pair whatsapp", SESSION)

    expect(text).not.toContain("whatsapp.target")
    expect(h.code).not.toHaveBeenCalled()
    const body = JSON.parse(String(h.calls[0]?.init.body)) as { title: string }
    expect(body.title).toBe("WhatsApp number")
    expect(h.store.list().find((record) => record.pair === "number")).toBeDefined()
  })

  it("asks for the number when whatsapp.target is missing, then posts the code", async () => {
    const h = await harness()
    await createPairForm(h.forms)

    expect(await handlePairReply(answer("frm_1", { provider: "whatsapp" }), h.replies)).toBe(true)

    expect(h.notices).toHaveLength(0)
    expect(h.calls[1]?.url).toBe(`${SERVER}/api/session/${SESSION}/form`)
    const body = JSON.parse(String(h.calls[1]?.init.body)) as { title: string; fields: Array<Record<string, unknown>> }
    expect(body.title).toBe("WhatsApp number")
    expect(body.fields[0]).toMatchObject({ key: "number", type: "string", required: true })
    expect(h.store.get("frm_1")?.status).toBe("resolved")
    expect(h.store.list().find((record) => record.pair === "number")?.formID).toBe("frm_2")

    expect(await handlePairReply(answer("frm_2", { number: "+49 1234 567890" }), h.replies)).toBe(true)

    expect(h.code).toHaveBeenCalledWith("491234567890")
    expect(h.notices.at(-1)?.text).toContain("whatsapp pairing code: ABCD1234")
    expect(h.notices.at(-1)?.text).toContain("Linked devices")
    expect(h.notices.at(-1)?.description).toBe(h.notices.at(-1)?.text)
    expect(h.store.get("frm_2")?.status).toBe("resolved")
  })

  it("posts the code straight away when whatsapp.target is configured", async () => {
    const h = await harness({ target: "491234567890" })
    await createPairForm(h.forms)

    await handlePairReply(answer("frm_1", { provider: "whatsapp" }), h.replies)

    expect(h.calls).toHaveLength(1)
    expect(h.code).toHaveBeenCalledWith("491234567890")
    expect(h.notices[0]?.text).toContain("whatsapp pairing code: ABCD1234")
  })

  it("posts the discord setup steps when the token is missing", async () => {
    const h = await harness()
    await createPairForm(h.forms)

    await handlePairReply(answer("frm_1", { provider: "discord" }), h.replies)

    // no token means no live check: the form that would validate it is never opened
    expect(h.calls).toHaveLength(1)
    expect(h.notices[0]?.text).toContain("DISCORD_BOT_TOKEN")
    expect(h.notices[0]?.text).toContain("/relay pair")
    expect(h.store.get("frm_1")?.status).toBe("resolved")
  })

  it("asks channel vs DM, then links a channel and posts the proof notice", async () => {
    const token = "discord-secret-token"
    const h = await harness({ env: { DISCORD_BOT_TOKEN: token } })
    await createPairForm(h.forms)

    await handlePairReply(answer("frm_1", { provider: "discord" }), h.replies)

    const target = JSON.parse(String(h.calls[1]?.init.body)) as {
      title: string
      fields: Array<Record<string, unknown>>
    }
    expect(target.title).toBe("Discord target")
    expect(target.fields[0]).toMatchObject({
      key: "target",
      type: "string",
      required: true,
      options: [
        { value: "channel", label: "A server channel" },
        { value: "dm", label: "A DM with me" },
      ],
    })
    expect(h.store.list().find((record) => record.pair === "discord-target")?.formID).toBe("frm_2")

    await handlePairReply(answer("frm_2", { target: "channel" }), h.replies)

    const id = JSON.parse(String(h.calls[2]?.init.body)) as { title: string; fields: Array<Record<string, unknown>> }
    expect(id.title).toBe("Discord channel ID")
    expect(id.fields[0]).toMatchObject({ key: "id", type: "string", required: true })

    await handlePairReply(answer("frm_3", { id: "123456789012345678" }), h.replies)

    const checked = h.calls.find((call) => call.url === "https://discord.com/api/v10/channels/123456789012345678")
    expect(checked?.init.headers).toMatchObject({ authorization: `Bot ${token}` })
    const posted = h.calls.find((call) => call.url.endsWith("/messages"))
    expect(JSON.parse(String(posted?.init.body))).toEqual({ content: LINKED_TEXT })
    expect(h.notices.at(-1)?.text).toContain("discord: linked")
    expect(h.notices.at(-1)?.text).not.toContain(token)
    // a channel pair proves no user ID: the notice says the allowlist is the manual step
    expect(h.notices.at(-1)?.text).toContain("security.allowlist")
    expect(JSON.parse(await readFile(h.configPath, "utf8"))).toMatchObject({
      discord: { enabled: true, target: "channel", channelID: "123456789012345678" },
    })
  })

  it("links a DM through the open-users channel", async () => {
    const h = await harness({ env: { DISCORD_BOT_TOKEN: "tok" } })
    await createPairForm(h.forms)
    await handlePairReply(answer("frm_1", { provider: "discord" }), h.replies)
    await handlePairReply(answer("frm_2", { target: "dm" }), h.replies)

    const id = JSON.parse(String(h.calls[2]?.init.body)) as { title: string }
    expect(id.title).toBe("Discord user ID")

    await handlePairReply(answer("frm_3", { id: "u1" }), h.replies)

    const opened = h.calls.find((call) => call.url.endsWith("/users/@me/channels"))
    expect(JSON.parse(String(opened?.init.body))).toEqual({ recipient_id: "u1" })
    expect(h.calls.find((call) => call.url.endsWith("/messages"))?.url).toBe(
      "https://discord.com/api/v10/channels/dm_1/messages",
    )
    expect(JSON.parse(await readFile(h.configPath, "utf8"))).toMatchObject({
      discord: { enabled: true, target: "dm", dmUserID: "u1" },
      // the user ID the pair proved is allowlisted: a fail-closed relay would otherwise lock them out
      security: { allowlist: ["u1"] },
    })
    expect(h.notices.at(-1)?.text).toContain("allowlisted u1 in security.allowlist")
  })

  it("reports Discord's error text and leaves config alone when the check fails", async () => {
    const token = "discord-secret-token"
    const h = await harness({
      env: { DISCORD_BOT_TOKEN: token },
      discord: () => new Response("Missing Access", { status: 403 }),
    })
    await createPairForm(h.forms)
    await handlePairReply(answer("frm_1", { provider: "discord" }), h.replies)
    await handlePairReply(answer("frm_2", { target: "channel" }), h.replies)
    await handlePairReply(answer("frm_3", { id: "42" }), h.replies)

    const text = h.notices.at(-1)?.text ?? ""
    expect(text).toContain("discord: not linked")
    expect(text).toContain("403 Missing Access")
    // the by-hand config is the fallback after a failed check, never the first answer
    expect(text).toContain("by hand")
    expect(text).toContain("discord.channelID")
    expect(text).not.toContain(token)
    expect(JSON.parse(await readFile(h.configPath, "utf8"))).toMatchObject({ discord: { enabled: false } })
  })

  it("offers the install URL when Discord refuses the DM for lack of a shared guild (50278)", async () => {
    const h = await harness({
      env: { DISCORD_BOT_TOKEN: "tok" },
      discord: (call) => {
        if (call.url.endsWith("/users/@me")) return new Response(JSON.stringify({ id: "app_1" }))
        if (call.url.endsWith("/users/@me/channels")) return new Response(JSON.stringify({ id: "dm_1" }))
        return new Response(
          JSON.stringify({ code: 50278, message: "Cannot send messages to this user due to having no mutual guilds" }),
          { status: 403 },
        )
      },
    })
    await createPairForm(h.forms)
    await handlePairReply(answer("frm_1", { provider: "discord" }), h.replies)
    await handlePairReply(answer("frm_2", { target: "dm" }), h.replies)
    await handlePairReply(answer("frm_3", { id: "u1" }), h.replies)

    const text = h.notices.at(-1)?.text ?? ""
    expect(text).toContain("50278")
    expect(text).toContain(
      "https://discord.com/oauth2/authorize?client_id=app_1&permissions=101376&scope=bot+applications.commands",
    )
    expect(JSON.parse(await readFile(h.configPath, "utf8"))).toMatchObject({ discord: { enabled: false } })
  })

  it("expires an unanswered pair form instead of answering it later", async () => {
    let clock = 1_000
    const h = await harness({ now: () => clock })
    await createPairForm(h.forms)

    clock += DEFAULT_TTL_MS + 1
    expect(await h.store.expire()).toBe(1)

    expect(await handlePairReply(answer("frm_1", { provider: "discord" }), h.replies)).toBe(false)
    expect(h.notices).toHaveLength(0)
  })

  it("ignores forms it did not create", async () => {
    const h = await harness()

    expect(await handlePairReply(answer("frm_other", { provider: "discord" }), h.replies)).toBe(false)
    expect(h.notices).toHaveLength(0)
  })

  it("keeps the direct-argument path: no form is created for /relay pair whatsapp", async () => {
    const h = await harness({ target: "491234567890" })

    expect(await h.run("/relay pair whatsapp", SESSION)).toContain("whatsapp pairing code: ABCD1234")
    expect(h.calls).toHaveLength(0)

    const listing = await harness()
    expect(await listing.run("/relay pair")).toContain("usage: /relay pair")
    expect(listing.calls).toHaveLength(0)
  })

  it("pairs from mock mode over a transient socket with link instructions only", async () => {
    const h = await harness({ socket: "none", target: "491234567890" })

    const text = await h.run("/relay pair whatsapp", SESSION)

    expect(h.openPairingSocket).toHaveBeenCalledWith(join(h.dir, "auth-state", "whatsapp"))
    expect(h.code).toHaveBeenCalledWith("491234567890")
    expect(text).toContain("whatsapp pairing code: ABCD1234")
    expect(text).toContain("Linked devices")
    // no go-live wording before the phone links
    expect(text).not.toContain("restart")
    expect(text).not.toContain("provider flipped")

    // the socket outlives the code only until the phone links, then it is closed
    await vi.waitFor(() => expect(h.closed).toHaveLength(1))
  })

  it("flips and posts the go-live notice when the link arrives as a 515 close", async () => {
    const h = await harness({ socket: "none", target: "491234567890", link: "close" })
    await createPairForm(h.forms)

    await handlePairReply(answer("frm_1", { provider: "whatsapp" }), h.replies)

    // the code notice still carries no go-live wording
    const code = h.notices.map((notice) => notice.text).find((text) => text.includes("whatsapp pairing code")) ?? ""
    expect(code).not.toContain("restart")
    // waitForLink never saw an open event; the creds the close left behind decide it
    await vi.waitFor(() => expect(h.notices.at(-1)?.text).toContain("provider flipped to whatsapp automatically"))
    expect(h.notices.at(-1)?.text).toContain("restart OpenCode to go live")
    // the number the link proved is allowlisted, and the notice says which one
    expect(h.notices.at(-1)?.text).toContain("allowlisted 491234567890 in security.allowlist")
    expect(JSON.parse(await readFile(join(h.dir, "config.json"), "utf8"))).toMatchObject({
      provider: "whatsapp",
      whatsapp: { enabled: true },
      security: { allowlist: ["491234567890"] },
    })
  })

  it("flips a config still on mock when the creds are already linked", async () => {
    const h = await harness({ socket: "none", paired: true })

    const text = await h.run("/relay pair whatsapp", SESSION)

    expect(text).toContain("provider flipped to whatsapp automatically")
    expect(text).toContain("restart OpenCode to go live")
    expect(text).not.toContain("already paired")
    expect(JSON.parse(await readFile(join(h.dir, "config.json"), "utf8"))).toMatchObject({
      provider: "whatsapp",
      whatsapp: { enabled: true },
    })
    expect(h.code).not.toHaveBeenCalled()
  })

  it("leaves an already-paired whatsapp provider alone, without a second notice", async () => {
    const flip = vi.fn(async () => true)
    const h = await harness({ paired: true, flip })
    await createPairForm(h.forms)

    await handlePairReply(answer("frm_1", { provider: "whatsapp" }), h.replies)

    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]?.text).toContain("already paired")
    expect(flip).not.toHaveBeenCalled()
    expect(h.code).not.toHaveBeenCalled()
  })

  it("flips the provider to whatsapp once the transient socket links", async () => {
    const h = await harness({ socket: "none", target: "491234567890" })

    await h.run("/relay pair whatsapp", SESSION)

    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(join(h.dir, "config.json"), "utf8")) as {
        provider: string
        whatsapp: { enabled: boolean }
      }
      expect(saved.provider).toBe("whatsapp")
      expect(saved.whatsapp.enabled).toBe(true)
    })
  })

  it("re-enables whatsapp when a previous /relay unpair left it disabled", async () => {
    const h = await harness({ socket: "none", target: "491234567890" })
    const path = join(h.dir, "config.json")
    // what /relay unpair whatsapp leaves: provider still whatsapp, transport off
    const config = JSON.parse(await readFile(path, "utf8")) as {
      provider: string
      whatsapp: { enabled: boolean }
    }
    config.provider = "whatsapp"
    config.whatsapp.enabled = false
    await writeFile(path, JSON.stringify(config), "utf8")

    await h.run("/relay pair whatsapp", SESSION)

    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(path, "utf8")) as { whatsapp: { enabled: boolean } }
      expect(saved.whatsapp.enabled).toBe(true)
    })
  })

  it("falls back to the manual provider step when config.json cannot be updated", async () => {
    const h = await harness({ socket: "none", target: "491234567890", flip: async () => false })
    await createPairForm(h.forms)

    await handlePairReply(answer("frm_1", { provider: "whatsapp" }), h.replies)

    await vi.waitFor(() =>
      expect(h.notices.map((notice) => notice.text).join("\n")).toContain('set provider to "whatsapp" in config.json'),
    )
    expect(JSON.parse(await readFile(join(h.dir, "config.json"), "utf8"))).toMatchObject({ provider: "mock" })
  })

  it("pairs over a transient socket when the provider socket is gone", async () => {
    const h = await harness({ socket: "down", target: "491234567890" })
    await createPairForm(h.forms)

    await handlePairReply(answer("frm_1", { provider: "whatsapp" }), h.replies)

    expect(h.openPairingSocket).toHaveBeenCalled()
    const code = h.notices.map((notice) => notice.text).find((text) => text.includes("whatsapp pairing code")) ?? ""
    expect(code).toContain("whatsapp pairing code: ABCD1234")
    expect(code).not.toContain("restart")
    expect(code).not.toContain('set provider to "whatsapp"')
    // the provider is already whatsapp: only the restart is left, and it comes after the link
    await vi.waitFor(() =>
      expect(h.notices.some((notice) => notice.text.includes("restart OpenCode so the relay connects"))).toBe(true),
    )
  })

  it("reports not paired when creds.json holds no linked device", async () => {
    const h = await harness({ target: "491234567890" })
    await mkdir(join(h.dir, "auth-state", "whatsapp"), { recursive: true })
    await writeFile(join(h.dir, "auth-state", "whatsapp", "creds.json"), "{}", "utf8")

    const text = await h.run("/relay pair whatsapp", SESSION)

    expect(text).toContain("whatsapp pairing code: ABCD1234")
    expect(text).not.toContain("already paired")
  })

  it("treats creds with me but no registered flag as unfinished, without flipping", async () => {
    const flip = vi.fn(async () => true)
    // the live false positive: the number is in creds.json, the phone never finished the link
    const h = await harness({ socket: "none", target: "491234567890", started: true, link: "none", flip })

    const text = await h.run("/relay pair whatsapp", SESSION)

    expect(text).toContain("pairing started but not completed")
    expect(text).not.toContain("already paired")
    expect(text).not.toContain("linked")
    expect(text).toContain("whatsapp pairing code: ABCD1234")
    await vi.waitFor(() => expect(h.closed).toHaveLength(1))
    expect(flip).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(join(h.dir, "config.json"), "utf8"))).toMatchObject({ provider: "mock" })
  })

  it("asks for the code again instead of flipping when the link never registers", async () => {
    const flip = vi.fn(async () => true)
    // waitForLink resolves, but the close leaves unregistered creds: not a link
    const h = await harness({ socket: "none", target: "491234567890", link: "unfinished", flip })
    await createPairForm(h.forms)

    await handlePairReply(answer("frm_1", { provider: "whatsapp" }), h.replies)

    await vi.waitFor(() =>
      expect(h.notices.map((notice) => notice.text).join("\n")).toContain("phone has not completed the link yet"),
    )
    expect(flip).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(join(h.dir, "config.json"), "utf8"))).toMatchObject({ provider: "mock" })
  })

  it("surfaces the real close reason, after one retry, instead of the generic failure", async () => {
    const h = await harness({
      socket: "none",
      target: "491234567890",
      fail: { message: "428 Connection Terminated" },
    })

    const text = await h.run("/relay pair whatsapp", SESSION)

    expect(text).toContain("pairing failed: 428 Connection Terminated")
    // a closed socket is transient: one retry, then the real reason
    expect(h.openPairingSocket).toHaveBeenCalledTimes(2)
    expect(h.closed).toHaveLength(2)
  })

  it("retries once and still pairs when the first socket closed early", async () => {
    const h = await harness({
      socket: "none",
      target: "491234567890",
      fail: { message: "428 Connection Terminated", times: 1 },
    })

    const text = await h.run("/relay pair whatsapp", SESSION)

    expect(h.openPairingSocket).toHaveBeenCalledTimes(2)
    expect(text).toContain("whatsapp pairing code: ABCD1234")
    expect(text).not.toContain("pairing failed")
  })

  it("does not retry a failure that is not a closed socket", async () => {
    const h = await harness({
      socket: "none",
      target: "491234567890",
      fail: { message: "custom pairing code must be exactly 8 chars", retryable: false },
    })

    const text = await h.run("/relay pair whatsapp", SESSION)

    expect(h.openPairingSocket).toHaveBeenCalledTimes(1)
    expect(text).toContain("pairing failed: custom pairing code must be exactly 8 chars")
  })

  it("adds the QR as blocks to the notice when the socket offered one", async () => {
    const h = await harness({
      socket: "none",
      target: "491234567890",
      qr: "https://wa.me/settings/linked_devices#ref,noiseKey,identityKey,adv,1",
    })
    await createPairForm(h.forms)

    await handlePairReply(answer("frm_1", { provider: "whatsapp" }), h.replies)

    const notice = h.notices.find((posted) => posted.text.includes("whatsapp pairing code"))
    expect(notice?.text).toContain("phone camera")
    // block characters, rendered from the qr event payload
    expect(notice?.description).toContain("\u2588")
  })

  it("omits the QR silently when the code path never saw a qr event", async () => {
    const h = await harness({ socket: "none", target: "491234567890" })

    const text = await h.run("/relay pair whatsapp", SESSION)

    expect(text).toContain("whatsapp pairing code: ABCD1234")
    expect(text).not.toContain("\u2588")
    expect(text).not.toContain("phone camera")
  })

  it("points at the stale auth dir when the creds already hold a linked device", async () => {
    const h = await harness({ socket: "none", fail: { message: "428 Connection Terminated" } })
    await createPairForm(h.forms)
    // no whatsapp.target yet, so the provider picker is followed by the number form
    await handlePairReply(answer("frm_1", { provider: "whatsapp" }), h.replies)
    // an earlier attempt left fully linked creds behind: every socket now takes the login path
    await mkdir(join(h.dir, "auth-state", "whatsapp"), { recursive: true })
    await writeFile(
      join(h.dir, "auth-state", "whatsapp", "creds.json"),
      '{"me":{"id":"491234567890@s.whatsapp.net"},"registered":true}',
      "utf8",
    )

    await handlePairReply(answer("frm_2", { number: "491234567890" }), h.replies)

    const text = h.notices.at(-1)?.text ?? ""
    expect(text).toContain("pairing failed: 428 Connection Terminated")
    expect(text).toContain("delete that folder")
  })
})
