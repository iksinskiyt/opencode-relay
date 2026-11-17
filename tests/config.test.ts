import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { configSchema, loadConfig, updateConfig } from "../src/config.js"

const example = JSON.parse(await readFile(new URL("../examples/config.example.json", import.meta.url), "utf8"))

describe("config example", () => {
  it("lists every key the schema defaults and nothing the schema does not know", () => {
    // equal, not merely valid: a missing key would come back filled by a default, an unknown key
    // would be stripped, so either drift from the schema fails this comparison
    expect(configSchema.parse(example)).toEqual(example)
  })
})

describe("updateConfig", () => {
  const configFile = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "relay-config-"))
    const file = join(dir, "config.json")
    await writeFile(file, `${JSON.stringify(example, null, 2)}\n`, "utf8")
    return file
  }

  it("serialises concurrent changes so none of them is lost", async () => {
    const file = await configFile()

    await Promise.all([
      updateConfig(file, (config) => {
        config.notifications.preset = "important"
      }),
      updateConfig(file, (config) => {
        config.notifications.categories.errors = false
      }),
      updateConfig(file, (config) => {
        config.notifications.passes.mode = "final_only"
      }),
    ])

    const config = await loadConfig(file)
    expect(config.notifications.preset).toBe("important")
    expect(config.notifications.categories.errors).toBe(false)
    expect(config.notifications.passes.mode).toBe("final_only")
  })

  it("leaves config.json untouched when the change throws and leaves no temp file", async () => {
    const file = await configFile()
    const before = await readFile(file, "utf8")

    await expect(
      updateConfig(file, () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")

    expect(await readFile(file, "utf8")).toBe(before)
    expect((await readdir(dirname(file))).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })
})
