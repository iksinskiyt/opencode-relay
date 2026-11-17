import { copyFile, mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommandInvocation } from "@opencode/plugin/promise/command"
import { describe, expect, it } from "vitest"
import { createCommand } from "../src/command.js"
import type { InboundMessage } from "../src/envelope.js"
import { createCorrelationStore, type PendingInput } from "../src/interactions/correlation.js"
import { type Decision, type GroupResult, handleInbound, type InboundDeps } from "../src/interactions/inbound.js"
import { getPreferences } from "../src/preferences.js"
import { loadListing, saveListing, saveSelected } from "../src/selection.js"

const SERVER = "http://127.0.0.1:4096"

interface Call {
  readonly url: string
  readonly init: RequestInit
}

const message = (text: string, quotedID?: string): InboundMessage => ({
  id: "m1",
  chatID: "me@s.whatsapp.net",
  senderID: "me@s.whatsapp.net",
  text,
  selfChat: true,
  ...(quotedID === undefined ? {} : { quotedID }),
})

const prompt = (overrides: Partial<PendingInput> = {}): PendingInput => ({
  provider: "whatsapp",
  externalUserID: "me@s.whatsapp.net",
  chatID: "me@s.whatsapp.net",
  messageID: "msg-1",
  sessionID: "ses_1",
  type: "form",
  formID: "frm_1",
  ...overrides,
})

const configPath = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "relay-inbound-"))
  const path = join(dir, "config.json")
  await copyFile(new URL("../examples/config.example.json", import.meta.url), path)
  return path
}

const deps = async (fetchImpl: typeof fetch, path?: string): Promise<InboundDeps> => ({
  store: await createCorrelationStore(await mkdtemp(join(tmpdir(), "relay-store-"))),
  provider: "whatsapp",
  configPath: path ?? (await configPath()),
  selected: {},
  sessions: async () => [{ id: "ses_1", title: "first" }, { id: "ses_2" }],
  serverURL: SERVER,
  fetchImpl,
})

const recorder = (responses: Array<Response>) => {
  const calls: Call[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return responses.shift() ?? new Response(null, { status: 204 })
  }) as typeof fetch
  return { calls, fetchImpl }
}

/** Stands in for `ctx.permission.reply`. */
const recorder2 = () => {
  const calls: Array<{ sessionID: string; requestID: string; decision: Decision }> = []
  return {
    calls,
    replyPermission: async (input: { sessionID: string; requestID: string; decision: Decision }) => {
      calls.push(input)
    },
  }
}

/** Stands in for `ctx.session.prompt`. */
const recorder3 = () => {
  const calls: Array<{ sessionID: string; text: string }> = []
  return {
    calls,
    prompt: async (input: { sessionID: string; text: string }) => {
      calls.push(input)
    },
  }
}

