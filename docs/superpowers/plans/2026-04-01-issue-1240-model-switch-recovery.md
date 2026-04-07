# Issue 1240 Model Switch Recovery Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issue #1240 so that after one provider/model is rate-limited, users can switch to another model or another Agent and immediately recover without restarting into a broken OpenClaw state.

**Architecture:** Treat this as a configuration propagation bug in the OpenClaw path. The fix should make model changes restart or reload the running gateway when required, make per-Agent model selection real in generated `openclaw.json`, and migrate persisted session model references so old sessions do not stay pinned to the exhausted provider.

**Tech Stack:** Electron main process, React renderer, SQLite config store, OpenClaw gateway config generation, Vitest.

---

## Current Evidence

- Issue #1240 reports that after Volcengine Coding Plan is exhausted, switching to Gemini in other task windows still shows the same limit error.
- [`src/renderer/components/ModelSelector.tsx`](/Users/leelei/.codex/worktrees/24fc/LobsterAI/src/renderer/components/ModelSelector.tsx) only changes Redux selected model.
- [`src/renderer/App.tsx`](/Users/leelei/.codex/worktrees/24fc/LobsterAI/src/renderer/App.tsx) persists the selected model to `app_config`.
- [`src/main/main.ts`](/Users/leelei/.codex/worktrees/24fc/LobsterAI/src/main/main.ts) handles `store:set('app_config')` by calling `syncOpenClawConfig({ restartGatewayIfRunning: false })`, so a running gateway can keep the old provider/model.
- [`src/main/libs/openclawConfigSync.ts`](/Users/leelei/.codex/worktrees/24fc/LobsterAI/src/main/libs/openclawConfigSync.ts) writes only `agents.defaults.model.primary`; `buildAgentsList()` does not include `agent.model`, so switching to another Agent can still use the same default model.
- [`src/main/libs/openclawConfigSync.ts`](/Users/leelei/.codex/worktrees/24fc/LobsterAI/src/main/libs/openclawConfigSync.ts) only migrates `agents/main/sessions/sessions.json` and only for a narrow `lobster -> providerId/model` case, so persisted sessions can stay pinned to the old provider.

## Task 1: Lock Down The Regression With Tests

**Files:**
- Modify: `src/main/libs/openclawConfigSync.test.ts`
- Create if needed: `src/main/libs/openclawConfigSync.sessionMigration.test.ts`
- Create if needed: `src/main/main.appConfigSync.test.ts`

- [ ] **Step 1: Add a regression test for per-Agent model emission**

Create a test that mirrors config generation expectations:
- main/default agent keeps `agents.defaults.model.primary`
- non-main agent with `agent.model = 'gemini-2.5-flash'` emits its own model override in `agents.list`

- [ ] **Step 2: Add a regression test for session-store migration**

Cover both:
- `agents/main/sessions/sessions.json`
- `agents/<agentId>/sessions/sessions.json`

Expected: sessions pinned to the old provider/model are rewritten to the newly selected provider/model when a global model switch happens.

- [ ] **Step 3: Add a regression test for app_config model changes**

Verify that changing `app_config.model.defaultModel` or `defaultModelProvider` results in a sync path that requests a gateway restart when the gateway is already running.

- [ ] **Step 4: Run only the new focused tests first**

Run:
```bash
npm test -- openclawConfigSync
```

Expected: the newly added regression cases fail before implementation.

## Task 2: Make Agent-Level Model Switching Real

**Files:**
- Modify: `src/main/libs/openclawConfigSync.ts`
- Modify if needed: `src/main/coworkStore.ts`
- Modify if needed: `src/main/presetAgents.ts`

- [ ] **Step 1: Add a helper that resolves an Agent's model into OpenClaw provider selection**

Implement a small helper in [`src/main/libs/openclawConfigSync.ts`](/Users/leelei/.codex/worktrees/24fc/LobsterAI/src/main/libs/openclawConfigSync.ts) that:
- accepts `agent.model`
- resolves provider + model identity using the same provider metadata path as the default model
- returns `model.primary` in OpenClaw format (`providerId/modelId`)

- [ ] **Step 2: Emit per-Agent model overrides in `buildAgentsList()`**

When `agent.model` is non-empty and resolvable, add:
```json
{
  "id": "agent-id",
  "model": { "primary": "provider/model" }
}
```

Keep existing identity and skills behavior intact.

- [ ] **Step 3: Decide fallback behavior**

If `agent.model` is empty or invalid:
- do not write a broken override
- fall back to `agents.defaults.model.primary`
- log one concise warning in English with the Agent id and bad model value

## Task 3: Migrate Persisted Session Model References After A Switch

**Files:**
- Modify: `src/main/libs/openclawConfigSync.ts`
- Add helper tests in: `src/main/libs/openclawConfigSync.test.ts`

