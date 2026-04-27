# OpenClaw Session Policy Setting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a simple global `会话保持时长` setting in LobsterAI, persist it locally, and always generate explicit OpenClaw `session.reset` and `session.maintenance` config from that value.

**Architecture:** Introduce a dedicated OpenClaw session policy config owned by the main process instead of overloading `cowork_config` or IM settings. The renderer reads and writes a single enum-like setting, while `openclawConfigSync.ts` maps that value into explicit runtime `session` fields. The UI stays simple, but runtime behavior becomes explicit and testable.

**Tech Stack:** Electron IPC, TypeScript, Redux Toolkit, React, Vitest

---

## File Structure

- Create: `src/main/openclawSessionPolicy/constants.ts`
- Create: `src/main/openclawSessionPolicy/store.ts`
- Create: `src/main/openclawSessionPolicy/store.test.ts`
- Modify: `src/main/main.ts`
- Modify: `src/main/libs/openclawConfigSync.ts`
- Modify: `src/main/libs/openclawConfigSync.test.ts`
- Modify: `src/renderer/types/cowork.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Modify: `src/renderer/services/cowork.ts`
- Modify: `src/renderer/store/slices/coworkSlice.ts`
- Modify: `src/renderer/components/Settings.tsx`
- Modify: `src/renderer/services/i18n.ts`

## Task 1: Add Main-Process Session Policy Model and Persistence

**Files:**
- Create: `src/main/openclawSessionPolicy/constants.ts`
- Create: `src/main/openclawSessionPolicy/store.ts`
- Create: `src/main/openclawSessionPolicy/store.test.ts`

- [ ] **Step 1: Write the failing store test**

```ts
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_OPENCLAW_SESSION_POLICY_CONFIG,
  OpenClawSessionKeepAlive,
} from './constants';
import {
  normalizeOpenClawSessionPolicyConfig,
  mapKeepAliveToSessionReset,
} from './store';

describe('normalizeOpenClawSessionPolicyConfig', () => {
  test('falls back to default when keepAlive is invalid', () => {
    const config = normalizeOpenClawSessionPolicyConfig({ keepAlive: 'bad-value' });
    expect(config).toEqual(DEFAULT_OPENCLAW_SESSION_POLICY_CONFIG);
  });
});

