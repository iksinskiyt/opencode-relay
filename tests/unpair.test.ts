import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { configSchema, loadConfig } from "../src/config.js"
import { relayCommand, type PairingDeps, type RelayCommandDeps } from "../src/interactions/inbound.js"

const example = JSON.parse(await readFile(new URL("../examples/config.example.json", import.meta.url), "utf8"))

interface Options {
  /** Write linked whatsapp creds, as a completed pairing leaves them. */
  paired?: boolean
  discord?: { enabled?: boolean; target?: "channel" | "dm"; id?: string }
  transports?: RelayCommandDeps["transports"]
  /** Makes a live socket available to log out; defaults to a recording stub. */
  live?: boolean
  /** Replaces the live socket's logout; implies `live`. */
  logout?: () => Promise<void>
}

const harness = async (options: Options = {}) => {
  const dir = await mkdtemp(join(tmpdir(), "relay-unpair-"))
  const configPath = join(dir, "config.json")
  const root = join(dir, "auth-state")
  const config = configSchema.parse({
    ...example,
    whatsapp: { ...example.whatsapp, selfChat: true, target: "491234567890" },
    discord: {
      ...example.discord,
      enabled: options.discord?.enabled ?? true,
      target: options.discord?.target ?? "channel",
      ...(options.discord?.target === "dm"
        ? { dmUserID: options.discord.id ?? "111222333444555666" }
        : { channelID: options.discord?.id ?? "123456789012345678" }),
    },
  })
  await writeFile(configPath, JSON.stringify(config), "utf8")
  if (options.paired === true) {
    const whatsappDir = join(root, "whatsapp")
    await mkdir(whatsappDir, { recursive: true })
    await writeFile(
      join(whatsappDir, "creds.json"),
      JSON.stringify({ me: { id: "491234567890@s.whatsapp.net" }, registered: true }),
      "utf8",
    )
  }
  await mkdir(root, { recursive: true })
  await writeFile(
    join(root, "discord.json"),
    JSON.stringify({ dmUserID: "111222333444555666", channelID: "dm_1" }),
    "utf8",
  )

  const loggedOut = vi.fn(options.logout ?? (async () => undefined))
  const pairing: PairingDeps = {
    dataDir: root,
    env: {},
    ...(options.live === true || options.logout !== undefined ? { whatsappLogout: loggedOut } : {}),
  }
  const deps: RelayCommandDeps = {
    provider: "whatsapp",
    configPath,
    selected: {},
    pairing,
    ...(options.transports === undefined ? {} : { transports: options.transports }),
  }
  return {
    configPath,
    root,
    loggedOut,
    run: (text: string) => relayCommand(text, deps),
    whatsappDir: join(root, "whatsapp"),
    discordCache: join(root, "discord.json"),
  }
}

describe("/relay unpair", () => {
  it("logs whatsapp out server-side, deletes the auth dir and turns the transport off", async () => {
    const h = await harness({ paired: true, live: true })
    expect(existsSync(h.whatsappDir)).toBe(true)

    const text = await h.run("/relay unpair whatsapp")

    expect(h.loggedOut).toHaveBeenCalledTimes(1)
    expect(text).toContain("logged out and unpaired")
    expect(text).toContain("auth-state/whatsapp removed")
    expect(existsSync(h.whatsappDir)).toBe(false)
    const config = await loadConfig(h.configPath)
    expect(config.whatsapp.enabled).toBe(false)
    expect(config.whatsapp.target).toBe("491234567890")
  })

  it("still removes the local creds when the logout call fails", async () => {
    const h = await harness({
      paired: true,
      logout: async () => {
        throw new Error("socket closed")
      },
    })

    const text = await h.run("/relay unpair whatsapp")

    expect(text).toContain("logout failed")
    expect(text).toContain("socket closed")
    expect(existsSync(h.whatsappDir)).toBe(false)
    expect((await loadConfig(h.configPath)).whatsapp.enabled).toBe(false)
  })

  it("cleans up locally when there is no live socket to log out", async () => {
    const h = await harness({ paired: true })

    const text = await h.run("/relay unpair whatsapp")

    expect(text).toContain("unpaired locally (no live WhatsApp socket to log out)")
    expect(existsSync(h.whatsappDir)).toBe(false)
  })

  it("says there is nothing to unpair when whatsapp was never paired", async () => {
    const h = await harness()

    const text = await h.run("/relay unpair whatsapp")

    expect(text).toBe("whatsapp: not paired - nothing to unpair")
    expect(h.loggedOut).not.toHaveBeenCalled()
    expect((await loadConfig(h.configPath)).whatsapp.enabled).toBe(true)
  })

  it("clears the discord target, disables it and deletes the DM channel cache", async () => {
    const h = await harness({ discord: { target: "dm" } })

    const text = await h.run("/relay unpair discord")

    expect(text).toContain("discord: unpaired")
    expect(text).toContain("auth-state/discord.json removed")
    expect(text).toContain("DISCORD_BOT_TOKEN")
    expect(existsSync(h.discordCache)).toBe(false)
    const config = await loadConfig(h.configPath)
    expect(config.discord.enabled).toBe(false)
    expect(config.discord.target).toBe("channel")
    expect(config.discord.dmUserID).toBeUndefined()
    expect(config.discord.channelID).toBeUndefined()
  })

  it("keeps the button preference and reports a cache that was already gone", async () => {
    const h = await harness()
    await h.run("/relay unpair discord")

    const text = await h.run("/relay unpair discord")

    expect(text).toContain("no auth-state/discord.json to remove")
    expect((await loadConfig(h.configPath)).discord.buttons).toBe(false)
  })

  it("warns that notifications stop when the unpaired transport was the only live one", async () => {
    const h = await harness({
      paired: true,
      live: true,
      transports: [
        { name: "whatsapp", state: "live" },
        { name: "discord", state: "disabled", reason: "discord.enabled is false" },
      ],
    })

    expect(await h.run("/relay unpair whatsapp")).toContain("notifications stop (envelopes go to the mock sink)")

    const both = await harness({
      paired: true,
      live: true,
      transports: [
        { name: "whatsapp", state: "live" },
        { name: "discord", state: "live" },
      ],
    })
    expect(await both.run("/relay unpair whatsapp")).not.toContain("notifications stop")
  })

  it("answers an unknown or missing provider with usage and changes nothing", async () => {
    const h = await harness({ paired: true })

    expect(await h.run("/relay unpair")).toBe("usage: /relay unpair <whatsapp|discord>")
    expect(await h.run("/relay unpair slack")).toBe("usage: /relay unpair <whatsapp|discord>")
    expect(existsSync(h.whatsappDir)).toBe(true)
    expect((await loadConfig(h.configPath)).whatsapp.enabled).toBe(true)
  })
})
