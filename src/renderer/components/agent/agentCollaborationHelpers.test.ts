import { SubagentCollaborationMode } from '@shared/agent';
import { describe, expect, test } from 'vitest';

import {
  countSelectedCollaborators,
  getDisplayedCollaboratorIds,
  hasCollaborationChanged,
  isRestrictedCollaborationMode,
  resolveCollaborationPayloadOnSave,
  selectCollaborationScope,
  toggleCollaboratorAgent,
} from './agentCollaborationHelpers';

describe('agentCollaborationHelpers', () => {
  test('isRestrictedCollaborationMode treats All as unrestricted and Allowlist/Disabled as restricted', () => {
    expect(isRestrictedCollaborationMode(SubagentCollaborationMode.All)).toBe(false);
    expect(isRestrictedCollaborationMode(SubagentCollaborationMode.Allowlist)).toBe(true);
    expect(isRestrictedCollaborationMode(SubagentCollaborationMode.Disabled)).toBe(true);
  });

  test('getDisplayedCollaboratorIds hides stale allowlist entries for legacy Disabled records', () => {
    expect(getDisplayedCollaboratorIds(SubagentCollaborationMode.All, ['a'])).toEqual([]);
    expect(getDisplayedCollaboratorIds(SubagentCollaborationMode.Disabled, ['a', 'b'])).toEqual([]);
    expect(getDisplayedCollaboratorIds(SubagentCollaborationMode.Allowlist, ['a', 'b'])).toEqual(['a', 'b']);
  });

  test('selectCollaborationScope switches between All and Allowlist while keeping local selections', () => {
    const toRestricted = selectCollaborationScope({
      currentMode: SubagentCollaborationMode.All,
      allowAgentIds: ['translator'],
      restricted: true,
    });
    expect(toRestricted).toEqual({
      mode: SubagentCollaborationMode.Allowlist,
      allowAgentIds: ['translator'],
    });

    const backToAll = selectCollaborationScope({
      currentMode: SubagentCollaborationMode.Allowlist,
      allowAgentIds: ['translator', 'writer'],
      restricted: false,
    });
    expect(backToAll).toEqual({
      mode: SubagentCollaborationMode.All,
      allowAgentIds: ['translator', 'writer'],
    });

    // Clicking the already-active restricted button on a legacy Disabled record is a no-op
    const keepLegacyDisabled = selectCollaborationScope({
      currentMode: SubagentCollaborationMode.Disabled,
      allowAgentIds: ['translator'],
      restricted: true,
    });
    expect(keepLegacyDisabled).toEqual({
      mode: SubagentCollaborationMode.Disabled,
      allowAgentIds: ['translator'],
    });
  });

  test('toggleCollaboratorAgent adds/removes agents and promotes legacy Disabled to Allowlist', () => {
    const added = toggleCollaboratorAgent({
      mode: SubagentCollaborationMode.Allowlist,
      allowAgentIds: ['translator'],
      targetAgentId: 'writer',
    });
    expect(added).toEqual({
      mode: SubagentCollaborationMode.Allowlist,
      allowAgentIds: ['translator', 'writer'],
    });

    const removed = toggleCollaboratorAgent({
      mode: SubagentCollaborationMode.Allowlist,
      allowAgentIds: ['translator', 'writer'],
      targetAgentId: 'translator',
    });
    expect(removed).toEqual({
      mode: SubagentCollaborationMode.Allowlist,
      allowAgentIds: ['writer'],
    });

    const promoted = toggleCollaboratorAgent({
      mode: SubagentCollaborationMode.Disabled,
      allowAgentIds: ['stale-agent'],
      targetAgentId: 'blogger',
    });
    expect(promoted).toEqual({
      mode: SubagentCollaborationMode.Allowlist,
      allowAgentIds: ['blogger'],
    });
  });

  test('resolveCollaborationPayloadOnSave avoids false dirty changes when switching back to All', () => {
    const initial = {
      mode: SubagentCollaborationMode.All,
      allowAgentIds: [] as string[],
    };
    const resolvedAfterCancel = resolveCollaborationPayloadOnSave({
      mode: SubagentCollaborationMode.All,
      allowAgentIds: ['translator'],
      initialAllowAgentIds: initial.allowAgentIds,
    });
    expect(resolvedAfterCancel).toEqual({
      subagentCollaborationMode: SubagentCollaborationMode.All,
      subagentAllowAgentIds: [],
    });
    expect(hasCollaborationChanged(initial, resolvedAfterCancel)).toEqual({
      modeChanged: false,
      allowAgentIdsChanged: false,
    });
  });

  test('resolveCollaborationPayloadOnSave preserves legacy Disabled records when untouched', () => {
    const initial = {
      mode: SubagentCollaborationMode.Disabled,
      allowAgentIds: ['translator'],
    };
    const resolved = resolveCollaborationPayloadOnSave({
      mode: SubagentCollaborationMode.Disabled,
      allowAgentIds: ['translator'],
      initialAllowAgentIds: initial.allowAgentIds,
    });
    expect(resolved).toEqual({
      subagentCollaborationMode: SubagentCollaborationMode.Disabled,
      subagentAllowAgentIds: ['translator'],
    });
    expect(hasCollaborationChanged(initial, resolved)).toEqual({
      modeChanged: false,
      allowAgentIdsChanged: false,
    });
  });

  test('countSelectedCollaborators only counts unique enabled candidates', () => {
    const candidates = new Set(['main', 'translator', 'writer']);
    expect(countSelectedCollaborators(['translator', 'deleted-id', 'translator'], candidates)).toBe(1);
    expect(countSelectedCollaborators([], candidates)).toBe(0);
  });
});
