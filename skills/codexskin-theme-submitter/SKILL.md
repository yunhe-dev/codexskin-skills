---
name: codexskin-theme-submitter
description: Validate and submit or update a CodexSkin theme from an Agent, anonymously for review or with an optional API key for immediate owned publishing.
---

# Submit a CodexSkin theme

Run `node scripts/codexskin.mjs submit <package.codexskin-theme>`.

Before transmission, identify the exact package, perform a dry validation, and
confirm the user may share every included asset. Do not guess among multiple
exports and do not upload until the user asked.

Without `CODEXSKIN_API_KEY`, explicitly say the submission will be anonymous
and enter review. With a key, the server identifies the author and may publish
immediately or update that author's existing theme. The key is not a website
login and the script must never read passwords, browser cookies, or OAuth
credentials. Never print the complete key.

Post JSON to `POST https://codexskin.cool/api/themes/submit`. Report the final
server status and detail URL. Do not automate the human upload form as a
fallback; on failure, report the API error and preserve the local package.
