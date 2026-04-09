# Agent Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind a default model to each Agent for the OpenClaw engine, surface it in the Cowork top-left model selector, and make changes apply to all sessions under that Agent.

**Architecture:** Keep `agents.model` as the only persisted source of truth. In the renderer, treat the Cowork model selector as a controlled OpenClaw-only editor for the current Agent. In the main process, extend OpenClaw config sync so each managed Agent emits its own resolved `model.primary`, falling back to the global default model when `agent.model` is empty.

**Tech Stack:** Electron, React 18, Redux Toolkit, TypeScript, Vitest

---

## File Structure

**Modify**
- `src/renderer/store/slices/agentSlice.ts`
  Keep Agent summaries rich enough to include `model`, so the Cowork UI can resolve the current Agent selection without extra IPC.
- `src/renderer/services/agent.ts`
  Preserve `model` in load/create/update flows and expose the value to Redux.
- `src/renderer/components/agent/AgentCreateModal.tsx`
  Add the `Agent Default Model` field and OpenClaw-only helper text.
- `src/renderer/components/agent/AgentSettingsPanel.tsx`
  Add editable Agent model selection for existing Agents.
- `src/renderer/components/cowork/CoworkPromptInput.tsx`
  Bind the top-left selector to the current Agent when the engine is `openclaw`, show fallback hint text, and confirm Agent-level changes before saving.
- `src/renderer/services/i18n.ts`
  Add labels, helper text, warning copy, fallback text, and invalid-model messaging.
- `src/main/libs/openclawConfigSync.ts`
  Emit per-Agent `model.primary` values into managed OpenClaw config while preserving default fallback behavior.

**Create**
- `src/renderer/components/cowork/agentModelSelection.ts`
  Pure helper for OpenClaw-only renderer logic: resolve current Agent model, detect fallback mode, and build controlled selector state.
- `src/renderer/components/cowork/agentModelSelection.test.ts`
  Unit tests for selector resolution and fallback detection.
- `src/main/libs/openclawAgentModels.ts`
  Pure helper for building OpenClaw managed Agent config entries with Agent-level model fallback.
- `src/main/libs/openclawAgentModels.test.ts`
  Unit tests for Agent model emission and fallback behavior.

## Task 1: Preserve Agent Model in Renderer State

**Files:**
- Modify: `src/renderer/store/slices/agentSlice.ts`
- Modify: `src/renderer/services/agent.ts`
- Test: `src/renderer/components/cowork/agentModelSelection.test.ts`

- [ ] **Step 1: Write the failing test for Agent model resolution inputs**

```ts
import { describe, expect, test } from 'vitest';
import type { Model } from '../../store/slices/modelSlice';
import { resolveAgentModelSelection } from './agentModelSelection';

const models: Model[] = [
  { id: 'gpt-4o', name: 'GPT-4o', providerKey: 'openai' },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', providerKey: 'anthropic' },
];

describe('resolveAgentModelSelection', () => {
  test('uses explicit agent model when present', () => {
    const result = resolveAgentModelSelection({
      agentModel: 'claude-sonnet-4',
      availableModels: models,
      fallbackModel: models[0],
      engine: 'openclaw',
    });

    expect(result.selectedModel?.id).toBe('claude-sonnet-4');
    expect(result.usesFallback).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- agentModelSelection
```

Expected: FAIL because `resolveAgentModelSelection` does not exist yet.

- [ ] **Step 3: Add Agent `model` to renderer state and IPC mapping**

Update the Agent summary shape so Redux keeps the persisted model:

```ts
interface AgentSummary {
  id: string;
  name: string;
  description: string;
  icon: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  source: 'custom' | 'preset';
  skillIds: string[];
}
```

Update `agentService.loadAgents()`, `createAgent()`, `updateAgent()`, and `addPreset()` so they preserve `model`:

```ts
store.dispatch(setAgents(agents.map((a) => ({
  id: a.id,
  name: a.name,
  description: a.description,
  icon: a.icon,
  model: a.model ?? '',
  enabled: a.enabled,
  isDefault: a.isDefault,
  source: a.source,
  skillIds: a.skillIds ?? [],
}))));
```

