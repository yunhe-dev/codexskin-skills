---
name: codexskin-theme-switcher
description: List, apply, hot-switch, audit, roll back, status-check, and restore installed CodexSkin themes through a loopback-only Codex Chromium endpoint.
---

# Switch or restore a CodexSkin theme

Commands:

```bash
node scripts/codexskin.mjs list
node scripts/codexskin.mjs switch <theme-id>
node scripts/codexskin.mjs switch <theme-id> --launch
node scripts/codexskin.mjs switch <theme-id> --launch --relaunch
node scripts/codexskin.mjs status
node scripts/codexskin.mjs audit
node scripts/codexskin.mjs rollback
node scripts/codexskin.mjs restore
```

Use only a debugging endpoint bound to `127.0.0.1`. A hot apply must inject an
owned style and route markers into every live Codex page, register the same
runtime for new renderer documents, preserve the previous theme, and verify
the expected id in the real DOM.

Theme only full workspace renderers. Codex auxiliary system windows such as
the hotkey window and avatar overlay are intentionally excluded: they are not
workspace pages, cannot produce reliable screenshots, and must keep their
native compact appearance. Report them as skipped with reason
`auxiliary-window`; they do not make workspace status `partial`.

If no endpoint exists, ask for explicit permission before restarting Codex with
loopback debugging flags, then rerun with `--launch`. The command schedules a
detached helper that survives the Codex quit/relaunch cycle. Use `--relaunch`
only to evict a stale session when the user also approved a restart. Keep the
confirmation short and actionable, for
example: "Codex must restart before activation. Reply **apply** and I will
restart Codex, activate the skin, and verify it in the real DOM." Do not
restart merely because the user asked to install. Never open a public
debugging port, edit `Codex.app`, `app.asar`, the signed bundle, WindowsApps,
or app authentication data.

When both Codex.app and ChatGPT.app are installed, the launcher selects the
currently running host before falling back to an installed app. A post-launch
probe is strict to the requested port so an older endpoint cannot be mistaken
for the relaunched host. If launch still fails, read the command diagnosis and
`~/.codexskin/state/launch.log` rather than retrying blindly.

Switch the exact theme id that was just installed or named by the user. Before
applying, run `list` and confirm the id exists; never apply a different theme
as a substitute.

After every apply:

1. require `status` to report the expected active id for all pages;
2. run `audit` before further claims;
3. inspect home, conversation, settings, menus, diff/output, terminal after it
   mounts, sidebar states, route changes, and a narrow window;
4. restore or roll back immediately on unreadable text or broken interaction.

Apply runs the screenshot-based readability audit itself. Contrast below 2.5
is critical; two or more critical samples trigger automatic rollback or native
restore. Ratios below WCAG guidance but above the critical floor remain active
as warnings so one edge-case label cannot falsely disable an otherwise readable
theme. Use `--force` only when the user explicitly accepts a critical result.

`rollback` returns to the recorded previous theme. `restore` removes all
CodexSkin styles, root markers, page markers, and new-document registrations,
then verifies the native state. When no renderer is running, `status` reports
`inactive` and `restore` safely clears the stale local runtime state instead of
failing. With no previous theme, rollback returns to native appearance. Tell
the user after success that `restore` remains available. Windows support
remains Beta until validated in a real production client.
