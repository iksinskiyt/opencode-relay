# Installation

Requires **Bun 1.x** and an OpenCode build with V2 plugin support. Commands below are PowerShell
(Windows); on macOS/Linux use the equivalent shell syntax.

## 1. Get the code

```powershell
git clone https://github.com/iksinskiyt/opencode-relay.git
Set-Location opencode-relay
bun install
```

## 2. Create the config

Config and state live in the plugin's data directory: `$env:XDG_DATA_HOME/opencode-relay/`, or
`~/.local/share/opencode-relay/` when that variable is unset.

```powershell
$data = Join-Path ($env:XDG_DATA_HOME ?? (Join-Path $HOME ".local\share")) "opencode-relay"
New-Item -ItemType Directory -Force $data | Out-Null
Copy-Item examples\config.example.json (Join-Path $data "config.json")
```

To smoke-test without any credentials, set `"whatsapp": { "enabled": false }` and
`"discord": { "enabled": false }`: with no live transport every envelope goes to the `mock` sink and
is logged instead of sent. The full key list is in [configuration.md](configuration.md).

`auth-state/` (credentials, batches, outbox) sits next to that `config.json`. Because both are
outside the checkout, one install serves every project and session: one WhatsApp pairing and one
Discord target cover all of them, and a `git pull` never touches them. A `config.json` left in the
checkout is copied there on the next start.

## 3. Load the plugin in OpenCode

Add the checkout to `plugins` in `opencode.jsonc` — global (`~/.config/opencode/opencode.jsonc`) or
project level — then restart OpenCode:

```jsonc
{
  "plugins": ["<path-to-the-checkout>"]
}
```

The plugin resolves its entrypoint from this package's `main`/`exports`, so point at the directory.

## 4. WhatsApp (QR pairing)

1. In `config.json`: `"provider": "whatsapp"`, `"whatsapp": { "enabled": true, "selfChat": true }`.
   `selfChat` posts into your own "Message yourself" chat; set `"selfChat": false` and
   `"whatsapp": { "target": "491234567890@s.whatsapp.net" }` to post elsewhere.
2. Start OpenCode. The plugin log prints a QR code.
3. On the phone: **WhatsApp -> Settings -> Linked devices -> Link a device**, scan it.
4. Credentials are stored in `auth-state/whatsapp/` and reused on the next start. `/relay pair
   whatsapp` also appends your number to `security.allowlist`, so your own chat can command the relay
   while unlisted senders stay dropped.

To unlink: `/relay unpair whatsapp` logs the device out on WhatsApp's side and deletes
`auth-state\whatsapp`. `bun bin/opencode-relay pair` prints the by-hand steps for a first link; it
never logs in by itself.

## 5. Discord (bot token)

1. Create a bot application in the Discord developer portal, copy its token, and invite the bot to
   your server.
2. Enable Developer Mode in Discord and copy the target channel ID.
3. Export the token for the process that runs OpenCode — never into `config.json`:

   ```powershell
   $env:DISCORD_BOT_TOKEN = "your-token"
   ```

4. In `config.json`: `"provider": "discord"`, `"discord": { "enabled": true, "target": "channel", "channelID": "123..." }` (or `"target": "dm"` with `"dmUserID"`; `/relay pair` can write either).

Prefer `/relay pair discord`: it checks the target live, posts a proof message, writes `config.json`
and appends the identity it proved to `security.allowlist` (the DM user ID). A channel pair proves no
user ID, so the notice asks you to add yours by hand — the relay is fail-closed and drops unlisted
senders.

Messages go out over the Discord REST API. Inbound arrives over the gateway websocket: `/relay`
registers as a slash command on connect (add the bot with the `applications.commands` scope), button
clicks answer permission prompts, and typed messages reach the relay too. If the socket cannot be
kept, the relay falls back to polling every 15s and keeps reconnecting with backoff. `discord.buttons`
forces the button row off. The `MESSAGE_CONTENT` intent is required for typed messages in a server
channel: enable it under Developer Portal → Bot → Privileged Gateway Intents.

To unlink: `/relay unpair discord` clears `discord.target`/`channelID`/`dmUserID`, turns
`discord.enabled` off and deletes `auth-state/discord.json`; the bot token stays in
`DISCORD_BOT_TOKEN` and the bot stays in the server (remove it in Discord if wanted).

## 6. CLI

Runs from anywhere: it resolves the data directory itself, so it looks at the same `config.json` and
`auth-state/` the plugin uses.

```powershell
bun bin/opencode-relay status    # config.json + auth-state presence
bun bin/opencode-relay doctor    # Bun, Baileys import, config schema, Discord token presence (no network)
bun bin/opencode-relay pair      # WhatsApp QR instructions
bun bin/opencode-relay config    # current preset / mode / categories
```

`bun link` puts `opencode-relay` on PATH, so the commands can drop the `bun bin/` prefix.

## 7. Verify

```powershell
bun run lint
bun run test
```
