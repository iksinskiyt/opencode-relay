# Contributing

Small, focused changes. One problem per pull request, with the tests that prove it.

## Setup

```powershell
bun install
# config and state live in the data dir, never in the checkout
$data = Join-Path ($env:XDG_DATA_HOME ?? (Join-Path $HOME ".local\share")) "opencode-relay"
New-Item -ItemType Directory -Force $data | Out-Null
Copy-Item examples\config.example.json (Join-Path $data "config.json")   # placeholders are fine
bun run build
bun run test
```

The host loads `dist/` through the root `index.js`, so run `bun run build` after any source change
before trying the plugin by hand. `bun run lint` is `tsc --noEmit` with `strict` on.

## Gates

Every change must leave all three green:

```powershell
bun run build
bun run lint
bun run test
```

New non-trivial logic (a branch, a loop, a parser, anything touching money, security or data loss)
needs a test next to it in `tests/`. A UI-only text change needs the test that already covers that
path updated, not deleted.

## Ground rules

- **No daemon, no Docker, no Redis, no database.** Long-lived work belongs to the OpenCode plugin
  host. State is the filesystem, in `auth-state/` under the plugin's XDG data dir.
- **No secrets in the tree.** Tokens come from the environment (`DISCORD_BOT_TOKEN`); `config.json`
  and `auth-state/` live in the data dir, git-ignored, and must stay out of the checkout.
  `examples/config.example.json` uses placeholders only.
- **Windows is the dev host.** The project is developed on Windows with PowerShell 7; no POSIX-only
  shell assumptions in scripts or docs.
- **Reuse before adding.** A helper, provider or pattern already in `src/` beats a new abstraction,
  option or dependency. Say no to features nobody asked for.
- **Keep the transport contract.** Transports normalise into one envelope (`src/envelope.ts`) and
  never reach into routing; routing never talks to a specific transport.

## Where things live

| Path | What belongs there |
| --- | --- |
| `src/notify.ts` | OpenCode events → envelopes (text, identity line, question details) |
| `src/router.ts` | transports, fan-out, retry queues, allowlist gate |
| `src/interactions/` | inbound handling: `/relay`, prompt replies, forms, correlation store |
| `src/providers/` | one file per transport, plus the Discord gateway |
| `src/pairing.ts` | `/relay pair`, server discovery, link state |
| `tests/` | vitest suites, one per module; stubs instead of network |

`AGENTS.md` holds the working agreements for automated agents; `docs/` holds the behaviour docs.
When behaviour changes, change the doc that describes it in the same pull request.

## Reporting

Open an issue with the OpenCode and plugin versions, the transport, the `config.json` keys involved
(placeholders, never real IDs or tokens), and what you expected versus what happened. Logs from
`/relay status` and `opencode-relay doctor` answer most first questions.