- [ ] **Step 1: Generalize session-store migration**

Refactor `syncManagedSessionStore()` so it can iterate every relevant session store under:
- `agents/main/sessions/sessions.json`
- `agents/<agentId>/sessions/sessions.json`

- [ ] **Step 2: Expand migration beyond the current `lobster` special case**

When the selected default model/provider changes, rewrite stored session references that still point at the previous effective default model. This should update:
- `entry.modelProvider`
- `entry.model`
- `entry.systemPromptReport.provider`
- `entry.systemPromptReport.model`

- [ ] **Step 3: Avoid corrupting intentionally pinned sessions**

Only rewrite sessions that are effectively following the old default. Do not overwrite sessions that already point at a different explicit provider/model than the previous default.

## Task 4: Restart The Running Gateway When Model/Provider Config Changes

**Files:**
- Modify: `src/main/main.ts`
- Modify if needed: `src/renderer/App.tsx`

- [ ] **Step 1: Detect app_config changes that affect OpenClaw runtime behavior**

Inside the `store:set` handler for `app_config`, compare old vs new values and treat these as restart-relevant:
- `model.defaultModel`
- `model.defaultModelProvider`
- provider enablement
- provider API key
- provider base URL
- provider API format
- provider `codingPlanEnabled`
- provider model list changes

- [ ] **Step 2: Restart only when runtime-affecting fields changed**

Call:
```ts
syncOpenClawConfig({
  reason: 'app-config-change',
  restartGatewayIfRunning: runtimeAffectingChange,
})
```

Do not restart for unrelated UI fields such as theme, language, or shortcuts.

- [ ] **Step 3: Preserve the active-workload safety rule**

Keep the existing deferred restart behavior in [`src/main/main.ts`](/Users/leelei/.codex/worktrees/24fc/LobsterAI/src/main/main.ts) so active sessions are not interrupted immediately. The expected behavior is:
- config write happens when safe
- if workloads are active, a deferred restart is scheduled
- once workloads stop, the gateway restarts onto the new model/provider

## Task 5: Reproduce And Harden The Startup Failure Path

**Files:**
- Modify if needed: `src/main/libs/openclawConfigSync.ts`
- Modify if needed: `src/main/libs/openclawEngineManager.ts`
- Modify if needed: `src/main/main.ts`

- [ ] **Step 1: Reproduce issue #1240 startup failure locally**

Use a local config sequence that mimics:
1. start on a Coding Plan provider
2. switch to Gemini while gateway is running
3. restart the app

Capture whether the failure comes from:
- malformed generated `openclaw.json`
- unsupported provider block for the selected model
- stale session/config interaction during bootstrap

- [ ] **Step 2: Add the smallest defensive fix once reproduction is confirmed**

Possible acceptable fixes:
- validate generated `openclaw.json` before replacing the old file
- keep the previous known-good config if the new config is invalid
- surface a precise startup error instead of leaving the app unable to boot

- [ ] **Step 3: Avoid speculative hardening**

Do not add fallback complexity unless the reproduction proves this path is real.

## Task 6: Verify End-To-End Behavior

**Files:**
- Modify test files listed above

- [ ] **Step 1: Run targeted tests**

Run:
```bash
npm test -- openclawConfigSync
```

- [ ] **Step 2: Run touched main-process validation**

Run:
```bash
npm run compile:electron
```

- [ ] **Step 3: Manual regression check in the app**

Verify this exact flow:
1. configure Volcengine Coding Plan as current model
2. trigger a rate-limit style failure
3. switch model in the chat UI to Gemini
4. confirm a new Cowork session uses Gemini without app restart
5. switch to another Agent/task window with its own configured model
6. confirm that Agent uses its own model rather than the exhausted default
7. restart the app and confirm startup succeeds with the regenerated config

- [ ] **Step 4: Commit**

```bash
git add src/main/main.ts src/main/libs/openclawConfigSync.ts src/main/libs/openclawConfigSync.test.ts
git commit -m "fix(openclaw): recover model switching after provider limits"
```

## Notes For The Implementer

- Prefer a small helper for comparing old/new `app_config` runtime fields instead of scattering JSON comparisons through [`src/main/main.ts`](/Users/leelei/.codex/worktrees/24fc/LobsterAI/src/main/main.ts).
- Reuse existing provider resolution logic from [`src/main/libs/claudeSettings.ts`](/Users/leelei/.codex/worktrees/24fc/LobsterAI/src/main/libs/claudeSettings.ts) instead of inventing a second provider-matching path.
- Keep all new log messages in English and follow the repository logging rules.
- Do not change unrelated renderer UX unless reproduction proves the current UI creates misleading model-switch timing.
