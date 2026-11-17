import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { type CommandDeps, createCommand } from "../src/command.js"
import type { CommandInvocation } from "@opencode/plugin/promise/command"
import { getPreferences } from "../src/preferences.js"

const SESSION = "ses_caller"

const configPath = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "relay-command-"))
  const path = join(dir, "config.json")
  await copyFile(new URL("../examples/config.example.json", import.meta.url), path)
  return path
}

const harness = async (path?: string) => {
  const replies: Array<{ sessionID: string; text: string; description: string }> = []
  const deps: CommandDeps = {
    configPath: path ?? (await configPath()),
    provider: "whatsapp",
    selected: {},
    sessions: async () => [{ id: "ses_1", title: "first" }, { id: "ses_2" }],
    models: async () => [{ providerID: "prov", id: "mod" }, { providerID: "prov", id: "other" }],
    pending: () => ({ sessions: 2, items: 5 }),
    reply: async (message) => {
      replies.push(message)
    },
  }
  const command = createCommand(deps)
  const run = async (text: string): Promise<string> => {
    // run() itself has no `this` dependence, so the stub invocation can be a plain object
    await command.execute({ sessionID: SESSION, prompt: { text }, delivery: "queue" } as CommandInvocation)
    return replies.at(-1)?.text ?? ""
  }
  return { deps, replies, command, run }
}

