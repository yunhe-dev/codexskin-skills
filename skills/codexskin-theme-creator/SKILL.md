---
name: codexskin-theme-creator
description: Create, redesign, validate, preview, package, apply with permission, and verify an original Codex desktop skin as an independent .codexskin-theme package.
---

# Create a CodexSkin theme

Create a reversible session theme without modifying Codex application files.
Use this skill's design contract, validators, and runtime as the sole authority
unless the user explicitly names another source.

## Managed storage

- source: `~/.codexskin/themes/<theme-id>/`
- previews: `~/.codexskin/themes/<theme-id>/previews/`
- exports: `~/.codexskin/exports/<theme-id>.codexskin-theme`
- state: `~/.codexskin/state/`

Do not write theme files into the current workspace or a staging directory by
default. Do not inspect or copy a finished local theme unless the user named it.

## Required references

Read completely before creation:

- `references/design-playbook.md`
- `references/qa-checklist.md`
- `references/theme-schema.md`
- `references/asset-rights.md`

## Gate 1: design contract

Record `layoutMode`, `backgroundScope`, `decorDensity`, light/dark rationale,
art focal point, text-safe region, semantic palette, allowed changes, preserved
native behavior, and target viewports.

Default to native geometry. Strong visual references normally use
`native-immersive`; background-only requests use `native-background`; a bounded
hero composition may use `editorial-showcase`; concepts without art use
`palette-only`. Default dominant artwork to home-only for readability and ask
whether it should extend to conversations before building.

## Gate 2: native contract

When a real app endpoint is already available, inspect the native home,
conversation, settings, menus, diff/output, terminal, sidebar states, and narrow
layout. Preserve geometry, hit targets, keyboard focus, hover-only actions, and
route behavior unless the design contract explicitly permits a change.

## Gate 3: scaffold and implement

Create `manifest.json`, `theme.css`, `README.md`, `assets/`, `previews/`, and
`state/` under the managed theme directory. Use the marker
`data-codexskin-theme="<theme-id>"` and CodexSkin-owned runtime ids only.

Implement in this order:

1. semantic tokens;
2. shell surfaces;
3. exact route-scoped artwork;
4. verified native component roots;
5. idle, hover, selected, disabled, focus, loading, running, expanded, open;
6. non-interactive decoration with `pointer-events: none`;
7. responsive and reduced-motion rules.

Never use broad descendant state repairs such as `main * { opacity: 1 }`, hide
native controls, or put low-contrast artwork behind toolbar controls. Theme the
terminal host, viewport, and screen together. When surface luminance changes,
override explicit descendant text tokens on the verified component roots.

## Gate 4: static validation and previews

Run from this repository:

```bash
node scripts/codexskin.mjs validate ~/.codexskin/themes/<theme-id>
node scripts/codexskin.mjs create ~/.codexskin/themes/<theme-id>
```

Fix every error. Produce full-workspace raster previews named
`preview-1440x900.(png|jpg|webp)` and
`preview-980x760.(png|jpg|webp)`. They must include sidebar, header, and content;
never use raw artwork as the gallery preview. Label unverified mockups as design
previews.

## Gate 5: apply only with permission

Ask before applying, changing settings, or restarting Codex. If a loopback
debugging endpoint already exists, use `$codexskin-theme-switcher` for a hot
apply. If it does not, stop and ask for restart permission. Never bind the
debugging endpoint beyond `127.0.0.1` and never modify the signed app.

After apply, `status` must report the expected active id in every live page.
Then run the readability audit and inspect home, conversation, settings, menus,
diff/output, mounted terminal, sidebar states, route changes, and a narrow
window. A package, preview, static check, or style marker alone is not proof.
Restore or roll back immediately if readability fails.

## Gate 6: export after verification

Re-run `create` after replacing the primary preview with a real applied-theme
screenshot. The UTF-8 JSON package must remain under 30 MB and contain no
absolute paths, scripts, executables, private references, tracking, or external
CSS resources.

Offer both submission paths after export:

- manual: `https://codexskin.cool/submit`;
- agent: `$codexskin-theme-submitter`.

Do not submit unless the user asks. Never include Dream Skin assets unless the
user separately and explicitly requests them.

## Completion standard

Report design, static validation, preview generation, real-app application,
route-by-route visual verification, and package export separately. Never claim
completion when any required real-app check remains unperformed.
