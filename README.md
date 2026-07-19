# CodexSkin Skills

Official open-source Agent skills for discovering, creating, installing,
switching, restoring, and submitting themes from
[codexskin.cool](https://codexskin.cool).

The website and its private application code are not part of this repository.
These skills use public CodexSkin HTTP APIs and a local-only Codex Chromium
debugging connection. They never read passwords, browser cookies, Google OAuth
tokens, or modify `Codex.app`, `app.asar`, or application signatures.

## Skills

- `$codexskin-theme-creator`
- `$codexskin-theme-finder`
- `$codexskin-theme-installer`
- `$codexskin-theme-switcher`
- `$codexskin-theme-submitter`

Each skill is in `skills/<name>/SKILL.md`. The shared Node.js helper is
`scripts/codexskin.mjs` and requires Node.js 20 or newer.

## Local folders

```text
~/.codexskin/themes/<id>/
~/.codexskin/exports/
~/.codexskin/state/
```

Finder and Installer work anonymously. Set `CODEXSKIN_API_KEY` only when you
want higher API limits or authenticated publishing. Windows support is Beta
until validated against the production Codex client.

## License

MIT
