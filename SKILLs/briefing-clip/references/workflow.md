# Block Clipping Workflow

## Table of Contents

1. Workflow modes
2. Prompting for block output
3. Mapping content atoms to blocks
4. Rendering checklist
5. Screenshot checklist

## Workflow Modes

Use the lightest path that still produces stable blocks:

- Raw sources only: summarize first, then emit typed `blocks`.
- Existing notes: convert notes into content atoms, then map to blocks.
- Existing blocks JSON: skip synthesis and render immediately.
- Theme refresh request: keep `blocks` intact and update `theme` tokens or switch `theme.preset`.

The clipping skill now fixes layout freedom to `stable` internally. Do not ask the user to choose `stable` or `expressive`.

## Prompting For Block Output

Ask the model to separate editorial planning from rendering:

```text
You are preparing a long-image clipping brief built from typed blocks.

Goals:
1. Distill the source into compact editorial atoms.
2. Map each atom to the best block type.
3. Choose variants that keep the page visually varied but coherent.
4. Return valid JSON only.

Rules:
- Use top-level theme tokens for visual styling.
- Keep each block tight enough for one card.
- Prefer concise copy over exhaustive metadata.
- Use variants to change layout rhythm, not the overall design language.
- Keep one typography direction across the page: serif-led, sans-led, or handwritten-led.
- Do not mix serif, sans-serif, and handwritten families on one page. Monospace is only for code or commands.
- End with a footer-mark block.
```

## Mapping Content Atoms To Blocks

Typical mapping:

- page identity -> `masthead`
- tags or topics -> `tag-row`
- main editorial topic -> `section-card`
- shorter miscellaneous items -> `bullet-note`
- strong numeric contrast -> `metric-strip`
- memorable lines -> `quote-stack`
- transitions -> `divider`
- ending mark -> `footer-mark`

## Rendering Checklist

- Keep all visual variables at the theme level.
- Let block CSS define spacing, ornament, and internal layout only.
- Rotate variants when nearby blocks use the same type.
- Do not let every block have equal visual weight.
- Keep the page narrow enough for clipping aesthetics unless the user asks for a wide editorial sheet.
- Check typography before shipping: the page should read as one coherent serif-led, sans-led, or handwritten-led system.

## Screenshot Checklist

Default capture path:

1. Render a temporary local HTML file with the bundled clipping template.
2. Use the bundled `capture.mjs` script to drive a local browser in headless mode.
3. Capture one full-page PNG.
4. Remove temporary render files unless the user explicitly asks for debug retention.

Do not replace this flow with direct `browser` tool calls. The clipping skill must not use `browser start`, `browser navigate`, `browser snapshot`, or `browser screenshot` for capture, because that path may open a visible browser window.

Before finishing, verify:

- header spacing feels intentional
- repeated blocks do not look cloned
- dividers actually improve pacing
- footer closes the page cleanly
- typography direction is consistent across headlines, body copy, chips, and footer
- monospace appears only where the payload is actually code or commands