- [ ] **Step 4: Create the renderer helper with minimal passing logic**

Create `src/renderer/components/cowork/agentModelSelection.ts`:

```ts
import type { CoworkAgentEngine } from '../../../main/libs/agentEngine/types';
import type { Model } from '../../store/slices/modelSlice';

type ResolveAgentModelSelectionInput = {
  agentModel: string;
  availableModels: Model[];
  fallbackModel: Model | null;
  engine: CoworkAgentEngine;
};

export function resolveAgentModelSelection({
  agentModel,
  availableModels,
  fallbackModel,
  engine,
}: ResolveAgentModelSelectionInput): { selectedModel: Model | null; usesFallback: boolean } {
  if (engine !== 'openclaw') {
    return { selectedModel: fallbackModel, usesFallback: false };
  }

  const explicit = availableModels.find((model) => model.id === agentModel) ?? null;
  if (explicit) {
    return { selectedModel: explicit, usesFallback: false };
  }

  return { selectedModel: fallbackModel, usesFallback: true };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
npm test -- agentModelSelection
```

Expected: PASS with the initial helper test green.

- [ ] **Step 6: Commit**

```bash
git add \
  src/renderer/store/slices/agentSlice.ts \
  src/renderer/services/agent.ts \
  src/renderer/components/cowork/agentModelSelection.ts \
  src/renderer/components/cowork/agentModelSelection.test.ts
git commit -m "refactor(agent): preserve model in renderer state"
```

## Task 2: Add Agent Default Model Controls in Agent Screens

**Files:**
- Modify: `src/renderer/components/agent/AgentCreateModal.tsx`
- Modify: `src/renderer/components/agent/AgentSettingsPanel.tsx`
- Modify: `src/renderer/services/i18n.ts`
- Test: `src/renderer/components/cowork/agentModelSelection.test.ts`

- [ ] **Step 1: Extend the helper test for fallback semantics used by the forms**

Add:

```ts
test('falls back to the global model in openclaw when agent model is empty', () => {
  const result = resolveAgentModelSelection({
    agentModel: '',
    availableModels: models,
    fallbackModel: models[0],
    engine: 'openclaw',
  });

  expect(result.selectedModel?.id).toBe('gpt-4o');
  expect(result.usesFallback).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- agentModelSelection
```

Expected: FAIL until the helper and UI logic recognize fallback mode consistently.

- [ ] **Step 3: Add model state and controlled `ModelSelector` to Agent create/edit flows**

In `AgentCreateModal.tsx`, add local state and wire it into create:

```tsx
const [model, setModel] = useState<Model | null>(null);

const handleCreate = async () => {
  const agent = await agentService.createAgent({
    name: name.trim(),
    description: description.trim(),
    systemPrompt: systemPrompt.trim(),
    identity: identity.trim(),
    model: model?.id ?? '',
    icon: icon.trim() || undefined,
    skillIds,
  });
};
```

Render the field:

```tsx
<div>
  <label className="block text-sm font-medium text-secondary mb-1">
    {i18nService.t('agentDefaultModel')}
  </label>
  <ModelSelector
    value={model}
    onChange={setModel}
    defaultLabel={i18nService.t('agentModelUseGlobalDefault')}
  />
  <p className="mt-1 text-xs text-secondary/70">
    {i18nService.t('agentModelOpenClawOnly')}
  </p>
</div>
```

In `AgentSettingsPanel.tsx`, initialize from `a.model` and save it back through `agentService.updateAgent(...)`.

- [ ] **Step 4: Add the user-visible strings**

Add both Chinese and English keys in `src/renderer/services/i18n.ts`:

```ts
agentDefaultModel: 'Agent 默认模型',
agentModelUseGlobalDefault: '使用全局默认模型',
agentModelOpenClawOnly: '仅 OpenClaw 引擎使用此设置',
```

