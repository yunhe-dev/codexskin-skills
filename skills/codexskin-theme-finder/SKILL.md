---
name: codexskin-theme-finder
description: Search and compare public CodexSkin themes and visual skin inspirations, anonymously by default and with an optional key only for higher limits.
---

# Find CodexSkin themes

Run `node scripts/codexskin.mjs find [style, subject, mood]`.

Use `https://codexskin.cool` unless the user explicitly supplies another API
base. Do not request an API key for ordinary search. `CODEXSKIN_API_KEY` is
optional and only raises rate limits.

Present no more than five useful results with id, kind, author, description,
detail URL, and a locally downloaded preview suitable for displaying in chat.
Explain each next step:

- installable Theme → offer Installer and then Switcher;
- non-installable Theme → share its detail URL for manual handling;
- Skin → visual reference only; offer Creator using its preview image.

Always share the detail URL. When the user selects an installable theme, hand
off to `$codexskin-theme-installer`; do not claim search itself installed it.
