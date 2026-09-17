# Block Schema

## Table of Contents

1. Top-level contract
2. Shared block fields
3. Block types
4. Variant catalog
5. Example payload

## Top-Level Contract

```json
{
  "meta": {
    "title": "string",
    "subtitle": "string",
    "date_label": "string",
    "edition": "string",
    "source_note": "string"
  },
  "theme": {
    "preset": "string",
    "tokens": {}
  },
  "layout": {
    "canvas_width": 720,
    "spacing_scale": "comfortable",
    "freedom": "stable"
  },
  "blocks": []
}
```

Layout guidance:

- `freedom`: optional, supports `stable` or `expressive`
- `stable`: safer, more regular layout rhythm
- `expressive`: more width changes, offset rhythm, and stronger visual hierarchy

## Shared Block Fields

Every block uses this shape:

```json
{
  "id": "string",
  "type": "string",
  "variant": "string",
  "tone": "neutral",
  "props": {}
}
```

Guidance:

- `type`: choose the block primitive
- `variant`: choose the layout flavor for that type
- `tone`: optional semantic tone such as `neutral`, `soft`, or `accent`
- `props`: content only, plus local layout hints that do not override theme tokens

## Block Types

### `masthead`

Purpose: title block for page identity.

Props:

```json
{
  "title": "string",
  "subtitle": "string",
  "date_label": "string",
  "meta_line": "string"
}
```

### `tag-row`

Purpose: short chips or tab-like tags.

Props:

```json
{
  "items": [
    {
      "label": "string",
      "tone": "neutral"
    }
  ]
}
```

### `section-card`

Purpose: primary story card with heading and bullets.

Props:

```json
{
  "icon": "string",
  "title": "string",
  "intro": "string",
  "bullets": ["string"],
  "closing": "string"
}
```

### `bullet-note`

Purpose: shorter notes or miscellany.

Props:

```json
{
  "title": "string",
  "items": [
    {
      "icon": "string",
      "text": "string",
      "emphasis": "optional string"
    }
  ]
}
```

### `metric-strip`

Purpose: high-contrast number cluster plus commentary.

Props:

```json
{
  "title": "string",
  "summary": "string",
  "stats": [
    {
      "value": "string",
      "label": "string"
    }
  ],
  "bullets": ["string"],
  "closing": "string"
}
```

### `quote-stack`

Purpose: one or more standout quotes.

Props:

```json
{
  "title": "string",
  "quotes": [
    {
      "text": "string",
      "source": "string"
    }
  ]
}
```

### `divider`

Purpose: pacing break between larger cards.

Props:

```json
{
  "label": "optional string"
}
```

### `footer-mark`

Purpose: end cap for the clipping page.

Props:

```json
{
  "left": "string",
  "center": "string",
  "right": "string"
}
```

### `stat-band`

Purpose: compact horizontal summary counters.

Props:

```json
{
  "items": [
    {
      "value": "string",
      "label": "string"
    }
  ]
}
```

### `timeline-card`

Purpose: multi-step itinerary, phase list, or ordered guide.

Props:

```json
{
  "icon": "string",
  "title": "string",
  "steps": [
    {
      "label": "string",
      "heading": "string",
      "detail": "string"
    }
  ],
  "closing": "string"
}
```

### `callout-quote`

Purpose: short inline quote or highlighted statement inside the flow.

Props:

```json
{
  "quote": "string",
  "source": "string"
}
```

### `checklist-card`

Purpose: checklist, readiness list, or setup task list.

Props:

```json
{
  "icon": "string",
  "title": "string",
  "items": [
    {
      "text": "string",
      "checked": true
    }
  ]
}
```

### `comparison-card`

Purpose: side-by-side contrast between two options or states.

Props:

```json
{
  "icon": "string",
  "title": "string",
  "left": {
    "title": "string",
    "items": ["string"]
  },
  "right": {
    "title": "string",
    "items": ["string"]
  }
}
```

### `code-card`

Purpose: commands, code snippets, config examples, or token examples.

Props:

```json
{
  "icon": "string",
  "title": "string",
  "language": "string",
  "code": "string"
}
```

### `news-stream`

Purpose: daily-brief style item flow for multiple short news entries.

Props:

```json
{
  "title": "string",
  "items": [
    {
      "tag": "string",
      "heading": "string",
      "summary": "string",
      "quote": "optional string",
      "quote_source": "optional string"
    }
  ]
}
```

### `tip-box`

Purpose: practical advice, tricks, or pitfalls.

Props:

```json
{
  "icon": "string",
  "title": "string",
  "items": [
    {
      "label": "string",
      "text": "string"
    }
  ],
  "closing": "string"
}
```

## Variant Catalog

- `masthead`: `centered-stamp`, `compact-ledger`
- `tag-row`: `flag-tabs`, `stamp-tags`
- `section-card`: `paper-slip`, `redline-note`, `ledger-panel`
- `bullet-note`: `loose-list`, `icon-list`
- `metric-strip`: `triple-counter`, `swing-board`
- `quote-stack`: `pink-stack`, `margin-quotes`
- `divider`: `stitched-line`, `tiny-ornament`
- `footer-mark`: `edition-footer`, `double-rule-footer`
- `stat-band`: `headline-strip`, `daily-totals`
- `timeline-card`: `day-steps`, `phase-ladder`
- `callout-quote`: `inline-pull`, `soft-banner`
- `checklist-card`: `paper-checks`, `setup-checks`
- `comparison-card`: `split-verdict`, `before-after`
- `code-card`: `terminal-panel`, `token-sheet`
- `news-stream`: `daily-stream`, `commentary-stream`
- `tip-box`: `advice-board`, `pitfall-board`

## Example Payload

```json
{
  "meta": {
    "title": "Signal Ledger",
    "subtitle": "A daily clipping brief",
    "date_label": "2026-03-23",
    "edition": "Morning issue",
    "source_note": "Compiled from curated notes and links."
  },
  "theme": {
    "preset": "paperwhisper-warm-redline"
  },
  "layout": {
    "canvas_width": 720,
    "spacing_scale": "comfortable"
  },
  "blocks": [
    {
      "id": "masthead-1",
      "type": "masthead",
      "variant": "centered-stamp",
      "props": {
        "title": "Signal Ledger",
        "subtitle": "A daily clipping brief",
        "date_label": "2026-03-23",
        "meta_line": "editorial clipping"
      }
    }
  ]
}
```
