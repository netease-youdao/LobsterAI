---
title: Agent Model Selection for OpenClaw
date: 2026-04-03
tags:
  - superpowers-spec
  - cowork
  - agent
  - openclaw
scope:
  - src/renderer/components/agent/
  - src/renderer/components/cowork/
  - src/renderer/services/agent.ts
  - src/main/libs/openclawConfigSync.ts
  - src/main/coworkStore.ts
---

# Agent Model Selection for OpenClaw

## Overview

Bind a default model to each Agent for the OpenClaw engine. The current Agent controls the model shown in the Cowork top-left model selector, and changing that selector updates the Agent's default model rather than a per-session override.

## Problem

The codebase already stores `agents.model`, but the product behavior is still effectively global-model driven. Users can switch between Agents, but cannot rely on each Agent to carry its own model choice in OpenClaw. This creates a mismatch between the Agent abstraction and runtime behavior.

## Goals

1. Each Agent has a single default model persisted in `agents.model`.
2. In `openclaw`, the top-left model selector reflects and edits the current Agent's model.
3. Model changes apply to all sessions under that Agent, including old sessions when they continue.
4. The UX treats model selection as direct Agent configuration, not a session-level override.

## Non-Goals

1. No session-level model customization.
2. No model snapshot stored on sessions.
3. No behavior changes for `yd_cowork`.
4. No cross-engine unification of Agent model semantics.
5. No migration that rewrites historical session data.

## Confirmed Product Decisions

### Interaction Model

1. The only model ownership level introduced by this feature is `agent`.
2. When the user is on an Agent tab, the Cowork top-left model selector shows that Agent's model.
3. Existing Agents without `model` are migrated to explicit Agent models at startup using the current global default only when the provider resolution is unambiguous.
4. Changing the model in the top-left selector updates the current Agent's default model.
5. The change affects all sessions under that Agent.
6. There is no concept of a temporary per-session model override.

### Engine Scope

This feature applies only to `openclaw`.

1. `openclaw` uses `agent.model` when available.
2. `yd_cowork` keeps its current global-model behavior unchanged.
3. UI copy must clearly state that Agent default model settings only take effect in OpenClaw.

### Existing Session Behavior

Because there is no session-level model field:

1. Old sessions do not keep the model they were originally created with.
2. Continuing an old OpenClaw session always resolves the current `agent.model`.
3. If the user changes an Agent's model, all sessions under that Agent follow the new model on future execution.

## Data Model

### Source of Truth

`agents.model` remains the sole persisted source of truth.

No new fields are added to:

1. `cowork_sessions`
2. `cowork_messages`
3. renderer session state

### Resolution Rule

For OpenClaw runtime resolution:

1. Use `agent.model` if non-empty.
2. Otherwise fall back to the global default model.
3. If the resolved model is unavailable or invalid, block execution and ask the user to choose a valid model for the current Agent.

## UI Design

### Cowork Top-Left Model Selector

In OpenClaw mode:

1. The selector value is bound to the current Agent.
2. Switching Agent updates the selector display immediately.
3. Changing the selector updates the current Agent's `model`.

In non-OpenClaw mode:

1. Existing behavior remains unchanged.
2. The selector must not imply Agent-level model binding.

### Confirmation and Explanatory Copy

No confirmation prompt is shown when the user changes the current Agent model from Cowork.

Requirements:

1. The top-left selector and the input-area selector both update the current Agent immediately.
2. The UI copy around Agent settings should continue to label the field as `Agent Default Model`.
3. The product does not introduce a separate warning gate for Agent-level model changes.

### Agent Management Screens

Agent creation and settings screens add an explicit `Agent Default Model` field.

Requirements:

1. The field uses the existing model selection source.
2. The label should communicate that this is the Agent's default model.
3. Helper text should state that the setting only applies to OpenClaw.

## Runtime Design

### OpenClaw Config Sync

OpenClaw already supports per-Agent structures, but the current sync only emits Agent identity and skills. The sync needs to also emit each Agent's resolved model.

Required change:

1. Extend `buildAgentsList()` so each enabled non-main Agent can include model configuration.
2. Ensure the `main` Agent also follows the same resolution rule through its defaults.
3. Preserve the existing fallback to the global default model when `agent.model` is empty.

### Session Execution Semantics

OpenClaw session execution should continue to use `agentId` as the Agent selector.

The actual model used for execution is not stored on the session. Instead:

1. session -> agentId
2. agentId -> current agent record
3. agent record -> `model` or fallback
4. resolved model -> OpenClaw execution config

This keeps the model behavior consistent for both new and existing sessions.

## Error Handling

### Missing Agent Model

If `agent.model` is empty on historical data:

1. try to migrate it to an explicit Agent model during startup
2. use the global default model only as the migration source for empty values, not as a persistent UI fallback mode

### Invalid Agent Model

If the Agent references a model that no longer exists:

1. do not silently choose another arbitrary model
2. block execution in OpenClaw
3. show an actionable message telling the user to reselect a valid model for the current Agent

### Engine Mismatch

If the current engine is not OpenClaw:

1. Agent default model behavior does not apply
2. UI should avoid misleading wording implying otherwise

## Implementation Boundaries

The intended implementation surface is:

1. Agent create modal
2. Agent settings panel
3. Cowork model selector behavior in OpenClaw mode
4. Agent service/store plumbing for persisting `model`
5. OpenClaw config sync for per-Agent model emission
6. Validation and user-facing error states for invalid Agent model references

The intended implementation surface explicitly excludes:

1. `yd_cowork` runtime changes
2. session schema changes
3. session-level model overrides
4. multi-level override precedence beyond `agent.model -> global default`

## Acceptance Criteria

1. In OpenClaw mode, switching to different Agents updates the top-left model selector to each Agent's model.
2. In OpenClaw mode, changing the top-left selector updates the current Agent's persisted `model`.
3. Changing the top-left selector does not require a confirmation prompt.
4. Creating a new session under an Agent uses that Agent's model.
5. Continuing an old session under an Agent also uses that Agent's current model.
6. Historical empty Agent models are migrated to explicit values during startup.
7. Bare historical model ids are auto-qualified only when the provider match is unique; ambiguous matches are left unchanged and warned.
8. If an Agent's configured model is invalid, OpenClaw execution is blocked with a clear corrective message.
9. In `yd_cowork`, current model behavior remains unchanged.
10. Agent create and edit flows both expose `Agent Default Model` with text indicating it is OpenClaw-only.

## Risks

1. If model availability changes dynamically, stale Agent model values can become invalid and must fail clearly.
2. Historical bare model ids with multiple provider matches require manual user re-selection to become fully explicit.

## Open Questions Resolved

1. Session-level model customization: not supported.
2. Old vs new session divergence after Agent model change: not supported; all sessions under the Agent follow the same model.
3. Engine scope: OpenClaw only.
