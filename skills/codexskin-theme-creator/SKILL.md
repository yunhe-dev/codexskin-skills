---
name: codexskin-theme-creator
description: Create and validate an original CodexSkin theme, two required previews, a verification report, and a .codexskin-theme package.
---

# CodexSkin Theme Creator

Create original work; do not copy another site's trademarks, text, or theme
assets. Ask for missing visual direction only when it materially changes the
result.

1. Create a directory containing `manifest.json`, `theme.css`, `README.md`,
   `preview-1440x900.png|jpg|webp`, and `preview-980x760.png|jpg|webp`.
2. Use only runtime CSS/DOM styling. Reject `@import`, external CSS resources,
   JavaScript URLs, scripts, and executable content.
3. Record asset sources and permissions in the README.
4. Run `node scripts/codexskin.mjs create <directory>` from this repository.
5. Report the generated package and verification result. Never include Dream
   Skin assets unless the user separately and explicitly asks for them.

The package is a UTF-8 JSON container with `format: codexskin-theme` and
`schemaVersion: 1`.
