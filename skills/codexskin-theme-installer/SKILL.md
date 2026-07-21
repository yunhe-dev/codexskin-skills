---
name: codexskin-theme-installer
description: Download, validate, and install a published .codexskin-theme package, then hand off to the switcher for optional activation.
---

# Install a CodexSkin theme

Run `node scripts/codexskin.mjs install <theme-id-or-slug>`.

Installer is anonymous by default. An optional `CODEXSKIN_API_KEY` only raises
limits. Validate the independent package schema, id, CSS, embedded assets,
size, MIME signatures, traversal safety, and external-resource prohibition
before writing to `~/.codexskin/themes/<id>/`.

## Install exactly what was requested

- Install the exact id or slug the user named. Never substitute a different
  theme — not an already-installed one, not a previously discussed one, not a
  "similar" one.
- After installation, read `~/.codexskin/themes/<id>/manifest.json` and confirm
  its `id` matches the requested id or slug. On mismatch, stop and report the
  mismatch instead of continuing.
- Report in one line: `Installed <id> version <version> at
  ~/.codexskin/themes/<id>/.` Always include the version.

## Next step

Skin entries return `NOT_INSTALLABLE`; share their detail URL and offer Creator
instead. A successful installation is not activation. Hand off to
`$codexskin-theme-switcher`. Hot-apply only when a loopback endpoint already
exists. When none exists, keep the confirmation short, for example:

> Codex must restart before activation. Reply **apply** and I will restart
> Codex, activate the skin, and verify it in the real DOM before reporting
> completion.

Never modify Codex application bundles or signatures.

Use `--force` only when the user asked to update or replace an existing local
copy. Revalidate after replacement.