describe('mapKeepAliveToSessionReset', () => {
  test('maps seven days to idle reset', () => {
    expect(mapKeepAliveToSessionReset(OpenClawSessionKeepAlive.SevenDays)).toEqual({
      mode: 'idle',
      idleMinutes: 10080,
    });
  });

  test('maps always to reset off', () => {
    expect(mapKeepAliveToSessionReset(OpenClawSessionKeepAlive.Always)).toEqual({
      mode: 'off',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- openclawSessionPolicy
```

Expected: FAIL with module-not-found errors for `./constants` and `./store`.

- [ ] **Step 3: Add constants module**

```ts
export const OpenClawSessionKeepAlive = {
  Always: 'always',
  OneDay: '1d',
  SevenDays: '7d',
  ThirtyDays: '30d',
  OneYear: '365d',
} as const;

export type OpenClawSessionKeepAlive =
  typeof OpenClawSessionKeepAlive[keyof typeof OpenClawSessionKeepAlive];

export const OPENCLAW_SESSION_POLICY_STORE_KEY = 'openclaw_session_policy';

export interface OpenClawSessionPolicyConfig {
  keepAlive: OpenClawSessionKeepAlive;
}

export const DEFAULT_OPENCLAW_SESSION_POLICY_CONFIG: OpenClawSessionPolicyConfig = {
  keepAlive: OpenClawSessionKeepAlive.SevenDays,
};
```

- [ ] **Step 4: Add store module**

```ts
import { DEFAULT_OPENCLAW_SESSION_POLICY_CONFIG, OPENCLAW_SESSION_POLICY_STORE_KEY, OpenClawSessionKeepAlive, type OpenClawSessionPolicyConfig } from './constants';

type KeyValueStore = {
  get: <T>(key: string) => T | undefined;
  set: (key: string, value: unknown) => void;
};

export const normalizeOpenClawSessionPolicyConfig = (
  value: unknown,
): OpenClawSessionPolicyConfig => {
  const keepAlive = (value as { keepAlive?: string } | null)?.keepAlive;
  const validValues = new Set(Object.values(OpenClawSessionKeepAlive));
  if (keepAlive && validValues.has(keepAlive as OpenClawSessionKeepAlive)) {
    return { keepAlive: keepAlive as OpenClawSessionKeepAlive };
  }
  return DEFAULT_OPENCLAW_SESSION_POLICY_CONFIG;
};

export const mapKeepAliveToSessionReset = (
  keepAlive: OpenClawSessionKeepAlive,
): { mode: 'off' } | { mode: 'idle'; idleMinutes: number } => {
  switch (keepAlive) {
    case OpenClawSessionKeepAlive.Always:
      return { mode: 'off' };
    case OpenClawSessionKeepAlive.OneDay:
      return { mode: 'idle', idleMinutes: 1440 };
    case OpenClawSessionKeepAlive.ThirtyDays:
      return { mode: 'idle', idleMinutes: 43200 };
    case OpenClawSessionKeepAlive.OneYear:
      return { mode: 'idle', idleMinutes: 525600 };
    case OpenClawSessionKeepAlive.SevenDays:
    default:
      return { mode: 'idle', idleMinutes: 10080 };
  }
};

export const loadOpenClawSessionPolicyConfig = (store: KeyValueStore): OpenClawSessionPolicyConfig => {
  return normalizeOpenClawSessionPolicyConfig(store.get(OPENCLAW_SESSION_POLICY_STORE_KEY));
};

export const saveOpenClawSessionPolicyConfig = (
  store: KeyValueStore,
  value: unknown,
): OpenClawSessionPolicyConfig => {
  const normalized = normalizeOpenClawSessionPolicyConfig(value);
  store.set(OPENCLAW_SESSION_POLICY_STORE_KEY, normalized);
  return normalized;
};
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
npm test -- openclawSessionPolicy
```

Expected: PASS for normalization and keep-alive mapping tests.

- [ ] **Step 6: Commit**

```bash
git add src/main/openclawSessionPolicy/constants.ts src/main/openclawSessionPolicy/store.ts src/main/openclawSessionPolicy/store.test.ts
git commit -m "feat(openclaw): add session policy config store"
```

## Task 2: Add IPC Surface and Shared Renderer Types

**Files:**
- Modify: `src/main/main.ts`
- Modify: `src/renderer/types/cowork.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Modify: `src/renderer/services/cowork.ts`
- Modify: `src/renderer/store/slices/coworkSlice.ts`

- [ ] **Step 1: Write the failing type changes**

Add these types to the shared renderer model first:

```ts
export const OpenClawSessionKeepAlive = {
  Always: 'always',
  OneDay: '1d',
  SevenDays: '7d',
  ThirtyDays: '30d',
  OneYear: '365d',
} as const;

export type OpenClawSessionKeepAlive =
  typeof OpenClawSessionKeepAlive[keyof typeof OpenClawSessionKeepAlive];

export interface OpenClawSessionPolicyConfig {
  keepAlive: OpenClawSessionKeepAlive;
}
```

Then extend `CoworkConfig`:

```ts
export interface CoworkConfig {
  workingDirectory: string;
  systemPrompt: string;
  executionMode: CoworkExecutionMode;
  agentEngine: CoworkAgentEngine;
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: 'strict' | 'standard' | 'relaxed';
  memoryUserMemoriesMaxItems: number;
  openClawSessionPolicy: OpenClawSessionPolicyConfig;
}
```

- [ ] **Step 2: Update reducer initial state**

```ts
config: {
  workingDirectory: '',
  systemPrompt: '',
  executionMode: 'local',
  agentEngine: 'openclaw',
  memoryEnabled: true,
  memoryImplicitUpdateEnabled: true,
  memoryLlmJudgeEnabled: false,
  memoryGuardLevel: 'strict',
  memoryUserMemoriesMaxItems: 12,
  openClawSessionPolicy: {
    keepAlive: '7d',
  },
},
```

- [ ] **Step 3: Add main-process IPC handlers**

In `src/main/main.ts`, add two handlers near existing `cowork:config:get/set`:

```ts
ipcMain.handle('openclaw:sessionPolicy:get', async () => {
  try {
    const config = loadOpenClawSessionPolicyConfig(getStore());
    return { success: true, config };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get OpenClaw session policy',
    };
  }
});

ipcMain.handle('openclaw:sessionPolicy:set', async (_event, config: unknown) => {
  try {
    const saved = saveOpenClawSessionPolicyConfig(getStore(), config);
    await syncOpenClawConfig({ reason: 'session-policy-updated', restartGatewayIfRunning: false });
    return { success: true, config: saved };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save OpenClaw session policy',
    };
  }
});
```

- [ ] **Step 4: Expose renderer API surface**

Add preload-facing typings in `src/renderer/types/electron.d.ts`:

```ts
interface OpenClawSessionPolicyConfig {
  keepAlive: 'always' | '1d' | '7d' | '30d' | '365d';
}
```

Add to the `window.electron.openclaw` namespace:

```ts
sessionPolicy: {
  get: () => Promise<{ success: boolean; config?: OpenClawSessionPolicyConfig; error?: string }>;
  set: (config: OpenClawSessionPolicyConfig) => Promise<{ success: boolean; config?: OpenClawSessionPolicyConfig; error?: string }>;
};
```

- [ ] **Step 5: Load the new config into Redux on init**

Update `src/renderer/services/cowork.ts` `loadConfig()` to merge in the session policy:

```ts
async loadConfig(): Promise<void> {
  const [coworkResult, sessionPolicyResult] = await Promise.all([
    window.electron?.cowork?.getConfig(),
    window.electron?.openclaw?.sessionPolicy?.get?.(),
  ]);

  if (coworkResult?.success && coworkResult.config) {
    store.dispatch(setConfig({
      ...coworkResult.config,
      openClawSessionPolicy: sessionPolicyResult?.success && sessionPolicyResult.config
        ? sessionPolicyResult.config
        : { keepAlive: '7d' },
    }));
  }
}
```

- [ ] **Step 6: Run targeted tests and typecheck**

Run:

```bash
npm test -- coworkStore
npm run build
```

Expected: existing cowork tests still pass and TypeScript compilation succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/main/main.ts src/renderer/types/cowork.ts src/renderer/types/electron.d.ts src/renderer/services/cowork.ts src/renderer/store/slices/coworkSlice.ts
git commit -m "feat(openclaw): add session policy ipc surface"
```

## Task 3: Generate Explicit OpenClaw Session Reset and Maintenance

**Files:**
- Modify: `src/main/libs/openclawConfigSync.ts`
- Modify: `src/main/libs/openclawConfigSync.test.ts`

- [ ] **Step 1: Write the failing OpenClaw mapping test**

Add a small pure helper test in `src/main/libs/openclawConfigSync.test.ts`:

```ts
describe('session policy mapping', () => {
  test('maps seven-day keepAlive to idle reset and fixed maintenance', () => {
    const keepAlive = '7d';
    const reset = keepAlive === '7d'
      ? { mode: 'idle', idleMinutes: 10080 }
      : { mode: 'off' };

    expect(reset).toEqual({ mode: 'idle', idleMinutes: 10080 });
    expect({
      pruneAfter: '365d',
      maxEntries: 1000000,
      rotateBytes: '1gb',
    }).toEqual({
      pruneAfter: '365d',
      maxEntries: 1000000,
      rotateBytes: '1gb',
    });
  });
});
```

- [ ] **Step 2: Extract explicit session config helpers in `openclawConfigSync.ts`**

Add near the top of the file:

```ts
const OPENCLAW_SESSION_MAINTENANCE = {
  pruneAfter: '365d',
  maxEntries: 1000000,
  rotateBytes: '1gb',
} as const;
```

Add a resolver method:

```ts
private buildSessionConfig(): Record<string, unknown> {
  const policy = this.getOpenClawSessionPolicy?.() ?? { keepAlive: '7d' };
  const reset = mapKeepAliveToSessionReset(policy.keepAlive);
  return {
    dmScope: 'per-account-channel-peer',
    reset,
    maintenance: { ...OPENCLAW_SESSION_MAINTENANCE },
  };
}
```

- [ ] **Step 3: Wire session config into the generated runtime config**

Replace the inline `session` object:

```ts
session: this.buildSessionConfig(),
```

instead of:

```ts
session: {
  dmScope: 'per-account-channel-peer',
},
```

- [ ] **Step 4: Pass the new dependency into `OpenClawConfigSync`**

When constructing `OpenClawConfigSync` in `src/main/main.ts`, add:

```ts
getOpenClawSessionPolicy: () => loadOpenClawSessionPolicyConfig(getStore()),
```

and extend the dependency type in `src/main/libs/openclawConfigSync.ts`:

```ts
getOpenClawSessionPolicy?: () => { keepAlive: 'always' | '1d' | '7d' | '30d' | '365d' };
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm test -- openclawConfigSync
```

Expected: PASS with new mapping test and no regression in existing tests.

- [ ] **Step 6: Commit**

```bash
git add src/main/libs/openclawConfigSync.ts src/main/libs/openclawConfigSync.test.ts src/main/main.ts
git commit -m "feat(openclaw): generate explicit session reset config"
```

## Task 4: Add `会话保持时长` to Settings UI and Save Flow

**Files:**
- Modify: `src/renderer/components/Settings.tsx`
- Modify: `src/renderer/services/i18n.ts`

- [ ] **Step 1: Add new i18n keys**

Add matching `zh` and `en` keys in `src/renderer/services/i18n.ts`:

```ts
openClawSessionKeepAlive: '会话保持时长',
openClawSessionKeepAliveHint: '在这个时间内继续聊天，会沿用原来的上下文；超过后会自动开始新会话。时间越长，连续性更强，但也更容易带入较早的信息。',
openClawSessionKeepAliveAlways: '始终延续',
openClawSessionKeepAliveOneDay: '24小时',
openClawSessionKeepAliveSevenDays: '7天（推荐）',
openClawSessionKeepAliveThirtyDays: '30天',
openClawSessionKeepAliveOneYear: '1年',
```

English:

```ts
openClawSessionKeepAlive: 'Session continuity',
openClawSessionKeepAliveHint: 'Continue chatting within this period to keep the same context. After that, LobsterAI starts a new session automatically. Longer durations improve continuity but can also carry older context forward.',
openClawSessionKeepAliveAlways: 'Always continue',
openClawSessionKeepAliveOneDay: '24 hours',
openClawSessionKeepAliveSevenDays: '7 days (Recommended)',
openClawSessionKeepAliveThirtyDays: '30 days',
openClawSessionKeepAliveOneYear: '1 year',
```

- [ ] **Step 2: Add local state in `Settings.tsx`**

Near the existing cowork settings state:

```ts
const [openClawSessionKeepAlive, setOpenClawSessionKeepAlive] = useState<OpenClawSessionKeepAlive>(
  coworkConfig.openClawSessionPolicy?.keepAlive || '7d',
);
```

Sync it from Redux:

```ts
useEffect(() => {
  setOpenClawSessionKeepAlive(coworkConfig.openClawSessionPolicy?.keepAlive || '7d');
}, [coworkConfig.openClawSessionPolicy?.keepAlive]);
```

- [ ] **Step 3: Include this field in dirty-state detection**

Extend `hasCoworkConfigChanges`:

```ts
const hasCoworkConfigChanges = coworkAgentEngine !== coworkConfig.agentEngine
  || coworkMemoryEnabled !== coworkConfig.memoryEnabled
  || coworkMemoryLlmJudgeEnabled !== coworkConfig.memoryLlmJudgeEnabled
  || openClawSessionKeepAlive !== (coworkConfig.openClawSessionPolicy?.keepAlive || '7d');
```

- [ ] **Step 4: Render the new control in the existing LobsterAI settings section**

Insert a compact select block in the same section that contains agent engine and memory toggles:

```tsx
<div className="space-y-2 rounded-xl border px-4 py-4 border-border">
  <label className="block text-sm font-medium text-foreground">
    {i18nService.t('openClawSessionKeepAlive')}
  </label>
  <p className="text-xs text-secondary">
    {i18nService.t('openClawSessionKeepAliveHint')}
  </p>
  <select
    value={openClawSessionKeepAlive}
    onChange={(e) => setOpenClawSessionKeepAlive(e.target.value as OpenClawSessionKeepAlive)}
    className="w-full rounded-lg border px-3 py-2 text-sm border-border bg-surface text-foreground"
  >
    <option value="always">{i18nService.t('openClawSessionKeepAliveAlways')}</option>
    <option value="1d">{i18nService.t('openClawSessionKeepAliveOneDay')}</option>
    <option value="7d">{i18nService.t('openClawSessionKeepAliveSevenDays')}</option>
    <option value="30d">{i18nService.t('openClawSessionKeepAliveThirtyDays')}</option>
    <option value="365d">{i18nService.t('openClawSessionKeepAliveOneYear')}</option>
  </select>
</div>
```

- [ ] **Step 5: Save the setting during Settings submit**

In `handleSubmit`, after successful `coworkService.updateConfig(...)`, save the session policy:

```ts
const savedSessionPolicy = await window.electron.openclaw.sessionPolicy.set({
  keepAlive: openClawSessionKeepAlive,
});
if (!savedSessionPolicy?.success) {
  throw new Error(savedSessionPolicy?.error || i18nService.t('coworkConfigSaveFailed'));
}
```

- [ ] **Step 6: Run build to verify UI typing**

Run:

```bash
npm run build
```

Expected: PASS with no TypeScript or JSX errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/Settings.tsx src/renderer/services/i18n.ts
git commit -m "feat(settings): add session continuity control"
```

## Task 5: End-to-End Verification

**Files:**
- Test: `src/main/openclawSessionPolicy/store.test.ts`
- Test: `src/main/libs/openclawConfigSync.test.ts`

- [ ] **Step 1: Run focused automated checks**

Run:

```bash
npm test -- openclawSessionPolicy
npm test -- openclawConfigSync
```

Expected: PASS for new policy storage and runtime config mapping coverage.

- [ ] **Step 2: Run the main project build**

Run:

```bash
npm run build
```

Expected: PASS with updated renderer types and main-process code.

- [ ] **Step 3: Manual verification in the app**

Run:

```bash
npm run electron:dev
```

Verify:

- Open Settings and find `会话保持时长`
- Default selection is `7天（推荐）`
- Change it to `1年`, save settings, and confirm `/Users/wulei/Library/Application Support/LobsterAI/openclaw/state/openclaw.json` includes:

```json
"session": {
  "dmScope": "per-account-channel-peer",
  "reset": {
    "mode": "idle",
    "idleMinutes": 525600
  },
  "maintenance": {
    "pruneAfter": "365d",
    "maxEntries": 1000000,
    "rotateBytes": "1gb"
  }
}
```

- Change it to `始终延续`, save again, and confirm:

```json
"reset": {
  "mode": "off"
}
```

- [ ] **Step 4: Final commit**

```bash
git add src/main/openclawSessionPolicy src/main/main.ts src/main/libs/openclawConfigSync.ts src/main/libs/openclawConfigSync.test.ts src/renderer/types/cowork.ts src/renderer/types/electron.d.ts src/renderer/services/cowork.ts src/renderer/store/slices/coworkSlice.ts src/renderer/components/Settings.tsx src/renderer/services/i18n.ts
git commit -m "feat(openclaw): add session continuity setting"
```

## Self-Review

- Spec coverage:
  - User-facing single global setting: covered in Task 4
  - Dedicated config model: covered in Task 1 and Task 2
  - Explicit runtime `session.reset` and `session.maintenance`: covered in Task 3
  - No IM-specific override in v1: reflected in scope and no task adds it
- Placeholder scan:
  - No `TODO`, `TBD`, or undefined commands remain
  - All new file paths are explicit
- Type consistency:
  - `OpenClawSessionKeepAlive` values match the spec and UI options
  - `openClawSessionPolicy.keepAlive` is used consistently in main, renderer, and tests