describe("handleInbound", () => {
  it("answers a single-field form and resolves the prompt", async () => {
    const { calls, fetchImpl } = recorder([
      new Response(JSON.stringify({ fields: [{ key: "answer", type: "string" }] }), { status: 200 }),
      new Response(null, { status: 204 }),
    ])
    const d = await deps(fetchImpl)
    await d.store.add(prompt())

    const reply = await handleInbound(message("yes please"), d)

    expect(calls[0]?.url).toBe(`${SERVER}/api/session/ses_1/form/frm_1`)
    expect(calls[1]?.url).toBe(`${SERVER}/api/session/ses_1/form/frm_1/reply`)
    expect(calls[1]?.init.method).toBe("POST")
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ answer: { answer: "yes please" } })
    expect(reply).toContain("answered")
    expect(d.store.resolve("whatsapp", "me@s.whatsapp.net", "me@s.whatsapp.net")).toBeUndefined()
  })

  it("answers a multi-field form from one numbered line per field", async () => {
    const { calls, fetchImpl } = recorder([
      new Response(
        JSON.stringify({
          fields: [
            { key: "branch", type: "string", required: true },
            { key: "note", type: "string" },
          ],
        }),
        { status: 200 },
      ),
      new Response(null, { status: 204 }),
    ])
    const d = await deps(fetchImpl)
    await d.store.add(prompt())

    const reply = await handleInbound(message("1: main\n2: ship it"), d)

    expect(calls).toHaveLength(2)
    expect(calls[1]?.url).toBe(`${SERVER}/api/session/ses_1/form/frm_1/reply`)
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ answer: { branch: "main", note: "ship it" } })
    expect(reply).toContain("answered (branch, note)")
    expect(d.store.get("msg-1")?.status).toBe("resolved")
  })

  it("accepts field keys instead of numbers", async () => {
    const { calls, fetchImpl } = recorder([
      new Response(
        JSON.stringify({ fields: [{ key: "branch", type: "string" }, { key: "note", type: "string" }] }),
        { status: 200 },
      ),
      new Response(null, { status: 204 }),
    ])
    const d = await deps(fetchImpl)
    await d.store.add(prompt())

    await handleInbound(message("branch: dev\nnote: tonight"), d)

    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ answer: { branch: "dev", note: "tonight" } })
  })

  it("answers a select by option letter, label or value, in the form's order", async () => {
    const fields = [
      {
        key: "branch",
        type: "string",
        options: [
          { value: "release", label: "Release" },
          { value: "feature", label: "Feature" },
        ],
      },
    ]
    for (const [answer, expected] of [
      ["a", "release"],
      ["b", "feature"],
      ["Feature", "feature"],
      ["feature", "feature"],
      ["2", "feature"],
    ] as const) {
      const { calls, fetchImpl } = recorder([
        new Response(JSON.stringify({ fields }), { status: 200 }),
        new Response(null, { status: 204 }),
      ])
      const d = await deps(fetchImpl)
      await d.store.add(prompt())

      await handleInbound(message(answer), d)

      expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ answer: { branch: expected } })
    }
  })

  it("coerces boolean, number and multiselect values to the form's types", async () => {
    const { calls, fetchImpl } = recorder([
      new Response(
        JSON.stringify({
          fields: [
            { key: "confirm", type: "boolean" },
            { key: "count", type: "integer" },
            { key: "tags", type: "multiselect", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
          ],
        }),
        { status: 200 },
      ),
      new Response(null, { status: 204 }),
    ])
    const d = await deps(fetchImpl)
    await d.store.add(prompt())

    await handleInbound(message("1: yes\n2: 3\n3: a, b"), d)

    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      answer: { confirm: true, count: 3, tags: ["a", "b"] },
    })
  })

  it("asks for the missing fields instead of guessing, and keeps the form pending", async () => {
    const { calls, fetchImpl } = recorder([
      new Response(
        JSON.stringify({
          fields: [
            { key: "first", type: "string", required: true },
            { key: "second", type: "string", required: true },
          ],
        }),
        { status: 200 },
      ),
    ])
    const d = await deps(fetchImpl)
    await d.store.add(prompt())

    const reply = (await handleInbound(message("1: only one"), d)) ?? ""

    expect(reply).toContain("one line per field")
    expect(reply).toContain("2. second")
    expect(calls).toHaveLength(1)
    expect(d.store.get("msg-1")?.status).toBe("pending")
  })

  it("accumulates one click per field and submits only when the form is complete", async () => {
    const fields = [
      { key: "branch", type: "string", required: true, title: "Branch", options: [{ value: "release", label: "Release" }] },
      { key: "note", type: "string", required: true, title: "Note" },
    ]
    const { calls, fetchImpl } = recorder([
      new Response(JSON.stringify({ fields }), { status: 200 }),
      new Response(JSON.stringify({ fields }), { status: 200 }),
      new Response(null, { status: 204 }),
    ])
    const d = await deps(fetchImpl)
    await d.store.add(prompt())

    // a button click is just "key: value"; the form needs a second field, so nothing is submitted
    const first = (await handleInbound(message("branch: release"), d)) ?? ""

    expect(first).toContain("still needed")
    expect(first).toContain("2. Note")
    expect(calls).toHaveLength(1)
    expect(d.store.get("msg-1")?.partial).toEqual({ branch: "release" })
    expect(d.store.get("msg-1")?.status).toBe("pending")

    const second = (await handleInbound(message("note: ship it"), d)) ?? ""

    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ answer: { branch: "release", note: "ship it" } })
    expect(second).toContain("answered (branch, note)")
    expect(d.store.get("msg-1")?.status).toBe("resolved")
  })

  it("cancels a form through the cancel endpoint", async () => {
    const { calls, fetchImpl } = recorder([new Response(null, { status: 204 })])
    const d = await deps(fetchImpl)
    await d.store.add(prompt())

    const reply = await handleInbound(message("cancel"), d)

    expect(calls[0]?.url).toBe(`${SERVER}/api/session/ses_1/form/frm_1`)
    expect(calls[0]?.init.method).toBe("DELETE")
    expect(reply).toContain("cancelled")
    expect(d.store.get("msg-1")?.status).toBe("resolved")
  })

  it("cancels a half-answered form and does not answer with what was collected", async () => {
    const fields = [
      { key: "first", type: "string", required: true },
      { key: "second", type: "string", required: true },
    ]
    const { calls, fetchImpl } = recorder([
      new Response(JSON.stringify({ fields }), { status: 200 }),
      new Response(null, { status: 204 }),
    ])
    const d = await deps(fetchImpl)
    await d.store.add(prompt())

    await handleInbound(message("1: only one"), d)
    const reply = (await handleInbound(message("cancel"), d)) ?? ""

    expect(reply).toContain("cancelled")
    expect(calls[1]?.init.method).toBe("DELETE")
    // no /reply call ever happened: a cancelled form submits nothing
    expect(calls.some((call) => call.url.endsWith("/reply"))).toBe(false)
    expect(d.store.get("msg-1")?.status).toBe("resolved")
  })

  it("reports a rejected answer and keeps the form pending for another try", async () => {
    const { fetchImpl } = recorder([
      new Response(JSON.stringify({ fields: [{ key: "answer", type: "string" }] }), { status: 200 }),
      new Response(JSON.stringify({ message: "invalid answer" }), { status: 400 }),
    ])
    const d = await deps(fetchImpl)
    await d.store.add(prompt())

    const reply = await handleInbound(message("nope"), d)

    expect(reply).toContain("not answered")
    expect(reply).toContain("400")
    expect(d.store.get("msg-1")?.status).toBe("pending")
  })

  it("calls an expired prompt expired instead of forwarding the answer as a prompt", async () => {
    let clock = 1_000
    const store = await createCorrelationStore(await mkdtemp(join(tmpdir(), "relay-store-")), () => clock)
    const { fetchImpl } = recorder([])
    const host = recorder3()
    const d = { ...(await deps(fetchImpl)), store, prompt: host.prompt }
    await store.add(prompt(), 500)
    clock += 600

    const reply = (await handleInbound(message("1: stale answer"), d)) ?? ""

    expect(reply).toContain("expired")
    expect(reply).toContain("frm_1")
    expect(host.calls).toEqual([])
  })

  it("answers the form a quoted reply points at, not the newest one", async () => {
    const { calls, fetchImpl } = recorder([
      new Response(JSON.stringify({ fields: [{ key: "answer", type: "string" }] }), { status: 200 }),
      new Response(null, { status: 204 }),
    ])
    const d = await deps(fetchImpl)
    await d.store.add(prompt())
    await d.store.add(prompt({ messageID: "msg-2", formID: "frm_2" }))

    await handleInbound(message("the first one", "msg-1"), d)

    expect(calls[1]?.url).toBe(`${SERVER}/api/session/ses_1/form/frm_1/reply`)
    expect(d.store.get("msg-1")?.status).toBe("resolved")
    expect(d.store.get("msg-2")?.status).toBe("pending")
  })

  it("does not forward an answer that quotes an already settled prompt", async () => {
    const { fetchImpl } = recorder([])
    const host = recorder3()
    const d = { ...(await deps(fetchImpl)), prompt: host.prompt }
    await d.store.add(prompt())
    await d.store.complete("msg-1")

    const reply = (await handleInbound(message("1: late", "msg-1"), d)) ?? ""

    expect(reply).toContain("already resolved")
    expect(host.calls).toEqual([])
  })

  it("answers a permission through the plugin host", async () => {
    const { fetchImpl } = recorder([])
    const host = recorder2()
    const d = { ...(await deps(fetchImpl)), replyPermission: host.replyPermission }
    await d.store.add(prompt({ type: "permission", formID: undefined, permissionID: "per_1" }))

    await handleInbound(message("no"), d)

    expect(host.calls).toEqual([{ sessionID: "ses_1", requestID: "per_1", decision: "reject" }])
    expect(d.store.get("msg-1")?.status).toBe("resolved")
  })

  it("treats an unclear permission answer as a reject", async () => {
    const { fetchImpl } = recorder([])
    const host = recorder2()
    const d = { ...(await deps(fetchImpl)), replyPermission: host.replyPermission }
    await d.store.add(prompt({ type: "permission", formID: undefined, permissionID: "per_1" }))

    await handleInbound(message("banana"), d)

    expect(host.calls[0]?.decision).toBe("reject")
  })

  it("uses the selected session when the prompt has none", async () => {
    const { fetchImpl } = recorder([])
    const host = recorder2()
    const d = { ...(await deps(fetchImpl)), replyPermission: host.replyPermission }
    d.selected.sessionID = "ses_9"
    await d.store.add(prompt({ sessionID: "", type: "permission", formID: undefined, permissionID: "per_1" }))

    await handleInbound(message("yes"), d)

    expect(host.calls[0]).toEqual({ sessionID: "ses_9", requestID: "per_1", decision: "once" })
  })

  it("says what to do when a permission reply has no host or session", async () => {
    const { fetchImpl } = recorder([])
    const d = await deps(fetchImpl)
    await d.store.add(prompt({ type: "permission", formID: undefined, permissionID: "per_1" }))
    expect(await handleInbound(message("yes"), d)).toContain("plugin host")

    const host = recorder2()
    const withHost = { ...(await deps(fetchImpl)), replyPermission: host.replyPermission }
    await withHost.store.add(prompt({ sessionID: "", type: "permission", formID: undefined, permissionID: "per_2" }))
    expect(await handleInbound(message("yes"), withHost)).toContain("sessionID")
  })

  it("forwards a plain message to the only active session", async () => {
    const { calls, fetchImpl } = recorder([])
    const host = recorder3()
    const d = {
      ...(await deps(fetchImpl)),
      sessions: async () => [{ id: "ses_1", title: "first" }],
      prompt: host.prompt,
    }

    expect(await handleInbound(message("run the tests"), d)).toBe("🤖 Relay · *first*\nsent to 'first'")
    expect(host.calls).toEqual([{ sessionID: "ses_1", text: "run the tests" }])
    expect(calls).toHaveLength(0)
  })

  it("sends to the selected session even when several are active", async () => {
    const { fetchImpl } = recorder([])
    const host = recorder3()
    const d = { ...(await deps(fetchImpl)), prompt: host.prompt }
    d.selected.sessionID = "ses_2"

    expect(await handleInbound(message("try again"), d)).toBe("🤖 Relay · *ses_2*\nsent to 'ses_2'")
    expect(host.calls).toEqual([{ sessionID: "ses_2", text: "try again" }])
  })

  it("asks which session when more than one is active and none is selected", async () => {
    const { fetchImpl } = recorder([])
    const host = recorder3()
    const d = { ...(await deps(fetchImpl)), prompt: host.prompt }

    const reply = await handleInbound(message("hello?"), d)

    expect(reply).toContain("/relay select")
    expect(reply).toContain("ses_1 — first")
    expect(host.calls).toEqual([])
  })

  it("never forwards into a session the host does not list (archived or gone)", async () => {
    const { fetchImpl } = recorder([])
    const host = recorder3()
    const d = { ...(await deps(fetchImpl)), prompt: host.prompt }
    d.selected.sessionID = "ses_gone"

    expect(await handleInbound(message("still there?"), d)).toContain("/relay select")
    expect(host.calls).toEqual([])
  })

  it("sends nothing when there is no active session", async () => {
    const { fetchImpl } = recorder([])
    const host = recorder3()
    const d = { ...(await deps(fetchImpl)), sessions: async () => [], prompt: host.prompt }

    expect(await handleInbound(message("anyone?"), d)).toContain("no active session")
    expect(host.calls).toEqual([])
  })

  it("caps a pasted prompt so one message cannot become a huge model request", async () => {
    const { fetchImpl } = recorder([])
    const host = recorder3()
    const d = {
      ...(await deps(fetchImpl)),
      sessions: async () => [{ id: "ses_1", title: "first" }],
      prompt: host.prompt,
    }

    await handleInbound(message("x".repeat(5_000)), d)

    expect(host.calls[0]?.text.length).toBe(2_000)
  })

  it("creates the relay group once and reports a creation failure", async () => {
    const { fetchImpl } = recorder([])
    const d = await deps(fetchImpl)

    expect(await handleInbound(message("/relay group"), d)).toBe("🤖 Relay\ngroup layout needs the whatsapp transport")

    const created = {
      ...d,
      group: async () => ({ jid: "1203630@g.us", created: true, subject: "Relay" }),
    }
    const reply = (await handleInbound(message("/relay group"), created)) ?? ""
    expect(reply).toContain('created group "Relay" (1203630@g.us); notifications go there from now on')
    expect(reply).toContain("WhatsApp limitation of linked devices")

    const reused = { ...d, group: async () => ({ jid: "1203630@g.us", created: false, subject: "Relay" }) }
    expect(await handleInbound(message("/relay group"), reused)).toContain("reusing group")

    const failed = {
      ...d,
      group: async (): Promise<GroupResult> => {
        throw new Error("whatsapp not connected: link the device first")
      },
    }
    expect(await handleInbound(message("/relay group"), failed)).toBe(
      "🤖 Relay\ngroup layout failed: whatsapp not connected: link the device first",
    )
  })

  it("lists sessions from the plugin host", async () => {
    const { calls, fetchImpl } = recorder([])
    const d = await deps(fetchImpl)

    const reply = await handleInbound(message("/relay sessions"), d)

    expect(reply).toContain("ses_1 — first")
    expect(reply).toContain("ses_2")
    expect(calls).toHaveLength(0)
  })

  it("answers /relay help with every subcommand and the current values", async () => {
    const { fetchImpl } = recorder([])
    const d = await deps(fetchImpl)

    const reply = (await handleInbound(message("/relay help"), d)) ?? ""

    for (const name of ["status", "sessions", "select", "notifications", "model", "pair", "group", "help"]) {
      expect(reply).toContain(`/relay ${name}`)
    }
    expect(reply).toContain("current: provider whatsapp, preset all, mode batch, model none")
  })

  it("answers an unknown subcommand with usage instead of silence", async () => {
    const { fetchImpl } = recorder([])
    const d = await deps(fetchImpl)

    expect(await handleInbound(message("/relay nonsense"), d)).toContain("commands: /relay status")
    expect(await handleInbound(message("/relay"), d)).toContain("commands: /relay status")
  })

  it("builds the bot install URL from the token's own app id and never echoes the token", async () => {
    const { calls, fetchImpl } = recorder([new Response(JSON.stringify({ id: "app_1" }), { status: 200 })])
    const d = { ...(await deps(fetchImpl)), pairing: { env: { DISCORD_BOT_TOKEN: "tok-secret" } } }

    const reply = (await handleInbound(message("/relay invite discord"), d)) ?? ""

    expect(calls[0]?.url).toBe("https://discord.com/api/v10/users/@me")
    expect(reply).toContain(
      "https://discord.com/oauth2/authorize?client_id=app_1&permissions=101376&scope=bot+applications.commands",
    )
    expect(reply).toContain("bot + applications.commands")
    expect(reply).not.toContain("tok-secret")
  })

  it("fails the invite cleanly when the token is missing or rejected", async () => {
    const { fetchImpl } = recorder([new Response("401: Unauthorized", { status: 401 })])
    const missing = { ...(await deps(fetchImpl)), pairing: { env: {} } }
    expect(await handleInbound(message("/relay invite"), missing)).toContain("DISCORD_BOT_TOKEN")

    const rejected = { ...(await deps(fetchImpl)), pairing: { env: { DISCORD_BOT_TOKEN: "bad" } } }
    expect(await handleInbound(message("/relay invite"), rejected)).toContain("rejected (401)")

    expect(await handleInbound(message("/relay invite whatsapp"), missing)).toContain("usage: /relay invite [discord]")
  })

  it("answers a failing command on the transport path instead of going silent", async () => {
    const { fetchImpl } = recorder([])
    const d = await deps(fetchImpl, join(tmpdir(), "relay-inbound-missing", "config.json"))

    expect(await handleInbound(message("/relay help"), d)).toContain("relay: ")
  })

  it("remembers the selected session", async () => {
    const { fetchImpl } = recorder([])
    const d = await deps(fetchImpl)

    expect(await handleInbound(message("/relay select ses_2"), d)).toBe("🤖 Relay · *ses_2*\nselected ses_2")
    expect(d.selected.sessionID).toBe("ses_2")
  })

  it("numbers the session list and resolves the number against the last listing", async () => {
    const { fetchImpl } = recorder([])
    const d = { ...(await deps(fetchImpl)), sessions: async () => [{ id: "ses_1", title: "first" }, { id: "ses_2", title: "second" }] }

    expect(await handleInbound(message("/relay sessions"), d)).toContain("1. ses_1 — first\n2. ses_2 — second")
    expect(await handleInbound(message("/relay select 2"), d)).toContain("selected ses_2 — second")
    expect(d.selected.sessionID).toBe("ses_2")
  })

  it("resolves a number against a stale listing from the other host", async () => {
    const path = await configPath()
    const { fetchImpl } = recorder([])
    const d = await deps(fetchImpl, path)
    // the other host printed three sessions; this host now lists two
    await saveListing(path, [{ id: "ses_a", title: "a" }, { id: "ses_b" }, { id: "ses_c" }])

    expect(await handleInbound(message("/relay select 3"), d)).toContain("selected ses_c")
    expect(d.selected.sessionID).toBe("ses_c")
  })

  it("answers an out-of-range number with usage and a fresh list, which re-anchors the numbers", async () => {
    const path = await configPath()
    const { fetchImpl } = recorder([])
    const d = await deps(fetchImpl, path)
    await saveListing(path, [{ id: "ses_a" }])

    const reply = (await handleInbound(message("/relay select 9"), d)) ?? ""
    expect(reply).toContain("usage: /relay select")
    expect(reply).toContain("1. ses_1 — first")
    expect(await loadListing(path)).toEqual([{ id: "ses_1", title: "first" }, { id: "ses_2" }])
  })

  it("forwards to a selection made in the other host (TUI command, phone inbound)", async () => {
    const path = await configPath()
    const { fetchImpl } = recorder([])
    const host = recorder3()
    const sessions = async () => [{ id: "ses_1", title: "first" }, { id: "ses_2", title: "second" }]
    const d = { ...(await deps(fetchImpl, path)), sessions, prompt: host.prompt }
    const command = createCommand({
      configPath: path,
      provider: "whatsapp",
      selected: {},
      sessions,
      pending: () => ({ sessions: 0, items: 0 }),
      reply: async () => undefined,
    })

    // host A: the TUI command, with its own empty `selected` memory
    await command.execute({ sessionID: "ses_tui", prompt: { text: "select 2" }, delivery: "queue" } as CommandInvocation)
    // host B: the transport inbound, a separate process with a separate `selected`
    expect(await handleInbound(message("hello from the phone"), d)).toBe("🤖 Relay · *second*\nsent to 'second'")
    expect(host.calls).toEqual([{ sessionID: "ses_2", text: "hello from the phone" }])
  })

  it("falls back to the list when the persisted selection is gone", async () => {
    const path = await configPath()
    const { fetchImpl } = recorder([])
    const host = recorder3()
    const d = { ...(await deps(fetchImpl, path)), prompt: host.prompt }
    await saveSelected(path, "ses_archived")

    const reply = (await handleInbound(message("still there?"), d)) ?? ""

    expect(reply).toContain("/relay select")
    expect(host.calls).toEqual([])
  })

  it("toggles a notification category in config.json", async () => {
    const path = await configPath()
    const { fetchImpl } = recorder([])
    const d = await deps(fetchImpl, path)

    expect(await handleInbound(message("/relay notifications errors off"), d)).toContain("errors: off")

    const config = JSON.parse(await readFile(path, "utf8")) as { notifications: { categories: { errors: boolean } } }
    expect(config.notifications.categories.errors).toBe(false)
    expect((await getPreferences(path)).categories.errors).toBe(false)
  })

  it("shows and sets the notification mode", async () => {
    const path = await configPath()
    const { fetchImpl } = recorder([])
    const d = await deps(fetchImpl, path)

    const shown = await handleInbound(message("/relay notifications"), d)
    expect(shown).toContain("mode: batch")

    expect(await handleInbound(message("/relay notifications mode immediate"), d)).toContain("mode: immediate")
    expect((await getPreferences(path)).mode).toBe("immediate")
  })

  it("sets the notification preset", async () => {
    const path = await configPath()
    const { fetchImpl } = recorder([])
    const d = await deps(fetchImpl, path)

    expect(await handleInbound(message("/relay notifications preset important"), d)).toContain("preset: important")
    expect((await getPreferences(path)).preset).toBe("important")
    expect(await handleInbound(message("/relay notifications preset nope"), d)).toContain("preset must be")
  })
})

