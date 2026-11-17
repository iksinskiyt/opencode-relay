import { copyFile, mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type GenerateText, matchModel, ModelProcessor, processEnvelope, resolveModel, setModel } from "../src/ai.js"
import { configSchema } from "../src/config.js"
import type { Envelope } from "../src/envelope.js"

const example = JSON.parse(await readFile(new URL("../examples/config.example.json", import.meta.url), "utf8"))
const ai = (enabled: boolean) =>
  configSchema.parse({
    ...example,
    aiProcessing: { enabled, model: { providerID: "prov", modelID: "mod" } },
  })

const available = [{ providerID: "prov", id: "mod" }]

const envelope = (category: Envelope["category"]): Envelope => ({
  id: "env_1",
  category,
  text: "pass finished: renamed the router",
  createdAt: 0,
})

describe("ai processor", () => {
  it("returns the input untouched when aiProcessing is disabled", async () => {
    const processor = new ModelProcessor(ai(false), available)
    const input = envelope("passCompleted")
    expect(processor.model).toBeNull()
    expect(await processEnvelope(processor, input)).toBe(input)
  })

  it("falls back to raw text when the configured model is unavailable", async () => {
    const config = ai(true)
    expect(resolveModel(config, [])).toBeNull()
    expect(resolveModel(config, [{ providerID: "prov", id: "other" }])).toBeNull()
    expect(resolveModel(config, available)).toEqual({ providerID: "prov", id: "mod" })

    const processor = new ModelProcessor(config, [])
    const input = envelope("taskCompleted")
    expect(await processEnvelope(processor, input)).toBe(input)
  })

  it("adds the host summary on top of the full text instead of replacing it", async () => {
    const prompts: string[] = []
    const generate: GenerateText = async ({ prompt, model }) => {
      prompts.push(prompt)
      expect(model).toEqual({ providerID: "prov", id: "mod" })
      return { text: "  renamed the router  " }
    }

    const processor = new ModelProcessor(ai(true), available, generate)
    const summarised = await processEnvelope(processor, envelope("passCompleted"))

    expect(summarised.text).toBe("summary: renamed the router\n\npass finished: renamed the router")
    expect(summarised.id).toBe("env_1")
    expect(prompts[0]).toContain("renamed the router")
  })

  it("picks up a model set through config.json without a restart", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "relay-ai-")), "config.json")
    await copyFile(new URL("../examples/config.example.json", import.meta.url), path)
    const input = envelope("passCompleted")
    const processor = new ModelProcessor(ai(false), available, async () => ({ text: "summary" }), path)
    expect(processor.model).toBeNull()
    expect(await processEnvelope(processor, input)).toBe(input)

    await setModel(path, "prov", "mod")

    expect((await processEnvelope(processor, input)).text).toBe(`summary: summary\n\n${input.text}`)
  })

  it("keeps the raw text when the model call fails or returns nothing", async () => {
    const broken = new ModelProcessor(ai(true), available, async () => {
      throw new Error("provider down")
    })
    const input = envelope("errors")
    expect((await processEnvelope(broken, input)).text).toBe(input.text)

    const empty = new ModelProcessor(ai(true), available, async () => ({ text: "   " }))
    expect((await processEnvelope(empty, input)).text).toBe(input.text)
  })

  it("never sends questions or permissions through the processor", async () => {
    let calls = 0
    const processor = {
      summarize: async (input: Envelope): Promise<Envelope> => {
        calls += 1
        return input
      },
    }

    const question = envelope("questions")
    const permission = envelope("permissions")
    expect(await processEnvelope(processor, question)).toBe(question)
    expect(await processEnvelope(processor, permission)).toBe(permission)
    expect(calls).toBe(0)

    await processEnvelope(processor, envelope("passCompleted"))
    await processEnvelope(processor, envelope("taskCompleted"))
    await processEnvelope(processor, envelope("errors"))
    expect(calls).toBe(3)
  })
})

describe("model matching", () => {
  const host = [
    { providerID: "opencode", id: "muse-spark-1.3" },
    { providerID: "opencode", id: "muse-spark-2.0" },
  ]
  const configPath = async (): Promise<string> => {
    const path = join(await mkdtemp(join(tmpdir(), "relay-match-")), "config.json")
    await copyFile(new URL("../examples/config.example.json", import.meta.url), path)
    return path
  }

  it("takes the exact ID before anything fuzzy", () => {
    expect(matchModel("opencode", "muse-spark-1.3", host)).toEqual({ kind: "match", model: host[0] })
  })

  it("drops a variant suffix typed on top of a real ID", () => {
    expect(matchModel("opencode", "muse-spark-1.3-contributor", host)).toEqual({
      kind: "match",
      model: host[0],
    })
  })

  it("accepts a unique prefix, and refuses to guess between several", () => {
    expect(matchModel("opencode", "muse-spark-2", host)).toEqual({ kind: "match", model: host[1] })

    const ambiguous = matchModel("opencode", "muse-spark", host)
    expect(ambiguous.kind).toBe("ambiguous")
    expect(ambiguous.kind === "ambiguous" && ambiguous.candidates).toEqual(host)
  })

  it("does not match another provider's model", () => {
    expect(matchModel("opencode", "spark", [{ providerID: "other", id: "spark" }])).toEqual({
      kind: "none",
    })
  })

  it("stores the resolved ID, and reports what an ambiguous one matched", async () => {
    const path = await configPath()

    expect(await setModel(path, "opencode", "muse-spark-1.3-contributor", host)).toEqual({
      enabled: true,
      providerID: "opencode",
      modelID: "muse-spark-1.3",
    })
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      aiProcessing: { model: { providerID: string; modelID: string } }
    }
    expect(saved.aiProcessing.model).toEqual({ providerID: "opencode", modelID: "muse-spark-1.3" })

    await expect(setModel(path, "opencode", "muse-spark", host)).rejects.toThrow(
      "ambiguous model: opencode/muse-spark matches opencode/muse-spark-1.3, opencode/muse-spark-2.0",
    )
    await expect(setModel(path, "opencode", "nope", host)).rejects.toThrow(
      "unknown model: opencode/nope (see /relay model)",
    )
  })
})
