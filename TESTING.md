# Testing locally

Mock mode is the no-credential local setup: the plugin loads, every envelope goes to the `mock` sink
and is logged, and nothing leaves the machine. No account, token or QR code needed.

## Setup

```powershell
bun install
# start from the example, then turn both transports off for mock mode
$data = Join-Path ($env:XDG_DATA_HOME ?? (Join-Path $HOME ".local\share")) "opencode-relay"
New-Item -ItemType Directory -Force $data | Out-Null
Copy-Item examples\config.example.json (Join-Path $data "config.json")
```

```jsonc
{
  "whatsapp": { "enabled": false },
  "discord":  { "enabled": false }
}
```

`config.provider` is only a label for `/relay status`; the `enabled` flags decide what runs. When no
transport is live, the `mock` sink takes over automatically.

## Gates

```powershell
bun run build   # tsc emit
bun run lint    # tsc --noEmit over src/
bun run test    # vitest: providers, correlation, forms, unpair, batching, retry, dedupe, AI, inbound
```

Images, without a phone: `/relay send <path> [caption]`, or drop a png/jpg in `auth-state/outbox/`
and wait one tick. Both paths are covered by the tests with stubbed transports (no network).

## Doctor and CLI

```powershell
bun run ./src/cli.ts doctor      # Bun, Baileys import, config schema, Discord token (no network)
bun run ./src/cli.ts status      # data-dir config.json + auth-state + pending batches
bun run ./src/cli.ts config      # preset, mode, enabled categories
```

## Mock-mode plugin load

Add the checkout to `plugins` in `opencode.jsonc` (global or project), restart OpenCode, and the
envelopes are logged instead of sent:

```jsonc
{ "plugins": ["<path-to-the-checkout>"] }
```

## Switching to live transports

WhatsApp (needs a phone):

1. `config.json`: `"provider": "whatsapp"`, `"whatsapp": { "enabled": true, "selfChat": true }`.
2. Start OpenCode, scan the QR from **WhatsApp -> Linked devices**.
3. Credentials land in `auth-state/whatsapp/`. Unverified: no real pairing was done here.
4. To unlink: `/relay unpair whatsapp` (server-side logout + local delete) and check the phone's
   Linked devices list no longer shows the relay.

Discord (needs a bot token, plus a channel ID or a user ID for DMs):

1. `$env:DISCORD_BOT_TOKEN = "..."` for the process that runs OpenCode (never in `config.json`).
2. `config.json`: `"provider": "discord"`, `"discord": { "enabled": true, "target": "channel", "channelID": "123..." }`
   (or `"target": "dm"` with `"dmUserID"`). `/relay pair` → Discord links either mode from a form: it
   checks the pick against the API and posts `Relay linked — say hi here` into it.
3. Inbound arrives over the gateway: type answers in the channel or DM, run `/relay` as a slash
   command (registered on connect), and click Allow/Always/Reject on permission prompts.
   `discord.buttons` forces that row off. If the socket cannot stay up, the relay logs it, polls
   every 15s instead, and reconnects with backoff; `/relay status` shows `discord: live (gateway)`
   or `discord: live (polling)`.
4. To unlink: `/relay unpair discord` clears the target and the DM cache; the bot token stays in the
   environment, and the bot remains in the server until removed in Discord.

Unverified live paths: WhatsApp QR pairing/delivery, Discord gateway/slash-command registration
against the real API, form replies against a live local server, and the AI summary call. The form
routes themselves are verified against `@opencode/protocol`; the tests drive them with a stub server.

Answering a form from chat: the question message lists every field and its options. Reply once for a
single field (option letter, label or value is accepted), with `1: <answer>` lines for several, or
`cancel`. Text that matches no option is sent as typed, and `Other: <text>` forces that even when the
text looks like an option; only a boolean or a number field refuses prose, and the reply then says how
to retry. After 15 minutes the form expires and the relay says so instead of forwarding the answer. A
form answered in the TUI settles its chat prompt at once, and an answer that still hits a dead form is
answered "already answered or cancelled elsewhere" instead of an HTTP error.

Notifications carry the assistant's full response text (the transports split long messages), with a
`summary:` line above it when `aiProcessing` names a model.

The form paths find the server at runtime: `OPENCODE_SERVER_URL` from the environment first, then the
registration file the server writes (`$env:XDG_STATE_HOME` or `$HOME\.local\state`, then
`opencode\service.json`), which carries the current ephemeral port and password. Only when that file
is missing or stale are `127.0.0.1:4096` and `127.0.0.1:28894` probed, one second each, in parallel.
To pin a server by hand: `$env:OPENCODE_SERVER_URL = "http://127.0.0.1:28894"` before starting
OpenCode; with no server found the relay answers in chat telling you to set it.

## State written while testing

`auth-state/` in the data directory (git-ignored, never in the checkout): `batches.json`, `interactions.json`, `dedupe.json`,
`retry-<transport>.json`, `selected.json`, `sessions.json`, `discord.json` (DM channel cache),
`outbox/` (+ `outbox/sent/`, image pickup), `whatsapp/` (device creds). Delete the folder to reset
everything; `whatsapp/` is the only part that needs a re-pair. `/relay unpair whatsapp|discord`
removes the transport's own part without touching the rest.
