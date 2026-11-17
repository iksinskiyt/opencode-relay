import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { loadImage } from "../src/image.js"
import { relayCommand } from "../src/interactions/inbound.js"
import { createRelayTool, createTool, type ToolDeps } from "../src/tool.js"

/** Enough of a context for the tool: it reads the session ID and nothing else. */
const context = { sessionID: "ses_caller" } as unknown as ToolContext

const PNG = Buffer.from("89504e470d0a1a0a", "hex")

const harness = async (overrides: Partial<ToolDeps> = {}) => {
  const root = await mkdtemp(join(tmpdir(), "relay-tool-"))
  const calls: Array<{ path: string; caption?: string; sessionID?: string }> = []
  const deps: ToolDeps = {
    root,
    image: async (input) => {
      calls.push(input)
      return `sent shot.png to WhatsApp + Discord`
    },
    ...overrides,
  }
  const tool = createTool(deps)
  const run = async (input: unknown): Promise<string> => {
    const result = await tool.execute(input, context)
    return result.content as string
  }
  /** `/relay send` and the tool share this sender: real validation, then the fan-out text. */
  const sending = async (input: { path: string }): Promise<string> => `sent ${(await loadImage(input)).name}`
  return { root, deps, tool, calls, run, sending }
}

describe("relay_send_image tool", () => {
  it("registers under its own name with a JSON Schema input the host can hand to the model", async () => {
    const { tool } = await harness()

    expect(tool.name).toBe("relay_send_image")
    expect(tool.description).toContain("Send an image")
    // the model reaches for the tool on these words, and never reports a send without calling it
    for (const trigger of ["screenshots", "relay this to my phone", "WhatsApp/Discord"]) {
      expect(tool.description).toContain(trigger)
    }
    expect(tool.description).toContain("Reading the file is not sending it")
    expect(tool.description).toContain("never claim an image was sent")
    expect(tool.input).toMatchObject({
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" }, caption: { type: "string" }, chat: { type: "string" } },
    })
    expect(typeof tool.execute).toBe("function")
  })

  it("sends the image for the calling session and reports where it went", async () => {
    const { calls, run } = await harness()

    const text = await run({ path: "C:\\shots\\shot.png", caption: "build passed" })

    expect(text).toBe("sent shot.png to WhatsApp + Discord")
    expect(calls).toEqual([{ path: "C:\\shots\\shot.png", caption: "build passed", sessionID: "ses_caller" }])
  })

  it("resolves a repo-relative path against the project directory", async () => {
    const { calls, root, run } = await harness()

    await run({ path: join("shots", "shot.png") })

    expect(calls[0]?.path).toBe(join(root, "shots", "shot.png"))
  })

  it("answers a missing file instead of throwing", async () => {
    const { root, run, sending } = await harness()
    const tool = createTool({ root, image: sending })

    const text = (await tool.execute({ path: "nope.png" }, context)).content as string

    expect(text).toBe(`image not sent: no such file: ${join(root, "nope.png")}`)
  })

  it("accepts a small image through the real loader", async () => {
    const { root, sending } = await harness()
    await writeFile(join(root, "shot.png"), PNG)
    const tool = createTool({ root, image: sending })

    expect((await tool.execute({ path: "shot.png" }, context)).content).toBe("sent shot.png")
  })

  it("reports an oversized image as rejected, not queued", async () => {
    const { root, sending } = await harness()
    await writeFile(join(root, "huge.png"), Buffer.alloc(9 * 1024 * 1024))
    const tool = createTool({ root, image: sending })

    const text = (await tool.execute({ path: "huge.png" }, context)).content as string

    expect(text).toBe("image not sent: image is 9.0 MB, the limit is 8.0 MB")
  })

  it("asks for the path when the call omits it", async () => {
    const { calls, run } = await harness()

    expect(await run({})).toBe("relay_send_image: path is required")
    expect(await run({ path: "  " })).toBe("relay_send_image: path is required")
    expect(calls).toEqual([])
  })

  it("says chat targeting is not wired yet instead of pretending it was honoured", async () => {
    const { run } = await harness()

    expect(await run({ path: "a.png", chat: "me" })).toBe(
      "sent shot.png to WhatsApp + Discord (chat targeting is not wired yet)",
    )
  })
})

describe("relay tool", () => {
  /** The words the tool hands the dispatcher, so a leading "relay"/"/relay" cannot reach it. */
  const harness = () => {
    const calls: Array<{ text: string; sessionID?: string }> = []
    const tool = createRelayTool({
      command: async (text, sessionID) => {
        calls.push({ text, ...(sessionID === undefined ? {} : { sessionID }) })
        return `answer for: ${text}`
      },
    })
    const run = async (input: unknown): Promise<string> => (await tool.execute(input, context)).content as string
    return { calls, tool, run }
  }

  it("registers as `relay` and tells the model not to explore the repo for relay state", async () => {
    const { tool } = await harness()

    expect(tool.name).toBe("relay")
    for (const trigger of ["relay status", "/relay sessions", "pair whatsapp", "is the relay up"]) {
      expect(tool.description).toContain(trigger)
    }
    expect(tool.description).toContain("Call this tool instead of exploring the repo")
    expect(tool.input).toMatchObject({
      type: "object",
      required: ["command"],
      properties: { command: { type: "string" } },
    })
    expect(typeof tool.execute).toBe("function")
  })

  it("passes the command to the dispatcher for the invoking session", async () => {
    const { calls, run } = await harness()

    expect(await run({ command: "status" })).toBe("answer for: status")
    expect(calls).toEqual([{ text: "status", sessionID: "ses_caller" }])
  })

  it("accepts the leading relay word and slash the user may paste", async () => {
    const { calls, run } = await harness()

    await run({ command: "relay status" })
    await run({ command: "/relay pair whatsapp" })

    expect(calls.map((call) => call.text)).toEqual(["status", "pair whatsapp"])
  })

  it("answers an unknown command with the usage list, not a guess", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-tool-cmd-"))
    const configPath = join(root, "config.json")
    await writeFile(configPath, JSON.stringify({ provider: "whatsapp" }))
    const tool = createRelayTool({
      command: (text, sessionID) =>
        relayCommand(text, { configPath, provider: "whatsapp", selected: {} }, sessionID),
    })

    const text = (await tool.execute({ command: "nonsense" }, context)).content as string

    expect(text).toContain("commands: /relay status")
    expect(text).toContain("/relay help")
    expect(text).not.toContain("nonsense")
  })
})
