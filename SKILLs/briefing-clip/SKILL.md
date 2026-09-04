---
name: briefing-clip
description: Generate clipping-style long images from structured block JSON using the built-in template and the project's existing Playwright capture path. Keep style presets, force stable layout internally, and default to one final PNG output.
official: true
---

# Briefing Clip

Use this skill when the user wants a clipping-style long image, editorial brief, paper-like digest, or shareable briefing PNG.

## What This Skill Does

- Keeps the clipping template, references, and scripts bundled inside the skill.
- Preserves the `style` / preset parameter.
- Does **not** expose `stable` / `expressive` as a user-facing parameter.
- Always renders with stable layout rules internally.
- Uses the bundled headless capture script for screenshot generation.
- Defaults to a single final PNG output.

## Output Contract

Default output is one PNG file. Do not scaffold a persistent workspace unless the user explicitly asks for debug artifacts.

When replying with the result, prefer:

```markdown
已生成剪报：

![剪报结果](/absolute/path/to/output.png)
```

## Preferred Workflow

1. Read the source material.
2. Distill it into typed `blocks` JSON.
3. Choose or confirm a `style` preset.
4. Run the bundled script to generate the PNG.
5. Reply with the local PNG path as a Markdown image.

## Presets

- `paperwhisper-warm-ledger`
- `editorial-tldr-bold`
- `curator-mosaic-soft`
- `travel-notes-paper`
- `deep-tech-nocturne`
- `daily-brief-clean`
- `playbook-brutal-lite`

If the user does not specify a preset, use `paperwhisper-warm-ledger`.

## Important Rules

- Keep layout freedom fixed to stable. Do not ask the user to choose between `stable` and `expressive`.
- Reuse the built-in scripts on every run.
- Avoid creating long-lived output folders.
- Do not install dependencies as part of normal clipping generation.
- Keep only the final PNG unless the user explicitly asks to keep debug artifacts.
- Do not call the `browser` tool directly for clipping capture.
- Do not use `browser start`, `browser navigate`, `browser snapshot`, or `browser screenshot` for this skill.
- Always invoke the bundled generator script from Bash or Node so the built-in headless capture path is used.

## Scripts

Render and capture from structured block JSON:

```bash
node "$SKILLS_ROOT/briefing-clip/scripts/generate-briefing-clip.js" \
  --output /absolute/path/to/output.png \
  --preset paperwhisper-warm-ledger \
  --input-file /absolute/path/to/clip-data.json
```

Or pipe JSON directly:

```bash
cat /absolute/path/to/clip-data.json | node "$SKILLS_ROOT/briefing-clip/scripts/generate-briefing-clip.js" \
  --output /absolute/path/to/output.png \
  --preset paperwhisper-warm-ledger
```

Debug mode keeps temporary render files:

```bash
node "$SKILLS_ROOT/briefing-clip/scripts/generate-briefing-clip.js" \
  --output /absolute/path/to/output.png \
  --preset paperwhisper-warm-ledger \
  --input-file /absolute/path/to/clip-data.json \
  --debug
```

## References

- `references/workflow.md`
- `references/block-schema.md`
- `references/composition-rules.md`
- `references/theme-tokens.md`

Read only what you need. Use the bundled scripts rather than recreating the render pipeline by hand.
