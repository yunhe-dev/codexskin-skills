---
name: codexskin-theme-switcher
description: Apply, switch, validate, roll back, or restore an installed CodexSkin theme through a local-only Codex Chromium debugging port.
---

# CodexSkin Theme Switcher

Use only an already-running debugging endpoint bound to `127.0.0.1`. Apply a
theme with `node scripts/codexskin.mjs switch <id>`, roll back with
`node scripts/codexskin.mjs rollback`, or remove runtime styling with
`node scripts/codexskin.mjs restore`.

After each change, verify the injected style and state file. Never open a
network-facing debug port, modify `Codex.app`/`app.asar`, or change an app
signature. If Codex must restart, stop and obtain user permission first.
Windows is Beta until the production client is validated.
