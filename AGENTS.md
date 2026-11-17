# AGENTS.md — opencode-relay

## Project Overview

`opencode-relay` is a messaging bridge: it relays conversations between WhatsApp and Discord
from inside an **OpenCode plugin**. The plugin owns its runtime — there is no daemon, no Docker
and no Redis. Durable state is the filesystem (`auth-state/` under the plugin's XDG data dir,
`dist/` build output); config is JSON validated with zod (`examples/config.example.json`). Messages
are normalised into one envelope and routed per config, so adding a transport does not change the
routing core.

Read the relay spec (pointer in `README.md`) before changing behaviour: it owns the envelope,
the delivery guarantees and the failure modes.

## Technology stack

| Layer | Choice |
| --- | --- |
| Runtime | Bun (no ts-node, no Node polyfills needed) |
| Language | TypeScript, `strict`, `module`/`moduleResolution` = `NodeNext` |
| Host | OpenCode plugin API — in-process, plugin-owned lifecycle |
| Transports | WhatsApp (Baileys) + Discord (discord.js) — Phase 1, not installed yet |
| Config | JSON file + zod schema |
| Logging | pino |
| Tests | vitest |
| State | Filesystem under the XDG data dir (`auth-state/`); no database |

## Platform: Windows dev host, PowerShell 7 (read before running anything)

**This repo is developed on Windows 10/11. The host has no `sh`, no GNU coreutils, and no Linux shell.**
Nothing in this project is containerised, so there is no POSIX shell to fall back on anywhere —
every command a human or agent runs must be valid PowerShell or a `bun`/`git`/`node` invocation.

Host rules for agents:

- **Shell**: PowerShell 7 (`pwsh` on PATH; pinned via the top-level `shell` key in
  `~/.config/opencode/opencode.jsonc`). Windows PowerShell 5.1 exists only as `powershell.exe`.
- **Write PowerShell, not bash**: `Get-ChildItem`/`ls`, `Get-Content`/`cat`, `Select-String` (not
  `grep`), `Get-Content -First N` / `-Last N` (not `head`/`tail`), `-replace` (not `sed`),
  `Measure-Object` (not `wc`), `Remove-Item` (not `rm -rf`), `Copy-Item` (not `cp`), `Test-Path`,
  `New-Item -ItemType Directory -Force`, `$env:NAME = 'value'` (not `export NAME=value`), backslash
  paths, `;` or `&&`/`||` to chain, `.\script.ps1` to run a script.
- **Missing on the host**: `sh`, `grep`, `sed`, `awk`, `head`, `tail`, `wc`, `touch`, `which`, `env`,
  `seq`, `unzip`. **Present**: `git`, `python`, `bun`, `node`, `docker`, `curl.exe`, `tar.exe`,
  `make.exe`, plus the aliases `ls`, `cat`, `rm`, `cp`, `mv`, `tee`, `sleep`.
- **`bash.exe` on PATH is WSL** (`C:\Windows\System32\bash.exe`), not Git Bash: different filesystem
  view (repo paths appear as `/mnt/f/...`). Do not use it for routine repo work.
- No `#!/bin/sh`, `chmod`, `apt-get`, `export VAR=...`, or `/tmp/...` paths in host instructions.

## Agent tooling (global `opencode-setup` install)

This project runs inside the global `opencode-setup` install. The tooling is already wired; do not
re-explain or re-install it.

- **Ponytail is active.** Smallest complete change: reuse what the repo already has, no unasked
  abstraction or config, deletion beats addition. Finish every caller, test and fixture the change
  touches; never skip validation, security or data-loss handling.
- **rtk rewrites shell calls** (`git status` runs as `rtk git status`) to compress terminal output.
  Read the compressed result; do not re-run the command raw just to see "everything".
- **context-mode keeps big output out of context.** For logs, test output, large JSON or long files,
  ask for the answer, not the blob (`ctx_execute`; `read` with offset/limit). An oversized `read`
  being denied is context-mode working, not a tool failure.
- **Skills are available to you and to every delegated lane** (lazy-loaded, invoke by name):
  `surgical-patch` (bug fix), `investigate-first` (cause unknown), `safe-refactor`,
  `lean-build` (new feature), `verify-and-stop` (validation only), `caveman` (terse output),
  `caveman-compress` (shrink a memory file; sends its text to the model provider).
- **Delegation lanes**: `fixer`, `explorer`, `librarian`, `oracle`, `designer`, `observer`. Give a
  lane a narrow, self-contained task, because only its final answer returns to this context.
- **Cost is cache-read, not input.** Start a new session when the task changes instead of carrying
  history forward.

## Essential commands

```powershell
bun install          # dependencies
bun run build        # tsc emit to dist/
bun run test         # vitest
bun run lint         # tsc --noEmit
```

## Boundaries

- No daemon, no Docker, no Redis, no database. If a design needs a long-lived background process,
  it belongs to the OpenCode plugin host, not to `opencode-relay`.
- `src/`, `docs/` and `tests/` are Phase 0 research-lane output. Do not create them opportunistically.
- Secrets (Discord token, WhatsApp credentials) live in the data dir's `auth-state/` or the
  environment, never in committed JSON; `examples/config.example.json` uses placeholders.
