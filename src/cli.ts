import { existsSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "./config.js"
import { discordToken } from "./env.js"
import { CATEGORIES } from "./envelope.js"
import { linkState } from "./pairing.js"
import { resolvePaths } from "./paths.js"
import { getPreferences } from "./preferences.js"
import { gatewayState } from "./providers/discord.js"
import { closeHint } from "./providers/discord-gateway.js"

/** Same resolution as the plugin: the data dir, not the shell's cwd. Running it may migrate. */
const paths = resolvePaths(process.cwd())
const configPath = paths.configPath
const authDir = paths.dataDir
const whatsappDir = join(authDir, "whatsapp")
if (paths.migrated !== undefined) {
  console.log(`copied ${paths.migrated} (and its auth-state) to ${configPath}; delete the old copy`)
}

const USAGE = "usage: opencode-relay <status|doctor|pair|config>"

async function status(): Promise<void> {
  let line = `missing (copy examples/config.example.json to ${configPath})`
  if (existsSync(configPath)) {
    try {
      const config = await loadConfig(configPath)
      line = `ok (provider: ${config.provider}, enabled: ${config.enabled})`
    } catch (error) {
      line = `invalid: ${(error as Error).message}`
    }
  }
  console.log(`config.json     ${line}`)
  console.log(`auth-state/     ${existsSync(authDir) ? "present" : "missing (created on first run)"}`)
  const link = linkState(whatsappDir)
  console.log(
    `whatsapp creds  ${
      link === "linked"
        ? "present (paired)"
        : link === "started"
          ? "present (pairing started, not completed: run /relay pair)"
          : "missing (see: pair)"
    }`,
  )
  console.log(`pending batches ${existsSync(join(authDir, "batches.json")) ? "present" : "none"}`)
}

async function doctor(): Promise<void> {
  let failed = false
  const report = (ok: boolean, label: string, detail: string): void => {
    if (!ok) failed = true
    console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(13)} ${detail}`)
  }

  const bun = (process.versions as Record<string, string | undefined>).bun
  report(bun !== undefined && Number.parseInt(bun, 10) >= 1, "bun", bun ?? "not running under Bun")

  try {
    await import("@whiskeysockets/baileys")
    report(true, "baileys", "imports")
  } catch (error) {
    report(false, "baileys", `import failed: ${(error as Error).message}`)
  }

  let needsToken = false
  try {
    const config = await loadConfig(configPath)
    needsToken = config.provider === "discord" && config.discord.enabled
    report(true, "config.json", "parses against the schema")
  } catch (error) {
    report(false, "config.json", (error as Error).message)
  }

  const { value: token, source: tokenSource } = discordToken()
  const hasToken = token !== undefined
  report(
    hasToken || !needsToken,
    "discord token",
    hasToken
      ? `DISCORD_BOT_TOKEN from ${tokenSource} (not verified, no network)`
      : needsToken
        ? "token missing: set DISCORD_BOT_TOKEN with setx, then restart OpenCode"
        : "not set (provider is not discord)",
  )

  // written by the plugin process: without it a polling-only transport has no visible reason
  const gateway = await gatewayState(authDir)
  if (gateway !== undefined) {
    const when = gateway.at.slice(0, 16).replace("T", " ")
    report(
      true,
      "gateway",
      gateway.close === undefined
        ? `up at ${when} (last READY)`
        : `down since ${when}: closed ${closeHint(gateway.close)}`,
    )
  }

  if (failed) process.exitCode = 1
}

function pair(): void {
  if (linkState(whatsappDir) === "linked") {
    console.log(`already paired: ${whatsappDir}`)
    console.log("to re-pair, stop OpenCode, delete that folder and start it again")
    return
  }
  if (linkState(whatsappDir) === "started") {
    console.log(`pairing started but not completed: ${whatsappDir}`)
    console.log("run /relay pair whatsapp for a fresh code and enter it on the phone fast")
    return
  }
  console.log("WhatsApp pairing (this CLI never logs in, the plugin renders the QR):")
  console.log('1. config.json: "provider": "whatsapp" with whatsapp.enabled true (selfChat posts to your own chat)')
  console.log("2. Start OpenCode with the plugin loaded (docs/installation.md).")
  console.log("3. The plugin log shows a QR: WhatsApp > Settings > Linked devices > Link a device.")
  console.log(`4. Creds land in ${whatsappDir} and are reused on the next start.`)
  console.log("   To re-pair: stop OpenCode, delete that folder, start again.")
}

async function config(): Promise<void> {
  if (!existsSync(configPath)) {
    console.error(`no config.json at ${configPath}: copy examples/config.example.json first`)
    process.exitCode = 1
    return
  }
  const prefs = await getPreferences(configPath)
  const on = CATEGORIES.filter((category) => prefs.categories[category])
  const off = CATEGORIES.filter((category) => !prefs.categories[category])
  console.log(`preset: ${prefs.preset}`)
  console.log(`mode:   ${prefs.mode}`)
  console.log(`on:     ${on.join(", ") || "none"}`)
  console.log(`off:    ${off.join(", ") || "none"}`)
  if (prefs.preset !== "all") console.log('note: the preset overrides the category list until preset is "all"')
}

const commands: Readonly<Record<string, () => void | Promise<void>>> = { status, doctor, pair, config }
const command = process.argv[2]
const run = command === undefined ? undefined : commands[command]
if (run === undefined) {
  console.log(USAGE)
  process.exitCode = command === undefined ? 0 : 2
} else {
  await run()
}
