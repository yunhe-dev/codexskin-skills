# Independent CodexSkin theme schema

Editable themes use `manifest.json` and `theme.css` under
`~/.codexskin/themes/<id>/`.

Required manifest fields:

```json
{
  "schemaVersion": 1,
  "id": "safe-theme-id",
  "displayName": "Theme name",
  "description": "Public description",
  "version": "0.1.0",
  "mode": "dark",
  "css": "theme.css",
  "preview": "previews/preview-1440x900.png",
  "design": {
    "layoutMode": "native-immersive",
    "backgroundScope": "home",
    "decorDensity": "balanced",
    "modeReason": "Reason",
    "artFocalPoint": "70% 35%",
    "textSafeRegion": "left 50%",
    "contrastStrategy": "Opaque native content surfaces",
    "allowedChanges": ["semantic palette", "home artwork"],
    "preserve": ["native geometry", "native controls", "native states"],
    "verificationViewports": ["1440x900", "980x760"]
  },
  "palette": {
    "canvas": "#111111",
    "surface": "#1a1a1a",
    "raised": "#242424",
    "text": "#f5f5f5",
    "muted": "#b4b4b4",
    "accent": "#7487ff",
    "border": "#444444",
    "focus": "#9cafff",
    "terminalBackground": "#0d0d0d",
    "terminalForeground": "#f5f5f5"
  }
}
```

Portable `.codexskin-theme` files are UTF-8 JSON, not ZIP:

```json
{
  "format": "codexskin-theme",
  "schemaVersion": 1,
  "exportedAt": "ISO-8601 timestamp",
  "manifest": {},
  "css": "complete CSS source",
  "readme": "theme README",
  "art": { "filename": "art.png", "mimeType": "image/png", "data": "base64" },
  "preview": { "filename": "preview-1440x900.png", "mimeType": "image/png", "data": "base64" },
  "images": [],
  "verification": {}
}
```

This is not a `.codex-theme` compatibility layer. Reject packages over 30 MB,
unsupported MIME signatures, external CSS resources, scripts, executable
content, traversal paths, secrets, or absolute/private references.
