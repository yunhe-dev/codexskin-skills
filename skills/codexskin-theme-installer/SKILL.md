---
name: codexskin-theme-installer
description: Download, validate, and install a published CodexSkin theme into the user's local theme directory without activating it.
---

# CodexSkin Theme Installer

1. Run `node scripts/codexskin.mjs install <theme-id-or-slug>`.
2. Verify the package schema, CSS safety, and decoded assets.
3. Install under `~/.codexskin/themes/<id>/` and report that installation does
   not mean the theme is active.
4. Finder and Installer are anonymous by default; an API key is optional and
   only raises limits.

Never modify Codex application bundles or signatures.
