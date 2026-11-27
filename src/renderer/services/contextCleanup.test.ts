import { describe, expect, test } from 'vitest';

import {
  CleanupActionMode,
  CleanupCapabilityKind,
  CleanupDependencyKind,
} from '../../shared/contextCleanup/constants';
import type { ContextCleanupCandidate } from '../../shared/contextCleanup/types';
import {
  computeSelectedCleanupSavings,
  getDefaultSelectedCandidateKeys,
  groupCleanupCandidates,
  makeCleanupCandidateKey,
} from './contextCleanup';

function makeCandidate(overrides: Partial<ContextCleanupCandidate>): ContextCleanupCandidate {
  return {
    kind: CleanupCapabilityKind.Skill,
    id: 'demo',
    name: 'Demo',
    description: 'Demo capability',
    estimatedTokens: 60,
    lastUsedAt: null,
    idleDays: null,
    enabledDays: 40,
    dependencies: [],
    defaultSelected: true,
    actionMode: CleanupActionMode.Toggle,
    ...overrides,
  };
}

describe('renderer contextCleanup helpers', () => {
  test('groups candidates in stable category order and calculates default selection savings', () => {
    const candidates: ContextCleanupCandidate[] = [
      makeCandidate({
        kind: CleanupCapabilityKind.DshPlugin,
        id: 'dsh-demo',
        name: 'dsh-demo',
        estimatedTokens: 0,
        estimatedTokensUnknown: true,
        defaultSelected: false,
        actionMode: CleanupActionMode.NavigatePlugins,
      }),
      makeCandidate({
        kind: CleanupCapabilityKind.Skill,
        id: 'unused-a',
        name: 'Unused A',
        estimatedTokens: 70,
      }),
      makeCandidate({
        kind: CleanupCapabilityKind.Skill,
        id: 'docx',
        name: 'Word',
        estimatedTokens: 55,
        dependencies: [{ kind: CleanupDependencyKind.CoreBuiltinSkill }],
        defaultSelected: false,
      }),
      makeCandidate({
        kind: CleanupCapabilityKind.DecisionModel,
        id: 'jev',
        name: 'Jev',
        estimatedTokens: 680,
      }),
      makeCandidate({
        kind: CleanupCapabilityKind.McpServer,
        id: 'crm-1',
        name: 'CRM',
        estimatedTokens: 420,
      }),
    ];

    const groups = groupCleanupCandidates(candidates);
    expect(groups.map(g => g.kind)).toEqual([
      CleanupCapabilityKind.Skill,
      CleanupCapabilityKind.McpServer,
      CleanupCapabilityKind.DecisionModel,
      CleanupCapabilityKind.DshPlugin,
    ]);
    expect(groups[0]?.totalTokens).toBe(125);

    const defaults = getDefaultSelectedCandidateKeys(candidates);
    expect(defaults.has(makeCleanupCandidateKey(CleanupCapabilityKind.Skill, 'unused-a'))).toBe(true);
    expect(defaults.has(makeCleanupCandidateKey(CleanupCapabilityKind.Skill, 'docx'))).toBe(false);
    expect(defaults.has(makeCleanupCandidateKey(CleanupCapabilityKind.DshPlugin, 'dsh-demo'))).toBe(false);

    const summary = computeSelectedCleanupSavings(candidates, defaults);
    expect(summary.selectedCount).toBe(3);
    expect(summary.savedTokens).toBe(70 + 680 + 420);
    expect(summary.targetItems).toHaveLength(3);
  });
});