describe("answers, free text and dead forms", () => {
  const detail = (fields: unknown[]): Response => new Response(JSON.stringify({ fields }), { status: 200 })
  const select = [
    { key: "branch", type: "string", options: [{ value: "release", label: "Release" }, { value: "feature", label: "Feature" }] },
  ]

  it("names the session on the first line of an answer", async () => {
    const { fetchImpl } = recorder([detail([{ key: "answer", type: "string" }]), new Response(null, { status: 204 })])
    const d = await deps(fetchImpl)
    await d.store.add(prompt())

    const reply = (await handleInbound(message("yes please"), d)) ?? ""

    expect(reply.split("\n")[0]).toBe("🤖 Relay · *first*")
    expect(reply).toContain("answered (answer)")
  })

  it("names an untitled session by its id, so the answer is never ambiguous", async () => {
    const { fetchImpl } = recorder([])
    const d = await deps(fetchImpl)
    d.selected.sessionID = "ses_2"

    expect((await handleInbound(message("/relay select ses_2"), d))?.split("\n")[0]).toBe("🤖 Relay · *ses_2*")
  })

  it("takes typed text for a field whose options do not match", async () => {
    const { calls, fetchImpl } = recorder([detail(select), new Response(null, { status: 204 })])
    const d = await deps(fetchImpl)
    await d.store.add(prompt())

    const reply = (await handleInbound(message("hotfix-42"), d)) ?? ""

    // the server accepts strings, so the typed answer goes through instead of a "not one of" error
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ answer: { branch: "hotfix-42" } })
    expect(reply).toContain("answered")
  })

  it('reads "Other: <text>" as the answer itself, even when it looks like an option', async () => {
    const { calls, fetchImpl } = recorder([detail(select), new Response(null, { status: 204 })])
    const d = await deps(fetchImpl)
    await d.store.add(prompt())

    await handleInbound(message("Other: a"), d)

    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ answer: { branch: "a" } })
  })

  it("keeps a multiselect part that matches no option, as typed", async () => {
    const { calls, fetchImpl } = recorder([
      detail([{ key: "tags", type: "multiselect", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }]),
      new Response(null, { status: 204 }),
    ])
    const d = await deps(fetchImpl)
    await d.store.add(prompt())

    await handleInbound(message("a, custom-tag"), d)

    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ answer: { tags: ["a", "custom-tag"] } })
  })

  it("says what it could not read, and how to retry", async () => {
    const { fetchImpl } = recorder([
      detail([
        { key: "first", type: "string", required: true },
        { key: "second", type: "string", required: true },
      ]),
    ])
    const d = await deps(fetchImpl)
    await d.store.add(prompt())

    const reply = (await handleInbound(message("just some prose"), d)) ?? ""

    expect(reply).toContain("could not read that as an answer")
    expect(reply).toContain('"1: <answer>"')
    expect(d.store.get("msg-1")?.status).toBe("pending")
  })

  it("calls a form that is gone already answered, in one clean line", async () => {
    const { calls, fetchImpl } = recorder([
      detail([{ key: "answer", type: "string" }]),
      new Response("not found", { status: 404 }),
    ])
    const d = await deps(fetchImpl)
    await d.store.add(prompt())

    const reply = (await handleInbound(message("main"), d)) ?? ""

    expect(calls[1]?.init.method).toBe("POST")
    expect(reply).toContain("form frm_1 is already answered or cancelled elsewhere")
    expect(reply).not.toContain("⚠️")
    expect(reply.match(/⌛/g)).toHaveLength(1)
    expect(d.store.get("msg-1")?.status).toBe("resolved")
    // the dead record must not answer a second reply
    expect(d.store.resolve("whatsapp", "me@s.whatsapp.net", "me@s.whatsapp.net")).toBeUndefined()
  })
})
