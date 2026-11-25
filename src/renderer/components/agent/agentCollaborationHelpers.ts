import { SubagentCollaborationMode } from '@shared/agent';

export interface CollaborationStateSnapshot {
  mode: SubagentCollaborationMode;
  allowAgentIds: readonly string[];
}

export interface CollaborationSavePayload {
  subagentCollaborationMode: SubagentCollaborationMode;
  subagentAllowAgentIds: string[];
}

/**
 * The simplified UI exposes two choices mirroring Skill scoping:
 * - "All Agents" (`SubagentCollaborationMode.All`, default)
 * - "Selected Agents" (`SubagentCollaborationMode.Allowlist`, or legacy `Disabled`)
 */
export function isRestrictedCollaborationMode(mode: SubagentCollaborationMode): boolean {
  return mode !== SubagentCollaborationMode.All;
}

/**
 * Resolve which collaborator IDs are visibly checked in the picker.
 * Legacy `Disabled` records allow zero collaborators at runtime, so we display
 * an empty selection rather than stale saved IDs.
 */
export function getDisplayedCollaboratorIds(
  mode: SubagentCollaborationMode,
  allowAgentIds: readonly string[],
): string[] {
  if (mode !== SubagentCollaborationMode.Allowlist) {
    return [];
  }
  return [...allowAgentIds];
}

/**
 * Transition collaboration mode when the user clicks "All Agents" vs "Selected Agents".
 * Switching back to "All" keeps `allowAgentIds` in local state so toggling back
 * to "Selected" within the same edit session preserves checked choices.
 */
export function selectCollaborationScope(input: {
  currentMode: SubagentCollaborationMode;
  allowAgentIds: readonly string[];
  restricted: boolean;
}): { mode: SubagentCollaborationMode; allowAgentIds: string[] } {
  if (!input.restricted) {
    return {
      mode: SubagentCollaborationMode.All,
      allowAgentIds: [...input.allowAgentIds],
    };
  }
  if (input.currentMode === SubagentCollaborationMode.Disabled) {
    return {
      mode: SubagentCollaborationMode.Disabled,
      allowAgentIds: [...input.allowAgentIds],
    };
  }
  return {
    mode: SubagentCollaborationMode.Allowlist,
    allowAgentIds: [...input.allowAgentIds],
  };
}

/**
 * Toggle a single candidate agent inside the "Selected Agents" picker.
 * Toggling an agent on a legacy `Disabled` record promotes it cleanly to
 * `Allowlist` starting from that single toggled agent.
 */
export function toggleCollaboratorAgent(input: {
  mode: SubagentCollaborationMode;
  allowAgentIds: readonly string[];
  targetAgentId: string;
}): { mode: SubagentCollaborationMode; allowAgentIds: string[] } {
  if (input.mode === SubagentCollaborationMode.Disabled) {
    return {
      mode: SubagentCollaborationMode.Allowlist,
      allowAgentIds: [input.targetAgentId],
    };
  }
  const exists = input.allowAgentIds.includes(input.targetAgentId);
  return {
    mode: SubagentCollaborationMode.Allowlist,
    allowAgentIds: exists
      ? input.allowAgentIds.filter(id => id !== input.targetAgentId)
      : [...input.allowAgentIds, input.targetAgentId],
  };
}

/**
 * Resolve the payload to persist and compare for dirty-state checks.
 * When `All` is selected, we preserve `initialAllowAgentIds` (or `[]` when creating)
 * so temporarily toggling to "Selected" and back to "All" does not dirty the form
 * or discard an existing stored allowlist.
 */
export function resolveCollaborationPayloadOnSave(input: {
  mode: SubagentCollaborationMode;
  allowAgentIds: readonly string[];
  initialAllowAgentIds?: readonly string[];
}): CollaborationSavePayload {
  if (input.mode === SubagentCollaborationMode.Allowlist) {
    return {
      subagentCollaborationMode: SubagentCollaborationMode.Allowlist,
      subagentAllowAgentIds: [...input.allowAgentIds],
    };
  }
  return {
    subagentCollaborationMode: input.mode,
    subagentAllowAgentIds: [...(input.initialAllowAgentIds ?? [])],
  };
}

export function countSelectedCollaborators(
  displayedAllowAgentIds: readonly string[],
  availableCandidateIds: ReadonlySet<string>,
): number {
  let count = 0;
  const seen = new Set<string>();
  for (const id of displayedAllowAgentIds) {
    if (!seen.has(id) && availableCandidateIds.has(id)) {
      seen.add(id);
      count += 1;
    }
  }
  return count;
}

export function hasCollaborationChanged(
  initial: CollaborationStateSnapshot,
  resolved: CollaborationSavePayload,
): { modeChanged: boolean; allowAgentIdsChanged: boolean } {
  const modeChanged = resolved.subagentCollaborationMode !== initial.mode;
  const allowAgentIdsChanged =
    resolved.subagentAllowAgentIds.length !== initial.allowAgentIds.length
    || resolved.subagentAllowAgentIds.some((id, idx) => id !== initial.allowAgentIds[idx]);
  return { modeChanged, allowAgentIdsChanged };
}
