import pino from "pino"
import { describe, expect, it, vi } from "vitest"
import {
  closeHint,
  commandsBody,
  componentText,
  createDiscordGateway,
  GATEWAY_INTENTS,
  interactionText,
  questionAnswer,
  registerCommands,
  type GatewaySocket,
} from "../src/providers/discord-gateway.js"
import { flush, sockets } from "./fake-socket.js"

const capture = () => {
  const lines: string[] = []
  const log = pino({ level: "debug" }, { write: (line: string) => lines.push(line) })
  return { log, lines }
}

const gateway = (factory: (url: string) => GatewaySocket, overrides: Record<string, unknown> = {}) => {
  const { log, lines } = capture()
  const onMessage = vi.fn()
  const onInteraction = vi.fn()
  const onReady = vi.fn()
  const onDown = vi.fn()
  const created = createDiscordGateway({
    token: "s3cr3t",
    log,
    socket: factory,
    backoff: () => 0,
    onMessage,
    onInteraction,
    onReady,
    onDown,
    ...overrides,
  })
  return { created, log, lines, onMessage, onInteraction, onReady, onDown }
}

describe("discord gateway protocol", () => {
  it("identifies with the message intents and never logs the token", () => {
    const fake = sockets()
    const { created, lines } = gateway(fake.factory)

    created.start()
    fake.last().emit({ op: 10, d: { heartbeat_interval: 600_000 } })

    const identify = fake.last().payloads()[0]
    expect(identify?.op).toBe(2)
    expect((identify?.d as Record<string, unknown>).token).toBe("s3cr3t")
    expect((identify?.d as Record<string, unknown>).intents).toBe(GATEWAY_INTENTS)
    expect(GATEWAY_INTENTS).toBe(1 | 512 | 4096 | 32768)
    expect(lines.join("")).not.toContain("s3cr3t")
    created.stop()
  })

  it("registers the slash commands once READY names the application", async () => {
    const fake = sockets()
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(JSON.stringify([]), { status: 200 })
    }) as typeof fetch
    const { created, onReady } = gateway(fake.factory, { fetchImpl })

    created.start()
    fake.last().open("app9")
    await flush()

    expect(onReady).toHaveBeenCalledWith("app9")
    expect(created.live()).toBe(true)
    expect(calls[0]?.url).toBe("https://discord.com/api/v10/applications/app9/commands")
    expect(calls[0]?.init.method).toBe("PUT")
    const body = JSON.parse(String(calls[0]?.init.body)) as Array<{ name: string; options: Array<{ name: string }> }>
    expect(body[0]?.name).toBe("relay")
    expect(body[0]?.options.map((option) => option.name)).toEqual([
      "status",
      "sessions",
      "select",
      "notifications",
      "model",
      "pair",
      "unpair",
      "invite",
      "group",
      "send",
      "help",
    ])
    created.stop()
  })

  it("dispatches message and interaction frames to the transport", () => {
    const fake = sockets()
    const { created, onMessage, onInteraction } = gateway(fake.factory)

    created.start()
    fake.last().emit({ op: 10, d: { heartbeat_interval: 600_000 } })
    fake.last().emit({
      op: 0,
      s: 2,
      t: "MESSAGE_CREATE",
      d: { id: "101", channel_id: "42", content: "hi", author: { id: "u1" } },
    })
    fake.last().emit({ op: 0, s: 3, t: "INTERACTION_CREATE", d: { id: "i1", type: 3, token: "tok" } })

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "101", content: "hi" }))
    expect(onInteraction).toHaveBeenCalledWith(expect.objectContaining({ id: "i1", type: 3 }))
    created.stop()
  })

  it("resumes the session after a dropped socket", async () => {
    const fake = sockets()
    const { created } = gateway(fake.factory)

    created.start()
    fake.last().open()
    await flush()
    fake.last().close(1006)
    await flush()

    expect(fake.made).toHaveLength(2)
    expect(fake.last().url).toBe("wss://resume.test/?v=10&encoding=json")
    fake.last().emit({ op: 10, d: { heartbeat_interval: 600_000 } })
    const resume = fake.last().payloads()[0]
    expect(resume?.op).toBe(6)
    expect((resume?.d as Record<string, unknown>).session_id).toBe("sess1")
    created.stop()
  })

  it("identifies again when Discord says the session is gone", async () => {
    const fake = sockets()
    const { created } = gateway(fake.factory)

    created.start()
    fake.last().open()
    await flush()
    fake.last().emit({ op: 9, d: false })
    await flush()

    fake.last().emit({ op: 10, d: { heartbeat_interval: 600_000 } })
    expect(fake.last().payloads()[0]?.op).toBe(2)
    created.stop()
  })

  it("stops reconnecting when the token or intents are refused", async () => {
    const fake = sockets()
    const { created, onDown } = gateway(fake.factory)

    created.start()
    fake.last().close(4004)
    await flush()

    expect(onDown).toHaveBeenCalled()
    expect(fake.made).toHaveLength(1)
    created.stop()
  })

  it("hands the close and its reason to the caller", async () => {
    const fake = sockets()
    const { created, onDown } = gateway(fake.factory)

    created.start()
    fake.last().open()
    await flush()
    fake.last().close(4014, "Disallowed intent(s)")
    await flush()

    expect(onDown).toHaveBeenCalledWith({ code: 4014, reason: "Disallowed intent(s)" })
    created.stop()
  })

  it("keeps auth, intent and unknown close codes apart in the hint", () => {
    // the three the user can act on: a wrong token, a bad intent, a privileged intent switch
    expect(closeHint({ code: 4004 })).toContain("token")
    expect(closeHint({ code: 4013 })).toContain("invalid intents")
    expect(closeHint({ code: 4014 })).toContain("MESSAGE_CONTENT")
    expect(closeHint({ code: 4014 })).not.toBe(closeHint({ code: 4013 }))
    expect(closeHint({ code: 4014, reason: "Disallowed intent(s)" })).toContain("Disallowed intent(s)")
    expect(closeHint({ code: 9999 })).toContain("9999")
  })
})

