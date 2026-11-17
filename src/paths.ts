import { copyFileSync, cpSync, existsSync, mkdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The install root: `dist/index.js` and `src/index.ts` both sit one level below it, anything else
 * (a flattened single-file build) is its own root.
 */
export function pluginRoot(moduleUrl: string = import.meta.url): string {
  const dir = dirname(fileURLToPath(moduleUrl))
  const name = basename(dir)
  return name === "dist" || name === "src" ? dirname(dir) : dir
}

/**
 * Where config and state live: a data directory outside the install, so a reinstall or `git pull`
 * cannot drop the WhatsApp pairing and the repo never holds secrets.
 */
export function dataRoot(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode-relay")
}

export interface RelayPaths {
  configPath: string
  /** Credentials, batches, outbox: inside the data dir, beside the config that won. */
  dataDir: string
  source: "data" | "legacy" | "missing"
  /** The old in-repo config.json this run copied to the data dir, when any. */
  migrated?: string
  /** Every config.json looked at, for the "relay disabled" log. */
  searched: string[]
}

/**
 * One-time migration off the install: copy, never delete, so a failed run leaves the old pair
 * intact and the caller can tell the user what to remove.
 */
function migrate(legacyConfig: string, configPath: string, dataDir: string): void {
  mkdirSync(dirname(configPath), { recursive: true })
  copyFileSync(legacyConfig, configPath)
  const legacyState = join(dirname(legacyConfig), "auth-state")
  if (!existsSync(dataDir) && existsSync(legacyState)) cpSync(legacyState, dataDir, { recursive: true })
}

/**
 * Config and state live in the data directory, not with the session that loaded the plugin: the
 * host passes the session's directory, so anchoring there gives every other project a silent dead
 * plugin. A config.json still inside the install (or a project) is copied over once, so an older
 * install keeps working without re-pairing.
 */
export function resolvePaths(
  location: string,
  root: string = pluginRoot(),
  env: Record<string, string | undefined> = process.env,
): RelayPaths {
  const home = dataRoot(env)
  const configPath = join(home, "config.json")
  const dataDir = join(home, "auth-state")
  if (existsSync(configPath)) return { configPath, dataDir, source: "data", searched: [configPath] }
  const candidates = [join(root, "config.json"), ...(location === root ? [] : [join(location, "config.json")])]
  const legacy = candidates.find((candidate) => existsSync(candidate))
  if (legacy !== undefined) {
    migrate(legacy, configPath, dataDir)
    const searched = candidates.filter((candidate) => candidate !== legacy)
    return { configPath, dataDir, source: "legacy", migrated: legacy, searched: [configPath, ...searched] }
  }
  return { configPath, dataDir, source: "missing", searched: [configPath] }
}

/** `..` and symlinks are resolved before the check, so neither can step outside a root. */
const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * A path a user asked the relay to send: only files under one of these roots. Returns the resolved
 * path to send, or null when it is outside every root.
 */
export function withinRoots(path: string, roots: readonly string[]): string | null {
  const candidate = real(path)
  const fold = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value)
  for (const root of roots) {
    const base = real(root)
    if (fold(candidate) === fold(base) || fold(candidate).startsWith(fold(base) + sep)) return candidate
  }
  return null
}
