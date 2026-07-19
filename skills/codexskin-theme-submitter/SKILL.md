---
name: codexskin-theme-submitter
description: Submit or update a validated CodexSkin theme from an Agent, using anonymous review or an optional API key for immediate author publishing.
---

# CodexSkin Theme Submitter

Run `node scripts/codexskin.mjs submit <package.codexskin-theme>`.

Before upload, confirm the creator owns or may publish every asset. Without
`CODEXSKIN_API_KEY`, explicitly tell the user the theme will be an anonymous
submission awaiting review. With a key, the server identifies the author and
can publish or update that author's theme immediately. Never access user
passwords, login cookies, or OAuth credentials.
