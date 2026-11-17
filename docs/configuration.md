# Configuration

`config.json` lives in the plugin's data directory — `XDG_DATA_HOME/opencode-relay/`, or
`~/.local/share/opencode-relay/` when that is unset (the same rule OpenCode itself follows) — not in
the project you open, and is validated with zod ([`src/config.ts`](../src/config.ts)); missing keys
take the defaults below. One install therefore serves every project and session: one WhatsApp
pairing and one Discord target cover all of them, and `auth-state/` (credentials, batches, outbox,
selections) sits there too. [`examples/config.example.json`](../examples/config.example.json) is a
complete starting point.

A `config.json` left beside the plugin (or in a project directory) is copied into the data
directory on the next start, together with its `auth-state/`; the log line names the copy that was
moved, and the old files can be deleted once the relay runs.

## Top level

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` disables the relay at setup |
| `provider` | `"whatsapp"` | default label for explicit sends and `/relay status`; live transports follow the `enabled` flags below |

Every transport with `enabled: true` runs at the same time: outbound messages fan out to all of
them, and inbound commands are answered from whichever one receives them. A transport that is
enabled but cannot resolve its credentials is skipped and reported by `/relay status`; when no
transport is live, `mock` logs every envelope. `/relay status` lists each transport as `live`,
`mocked` or `disabled` with the reason.

## `notifications`

| Key | Default | Meaning |
| --- | --- | --- |
| `preset` | `"all"` | `all`, `important` or `completion` |
| `orchestratorOnly` | `true` | only root sessions notify; a subagent's child session stays quiet |
| `categories.<name>` | see below | used only when `preset` is `all` |
| `passes.mode` | `"batch"` | `immediate`, `batch` or `final_only` |
| `passes.debounceSeconds` | `120` | quiet period that ends a batch |
| `passes.maxWaitSeconds` | `600` | longest a batch can stay open |

Categories and the events behind them:

| Category | Events |
| --- | --- |
| `passCompleted` | `session.step.ended`, `session.text.ended` |
| `taskCompleted` | `session.idle` |
| `questions` | `form.created` |
| `permissions` | `permission.asked` |
| `errors` | `session.execution.failed`, `session.step.failed` |
| `sessionStarted` | `session.created` |
| `sessionInterrupted` | `session.execution.interrupted` |
| `message` | none: hand-sent images and outbox pickups (`/relay send`) |

Category defaults: all `true` except `sessionStarted`. Presets override the category map:
`important` = questions, permissions, errors, taskCompleted, sessionInterrupted;
`completion` = questions, permissions, errors, taskCompleted.

`orchestratorOnly` (default `true`) drops events from child sessions: the subagents an orchestrator
spawns no longer notify, only the orchestrator's own session does. The parent comes from
`session.created` (it carries `parentID`) or `ctx.session.get`, cached per session. Set it to
`false` to notify for every session again. If the parent lookup fails the event relays — losing the
orchestrator's own notice is the worse mistake.

Every message the relay sends — notification, command answer, form/permission answer, forwarded
prompt acknowledgement — starts with `🤖 Relay · <session title>` (just `🤖 Relay` when no session is
involved, and the session ID when the session has no title yet). A linked WhatsApp device renders all
of its own sends on the right, so the identity line is what makes several sessions readable in one
chat. After it: what happened, then the content.

Pass modes: `immediate` sends each pass at once, `batch` merges a session's passes into one message
after the debounce, `final_only` holds them until a completion/question/permission event flushes
the batch. Pending batches are written to `auth-state/batches.json` and restored on the next start,
so a restart does not drop them.

A pass notification carries the assistant's own response text (`session.text.ended`) in full, in a
code block, so the message says what the pass produced and not only that it ended. Nothing is
truncated: both transports split a long message themselves (Discord at 2000 characters with the code
fence kept valid, WhatsApp at 64 KiB by line). With a model configured, `aiProcessing` adds a short
`summary:` above the full text — it never replaces it, so no paragraph is lost.

## `aiProcessing`

`enabled` (default `true`) plus `model: { providerID, modelID }`, which must name a model the host
reports. Completion, error and pass text gets a three-line summary through the host's stateless
`ctx.experimental.generate.text` call, printed as `summary: ...` above the full text; forms and
permission prompts always pass through verbatim. When AI is off, the model is not in the host's
list, or the call fails, the full text is relayed on its own.

## Transports

| Key | Default | Meaning |
| --- | --- | --- |
| `whatsapp.enabled` | `true` | connect to WhatsApp |
| `whatsapp.selfChat` | `true` | post into your own chat instead of `target` |
| `whatsapp.target` | — | JID when `selfChat` is off: a phone number (`491234567890@s.whatsapp.net`) or the group `/relay group` creates |
| `discord.enabled` | `false` | post over the REST API |
| `discord.target` | `"channel"` | `channel` posts into `channelID`; `dm` opens the DM with `dmUserID` and caches its channel |
| `discord.channelID` | — | channel the bot posts into, required when `target` is `channel` |
| `discord.dmUserID` | — | user whose DM the bot opens, required when `target` is `dm` |
| `discord.buttons` | `false` | force the Allow/Always/Reject row off; it renders while the gateway is connected |

Discord needs `DISCORD_BOT_TOKEN` in the environment; it is never read from `config.json`. The token
plus the ID the chosen target uses must both be present, or Discord is reported as `mocked` and
skipped while the other transports keep running. A
config that only sets `channelID` keeps working: no `target` means `channel`.
Outbound uses `POST /channels/{id}/messages`. Inbound is the gateway websocket (v10, intents Guilds +
GuildMessages + DirectMessages + MessageContent): `MESSAGE_CREATE` goes through the same handler as a
typed message, `INTERACTION_CREATE` carries the `/relay` slash commands and the button clicks. While
the socket is down, inbound falls back to polling `GET /channels/{id}/messages` every 15s from the
last gateway message, and resumes the gateway with backoff. The dedupe store means a message
delivered on both paths is answered once. In DM mode the relay opens the DM once with
`POST /users/@me/channels {recipient_id: dmUserID}` and keeps the returned channel id in
`auth-state/discord.json`, so a restart reuses it without another call; delete that file (or change
`dmUserID`) to resolve it again. The first poll only anchors, so history is never replayed.

`/relay pair` links Discord interactively once the token is set: pick Discord, pick channel vs DM,
then the channel or user ID. The form checks the pick live (`GET /channels/{id}`, or the DM open
call), posts `Relay linked — say hi here` into it, and writes `discord.target` plus the ID to
`config.json`. A DM pair also appends that user ID to `security.allowlist`, so the fail-closed gate
lets you command the relay; a channel pair proves no user ID, so the notice names the manual step.
A failed check reports Discord's own error text.

## `security`

| Key | Default | Meaning |
| --- | --- | --- |
| `pairingRequired` | `true` | only allowlisted senders are accepted |
| `allowUnpairedUsers` | `false` | accept every sender (ignore the allowlist) |
| `allowlist` | `[]` | full JIDs or bare numbers in international format, or Discord user IDs |
| `imageRoots` | `[]` | extra directories `/relay send` and `relay_send_image` may read from; the install, the project and `auth-state/outbox` always are |
| `allowImageUrls` | `false` | allow an image `url`; off means URL inputs are refused, so the relay never fetches an address from a message |

`/relay send` and `relay_send_image` only read files under the install, the project directory, the
outbox, or a `security.imageRoots` entry: anything else is refused with the path in the answer.

`/relay pair` appends the identity the pair proved (WhatsApp: the linked number; Discord: the DM
user ID) and names it in the pair notice, so a fail-closed relay does not lock you out. A Discord
channel pair proves no user ID, so that entry stays manual.

See [security.md](security.md).

## `/relay` commands

The same subcommands work two ways: as a chat command (`/relay status`) and over WhatsApp from your
own chat or a paired sender.

```
/relay status
/relay sessions
/relay select <number|sessionID>
/relay notifications
/relay notifications <category> on|off
/relay notifications mode immediate|batch|final_only
/relay notifications preset all|important|completion
/relay model
/relay model <providerID> <modelID>
/relay pair [whatsapp|discord]
/relay unpair [whatsapp|discord]
/relay group
/relay send <path> [caption]
/relay help
```

`/relay send <path> [caption]` posts one image file to every live transport. The path may contain
spaces (a Windows screenshot name usually does): the relay takes the longest run of words that names
an existing file and treats the rest as the caption. Only `png`, `jpg`, `jpeg`, `gif` and `webp` are
accepted, and the file is checked before anything is sent, so a missing or oversized file answers
instead of being queued. Discord uploads it as an attachment (an `http(s)` URL is sent as an embed
instead, so nothing is downloaded), WhatsApp sends it as an image message; both use the caption as
the message body and prepend the usual identity line. `/relay send` refuses a file above 8 MB
(Discord's per-file cap) before anything is sent; the transports apply their own cap too (WhatsApp
16 MB). A caption longer than WhatsApp's 1024-character limit arrives as the image plus the
remaining text.

Dropping a file in `auth-state/outbox/` does the same without a command: the next tick (15s) sends
every new `png`/`jpg`/`jpeg`/`gif`/`webp` there with the file name as caption, then moves it to
`auth-state/outbox/sent/` so it never goes out twice. No watcher, no extra process. A file the
transport rejects stays in `outbox/` and is retried on the next tick; one above the 16 MB cap is
moved to `sent/` unsent with a warning instead of being retried forever.

Agents can send an image directly, without a command: the plugin registers a `relay_send_image` tool
(`path` required, `caption` optional) that takes the same validation as `/relay send` and answers with
where the file went ("sent shot.png to WhatsApp + Discord"). It exists so "send this screenshot to my
phone" is one step: the agent calls the tool with the file it just wrote, and the image keeps that
session's identity header. A relative path resolves against the project directory, not the host's
working directory. The tool is not filtered by the notification preset or `orchestratorOnly`: the user
asked for that send, so it goes out even when routine notifications are off. Typing `/relay send
<path>` and dropping the file in `auth-state/outbox/` still work, and are the fallbacks for a host
where the agent cannot call the tool.

`/relay help` prints every subcommand with a one-line purpose, plus the current provider, preset,
mode and model, so a phone user can find the next step without the docs. Any unknown subcommand
answers with the usage line instead of silence - the same in the chat command and the transport
inbound path, since both go through the same handler.

The Discord slash command registers the same subcommands with a description for each one and each
option, the required flag where an argument is mandatory (`select session`), and fixed choices where
the value set is closed (`mode`, `preset`, the category on/off list, `provider`). Typed `/relay ...`
is unchanged: the interaction is turned back into the same text the typed path parses.

`/relay status` prints the provider, preset, mode, enabled categories and pending pass batches.
`/relay notifications` prints the current preset, mode and enabled categories. Changes are written
back to `config.json`. `sessions` lists recent sessions from the plugin host (`ctx.session.list`) as
a numbered list, recent first, and saves that order to `auth-state/sessions.json`. `select` takes
that number or a session ID and answers `selected <title>`; the choice is written to
`auth-state/selected.json`, so it survives a restart and means the same thing in the TUI host and
the transport host, which hold separate memory. Form and permission replies to a prompt whose event
carried no session go there too. A number resolves against the last saved listing;
with no saved listing it resolves against the host's current order, and a number out of range gets
the usage line plus a fresh list (which re-anchors the numbers).
`/relay model` lists the models the host reports (`ctx.model.list`) and marks the configured one;
`/relay model <providerID> <modelID>` writes it to `aiProcessing` in `config.json` and turns AI
summarising on. An ID the host does not report is refused, but it does not have to be byte-exact:
the exact ID wins first, then an ID that differs only by a trailing variant (`muse-spark-1.3-contributor`
finds `muse-spark-1.3`), then a unique prefix/contains match. Several candidates are refused with
their names instead of guessed. The running plugin picks the change up on the next notification, no
restart.

Replying to a pending permission or form prompt answers it: `once`/`yes` grants once,
`always` grants for the session, anything else rejects. Permissions go through
`ctx.permission.reply`; forms use the local OpenCode server because the plugin Context exposes
no form API. The routes come from `@opencode/protocol`:
`GET /api/session/{sessionID}/form/{formID}` for the fields,
`POST .../reply` with `{ answer: Record<string, string | number | boolean | string[]> }`, and
`DELETE .../{formID}` to cancel. The server URL is discovered at reply time, never assumed:
`OPENCODE_SERVER_URL` from the environment wins; otherwise the registration file the server itself
writes (`XDG_STATE_HOME` or `~/.local/state`, then `opencode/service.json`) supplies the live
ephemeral URL and its password; only when that file is missing or stale are `127.0.0.1:4096` and
`127.0.0.1:28894` probed, one second each, in parallel. If nothing answers, the chat reply tells you
to set `OPENCODE_SERVER_URL`.

The question message carries every field and its options in the form's own order (hidden fields and
`external` links are skipped), because the answer is typed text on both transports. One field takes
the whole reply; for a select, an option letter (`a`), label or value works. Text that matches no
option is still accepted and sent as typed — the server takes a string — and `Other: <text>` forces
that even when the text looks like an option. Several fields take
`1: <answer>` lines (or `<key>: <answer>`), and `cancel` cancels the form. The reply is coerced to
each field's type (`string`, `number`, `integer`, `boolean`, `multiselect`); a boolean or a number is
the only place typed prose is refused, and the reply then says so and shows how to retry. A rejected
answer or a failed HTTP call is reported in chat and leaves the form pending; an answer that arrives
after the 15-minute window is reported as expired instead of being forwarded into the session as a
prompt. A reply that quotes the notification anchors to that exact prompt, so two pending forms cannot
be answered out of order.

A form answered or cancelled elsewhere (the TUI, another chat) settles its pending prompt at once
(`form.replied` / `form.cancelled` are both watched). If an answer still lands on a dead form, the
server's 404 is turned into one line — "already answered or cancelled elsewhere; ask the agent to
raise it again" — and the pending prompt is dropped instead of being retried.

`/relay unpair whatsapp` logs the device out server-side (`sock.logout()`), deletes
`auth-state/whatsapp` and turns `whatsapp.enabled` off. If the logout call fails the failure is
reported, but the local credentials are still deleted: leaving them behind would reconnect.
`/relay unpair discord` clears `discord.target`, `channelID` and `dmUserID`, turns
`discord.enabled` off and deletes `auth-state/discord.json`; the bot token stays in
`DISCORD_BOT_TOKEN` (bots have no unlink call, so the bot stays in the server). Unpairing the only
live transport warns that notifications stop and envelopes go to the `mock` sink; the next
`/relay pair` turns the transport back on.

`/relay group` creates a WhatsApp group named "Relay" with your own number as its only other member
(`sock.groupCreate`) and writes its JID to `whatsapp.target` with `selfChat: false`, so outbound
notifications and your own messages share one conversation instead of one column of bubbles. A group
that already carries the name is reused, never duplicated. The change is on disk, so a restart keeps
routing there; `/relay group` a second time only reports the group it reused.

The group is a dedicated channel for notifications, not a second account. A linked device's sends are
always from us, so WhatsApp renders them on the right — that cannot be changed from the relay, and
true left-side bubbles need a second number paired as a dedicated bot, which is out of scope. The
identity line on every notification (`🤖 Relay · <session title>`) is what keeps the threads
distinguishable despite that.


A plain message with nothing pending is forwarded as a prompt: to the session picked with
`/relay select` (read back from `auth-state/selected.json`), or to the only active session the host
lists (`ctx.session.list({ archived: false })`). The answer names the session on its first line and
confirms `sent to '<title>'`. With several
active sessions and no selection, the relay lists them and asks for `/relay select` instead of
guessing; a selection the host no longer lists (archived or removed) is never written into — it
falls back to that same question. Prompts are capped at 2000 characters, and one inbound message
forwards once — a redelivery is dropped by the transport dedupe.