```ts
agentDefaultModel: 'Agent Default Model',
agentModelUseGlobalDefault: 'Use global default model',
agentModelOpenClawOnly: 'This setting only applies to the OpenClaw engine',
```

- [ ] **Step 5: Update the helper if needed and rerun the test**

Run:

```bash
npm test -- agentModelSelection
```

Expected: PASS with both explicit and fallback cases green.

- [ ] **Step 6: Manual verification**

Run:

```bash
npm run electron:dev
```

Verify:

1. Create Agent modal shows `Agent Default Model`
2. Settings panel shows existing Agent model
3. Empty selection displays the global-default label
4. Helper copy says the setting is OpenClaw-only

- [ ] **Step 7: Commit**

```bash
git add \
  src/renderer/components/agent/AgentCreateModal.tsx \
  src/renderer/components/agent/AgentSettingsPanel.tsx \
  src/renderer/services/i18n.ts \
  src/renderer/components/cowork/agentModelSelection.test.ts
git commit -m "feat(agent): add default model controls"
```

## Task 3: Bind the Cowork Top-Left Selector to the Current Agent in OpenClaw

**Files:**
- Modify: `src/renderer/components/cowork/CoworkPromptInput.tsx`
- Modify: `src/renderer/components/cowork/agentModelSelection.ts`
- Modify: `src/renderer/services/i18n.ts`
- Test: `src/renderer/components/cowork/agentModelSelection.test.ts`

- [ ] **Step 1: Write the failing tests for OpenClaw-only selector behavior**

Add:

```ts
test('uses fallback model outside openclaw without marking fallback mode', () => {
  const result = resolveAgentModelSelection({
    agentModel: 'claude-sonnet-4',
    availableModels: models,
    fallbackModel: models[0],
    engine: 'yd_cowork',
  });

  expect(result.selectedModel?.id).toBe('gpt-4o');
  expect(result.usesFallback).toBe(false);
});

test('marks invalid explicit model as fallback to global model', () => {
  const result = resolveAgentModelSelection({
    agentModel: 'deleted-model',
    availableModels: models,
    fallbackModel: models[0],
    engine: 'openclaw',
  });

  expect(result.selectedModel?.id).toBe('gpt-4o');
  expect(result.usesFallback).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- agentModelSelection
```

Expected: FAIL until engine gating and invalid-model fallback are handled.

- [ ] **Step 3: Wire `CoworkPromptInput` to current Agent + OpenClaw config**

Add selectors:

```tsx
const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
const agents = useSelector((state: RootState) => state.agent.agents);
const coworkAgentEngine = useSelector((state: RootState) => state.cowork.config.agentEngine);
const availableModels = useSelector((state: RootState) => state.model.availableModels);
const globalSelectedModel = useSelector((state: RootState) => state.model.selectedModel);

const currentAgent = agents.find((agent) => agent.id === currentAgentId);
const { selectedModel, usesFallback } = resolveAgentModelSelection({
  agentModel: currentAgent?.model ?? '',
  availableModels,
  fallbackModel: globalSelectedModel,
  engine: coworkAgentEngine,
});
```

Replace the uncontrolled selector with a controlled OpenClaw-only selector:

```tsx
{showModelSelector && !remoteManaged && (
  <ModelSelector
    dropdownDirection="up"
    value={coworkAgentEngine === 'openclaw' ? selectedModel : undefined}
    onChange={coworkAgentEngine === 'openclaw'
      ? async (nextModel) => {
          if (!currentAgent) return;
          const confirmed = window.confirm(i18nService.t('agentModelChangeWarning'));
          if (!confirmed) return;
          await agentService.updateAgent(currentAgent.id, { model: nextModel?.id ?? '' });
        }
      : undefined}
    defaultLabel={i18nService.t('agentModelUseGlobalDefault')}
  />
)}
```

Show the fallback hint only in OpenClaw when the Agent has no explicit model:

```tsx
{coworkAgentEngine === 'openclaw' && usesFallback && (
  <span className="text-xs text-secondary/70">
    {i18nService.t('agentModelFallbackHint')}
  </span>
)}
```

