# Skin Pack MVP Asset Contract

The MVP contains exactly two generated raster assets. Both are content images, never executable theme code.

## `workspace.backdrop`

- Format: PNG, JPEG, or WebP.
- Composition: landscape, preferably 16:9 and 2K-class.
- No text, logos, UI mockups, watermarks, borders, or fake controls.
- Keep the central content band and lower prompt-input area low-detail.
- Put the main decorative focal point toward an outer third.
- Match the structured presentation palette registered with the draft.
- Use broad shapes and restrained contrast so the host's fixed wash can preserve readability.
- The same image may be reused by the active conversation view at a host-controlled low opacity. Do not generate a separate conversation background.

Prompt suffix template:

```text
Create a polished desktop application atmosphere backdrop in the shared art direction and the exact registered presentation palette. Landscape 16:9 composition, no text, no logo, no UI, no watermark. Keep the central 45% and lower 25% visually quiet for readable interface content. Place the decorative focal interest near the registered focus coordinates, with broad shapes, controlled contrast, and clean edges suitable for CSS cover cropping.
```

## `home.emblem`

- Format: PNG, JPEG, or WebP.
- Composition: square.
- Must remain recognizable at 48 px.
- One centered, bold silhouette with minimal interior detail.
- No words, letters, captions, or imitated product names.
- Use a full-bleed square composition whose background reaches all four canvas edges.
- Transparency is optional, not required. An opaque thematic background is valid.
- Do not bake in rounded corners, an inset card, white or neutral outer canvas, a border, a frame, or padding. LobsterAI owns the displayed corner radius.
- It is a Cowork home skin emblem, not a replacement for the operating-system app icon, startup branding, export watermark, user avatar, or agent avatar.

Prompt suffix template:

```text
Create one compact full-bleed square application emblem in the shared art direction. A single bold centered silhouette, strong small-size readability at 48 pixels, minimal interior detail, clean edge, no words, no letters, no caption, no watermark. Extend the thematic background to all four canvas edges. Do not place the emblem inside a rounded card or an outer white or neutral canvas, and do not add a border, frame, padding, or baked corner radius. Transparency is optional; when alpha output is unreliable, use a full-canvas opaque thematic background.
```

## Forbidden outputs

- Icon collections or sprite sheets.
- Sidebar, toolbar, status, permission, warning, loading, Artifact, file-type, user, or agent icons.
- Fonts, CSS, SVG, HTML, scripts, animations, or layout definitions.
- More than one result per slot.
