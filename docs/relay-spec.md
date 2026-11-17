# Relay spec (pointer)

The normative spec is the **project brief of 2026-11-14** ("opencode-relay - WhatsApp <-> Discord
bridge shipped as an OpenCode plugin"). That brief is the source of truth; this file only points
at it and must not be quoted as the spec.

## Section map (brief §1-§21)

The brief is numbered §1-§21. Read it in that order; these are the topics it covers, grouped for
navigation (the brief's own titles win):

- §1-§2 - scope, mission, non-goals and terminology.
- §3-§5 - message envelope, normalisation and the routing core.
- §6 - notifications: presets, categories and pass batching/debounce timing.
- §7-§11 - transport adapters (WhatsApp/Baileys, Discord/discord.js), identity, pairing flow.
- §12 - configuration schema (normative example: `examples/config.example.json`).
- §13-§17 - delivery guarantees, ordering, retries, idempotency and failure modes.
- §18-§21 - AI processing, security model, operational limits and phasing (Phase 0/1).

## Authority

- Content of the spec: the brief (2026-11-14).
- Shape and defaults of §12 config: `examples/config.example.json` in this repo. If they differ,
  the example file and the brief's §12 must be reconciled - raise it, do not silently pick one.
- `README.md` and `AGENTS.md` summarize the brief; they never override it.
