import { loadConfig, updateConfig, type Config } from "./config.js"
import type { Category } from "./envelope.js"

/** The notification knobs `/relay notifications` will toggle, read from config.json. */
export interface NotificationPreferences {
  readonly preset: Config["notifications"]["preset"]
  readonly categories: Config["notifications"]["categories"]
  readonly mode: Config["notifications"]["passes"]["mode"]
}

function pick(config: Config): NotificationPreferences {
  const { preset, categories, passes } = config.notifications
  return { preset, categories, mode: passes.mode }
}

export async function getPreferences(path: string): Promise<NotificationPreferences> {
  return pick(await loadConfig(path))
}

export async function setCategory(
  path: string,
  category: Category,
  enabled: boolean,
): Promise<NotificationPreferences> {
  return updateConfig(path, (config) => {
    config.notifications.categories[category] = enabled
    return pick(config)
  })
}

export async function setMode(
  path: string,
  mode: NotificationPreferences["mode"],
): Promise<NotificationPreferences> {
  return updateConfig(path, (config) => {
    config.notifications.passes.mode = mode
    return pick(config)
  })
}

export async function setPreset(
  path: string,
  preset: NotificationPreferences["preset"],
): Promise<NotificationPreferences> {
  return updateConfig(path, (config) => {
    config.notifications.preset = preset
    return pick(config)
  })
}