- [ ] **Step 4: Add warning and fallback-copy translations**

Add:

```ts
agentModelChangeWarning: '这会修改当前 Agent 的默认模型，并影响该 Agent 下所有会话。该行为仅在 OpenClaw 引擎下生效。是否继续？',
agentModelFallbackHint: '当前 Agent 未单独配置模型，正在使用全局默认模型',
```

```ts
agentModelChangeWarning: 'This changes the current Agent\\'s default model and affects all sessions under this Agent. This behavior only applies to the OpenClaw engine. Continue?',
agentModelFallbackHint: 'This Agent has no explicit model configured and is currently using the global default model',
```

- [ ] **Step 5: Update the helper and rerun tests**

Make the helper pass all four cases, then run:

```bash
npm test -- agentModelSelection
```

Expected: PASS.

- [ ] **Step 6: Manual verification**

Run:

```bash
npm run electron:dev
```

Verify:

1. In OpenClaw, switching Agent changes the selector display
2. In OpenClaw, changing the selector prompts with the Agent-level warning
3. Saving a selection updates the Agent settings panel value
4. Empty Agent model shows fallback hint text
5. In `yd_cowork`, the selector keeps current behavior and does not act as an Agent editor

- [ ] **Step 7: Commit**

```bash
git add \
  src/renderer/components/cowork/CoworkPromptInput.tsx \
  src/renderer/components/cowork/agentModelSelection.ts \
  src/renderer/components/cowork/agentModelSelection.test.ts \
  src/renderer/services/i18n.ts
git commit -m "feat(cowork): bind openclaw model selector to agent"
```

## Task 4: Emit Per-Agent Models in OpenClaw Config Sync

**Files:**
- Create: `src/main/libs/openclawAgentModels.ts`
- Create: `src/main/libs/openclawAgentModels.test.ts`
- Modify: `src/main/libs/openclawConfigSync.ts`

- [ ] **Step 1: Write the failing test for per-Agent model emission**

Create `src/main/libs/openclawAgentModels.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { buildManagedAgentEntries } from './openclawAgentModels';

describe('buildManagedAgentEntries', () => {
  test('emits explicit model.primary for enabled non-main agents', () => {
    const result = buildManagedAgentEntries({
      agents: [
        {
          id: 'writer',
          name: 'Writer',
          icon: '✍️',
          model: 'openai/gpt-4o',
          enabled: true,
          skillIds: ['docx'],
        } as any,
      ],
      fallbackPrimaryModel: 'anthropic/claude-sonnet-4',
    });

    expect(result).toContainEqual(expect.objectContaining({
      id: 'writer',
      model: { primary: 'openai/gpt-4o' },
    }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- openclawAgentModels
```

Expected: FAIL because the helper does not exist yet.

- [ ] **Step 3: Create the pure helper with fallback behavior**

Create `src/main/libs/openclawAgentModels.ts`:

```ts
import type { Agent } from '../coworkStore';

type BuildManagedAgentEntriesInput = {
  agents: Agent[];
  fallbackPrimaryModel: string;
};

export function buildManagedAgentEntries({
  agents,
  fallbackPrimaryModel,
}: BuildManagedAgentEntriesInput): Array<Record<string, unknown>> {
  return agents
    .filter((agent) => agent.id !== 'main' && agent.enabled)
    .map((agent) => ({
      id: agent.id,
      ...(agent.name || agent.icon ? {
        identity: {
          ...(agent.name ? { name: agent.name } : {}),
          ...(agent.icon ? { emoji: agent.icon } : {}),
        },
      } : {}),
      ...(agent.skillIds.length > 0 ? { skills: agent.skillIds } : {}),
      model: {
        primary: (agent.model || '').trim() || fallbackPrimaryModel,
      },
    }));
}
```

- [ ] **Step 4: Replace the inline Agent list logic in `openclawConfigSync.ts`**

Import the helper and use it from `buildAgentsList()`:

