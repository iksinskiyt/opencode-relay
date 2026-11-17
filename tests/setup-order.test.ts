import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import plugin from "../src/index.js"

/**
 * The plugin reads the config beside the install, so the harness stands in for that resolution:
 * a run must never pick up the developer's own config.json.
 */
const paths = vi.hoisted(() => ({ root: "" }))
vi.mock("../src/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/paths.js")>()
  const [{ mkdtemp }, { tmpdir }, { join: joinPath }] = await Promise.all([
    import("node:fs/promises"),
    import("node:os"),
    import("node:path"),
  ])
  paths.root = await mkdtemp(joinPath(tmpdir(), "relay-setup-"))
  const configPath = joinPath(paths.root, "config.json")
  return {
    ...actual,
    resolvePaths: () => ({ configPath, dataDir: joinPath(paths.root, "auth-state"), source: "plugin", searched: [configPath] }),
  }
})

const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const until = async (done: () => boolean, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for registrations")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe("plugin setup order", () => {
  it("registers the command and tools before the model list resolves", async () => {
    const config = JSON.parse(await readFile(new URL("../examples/config.example.json", import.meta.url), "utf8"))
    // no transport and no AI: the only slow host call left is the model list
    config.whatsapp.enabled = false
    config.discord.enabled = false
    config.aiProcessing.enabled = false
    await writeFile(join(paths.root, "config.json"), JSON.stringify(config))

    const commands: Array<{ name: string }> = []
    const tools: Array<{ name: string }> = []
    const models = deferred<{ data: [] }>()
    const editor = (add: (item: { name: string }) => void) => ({ add })
    const ctx = {
      location: { directory: paths.root },
      command: {
        transform: async (fn: (input: unknown) => void) => {
          fn(editor((command) => commands.push(command)))
          return { dispose: async () => {} }
        },
      },
      tool: {
        transform: async (fn: (input: unknown) => void) => {
          fn(editor((tool) => tools.push(tool)))
          return { dispose: async () => {} }
        },
      },
      model: { list: () => models.promise },
      session: {
        list: async () => ({ data: [] }),
        get: async () => ({}),
        synthetic: async () => {},
        prompt: async () => {},
      },
      permission: { reply: async () => {} },
      experimental: { generate: { text: async () => "" } },
      event: {
        subscribe: async function* () {
          // no host events in this harness
        },
      },
    }

    const setup = plugin.setup(ctx as never)

    await until(() => commands.length > 0 && tools.length > 0)
    // the model list is still pending: the registrations did not wait for it
    expect(commands.map((command) => command.name)).toEqual(["relay"])
    expect(tools.map((tool) => tool.name)).toEqual(["relay_send_image", "relay"])

    models.resolve({ data: [] })
    const cleanup = await setup
    await cleanup?.()
  })
})
