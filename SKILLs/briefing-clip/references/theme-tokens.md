# Theme Tokens

## Table of Contents

1. Design principle
2. Token groups
3. Starter preset
4. Usage rules

## Design Principle

Blocks own structure. Themes own appearance.

Every clipping page should be able to swap palette, radius, spacing, texture, and fonts without rewriting block markup.

Typography direction is a page-level decision. A single page should read as one system: `serif-led`, `sans-led`, or `handwritten-led`.

## Token Groups

Use this theme shape:

```json
{
  "preset": "paperwhisper-warm-redline",
  "tokens": {
    "color": {},
    "radius": {},
    "type": {},
    "space": {},
    "shadow": {},
    "texture": {}
  }
}
```

Recommended groups:

- `color`: background, surface, ink, muted, accent, line, soft accent
- `radius`: card, chip, rule
- `type`: display, body, label
- `space`: xs, sm, md, lg, xl
- `shadow`: paper, lift
- `texture`: paper noise, edge softness, wash opacity

Typography guidance:

- `display`, `body`, and `label` may use different stacks only if they stay within the same direction.
- Do not mix serif and sans-serif within the same page-level theme.
- Do not add handwritten display text on an otherwise serif-led or sans-led page.
- Reserve monospace for code, commands, and literal technical snippets.

## Starter Presets

### `paperwhisper-warm-ledger`

- warm beige page background
- off-white paper cards
- deep ink text
- muted red accent with blue/green supporting chips
- soft paper shadow
- `serif-led`: display and body should both stay in a Songti / bookish serif family

Use for: daily clipping, community digests, scrapbook-like editorial pages.

### `editorial-tldr-bold`

- cool off-white background
- sharper cards and stronger rules
- high-contrast charcoal ink
- restrained blue accent
- bolder typography and lower ornament
- `sans-led`: display and body stay in a clean editorial sans family

Use for: analysis briefs, research roundups, executive TL;DR pages.

### `curator-mosaic-soft`

- soft gallery-like background wash
- rounded pastel surfaces
- gentler shadows and more playful spacing
- rose/teal accents
- editorial but more curated and lifestyle-oriented
- `handwritten-led`: display and body stay in the same handwritten / notebook family

Use for: mixed-source digests, inspiration roundups, creator briefings.

### `travel-notes-paper`

- kraft-paper background
- warm cream cards with soft torn edges
- travel-note colors like ochre, moss, and muted teal
- slightly playful spacing and friendlier Chinese headings
- `handwritten-led`: keep the page in one notebook-like handwriting family

Use for: travel guides, life notes, recommendations, field notebooks.

### `deep-tech-nocturne`

- dark navy to indigo background
- glassy panels with subtle glow
- bright accent colors for metrics and category chips
- monospace-friendly code and command blocks
- `sans-led`: keep headline and body in one technical sans system

Use for: technical explainers, concept primers, command cheat sheets.

### `daily-brief-clean`

- white editorial background
- crisp separators and colored category labels
- restrained emphasis blocks for comments and quotes
- stronger vertical rhythm for daily brief formats
- `sans-led`: keep the page typographically clean and uniform

Use for: industry briefs, AI dailies, community roundups.

### `playbook-brutal-lite`

- pale background with bold outlines
- high-contrast color blocks
- poster-like hierarchy and playful emphasis stickers
- stronger comparison and checklist components
- `sans-led`: typography should stay poster-like but not mix serif or handwritten accents

Use for: playbooks, tutorials, visual guides, framework explainers.

## Usage Rules

- Put brand or visual-system changes in `theme`, not block CSS.
- Let variants change composition, not color ownership.
- Keep accent colors coordinated across chips, rules, bullets, and counters.
- Use texture lightly; the clipping should feel tactile, not distressed.
- Choose one typography direction for the whole page and keep it consistent across display, body, labels, chips, and footer.
- If a preset is `serif-led`, `sans-led`, or `handwritten-led`, preserve that direction unless the user explicitly asks to change the entire page system.
- Monospace is an exception only for code or command content, not for decorative emphasis.
- Pair presets with different variant mixes:
  - `paperwhisper-warm-ledger`: `paper-slip`, `redline-note`, `pink-stack`
  - `editorial-tldr-bold`: `compact-ledger`, `ledger-panel`, `triple-counter`, `margin-quotes`
  - `curator-mosaic-soft`: `stamp-tags`, `paper-slip`, `icon-list`, `pink-stack`
