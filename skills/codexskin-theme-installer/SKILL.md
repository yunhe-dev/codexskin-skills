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

Skin entries return `NOT_INSTALLABLE`; share their detail URL and offer Creator
instead. A successful installation is not activation. Report the installed
source path, then hand off to `$codexskin-theme-switcher`. Hot-apply only when a
loopback endpoint already exists; otherwise ask before restarting Codex. Never
modify Codex application bundles or signatures.

Use `--force` only when the user asked to update or replace an existing local
copy. Revalidate after replacement.
