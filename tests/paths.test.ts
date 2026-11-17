import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { dataRoot, pluginRoot, resolvePaths, withinRoots } from "../src/paths.js"

const BASE = join(tmpdir(), "relay-fake-root")
const url = (...parts: string[]): string => pathToFileURL(join(BASE, ...parts)).href

const tempDir = () => mkdtemp(join(tmpdir(), "relay-paths-"))

/** An isolation env: XDG_DATA_HOME points at a fresh directory, so no real install is touched. */
const dataEnv = async (): Promise<{ env: Record<string, string>; home: string }> => {
  const home = await tempDir()
  return { env: { XDG_DATA_HOME: home }, home: join(home, "opencode-relay") }
}

/** An install root with an optional config.json, and a session directory with an optional one. */
const dirs = async (options: { plugin: boolean; location: boolean }) => {
  const root = await tempDir()
  const location = await tempDir()
  if (options.plugin) await writeFile(join(root, "config.json"), '{"enabled":false}')
  if (options.location) await writeFile(join(location, "config.json"), '{"enabled":false}')
  return { root, location }
}

describe("pluginRoot", () => {
  it("takes the parent of dist/ and of src/", () => {
    expect(pluginRoot(url("dist", "index.js"))).toBe(BASE)
    expect(pluginRoot(url("src", "index.ts"))).toBe(BASE)
  })

  it("treats any other directory as the root itself", () => {
    expect(pluginRoot(url("index.js"))).toBe(BASE)
    expect(pluginRoot(url("build", "nested", "index.js"))).toBe(join(BASE, "build", "nested"))
  })
})

describe("dataRoot", () => {
  it("sits under XDG_DATA_HOME when set", () => {
    expect(dataRoot({ XDG_DATA_HOME: "/data" })).toBe(join("/data", "opencode-relay"))
  })

  it("falls back to ~/.local/share, never APPDATA", () => {
    expect(dataRoot({ APPDATA: "/roaming" }, "/home/me")).toBe(join("/home/me", ".local", "share", "opencode-relay"))
  })
})

describe("resolvePaths", () => {
  it("reads the data dir's config and keeps state beside it", async () => {
    const { env, home } = await dataEnv()
    const { root, location } = await dirs({ plugin: true, location: true })
    await mkdir(home, { recursive: true })
    await writeFile(join(home, "config.json"), '{"enabled":false}')

    expect(resolvePaths(location, root, env)).toEqual({
      configPath: join(home, "config.json"),
      dataDir: join(home, "auth-state"),
      source: "data",
      searched: [join(home, "config.json")],
    })
  })

  it("copies an in-repo config and its auth-state over once, keeping the old pair intact", async () => {
    const { env, home } = await dataEnv()
    const { root, location } = await dirs({ plugin: false, location: false })
    await writeFile(join(root, "config.json"), '{"enabled":false}')
    await mkdir(join(root, "auth-state", "whatsapp"), { recursive: true })
    await writeFile(join(root, "auth-state", "whatsapp", "creds.json"), '{"me":"x"}')

    const paths = resolvePaths(location, root, env)

    expect(paths).toMatchObject({ source: "legacy", migrated: join(root, "config.json") })
    expect(paths.configPath).toBe(join(home, "config.json"))
    expect(existsSync(join(home, "auth-state", "whatsapp", "creds.json"))).toBe(true)
    // the source is left alone: a half-finished migration must not lose the pairing
    expect(existsSync(join(root, "config.json"))).toBe(true)
  })

  it("migrates a config left in the session directory too", async () => {
    const { env, home } = await dataEnv()
    const { root, location } = await dirs({ plugin: false, location: true })

    const paths = resolvePaths(location, root, env)

    expect(paths).toMatchObject({ source: "legacy", migrated: join(location, "config.json") })
    expect(existsSync(join(home, "config.json"))).toBe(true)
  })

  it("reports both searched paths when neither exists", async () => {
    const { env, home } = await dataEnv()
    const { root, location } = await dirs({ plugin: false, location: false })

    const paths = resolvePaths(location, root, env)

    expect(paths).toMatchObject({ source: "missing", configPath: join(home, "config.json") })
    expect(paths.searched).toEqual([join(home, "config.json")])
  })

  it("does not treat the same directory twice as install root and session", async () => {
    const { env, home } = await dataEnv()
    const root = await tempDir()
    await writeFile(join(root, "config.json"), '{"enabled":false}')

    const paths = resolvePaths(root, root, env)

    expect(paths).toMatchObject({ source: "legacy", migrated: join(root, "config.json") })
    expect(existsSync(join(home, "config.json"))).toBe(true)
  })
})

describe("withinRoots", () => {
  it("accepts a file inside a root and refuses one outside it", async () => {
    const root = await tempDir()
    const outside = await tempDir()
    await writeFile(join(root, "shot.png"), "x")
    await writeFile(join(outside, "secret.png"), "x")

    expect(withinRoots(join(root, "shot.png"), [root])).not.toBeNull()
    expect(withinRoots(join(outside, "secret.png"), [root])).toBeNull()
  })

  it("refuses a `..` escape that resolves outside every root", async () => {
    const root = await tempDir()
    const parent = join(root, "..", `${"relay-paths-"}escape.png`)

    expect(withinRoots(parent, [root])).toBeNull()
  })

  it("accepts a missing file inside a root, so the loader can report it", async () => {
    const root = await tempDir()

    expect(withinRoots(join(root, "gone.png"), [root])).not.toBeNull()
  })
})