```ts
private buildAgentsList(defaultPrimaryModel: string): { list?: Array<Record<string, unknown>> } {
  const agents = this.getAgents?.() ?? [];

  const list: Array<Record<string, unknown>> = [
    {
      id: 'main',
      default: true,
    },
    ...buildManagedAgentEntries({
      agents,
      fallbackPrimaryModel: defaultPrimaryModel,
    }),
  ];

  return list.length > 0 ? { list } : {};
}
```

Update the caller to pass the resolved default primary model:

```ts
agents: {
  defaults: {
    timeoutSeconds: OPENCLAW_AGENT_TIMEOUT_SECONDS,
    model: {
      primary: providerSelection.primaryModel,
    },
    sandbox: {
      mode: sandboxMode,
    },
    ...(workspaceDir ? { workspace: path.resolve(workspaceDir) } : {}),
  },
  ...this.buildAgentsList(providerSelection.primaryModel),
},
```

- [ ] **Step 5: Add the fallback test and run both tests**

Add:

```ts
test('falls back to the default primary model when agent model is empty', () => {
  const result = buildManagedAgentEntries({
    agents: [
      {
        id: 'writer',
        name: 'Writer',
        icon: '✍️',
        model: '',
        enabled: true,
        skillIds: [],
      } as any,
    ],
    fallbackPrimaryModel: 'anthropic/claude-sonnet-4',
  });

  expect(result[0]).toMatchObject({
    id: 'writer',
    model: { primary: 'anthropic/claude-sonnet-4' },
  });
});
```

Run:

```bash
npm test -- openclawAgentModels
npm test -- openclawConfigSync
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  src/main/libs/openclawAgentModels.ts \
  src/main/libs/openclawAgentModels.test.ts \
  src/main/libs/openclawConfigSync.ts
git commit -m "feat(openclaw): sync per-agent model bindings"
```

## Task 5: Final Verification and Cleanup

**Files:**
- Modify: `docs/superpowers/plans/2026-04-03-agent-model-selection.md` (check off completed items only during execution)

- [ ] **Step 1: Run focused automated checks**

Run:

```bash
npm test -- agentModelSelection
npm test -- openclawAgentModels
npm test -- openclawConfigSync
npm run lint
```

Expected:

1. All targeted Vitest suites PASS
2. `npm run lint` exits successfully

- [ ] **Step 2: Run end-to-end manual verification in Electron**

Run:

```bash
npm run electron:dev
```

Manual checklist:

1. Switch Cowork engine to `openclaw`
2. Create two Agents with different explicit models
3. Confirm the top-left selector changes with the Agent tab
4. Change one Agent model from the selector and accept the warning
5. Continue an old session under that Agent and confirm it uses the new model
6. Clear an Agent model and confirm fallback hint text appears
7. Switch to `yd_cowork` and confirm Agent model binding does not apply there

- [ ] **Step 3: Prepare release note / PR summary text**

Use this summary:

```md
- bind the Cowork model selector to the current Agent in OpenClaw
- add Agent default model fields in create/edit flows
- sync per-Agent model.primary values into managed OpenClaw config
- preserve global fallback behavior when an Agent has no explicit model
```

- [ ] **Step 4: Commit final polish**

```bash
git add .
git commit -m "feat(cowork): support openclaw agent model selection"
```

## Self-Review

### Spec Coverage

Covered requirements:

1. Agent-level `model` remains the only persisted source of truth
2. Cowork top-left selector becomes Agent-bound in OpenClaw only
3. Agent create/edit screens expose `Agent Default Model`
4. Warning copy explains Agent-level impact
5. OpenClaw config sync emits per-Agent model values
6. Fallback to global default model remains intact
7. Invalid-model handling is explicitly part of runtime verification and UI messaging
8. `yd_cowork` behavior stays unchanged

### Placeholder Scan

No `TODO`, `TBD`, “appropriate handling”, or “similar to task N” placeholders remain in this plan.

### Type Consistency

The plan uses these stable names consistently:

1. `agent.model`
2. `resolveAgentModelSelection`
3. `buildManagedAgentEntries`
4. `Agent Default Model`
5. `agentModelChangeWarning`

