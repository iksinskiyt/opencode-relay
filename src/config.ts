import { readFile, rename, writeFile } from "node:fs/promises"
import { z } from "zod"

export const configSchema = z.object({
  enabled: z.boolean().default(true),
  provider: z.string().default("whatsapp"),
  notifications: z
    .object({
      preset: z.enum(["all", "important", "completion"]).default("all"),
      /** Only root sessions notify: a subagent's child session stays quiet. */
      orchestratorOnly: z.boolean().default(true),
      categories: z
        .object({
          passCompleted: z.boolean().default(true),
          taskCompleted: z.boolean().default(true),
          questions: z.boolean().default(true),
          permissions: z.boolean().default(true),
          errors: z.boolean().default(true),
          sessionStarted: z.boolean().default(false),
          sessionInterrupted: z.boolean().default(true),
          /** Hand-sent images and outbox pickups; on by default like the rest. */
          message: z.boolean().default(true),
        })
        .default({}),
      passes: z
        .object({
          mode: z.enum(["immediate", "batch", "final_only"]).default("batch"),
          debounceSeconds: z.number().int().positive().default(120),
          maxWaitSeconds: z.number().int().positive().default(600),
        })
        .default({}),
    })
    .default({}),
  aiProcessing: z.object({
    enabled: z.boolean().default(true),
    model: z.object({ providerID: z.string(), modelID: z.string() }),
  }),
  whatsapp: z
    .object({
      enabled: z.boolean().default(true),
      /** Post notifications into your own "Message yourself" chat. */
      selfChat: z.boolean().default(true),
      /** Target JID when selfChat is off, e.g. `491234567890@s.whatsapp.net`. */
      target: z.string().optional(),
    })
    .default({}),
  discord: z
    .object({
      enabled: z.boolean().default(false),
      /** Where the bot talks: a server channel, or the DM it opens with `dmUserID`. */
      target: z.enum(["channel", "dm"]).default("channel"),
      /** Channel the bot posts into when target is "channel". */
      channelID: z.string().optional(),
      /** User whose DM the bot opens when target is "dm"; the channel is resolved and cached. */
      dmUserID: z.string().optional(),
      /** Force the Allow/Always/Reject row off; the gateway renders it while it is connected. */
      buttons: z.boolean().default(false),
      /** OAuth2 permission integer `/relay invite` puts in the install URL; unset means the minimal send/read set. */
      permissions: z.string().optional(),
    })
    .default({}),
  security: z
    .object({
      pairingRequired: z.boolean().default(true),
      allowUnpairedUsers: z.boolean().default(false),
      /** Paired senders: full JIDs or bare phone numbers in international format, or Discord user IDs. */
      allowlist: z.array(z.string()).default([]),
      /** Extra roots `relay_send_image` and `/relay send` may read from; the install and project always are. */
      imageRoots: z.array(z.string()).default([]),
      /** Off by default: a URL in an image field is refused, so the relay cannot fetch a local address. */
      allowImageUrls: z.boolean().default(false),
    })
    .default({}),
})

export type Config = z.infer<typeof configSchema>

export async function loadConfig(path: string): Promise<Config> {
  return configSchema.parse(JSON.parse(await readFile(path, "utf8")))
}

/** One serialised chain per file: two commands writing at once must not drop each other's change. */
const writes = new Map<string, Promise<unknown>>()

/**
 * The only way this project writes config.json: read, change, then tmp+rename so a crash cannot
 * truncate the live file. Every command and pairing flip goes through here.
 */
export function updateConfig<T>(path: string, change: (config: Config) => T | Promise<T>): Promise<T> {
  const previous = writes.get(path) ?? Promise.resolve()
  const next = previous.then(async () => {
    const config = await loadConfig(path)
    const result = await change(config)
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8")
    await rename(tmp, path)
    return result
  })
  // a failed update must not poison the next one
  writes.set(path, next.catch(() => undefined))
  return next
}

/** `/relay group`: route outbound into that group from now on, and after a restart. */
export async function setWhatsappTarget(path: string, jid: string): Promise<void> {
  await updateConfig(path, (config) => {
    config.whatsapp = { ...config.whatsapp, selfChat: false, target: jid }
  })
}

/** `/relay unpair whatsapp`: stop connecting until `/relay pair whatsapp` links a device again. */
export async function disableWhatsapp(path: string): Promise<void> {
  await updateConfig(path, (config) => {
    config.whatsapp = { ...config.whatsapp, enabled: false }
  })
}

/** `/relay unpair discord`: drop the target so nothing posts; the token stays in the environment. */
export async function clearDiscordTarget(path: string): Promise<void> {
  await updateConfig(path, (config) => {
    config.discord = {
      enabled: false,
      target: "channel",
      buttons: config.discord.buttons,
      // an install URL built once stays useful after an unpair
      ...(config.discord.permissions === undefined ? {} : { permissions: config.discord.permissions }),
    }
  })
}

/** `/relay pair discord`: turn the transport on and record the target the live check accepted. */
export async function setDiscordTarget(path: string, target: "channel" | "dm", id: string): Promise<void> {
  await updateConfig(path, (config) => {
    config.discord = {
      ...config.discord,
      enabled: true,
      target,
      ...(target === "dm" ? { dmUserID: id } : { channelID: id }),
    }
  })
}

/**
 * A successful pair writes the identity it proved into the allowlist, so a fail-closed relay never
 * locks the user out of their own chat. Editing `security.allowlist` by hand still works.
 */
export async function addToAllowlist(path: string, id: string): Promise<boolean> {
  return updateConfig(path, (config) => {
    if (id === "" || config.security.allowlist.includes(id)) return false
    config.security.allowlist = [...config.security.allowlist, id]
    return true
  })
}
