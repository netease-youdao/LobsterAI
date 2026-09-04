# Composition Rules

## Table of Contents

1. Selection rules
2. Variant rotation
3. Density rhythm
4. Long-image sequencing
5. Freedom levels

## Selection Rules

Choose the lightest block that preserves the editorial point:

- Use `section-card` for the main narrative units.
- Use `bullet-note` for short miscellany or low-stakes observations.
- Use `metric-strip` when numbers are the visual hook.
- Use `quote-stack` when memorable lines are the payload.
- Use `divider` to create breathing room or chapter shifts.
- Use `stat-band` when a page needs a quick numerical topline.
- Use `timeline-card` for day-by-day or step-by-step information.
- Use `checklist-card` for preparation, setup, or to-do content.
- Use `comparison-card` when the article has explicit contrasts.
- Use `code-card` for command references or configuration examples.
- Use `news-stream` for multiple short headline items in one section.
- Use `tip-box` for practical advice and caution lists.

## Variant Rotation

- Do not place the same `type` and `variant` next to each other when a sibling variant can carry the same content.
- When the page already has one dominant block style, choose a quieter sibling variant next.
- Use `tone` changes sparingly; rely on layout differences before color emphasis.

## Density Rhythm

Use a wave rather than a wall:

- dense -> dense -> light
- hero -> tags -> main story -> divider -> main story -> light note -> quotes -> footer

Practical rules:

- keep no more than two dense blocks in a row
- keep accent-tone blocks below one third of the page
- follow metric-heavy blocks with prose or quote blocks

## Long-Image Sequencing

Recommended order:

1. `masthead`
2. optional `tag-row`
3. 2-4 core content blocks
4. optional `divider`
5. lighter closing content such as `quote-stack` or `bullet-note`
6. `footer-mark`

When the source is very chatty or community-driven:

- increase `bullet-note` usage
- keep `section-card` count lower
- use `quote-stack` near the end for personality

## Freedom Levels

Use freedom level to decide how far the composition can drift from the default editorial skeleton.

### `stable`

Use when:

- the content is dense, factual, or summary-heavy
- the user wants a safer result
- readability matters more than stylistic surprise

Rules:

- keep the recommended top-to-bottom sequence mostly intact
- keep most cards near full width
- use width changes sparingly, at most one visibly narrower block every 2-3 cards
- rotate variants, but prefer quieter siblings
- avoid stacking two unusual layouts back-to-back

### `expressive`

Use when:

- the user says “自由一点”, “更有设计感”, “别太规整”, or similar
- the article is conceptual, editorial, or creator-facing
- the page should feel more curated than report-like

Rules:

- allow hero cards, narrow cards, and offset rhythm more often
- mix widths deliberately, for example `92% -> 100% -> 84% -> 96%`
- use stronger sibling variants before using tone changes
- let one or two cards feel dominant on purpose
- allow closing blocks to become lighter, more personal, or more poster-like

Practical guardrails:

- do not make every block a special layout
- keep at least one full-width anchor card every 2-3 blocks
- do not sacrifice readability just to increase variation
- trim copy before forcing a dense expressive block

## Preset Recipes

Use these as strong defaults:

- `paperwhisper-warm-ledger`
  - `masthead`: `centered-stamp`
  - `tag-row`: `flag-tabs`
  - `section-card`: alternate `paper-slip` and `redline-note`
  - `quote-stack`: `pink-stack`
- `editorial-tldr-bold`
  - `masthead`: `compact-ledger`
  - `tag-row`: `stamp-tags`
  - `section-card`: prefer `ledger-panel`
  - `metric-strip`: `triple-counter`
  - `quote-stack`: `margin-quotes`
- `curator-mosaic-soft`
  - `masthead`: `centered-stamp`
  - `tag-row`: `stamp-tags`
  - `section-card`: mix `paper-slip` and `ledger-panel`
  - `bullet-note`: `icon-list`
  - `quote-stack`: `pink-stack`
- `travel-notes-paper`
  - `checklist-card`: `paper-checks`
  - `timeline-card`: `day-steps`
  - `tip-box`: `advice-board`
- `deep-tech-nocturne`
  - `metric-strip`: `triple-counter`
  - `timeline-card`: `phase-ladder`
  - `code-card`: `terminal-panel`
- `daily-brief-clean`
  - `stat-band`: `daily-totals`
  - `news-stream`: `daily-stream`
  - `callout-quote`: `inline-pull`
- `playbook-brutal-lite`
  - `comparison-card`: `split-verdict`
  - `checklist-card`: `setup-checks`
  - `code-card`: `token-sheet`