describe("slash command payloads", () => {
  it("turns a subcommand invocation into the text the typed path parses", () => {
    const option = (name: string, value: string) => ({ name, value })

    expect(interactionText({ id: "i", type: 2, token: "t", data: { name: "status" } })).toBe("/relay status")
    expect(
      interactionText({ id: "i", type: 2, token: "t", data: { name: "select", options: [option("session", "3")] } }),
    ).toBe("/relay select 3")
    expect(
      interactionText({
        id: "i",
        type: 2,
        token: "t",
        data: { name: "model", options: [option("providerID", "anthropic"), option("modelID", "opus")] },
      }),
    ).toBe("/relay model anthropic opus")
    // notifications options expand to the words the handler reads: "<key> <value>" and "<category> on"
    expect(
      interactionText({
        id: "i",
        type: 2,
        token: "t",
        data: { name: "notifications", options: [option("mode", "batch")] },
      }),
    ).toBe("/relay notifications mode batch")
    expect(
      interactionText({
        id: "i",
        type: 2,
        token: "t",
        data: { name: "notifications", options: [option("change", "questions on")] },
      }),
    ).toBe("/relay notifications questions on")
    expect(interactionText({ id: "i", type: 2, token: "t", data: { name: "nope" } })).toBeUndefined()
  })

  it("maps our buttons to the answers the typed path understands", () => {
    expect(componentText({ id: "i", type: 3, token: "t", data: { custom_id: "relay:once" } })).toBe("once")
    expect(componentText({ id: "i", type: 3, token: "t", data: { custom_id: "relay:reject" } })).toBe("reject")
    expect(componentText({ id: "i", type: 3, token: "t", data: { custom_id: "someone:else" } })).toBeUndefined()
    expect(componentText({ id: "i", type: 2, token: "t", data: { name: "status" } })).toBeUndefined()
  })

  it("turns a question button or select into the same field answer text", () => {
    const click = (data: { custom_id: string; values?: string[] }) => ({ id: "i", type: 3, token: "t", data })

    expect(questionAnswer(click({ custom_id: "q:frm_1:branch:release" }))).toBe("branch: release")
    expect(questionAnswer(click({ custom_id: "q:frm_1:branch", values: ["feature"] }))).toBe("branch: feature")
    expect(questionAnswer(click({ custom_id: "q:frm_1:tags", values: ["a", "b"] }))).toBe("tags: a, b")
    expect(questionAnswer(click({ custom_id: "q:cancel" }))).toBe("cancel")
    // no formID: the id still names the field, the pending prompt names the form
    expect(questionAnswer(click({ custom_id: "q::branch:release" }))).toBe("branch: release")
    expect(questionAnswer(click({ custom_id: "q:" }))).toBeUndefined()
    expect(questionAnswer(click({ custom_id: "relay:once" }))).toBeUndefined()
    expect(questionAnswer({ id: "i", type: 2, token: "t", data: { name: "status" } })).toBeUndefined()
  })

  it("registers in the shape Discord's command API expects", () => {
    const body = commandsBody() as Array<{ name: string; description: string; options: Array<Record<string, unknown>> }>
    expect(body).toHaveLength(1)
    expect(body[0]?.name).toBe("relay")
    expect(body[0]?.description).not.toBe("")
    for (const sub of body[0]?.options ?? []) {
      expect(sub.type).toBe(1)
      expect(typeof sub.description).toBe("string")
    }
  })

  it("gives every option a description, a required flag and choices where the set is closed", () => {
    interface Option {
      name?: string
      description?: string
      required?: boolean
      choices?: Array<{ name: string; value: string }>
    }
    interface Sub {
      name?: string
      description?: string
      options?: Option[]
    }
    const body = commandsBody() as Array<{ description: string; options: Sub[] }>
    const subs = body[0]?.options ?? []

    for (const sub of subs) {
      expect(sub.description).toBeTruthy()
      for (const option of sub.options ?? []) {
        expect(option.description).toBeTruthy()
        expect(typeof option.required).toBe("boolean")
      }
    }
    const of = (sub: string, option: string) =>
      subs.find((entry) => entry.name === sub)?.options?.find((entry) => entry.name === option)
    expect(of("notifications", "mode")?.choices?.map((entry) => entry.value)).toEqual([
      "immediate",
      "batch",
      "final_only",
    ])
    expect(of("notifications", "preset")?.choices?.map((entry) => entry.value)).toEqual([
      "all",
      "important",
      "completion",
    ])
    expect(of("notifications", "change")?.choices?.map((entry) => entry.value)).toContain("questions off")
    expect(of("pair", "provider")?.choices?.map((entry) => entry.value)).toEqual(["whatsapp", "discord"])
    expect(of("unpair", "provider")?.choices?.map((entry) => entry.value)).toEqual(["whatsapp", "discord"])
    expect(of("select", "session")?.required).toBe(true)
  })

  it("falls back to the application endpoint when the app id is unknown", async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url))
      return String(url).endsWith("/oauth2/applications/@me")
        ? new Response(JSON.stringify({ id: "app9" }))
        : new Response("[]")
    }) as typeof fetch

    expect(await registerCommands("t", fetchImpl)).toBe("app9")
    expect(calls).toEqual([
      "https://discord.com/api/v10/oauth2/applications/@me",
      "https://discord.com/api/v10/applications/app9/commands",
    ])
  })
})
