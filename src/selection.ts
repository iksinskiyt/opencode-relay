import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

/** Chosen session, shared by the TUI command host and the transport (serve) host. */
export const SELECTED_FILE = "selected.json"
/** Last `/relay sessions` listing, so a number means the same thing in both hosts. */
export const SESSIONS_FILE = "sessions.json"

export interface ListedSession {
  readonly id?: string | undefined
  readonly title?: string | undefined
}

/** Both hosts derive the state root from their `config.json`, so they read the same files. */
export function authStateDir(configPath: string): string {
  return join(dirname(configPath), "auth-state")
}

/** The last `/relay select`, from disk; a missing or unreadable file means "nothing selected". */
export async function loadSelected(configPath: string): Promise<string | undefined> {
  const raw = await readJson(configPath, SELECTED_FILE)
  if (typeof raw !== "object" || raw === null) return undefined
  const { sessionID } = raw as { sessionID?: unknown }
  return typeof sessionID === "string" && sessionID !== "" ? sessionID : undefined
}

export async function saveSelected(configPath: string, sessionID: string): Promise<void> {
  await writeJsonAtomic(configPath, SELECTED_FILE, { sessionID, at: Date.now() })
}

/** Sessions the last listing printed, in its order; undefined when there is no usable file. */
export async function loadListing(configPath: string): Promise<ListedSession[] | undefined> {
  const raw = await readJson(configPath, SESSIONS_FILE)
  if (typeof raw !== "object" || raw === null) return undefined
  const { sessions } = raw as { sessions?: unknown }
  if (!Array.isArray(sessions)) return undefined
  const listed = sessions.filter(isListed)
  return listed.length === 0 ? undefined : listed
}

/** Best effort: a failed write only means a number falls back to the host's fresh order. */
export async function saveListing(configPath: string, sessions: readonly ListedSession[]): Promise<void> {
  try {
    await writeJsonAtomic(configPath, SESSIONS_FILE, { at: Date.now(), sessions })
  } catch {
    // no log here; the listing itself is still the answer
  }
}

async function readJson(configPath: string, name: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(authStateDir(configPath), name), "utf8")) as unknown
  } catch {
    return undefined
  }
}

/** tmp+rename like batch-store, but with the pid in the name so two hosts cannot share a temp file. */
async function writeJsonAtomic(configPath: string, name: string, value: unknown): Promise<void> {
  const dir = authStateDir(configPath)
  await mkdir(dir, { recursive: true })
  const file = join(dir, name)
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await rename(tmp, file)
}

function isListed(value: unknown): value is ListedSession {
  if (typeof value !== "object" || value === null) return false
  const { id, title } = value as { id?: unknown; title?: unknown }
  return typeof id === "string" && id !== "" && (title === undefined || typeof title === "string")
}
