# CodexSkin design playbook

## Layout modes

- `native-immersive`: native geometry with a coordinated visual world across
  shell, sidebar, cards, composer, menus, settings, diff/output, and terminal.
- `native-background`: native geometry with deliberately limited artwork.
- `editorial-showcase`: bounded home hero composition when the brief clearly
  requires it; all other routes remain native.
- `palette-only`: semantic color and material system without dominant artwork.

`backgroundScope: home` is the readability-safe default. `workspace` may add
artwork to verified conversations, never automatically to settings or every
`main` element. The scope is baked into CSS and requires a rebuild to change.

## Semantic palette

Define canvas, surface, raised, control, text, muted, disabled, accent, border,
focus, success, warning, danger, terminal background, and terminal foreground.
Bridge them to the verified native Codex tokens on the component root where
local inline variables would otherwise win.

## Surface coverage

Balanced and rich themes cover shell, header, sidebar idle/hover/selected,
suggestion cards, composer, buttons, menus, dialogs, settings controls,
markdown/code, output/diff, terminal host/viewport/screen, scrollbars, focus,
disabled, loading, and narrow layouts. A background plus veil is incomplete.

Decoration must be non-interactive, below native controls, and use
`pointer-events: none`. One owner controls each border and divider. Avoid text
selectors tied to a language when structural roles or test ids exist.

## CSS safety

Do not use `@import`, external URLs, scripts, JavaScript URLs, executable data,
broad descendant opacity/display/visibility/position/overflow fixes, or hidden
native actions. Local relative image assets are embedded into the package.

Use `:root[data-codexskin-theme="<id>"]` as the ownership marker. Do not reuse
another product's markers, state files, or runtime ids.
