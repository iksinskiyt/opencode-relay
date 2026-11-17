import { beforeEach, describe, expect, it, vi } from "vitest"
import { discordToken, resolveSecret } from "../src/env.js"

/** `reg query` result, as the resolver would see it. */
const reg = vi.hoisted(() => ({ status: 0 as number | null, stdout: "", throws: false, calls: 0 }))

vi.mock("node:child_process", () => ({
  spawnSync: () => {
    reg.calls += 1
    if (reg.throws) throw new Error("reg unavailable")
    return { status: reg.status, stdout: reg.stdout }
  },
}))

const spyLog = () => ({ debug: vi.fn(), info: vi.fn() })

beforeEach(() => {
  reg.status = 0
  reg.stdout = ""
  reg.throws = false
  reg.calls = 0
})

describe("resolveSecret", () => {
  it("lets the explicit override win over environment and registry", () => {
    reg.stdout = "    DEP_WINS    REG_SZ    from-registry"

    expect(resolveSecret("DEP_WINS", { value: "from-dep", env: { DEP_WINS: "from-env" } })).toEqual({
      value: "from-dep",
      source: "dep",
    })
    expect(reg.calls).toBe(0)
  })

  it("lets the environment win over the registry", () => {
    reg.stdout = "    ENV_WINS    REG_SZ    from-registry"
    process.env.ENV_WINS = "from-env"
    try {
      expect(resolveSecret("ENV_WINS", { env: process.env })).toEqual({ value: "from-env", source: "env" })
      expect(reg.calls).toBe(0)
    } finally {
      delete process.env.ENV_WINS
    }
  })

  it("falls back to HKCU\\Environment and keeps spaces in the value", () => {
    reg.stdout = [
      "",
      "HKEY_CURRENT_USER\\Environment",
      "    REG_SPACES    REG_EXPAND_SZ    a value with spaces",
      "",
    ].join("\r\n")

    expect(resolveSecret("REG_SPACES", { env: process.env })).toEqual({
      value: "a value with spaces",
      source: "registry",
    })
  })

  it("treats a failed, timed-out or throwing reg query as missing", () => {
    reg.status = 1
    reg.stdout = "ERROR: The system was unable to find the specified registry key or value."
    expect(resolveSecret("REG_FAIL", { env: process.env })).toEqual({ value: undefined, source: "missing" })

    reg.status = null
    expect(resolveSecret("REG_TIMEOUT", { env: process.env })).toEqual({ value: undefined, source: "missing" })

    reg.throws = true
    expect(resolveSecret("REG_THROWS", { env: process.env })).toEqual({ value: undefined, source: "missing" })
  })

  it("caches a registry hit for the process", () => {
    reg.stdout = "    CACHED    REG_SZ    once"

    expect(resolveSecret("CACHED", { env: process.env }).source).toBe("registry")
    const afterFirst = reg.calls
    expect(resolveSecret("CACHED", { env: process.env }).value).toBe("once")
    expect(reg.calls).toBe(afterFirst)
  })

  it("reports the source and never logs the value", () => {
    const depLog = spyLog()
    resolveSecret("LOG_SAFE", { value: "s3cr3t-value", log: depLog })
    expect(JSON.stringify([...depLog.debug.mock.calls, ...depLog.info.mock.calls])).not.toContain("s3cr3t-value")
    expect(JSON.stringify(depLog.debug.mock.calls)).toContain("dep")

    reg.stdout = "    LOG_REG    REG_SZ    s3cr3t-registry"
    const registryLog = spyLog()
    resolveSecret("LOG_REG", { env: process.env, log: registryLog })
    expect(registryLog.info.mock.calls[0]?.[0]).toEqual({ secret: "LOG_REG", source: "registry" })
    expect(JSON.stringify([...registryLog.debug.mock.calls, ...registryLog.info.mock.calls])).not.toContain(
      "s3cr3t-registry",
    )
  })

  it("reads DISCORD_BOT_TOKEN through the same chain", () => {
    expect(discordToken({ value: "tok" })).toEqual({ value: "tok", source: "dep" })
  })
})