describe("/relay chat command", () => {
  it("reports status into the invoking session", async () => {
    const { replies, run } = await harness()

    const text = await run("status")

    expect(text).toContain("provider: whatsapp")
    expect(text).toContain("preset: all")
    expect(text).toContain("mode: batch")
    expect(text).toContain("on: passCompleted")
    expect(text).toContain("pending batches: 2 (5 messages)")
    expect(replies).toEqual([{ sessionID: SESSION, text, description: text }])
  })

  it("lists every transport in status", async () => {
    const { deps, run } = await harness()
    deps.transports = [
      { name: "whatsapp", state: "live" },
      { name: "discord", state: "disabled", reason: "discord.enabled is false" },
    ]

    const text = await run("status")

    expect(text).toContain("whatsapp: live")
    expect(text).toContain("discord: disabled (discord.enabled is false)")
  })

  it("lists sessions with their titles", async () => {
    const { run } = await harness()

    const text = await run("sessions")

    expect(text).toContain("ses_1 — first")
    expect(text).toContain("ses_2")
  })

  it("remembers the selected session, persists it, and confirms its title", async () => {
    const path = await configPath()
    const { deps, run } = await harness(path)

    expect(await run("select ses_2")).toBe("selected ses_2")
    expect(deps.selected.sessionID).toBe("ses_2")

    const saved = JSON.parse(await readFile(join(dirname(path), "auth-state", "selected.json"), "utf8")) as {
      sessionID: string
      at: number
    }
    expect(saved.sessionID).toBe("ses_2")
    expect(typeof saved.at).toBe("number")
  })

  it("numbers the session list and accepts the number", async () => {
    const path = await configPath()
    const { deps, run } = await harness(path)

    expect(await run("sessions")).toBe("1. ses_1 — first\n2. ses_2")
    expect(await run("select 2")).toBe("selected ses_2")
    expect(deps.selected.sessionID).toBe("ses_2")
    expect(await run("select 1")).toBe("selected ses_1 — first")
    expect(deps.selected.sessionID).toBe("ses_1")
  })

  it("answers an out-of-range number with usage and a fresh list", async () => {
    const { deps, run } = await harness()

    const text = await run("select 9")

    expect(text.startsWith("usage: /relay select")).toBe(true)
    expect(text).toContain("1. ses_1 — first")
    expect(deps.selected.sessionID).toBeUndefined()
  })

  it("persists notification toggles to config.json", async () => {
    const path = await configPath()
    const { run } = await harness(path)

    expect(await run("notifications errors off")).toBe("errors: off")
    expect(await run("notifications mode immediate")).toBe("mode: immediate")
    expect(await run("notifications preset important")).toBe("preset: important")

    const config = JSON.parse(await readFile(path, "utf8")) as { notifications: { categories: { errors: boolean } } }
    expect(config.notifications.categories.errors).toBe(false)
    const prefs = await getPreferences(path)
    expect(prefs.mode).toBe("immediate")
    expect(prefs.preset).toBe("important")
  })

  it("lists models and marks the configured one", async () => {
    const { run } = await harness()

    const listing = await run("model")
    expect(listing).toContain("current: none")
    expect(listing).toContain("prov/mod")
    expect(listing).toContain("prov/other")
  })

  it("sets and persists the model that summarises notifications", async () => {
    const path = await configPath()
    const { run } = await harness(path)

    expect(await run("model prov mod")).toBe("model: prov/mod (AI summaries on)")

    const config = JSON.parse(await readFile(path, "utf8")) as { aiProcessing: unknown }
    expect(config.aiProcessing).toEqual({ enabled: true, model: { providerID: "prov", modelID: "mod" } })
    expect(await run("model")).toContain("prov/mod (current)")
  })

  it("refuses a model the host does not report", async () => {
    const path = await configPath()
    const { run } = await harness(path)

    expect(await run("model prov nope")).toBe("unknown model: prov/nope (see /relay model)")
    expect(await run("model prov")).toBe("usage: /relay model <providerID> <modelID>")

    const config = JSON.parse(await readFile(path, "utf8")) as { aiProcessing: { model: { modelID: string } } }
    expect(config.aiProcessing.model.modelID).toBe("")
  })

  it("accepts a unique prefix and names the candidates when several match", async () => {
    const path = await configPath()
    const { run } = await harness(path)

    expect(await run("model prov mo")).toBe("model: prov/mod (AI summaries on)")
    expect(await run("model prov o")).toBe(
      "ambiguous model: prov/o matches prov/mod, prov/other; name one of them",
    )
  })

  it("answers usage for an unknown subcommand and reports config errors", async () => {
    const { run } = await harness()
    expect(await run("nonsense")).toContain("commands: /relay status")
    expect(await run("/relay nonsense")).toContain("commands: /relay status")

    const broken = await harness(join(tmpdir(), "relay-command-missing", "config.json"))
    expect(await broken.run("status")).toContain("relay: ")
  })

  it("sends an image whose path holds spaces, with the caption after it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-command-"))
    const path = join(dir, "my shot.png")
    await writeFile(path, "x")
    const { deps, run } = await harness()
    const calls: Array<{ path: string; caption?: string }> = []
    deps.image = async (input) => {
      calls.push(input)
      return `sent ${input.path}`
    }

    expect(await run(`send ${path} build passed`)).toBe(`sent ${path}`)
    expect(calls).toEqual([{ path, caption: "build passed" }])
  })

  it("answers a missing image instead of sending it", async () => {
    const { deps, run } = await harness()
    deps.image = async () => {
      throw new Error("should not be called")
    }

    expect(await run("send C:\\nope\\missing.png")).toBe("no such file: C:\\nope\\missing.png")
    expect(await run("send")).toBe("usage: /relay send <path> [caption]")
  })

  it("answers help with every subcommand and the current values", async () => {
    const { run } = await harness()

    const text = await run("help")

    for (const name of ["status", "sessions", "select", "notifications", "model", "pair", "group", "send", "help"]) {
      expect(text).toContain(`/relay ${name}`)
    }
    expect(text).toContain("current: provider whatsapp, preset all, mode batch, model none")
  })

  it("gives every reply a non-empty description the TUI can render", async () => {
    const { replies, run } = await harness()
    const replied = async (text: string) => {
      await run(text)
      return replies.at(-1)!
    }

    const status = await replied("status")
    const usage = await replied("nonsense")
    const broken = await harness(join(tmpdir(), "relay-command-missing", "config.json"))
    await broken.run("status")

    for (const message of [status, usage, broken.replies.at(-1)!]) expect(message.description.trim()).not.toBe("")
    expect(status.description).toBe(status.text)
  })
})
