# Security

The relay sits between an OpenCode session and a messaging account, so treat the phone number, the
bot token and `auth-state/` as secrets. Both live in the plugin's data directory
(`$XDG_DATA_HOME/opencode-relay/`, else `~/.local/share/opencode-relay/`), never in the checkout.

## Inbound access: pairing and allowlist

Any WhatsApp message that is not from yourself is dropped unless the sender is paired
(`security.pairingRequired`, default `true`):

- `security.allowlist` holds full JIDs (`491234567890@s.whatsapp.net`) or bare numbers in
  international format (`491234567890`). The check compares digits only, so either form matches.
  `/relay pair` appends the identity it proved; add entries by hand for anyone else.
- `security.allowUnpairedUsers: true` turns the allowlist off. Only do that on a dedicated number.
- Messages you send in your own self-chat always pass; they are how you drive `/relay`.

The allowlist is the only inbound gate. A successful pair writes the identity it proved into it, so
`/relay pair` cannot lock you out of your own chat:

- WhatsApp: the number the link registered (from `auth-state/whatsapp/creds.json`).
- Discord: the user ID of the DM target. A channel pair proves no user ID, so that one line stays
  manual.

The pair notices name the entry they wrote. Editing `security.allowlist` in `config.json` still works
and is the fallback when a pair cannot write the file.

Commands can change notification settings and answer form
and permission prompts, and a form/permission reply is forwarded to the local OpenCode server, so
only add people who should be able to approve tool calls in your sessions.

## Credentials

- The Discord bot token comes from `DISCORD_BOT_TOKEN` in the environment. It is sent only in the
  `Authorization` header; failures log the response body, never the header.
- `config.json` holds no secrets — keep it that way (no tokens in `examples/`, no tokens in git).
  It lives in the data dir next to `auth-state/`; that state contains WhatsApp Signal keys, the
  correlation table, pending batches, the retry queue and the dedupe set.
- State is plain JSON on disk (no encryption). Restrict the directory to your user account.

## WhatsApp: unofficial protocol and terms of service

Transport is [Baileys](https://github.com/WhiskeySockets/Baileys), a reverse-engineered
implementation of the WhatsApp Web protocol. It is **not affiliated with, endorsed by or supported
by WhatsApp/Meta**, and it violates the WhatsApp Terms of Service in spirit if not letter.

Practical consequences:

- **Account ban risk.** Automating or linking an unofficial client can get the number banned,
  without warning or appeal. Use a number you can afford to lose, not your primary one.
- Protocol changes can break the adapter at any time; pin the Baileys version and expect breakage.
- Baileys is a dependency, not part of this project: its licensing and behaviour are its own.

Discord is used through the official REST API with a bot token, so the same caveat does not apply
there. Do not enable a provider you have not read the terms for.

## Outbound files and image URLs

`/relay send` and `relay_send_image` read files only under the install, the project directory,
`auth-state/outbox`, or a `security.imageRoots` entry; `..` and symlinks are resolved before the
check, so a path from a chat or a model cannot reach the rest of the disk.

An image `url` is refused unless `security.allowImageUrls` is on, and even then only `http(s)` and
never a loopback, link-local or private address: the fetch happens on this machine, so it must not
become a way to probe the local network.

## Revoking access

- **WhatsApp account**: `/relay unpair whatsapp` logs the device out server-side and deletes
  `auth-state\whatsapp` in one step. By hand: **WhatsApp -> Linked devices -> log out** the OpenCode
  entry, stop OpenCode, delete `auth-state\whatsapp`.
- **Discord bot**: `/relay unpair discord` clears the configured target and the DM channel cache.
  Reset the token in the developer portal, then update `DISCORD_BOT_TOKEN`, and remove the bot from
  the server if it is no longer wanted.
- **A paired person**: remove their entry from `security.allowlist` and restart OpenCode. Their
  pending form/permission answers stop resolving.
- **Everything**: stop OpenCode and delete `auth-state/` (creds, interactions, batches). Re-pairing
  is required afterwards.

Rotate the Discord token and re-pair WhatsApp if `auth-state/` is ever copied off the machine.
