import {
  CleanupActionMode,
  CleanupCapabilityKind,
} from '../../shared/contextCleanup/constants';
import type {
  ContextCleanupApplyResult,
  ContextCleanupCandidate,
  ContextCleanupDismissResult,
  ContextCleanupScanResult,
  ContextCleanupTargetItem,
  ContextCleanupUndoResult,
} from '../../shared/contextCleanup/types';
import { store } from '../store';
import { setMcpServers } from '../store/slices/mcpSlice';
import { setSkills } from '../store/slices/skillSlice';
import { mcpService } from './mcp';
import { skillService } from './skill';

export const CLEANUP_GROUP_ORDER: readonly CleanupCapabilityKind[] = [
  CleanupCapabilityKind.Skill,
  CleanupCapabilityKind.McpServer,
  CleanupCapabilityKind.DecisionModel,
  CleanupCapabilityKind.DshPlugin,
];

export interface CleanupCandidateGroup {
  kind: CleanupCapabilityKind;
  items: ContextCleanupCandidate[];
  totalTokens: number;
}

export function makeCleanupCandidateKey(kind: CleanupCapabilityKind, id: string): string {
  return `${kind}:${id}`;
}

export function groupCleanupCandidates(
  candidates: readonly ContextCleanupCandidate[],
): CleanupCandidateGroup[] {
  const buckets = new Map<CleanupCapabilityKind, ContextCleanupCandidate[]>();
  for (const item of candidates) {
    const list = buckets.get(item.kind) ?? [];
    list.push(item);
    buckets.set(item.kind, list);
  }
  const groups: CleanupCandidateGroup[] = [];
  for (const kind of CLEANUP_GROUP_ORDER) {
    const items = buckets.get(kind);
    if (!items || items.length === 0) continue;
    const totalTokens = items.reduce((sum, item) => sum + item.estimatedTokens, 0);
    groups.push({ kind, items, totalTokens });
  }
  return groups;
}

export function getDefaultSelectedCandidateKeys(
  candidates: readonly ContextCleanupCandidate[],
): Set<string> {
  const keys = new Set<string>();
  for (const item of candidates) {
    if (item.actionMode === CleanupActionMode.Toggle && item.defaultSelected) {
      keys.add(makeCleanupCandidateKey(item.kind, item.id));
    }
  }
  return keys;
}

export function computeSelectedCleanupSavings(
  candidates: readonly ContextCleanupCandidate[],
  selectedKeys: ReadonlySet<string>,
): { selectedCount: number; savedTokens: number; targetItems: ContextCleanupTargetItem[] } {
  let selectedCount = 0;
  let savedTokens = 0;
  const targetItems: ContextCleanupTargetItem[] = [];
  for (const item of candidates) {
    if (item.actionMode !== CleanupActionMode.Toggle) continue;
    if (!selectedKeys.has(makeCleanupCandidateKey(item.kind, item.id))) continue;
    selectedCount += 1;
    savedTokens += item.estimatedTokens;
    targetItems.push({ kind: item.kind, id: item.id });
  }
  return { selectedCount, savedTokens, targetItems };
}

async function refreshRendererStoresAfterCleanup(): Promise<void> {
  await Promise.allSettled([
    skillService.loadSkills().then((loaded) => {
      store.dispatch(setSkills(loaded));
    }),
    mcpService.loadServers().then((loaded) => {
      store.dispatch(setMcpServers(loaded));
    }),
  ]);
}

class ContextCleanupClientService {
  async scan(options?: { idleDays?: number }): Promise<ContextCleanupScanResult | null> {
    const api = window.electron?.contextCleanup;
    if (!api?.scan) return null;
    try {
      const response = await api.scan(options);
      if (response?.success && response.result) {
        return response.result;
      }
      return null;
    } catch {
      return null;
    }
  }

  async apply(items: ContextCleanupTargetItem[]): Promise<ContextCleanupApplyResult> {
    const api = window.electron?.contextCleanup;
    if (!api?.apply) {
      return {
        success: false,
        closedCount: 0,
        savedTokens: 0,
        undoToken: null,
        failedItems: [],
        error: 'Context cleanup API unavailable',
      };
    }
    const result = await api.apply(items);
    if (result.closedCount > 0) {
      await refreshRendererStoresAfterCleanup();
    }
    return result;
  }

  async undo(undoToken: string): Promise<ContextCleanupUndoResult> {
    const api = window.electron?.contextCleanup;
    if (!api?.undo) {
      return { success: false, restoredCount: 0, error: 'Context cleanup API unavailable' };
    }
    const result = await api.undo(undoToken);
    if (result.restoredCount > 0) {
      await refreshRendererStoresAfterCleanup();
    }
    return result;
  }

  async dismiss(): Promise<ContextCleanupDismissResult | null> {
    const api = window.electron?.contextCleanup;
    if (!api?.dismiss) return null;
    try {
      return await api.dismiss();
    } catch {
      return null;
    }
  }
}

export const contextCleanupService = new ContextCleanupClientService();
