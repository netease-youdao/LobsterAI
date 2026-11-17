# Renderer

Guidance for `src/renderer/`. Repository-wide rules are in the root
`AGENTS.md`. Paths below are relative to `src/renderer/` unless they start with
`src/`.

The renderer is React + Redux Toolkit + Tailwind. It has no Node access: it
reaches the main process only through `window.electron`, which is typed in
`types/electron.d.ts` and implemented in `src/main/preload.ts`.

## Map

- `App.tsx`: top-level app state and view routing.
- `services/cowork.ts`: Cowork IPC wrapper, Redux integration, and stream
  listener orchestration.
- `store/slices/coworkSlice.ts`: Cowork session and streaming state.
- `store/slices/agentSlice.ts`: agent state.
- `store/slices/artifactSlice.ts`: artifact state.
- `components/cowork/`: main Cowork UI, prompt input, session detail,
  permissions, thinking/tool display, context usage, forks, media, and voice
  input.
- `components/agent/`: agent creation and settings UI.
- `components/agentSidebar/`: agent/session tree and subagent session UI.
- `components/artifacts/`: artifact panel, badges, preview cards, renderers,
  and file directory view.
- `services/office/` and `components/artifacts/renderers/office/`: Office
  editor sessions, agent handlers, editor shell, toolbars, and previews. The
  editor table is `OFFICE_EDITORS` in `src/shared/office/`.
- `components/scheduledTasks/`: scheduled task list, form, detail, run history,
  and template UI.
- `components/im/`: IM platform settings and multi-instance UI.
- `components/skills/`: skill management UI.
- `components/mcp/`: MCP management UI.
- `services/i18n.ts`: renderer i18n dictionary and `t()` helper.

Other features have their own component directories (`pptCreation/`,
`imageCreation/`, `library/`, `kits/`, `experts/`, `desktopCompanion/`, and
more). List `components/` rather than treating this map as complete.

Import aliases: `@/` is `src/renderer/` and `@shared/` is `src/shared/`. Both
resolve in Vite, `tsc`, and Vitest.

## i18n Dictionary

`services/i18n.ts` holds one `translations` object with a `zh` block followed
by an `en` block, about 5k lines each. Search for a neighbouring key instead of
reading the file, and add every new key to both blocks.

## Testing

Vitest runs in a Node environment and collects only `*.test.ts`. There is no
DOM and no component-rendering library, so a `.test.tsx` file never runs. Move
logic worth testing into `services/`, slices, or plain helper modules and test
it there; check rendering and interaction in `npm run electron:dev`.

## Artifacts

Artifacts are parsed by `services/artifactParser.ts` and rendered under
`components/artifacts/`. The previewable types are the values of
`ArtifactTypeValue` in `types/artifact.ts`: `html`, `svg`, `image`, `video`,
`mermaid`, `code`, `markdown`, `text`, `document`, and `local-service`.

- HTML file artifacts use a local preview server for fidelity. Inline HTML uses
  an iframe sandbox.
- SVG and file previews must stay sanitized and isolated.
- Document and Office-style renderers live under
  `components/artifacts/renderers/`.
