import type { CommandDefinition } from "@opencode/plugin/promise/command"
import type { ModelRef } from "./ai.js"
import type { TransportStatus } from "./envelope.js"
import type { CorrelationStore } from "./interactions/correlation.js"
import { relayCommand, type GroupResult, type PairingDeps, type SessionInfo } from "./interactions/inbound.js"

export interface CommandDeps {
  /** config.json, for /relay notifications and status. */
  configPath: string
  /** Transport name, reported by /relay status. */
  provider: string
  /** Every configured transport, reported by /relay status. */
  transports?: readonly TransportStatus[]
  /** Session picked with /relay select, shared with inbound prompt replies. */
  selected: { sessionID?: string }
  /** Recent sessions from the plugin host (`ctx.session.list`). */
  sessions: () => Promise<SessionInfo[]>
  /** Models from the plugin host (`ctx.model.list`), for /relay model. */
  models?: () => Promise<ModelRef[]>
  /** Pending pass batches, from the batcher snapshot. */
  pending: () => { sessions: number; items: number }
  /** /relay pair: auth-state location and the live WhatsApp socket. */
  pairing?: PairingDeps
  /** /relay group: creates or reuses the transport group and persists it as the target. */
  group?: () => Promise<GroupResult>
  /** ctx.session.prompt: forwards a plain inbound message into a session. */
  prompt?: (input: { sessionID: string; text: string }) => Promise<void>
  /** Correlation store and local server for the interactive pair popup. */
  store?: CorrelationStore
  serverURL?: string
  fetchImpl?: typeof fetch
  /** `/relay send`: posts one image to every live transport. */
  image?: (input: { path: string; caption?: string }) => Promise<string>
  /** Where the answer goes: the invoking session. */
  reply: (message: RelayReply) => Promise<void>
}

/** Static notice for the invoking session; the TUI renders `description` only. */
export interface RelayReply {
  sessionID: string
  text: string
  description: string
}

/** `/relay` as a chat command: the WhatsApp handlers, answered inside the invoking session. */
export function createCommand(deps: CommandDeps): CommandDefinition {
  return {
    name: "relay",
    description: "Relay status, sessions and notification settings",
    execute: async (input) => {
      let text: string
      try {
        text = await relayCommand(input.prompt.text, deps, String(input.sessionID))
      } catch (error) {
        text = `relay: ${(error as Error).message}`
      }
      await deps.reply({ sessionID: String(input.sessionID), text, description: text })
    },
  }
}
