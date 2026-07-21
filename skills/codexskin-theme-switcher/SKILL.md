---
name: codexskin-theme-switcher
description: List, apply, hot-switch, audit, roll back, status-check, and restore installed CodexSkin themes through a loopback-only Codex Chromium endpoint.
---

# Switch or restore a CodexSkin theme

Commands:

```bash
node scripts/codexskin.mjs list
node scripts/codexskin.mjs switch <theme-id>
node scripts/codexskin.mjs status
node scripts/codexskin.mjs audit
node scripts/codexskin.mjs rollback
node scripts/codexskin.mjs restore
```

Use only a debugging endpoint bound to `127.0.0.1`. A hot apply must inject an
owned style and route markers into every live Codex page, register the same
runtime for new renderer documents, preserve the previous theme, and verify
the expected id in the real DOM.

If no endpoint exists, ask for explicit permission before restarting Codex with
loopback debugging flags. Keep the confirmation short and actionable, for
example: "Codex must restart before activation. Reply **apply** and I will
restart Codex, activate the skin, and verify it in the real DOM." Do not
restart merely because the user asked to install. Never open a public
debugging port, edit `Codex.app`, `app.asar`, the signed bundle, WindowsApps,
or app authentication data.

Switch the exact theme id that was just installed or named by the user. Before
applying, run `list` and confirm the id exists; never apply a different theme
as a substitute.

After every apply:

1. require `status` to report the expected active id for all pages;
2. run `audit` before further claims;
3. inspect home, conversation, settings, menus, diff/output, terminal after it
   mounts, sidebar states, route changes, and a narrow window;
4. restore or roll back immediately on unreadable text or broken interaction.

`rollback` returns to the recorded previous theme. `restore` removes all
CodexSkin styles, root markers, page markers, and new-document registrations,
then verifies the native state. Tell the user after success that `restore`
remains available. Windows support remains Beta until validated in a real
production client.
