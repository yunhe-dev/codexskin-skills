# CodexSkin QA checklist

## Static gates

- valid `manifest.json`, safe id, version, design contract, semantic palette;
- CSS under 1 MB with no external resources, scripts, traversal, or broad state
  overrides;
- supported local JPG, PNG, or WebP assets with matching signatures;
- full-workspace 1440×900 and 980×760 previews;
- package under 30 MB and free of absolute/private paths.

## Real-app matrix

Verify after explicit application permission:

- home heading, suggestions, project selector, composer;
- populated conversation, markdown, code, attachments, output and diff;
- settings, profile, selects, dialogs, menus, tooltips;
- terminal host, viewport, screen, ANSI colors after xterm mounts;
- sidebar idle, hover, selected, long titles and row actions;
- wide and narrow header actions;
- keyboard focus, disabled, loading, running, expanded and open states;
- route change, renderer reload, theme switch, rollback and restore.

`status` must report the expected theme in every live page. The readability
audit must pass on each mounted route; one home-page pass cannot prove settings
or terminal. Capture real screenshots and replace design previews before the
final export.

Hard failures include unreadable visible text, broken hit targets, hidden
native controls, clipping, overflow, duplicate borders, row-action collision,
network-facing debugging, or any modified application file. Restore or roll
back on a hard failure.
