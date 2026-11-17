import { isAbsolute, resolve } from "node:path"
import type { Info } from "@opencode/plugin/promise/tool"

/** Plain JSON Schema is one of the accepted `Tool.ValueSchema` forms: no schema library needed. */
const INPUT = {
  type: "object",
  properties: {
    path: { type: "string", description: "Image file: absolute, or relative to the project directory" },
    caption: { type: "string", description: "Message text sent with the image" },
    chat: { type: "string", description: "Destination chat; currently every live transport gets the image" },
  },
  required: ["path"],
  additionalProperties: false,
} as const

export interface ToolDeps {
  /** Project directory: a relative path resolves against it, not the host process's cwd. */
  root: string
  /** The same sender `/relay send` uses: validates the file, fans out, answers with the text to report. */
  image: (input: { path: string; caption?: string; sessionID?: string }) => Promise<string>
}

/** Plain JSON Schema for the `relay` tool: the words after "relay". */
const COMMAND_INPUT = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: 'The words after "relay", without a leading slash: "status", "sessions", "pair whatsapp"',
    },
  },
  required: ["command"],
  additionalProperties: false,
} as const

export interface RelayToolDeps {
  /** The same `/relay` dispatcher the chat command runs: subcommands, answers and usage text stay in step. */
  command: (text: string, sessionID?: string) => Promise<string>
}

const text = (content: string): { content: string } => ({ content })

/**
 * `relay_send_image`: the agent sends a file the user asked for ("send me this screenshot").
 * An explicit request, so it is not filtered by the notification preset or orchestratorOnly.
 */
export function createTool(deps: ToolDeps): Info {
  return {
    name: "relay_send_image",
    // the rule is in the description because a model that reads the file without calling this
    // reports a send that never happened
    description:
      'Send an image file from this machine (screenshot, chart, photo) to the user\'s paired WhatsApp/Discord chats on their phone. Use it whenever the user asks to send, relay or share images: "send me the screenshots", "relay this to my phone", "share on WhatsApp/Discord". Reading the file is not sending it: never claim an image was sent unless this tool was called and said so. Only png, jpg, jpeg, gif and webp up to 8 MB are accepted.',
    input: INPUT,
    execute: async (input, context) => {
      const { path, caption, chat } = (input ?? {}) as { path?: unknown; caption?: unknown; chat?: unknown }
      if (typeof path !== "string" || path.trim() === "") return text("relay_send_image: path is required")
      try {
        const sent = await deps.image({
          // a relative path is a repo path: the host's cwd is not the project's
          path: isAbsolute(path) ? path : resolve(deps.root, path),
          ...(typeof caption === "string" && caption.trim() !== "" ? { caption } : {}),
          sessionID: String(context.sessionID),
        })
        return text(chat === undefined ? sent : `${sent} (chat targeting is not wired yet)`)
      } catch (error) {
        // the loader's message names the file and the reason: report it, never the internals
        return text(`image not sent: ${(error as Error).message}`)
      }
    },
  }
}

/**
 * `relay`: the agent runs a `/relay` subcommand instead of reading the repo to answer "relay status".
 * The rule lives in the description because a model that shells out for relay state never sees the
 * live one: transports, gateway and pairing only exist inside this plugin.
 */
export function createRelayTool(deps: RelayToolDeps): Info {
  return {
    name: "relay",
    description:
      'Run a relay command and return its answer: the same /relay subcommands the user types (status, sessions, select, notifications, model, pair, unpair, invite, group, send, help). Use it for any relay request, with or without a leading slash: "relay status", "/relay sessions", "pair whatsapp", "is the relay up", "which session is selected". Call this tool instead of exploring the repo, grepping for relay code or running shell commands to find relay state: the live transport, gateway and pairing state exists only inside the plugin, so this tool is the only answer. `command` is the words after "relay", e.g. "status" or "pair whatsapp".',
    input: COMMAND_INPUT,
    execute: async (input, context) => {
      const { command } = (input ?? {}) as { command?: unknown }
      // tolerate "relay status" and "/relay status": the words after "relay" reach the dispatcher
      const words = typeof command === "string" ? command.trim().replace(/^\/?relay\b/i, "").trim() : ""
      try {
        return text(await deps.command(words, String(context.sessionID)))
      } catch (error) {
        return text(`relay: ${(error as Error).message}`)
      }
    },
  }
}
