# opencode-relay

Drive your OpenCode sessions from WhatsApp or Discord — and answer them from your phone.

`opencode-relay` is an **OpenCode plugin**, not a separate app: it lives inside the plugin host you
already run, watches the sessions, and relays what is happening to a chat you can actually reply to.
Notifications go out; your answers come back in as form replies, permission decisions and prompts.
Think *Grokbot meets TeamViewer, baked into OpenCode* — pair once, then leave the desk.

````text
🤖 Relay · fix the login redirect
Session 'fix the login redirect' finished a pass

summary: narrowed it to the auth callback; fixed and tested.

```
Renamed the callback route, updated the three callers, ran `bun run test` (42 passed).
...
```
````

That first line is the point: one chat can carry several sessions, and every message names its own.

## What it does

- **Notifications** for pass completions, task completions, questions, permission requests, errors,
  interrupts and (opt-in) session starts — with the assistant's own response text, in full.
- **Two-way answers**: a form question or permission prompt arrives in chat; reply `1: main`, `a`,
  `always`, or plain free text and it lands in the session. The TUI and the phone share one state.
- **Both transports at once**: WhatsApp (self-chat or a dedicated group) and Discord (channel or DM),
  each with its own retry queue. One failing never blocks the other.
- **Sessions on demand**: `/relay sessions`, `/relay select`, then just type - the message is
  forwarded to that session.
- **Images either way**: `/relay send <path> [caption]`, or drop a png/jpg in `auth-state/outbox/`
  and the next tick sends it - Discord as an attachment, WhatsApp as an image message.
- **AI on top, optional**: a short `summary:` above the full text, never instead of it.

On-call features (rotation, escalation, quiet hours) are the direction of travel, not shipped code.

## Quickstart

Requires **Bun** and an OpenCode install that loads plugins from the project directory.

```powershell
bun install
$data = Join-Path ($env:XDG_DATA_HOME ?? (Join-Path $HOME ".local\share")) "opencode-relay"
New-Item -ItemType Directory -Force $data | Out-Null
Copy-Item examples\config.example.json (Join-Path $data "config.json")   # then fill in placeholders
bun run build                                        # the host loads dist/, not src/
bun bin/opencode-relay doctor                         # environment + config check
```

Config and state live in that data directory (`auth-state/` next to `config.json`), never in the
checkout, so updating the plugin leaves the pairings alone.

Then, inside OpenCode:

```text
/relay pair            # pick WhatsApp or Discord and answer the form
/relay status          # what is live, what is pending
/relay sessions        # recent sessions, numbered
/relay select 2        # prompts and answers go to session 2
```

A successful pair writes its own identity to `security.allowlist` and says so, so a fail-closed relay
does not lock you out. WhatsApp needs a real number (Baileys; read the ToS risk first — see
[docs/security.md](docs/security.md)); Discord needs `DISCORD_BOT_TOKEN` in the environment, never in
`config.json`.

**Every source change needs `bun run build`.** A missing or stale build is the usual cause of a dead
relay; the plugin logs a `stale build` warning when it notices one.

## Commands

The same subcommands work typed in the TUI and over the transport; Discord also exposes them as a
native slash command with descriptions, required flags and choices.

| Command | What it does |
| --- | --- |
| `/relay status` | provider, transports, preset, mode, enabled categories, pending batches |
| `/relay sessions` | recent sessions as a numbered list |
| `/relay select <number\|sessionID>` | session that prompts and answers go to |
| `/relay notifications [category on\|off] [mode immediate\|batch\|final_only] [preset all\|important\|completion]` | what notifies, and how it is delivered |
| `/relay model [providerID modelID]` | model that writes the `summary:` line |
| `/relay pair [whatsapp\|discord]` | link a transport through a form |
| `/relay unpair [whatsapp\|discord]` | log out and drop that transport's credentials or target |
| `/relay group` | create or reuse the WhatsApp group notifications go to |
| `/relay send <path> [caption]` | send one image file (png/jpg/jpeg/gif/webp) to the link |
| `/relay help` | every subcommand plus current values |

CLI, for the terminal: `opencode-relay status | doctor | pair | config`. The details, including the
form-answer rules and the server discovery, are in [docs/configuration.md](docs/configuration.md).

## Configuration

One `config.json` in the plugin's data directory (`$XDG_DATA_HOME/opencode-relay/`, else
`~/.local/share/opencode-relay/`), validated with zod. `examples/config.example.json` is the
annotated starting point; the full key table lives in
[docs/configuration.md](docs/configuration.md). In short:

```jsonc
{
  "provider": "whatsapp",              // default transport name, reported by /relay status
  "notifications": { "preset": "all", "passes": { "mode": "batch" } },
  "aiProcessing": { "enabled": true, "model": { "providerID": "", "modelID": "" } },
  "whatsapp": { "enabled": true, "selfChat": true },
  "discord": { "enabled": false, "target": "dm", "dmUserID": "" },
  "security": { "pairingRequired": true, "allowlist": [], "allowImageUrls": false }
}
```

State is the filesystem (`auth-state/` there: WhatsApp credentials, batches, the correlation table,
retry queues, dedupe). No daemon, no Docker, no database — the plugin host owns the lifecycle.

## Architecture

`ctx.event.subscribe` → `notify.ts` (`reduce`: event → envelope) → batching → optional AI summary →
`router.ts` (fan out to every live transport) → provider (`whatsapp.ts`, `discord.ts`). Inbound is the
same path backwards: provider → `interactions/inbound.ts` (command, prompt reply, form/permission) →
the plugin host or the local server. One envelope, one router, pluggable transports: adding a
transport changes no routing code.

Normative behaviour — envelope, delivery guarantees, failure modes — lives in
[docs/relay-spec.md](docs/relay-spec.md).

## Status

v0.1.0. `bun run test` covers the envelope, routing, batching, both providers' send paths, the
Discord gateway, correlation, pairing and the form/permission answer paths. Not yet proven end to
end against live services: a real WhatsApp QR link, a real Discord bot in a real server, form replies
against a running OpenCode server, and the AI summary call. [TESTING.md](TESTING.md) lists what to
exercise by hand.

## Docs

- [Installation](docs/installation.md) — Bun, plugin wiring, QR pairing, Discord token
- [Configuration](docs/configuration.md) — presets, categories, modes, `/relay` commands
- [Security](docs/security.md) — pairing allowlist, secrets, Baileys/ToS risk, revocation
- [Relay spec](docs/relay-spec.md) — pointer to the normative brief
- [Testing](TESTING.md) — mock-mode setup, gates, switching to live transports

## Contributing

Bug reports and patches welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The short version: `bun run
build && bun run lint && bun run test` must be green, one focused change per pull request, and no
secrets in the tree.

## License

MIT — see [LICENSE](LICENSE).

Made with love by a clanker <3
