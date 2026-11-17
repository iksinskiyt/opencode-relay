import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { configSchema } from "../src/config.js"
import { relayCommand, type PairingDeps, type RelayCommandDeps } from "../src/interactions/inbound.js"

const example = JSON.parse(await readFile(new URL("../examples/config.example.json", import.meta.url), "utf8"))

interface Options {
  /** Write auth-state/whatsapp/creds.json, as a completed pairing would. */
  paired?: boolean
  /** Write creds a started-but-unfinished pairing leaves: `me`, but `registered` still false. */
  started?: boolean
  target?: string
  discordChannel?: string
  discordDm?: string
  env?: Record<string, string | undefined>
  code?: (phoneNumber: string) => Promise<string>
}

const harness = async (options: Options = {}) => {
  const dir = await mkdtemp(join(tmpdir(), "relay-pair-"))
  const configPath = join(dir, "config.json")
  const config = configSchema.parse({
    ...example,
    whatsapp: { ...example.whatsapp, ...(options.target === undefined ? {} : { target: options.target }) },
    discord: {
      ...example.discord,
      ...(options.discordChannel === undefined ? {} : { channelID: options.discordChannel }),
      ...(options.discordDm === undefined ? {} : { target: "dm", dmUserID: options.discordDm }),
    },
  })
  await writeFile(configPath, JSON.stringify(config), "utf8")
  if (options.paired === true || options.started === true) {
    const whatsappDir = join(dir, "auth-state", "whatsapp")
    await mkdir(whatsappDir, { recursive: true })
    // Baileys writes the creds object straight into creds.json; `registered` only flips to true
    // once WhatsApp confirms the device, so a started pairing has `me` without it
    await writeFile(
      join(whatsappDir, "creds.json"),
      JSON.stringify({ me: { id: "491234567890@s.whatsapp.net" }, registered: options.paired === true }),
      "utf8",
    )
  }

  const code = vi.fn(options.code ?? (async () => "ABCD1234"))
  const pairing: PairingDeps = { env: options.env ?? {}, whatsappCode: code }
  const deps: RelayCommandDeps = { provider: "whatsapp", configPath, selected: {}, pairing }
  return { code, deps, run: (text: string) => relayCommand(text, deps) }
}

describe("/relay pair", () => {
  it("lists providers, pairing state and usage", async () => {
    const { run } = await harness()

    const text = await run("/relay pair")

    expect(text).toContain("whatsapp: not paired")
    expect(text).toContain("discord: token missing, channel missing")
    expect(text).toContain("usage: /relay pair")
  })

  it("reports an already-paired whatsapp without requesting a code", async () => {
    const { code, run } = await harness({ paired: true })

    const text = await run("/relay pair whatsapp")

    expect(text).toContain("already paired")
    expect(text).toContain("delete that folder")
    expect(code).not.toHaveBeenCalled()
  })

  it("reports a started-but-unfinished pairing instead of already paired", async () => {
    const { code, run } = await harness({ started: true, target: "491234567890" })

    const text = await run("/relay pair whatsapp")

    // `me` without `registered`: the phone was never confirmed, so no "already paired"
    expect(text).toContain("pairing started but not completed")
    expect(text).toContain("whatsapp pairing code: ABCD1234")
    expect(text).not.toContain("already paired")
    expect(text).not.toContain("linked")
    expect(code).toHaveBeenCalledWith("491234567890")
  })

  it("shows the started state in the provider listing", async () => {
    const { run } = await harness({ started: true })

    expect(await run("/relay pair")).toContain("whatsapp: pairing started but not completed")
  })

  it("shows the pairing code with the phone steps and expiry note", async () => {
    const { code, run } = await harness({ target: "491234567890" })

    const text = await run("/relay pair whatsapp")

    expect(text).toContain("whatsapp pairing code: ABCD1234")
    expect(text).toContain("Linked devices")
    expect(text).toContain("expire")
    expect(text).not.toContain("restart")
    expect(code).toHaveBeenCalledWith("491234567890")
  })

  it("asks for whatsapp.target when no number is configured", async () => {    const { code, run } = await harness()

    const text = await run("/relay pair whatsapp")

    expect(text).toContain("whatsapp.target")
    expect(code).not.toHaveBeenCalled()
  })

  it("reports discord readiness and its setup steps without echoing the token", async () => {
    const token = "discord-secret-token"
    const ready = await harness({ env: { DISCORD_BOT_TOKEN: token }, discordChannel: "123" })
    const readyText = await ready.run("/relay pair discord")
    expect(readyText).toContain("token set, channel set")
    expect(readyText).not.toContain(token)

    const missing = await harness({ env: { DISCORD_BOT_TOKEN: token } })
    expect(await missing.run("/relay pair discord")).toContain("DISCORD_BOT_TOKEN")
  })

  it("reports a dm target in the readiness line", async () => {
    const h = await harness({ env: { DISCORD_BOT_TOKEN: "tok" }, discordDm: "u1" })

    const text = await h.run("/relay pair")

    expect(text).toContain("discord: token set, dm user set")
    expect(text).not.toContain("dm user missing")
  })

  it("allowlists an already-paired whatsapp number, so the chat is never locked out", async () => {
    const { deps, run } = await harness({ paired: true })

    const text = await run("/relay pair whatsapp")

    expect(text).toContain("already paired")
    expect(text).toContain("allowlisted 491234567890 in security.allowlist")
    const saved = JSON.parse(await readFile(deps.configPath, "utf8")) as { security: { allowlist: string[] } }
    expect(saved.security.allowlist).toEqual(["491234567890"])
  })

  it("allowlists the DM user of an already-linked discord", async () => {
    const { deps, run } = await harness({ env: { DISCORD_BOT_TOKEN: "tok" }, discordDm: "u1" })

    const text = await run("/relay pair discord")

    expect(text).toContain("nothing to do")
    expect(text).toContain("allowlisted u1 in security.allowlist")
    const saved = JSON.parse(await readFile(deps.configPath, "utf8")) as { security: { allowlist: string[] } }
    expect(saved.security.allowlist).toEqual(["u1"])
  })
})
