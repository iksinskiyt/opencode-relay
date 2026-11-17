import { spawnSync } from "node:child_process"
import pino from "pino"

/** Only what the resolver logs: which source answered, never the value. */
export interface SecretLog {
  debug: (fields: Record<string, string>, message: string) => void
  info: (fields: Record<string, string>, message: string) => void
}

export type SecretSource = "dep" | "env" | "registry" | "missing"

export interface ResolvedSecret {
  value: string | undefined
  source: SecretSource
}

export interface SecretDeps {
  /** Explicit override, highest priority. */
  value?: string
  /** Environment to read; defaults to process.env. */
  env?: Record<string, string | undefined>
  /** Defaults to this module's pino logger. */
  log?: SecretLog
}

const log: SecretLog = pino({ name: "opencode-relay" })

/** Registry hits are cached for the process: setx already ran before the host started. */
const registryHits = new Map<string, string>()

/** `    NAME    REG_SZ    value`: the value is what follows the type token, spaces and all. */
function parseRegValue(stdout: string, name: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+(REG_[A-Z_]+)\s+(.*)$/.exec(line)
    if (match?.[1]?.toUpperCase() !== name.toUpperCase()) continue
    const value = match[3]?.trim() ?? ""
    if (value !== "") return value
  }
  return undefined
}

/** HKCU\Environment, where setx writes; any failure means "absent" so the caller can report it. */
function registrySecret(name: string): string | undefined {
  const cached = registryHits.get(name)
  if (cached !== undefined) return cached
  try {
    const result = spawnSync("reg", ["query", "HKCU\\Environment", "/v", name], {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
    })
    const value = result.status === 0 ? parseRegValue(result.stdout, name) : undefined
    if (value === undefined) return undefined
    registryHits.set(name, value)
    return value
  } catch {
    return undefined
  }
}

/**
 * dep override -> process environment -> HKCU\Environment. The registry is the fix for hosts
 * whose launcher predates `setx`: they never inherit the variable, but the value is there.
 */
export function resolveSecret(name: string, deps: SecretDeps = {}): ResolvedSecret {
  const logger = deps.log ?? log
  if (deps.value !== undefined && deps.value !== "") {
    logger.debug({ secret: name, source: "dep" }, "secret resolved")
    return { value: deps.value, source: "dep" }
  }
  const env = deps.env ?? process.env
  const fromEnv = env[name]
  if (fromEnv !== undefined && fromEnv !== "") {
    logger.debug({ secret: name, source: "env" }, "secret resolved")
    return { value: fromEnv, source: "env" }
  }
  // an injected env is the caller's whole world; only the real process env can be stale
  const fromRegistry = env === process.env ? registrySecret(name) : undefined
  if (fromRegistry !== undefined) {
    logger.info({ secret: name, source: "registry" }, "secret resolved from the Windows registry")
    return { value: fromRegistry, source: "registry" }
  }
  logger.debug({ secret: name, source: "missing" }, "secret not found")
  return { value: undefined, source: "missing" }
}

export function discordToken(deps?: SecretDeps): ResolvedSecret {
  return resolveSecret("DISCORD_BOT_TOKEN", deps)
}
