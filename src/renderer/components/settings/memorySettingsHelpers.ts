import { AgentId, type AgentSource } from '../../../shared/agent/constants';
import type { CoworkUserMemoryEntry } from '../../types/cowork';
import { getAgentDisplayName, usesManagedPresetAvatar } from '../../utils/agentDisplay';

export const MemoryScopeFilter = {
  All: 'all',
  Global: 'global',
  Project: 'project',
} as const;
export type MemoryScopeFilter = typeof MemoryScopeFilter[keyof typeof MemoryScopeFilter];

export interface MemoryAgentInput {
  id: string;
  name: string;
  icon?: string;
  source?: AgentSource;
  presetId?: string;
}

export interface MemoryAgentOption {
  id: string;
  name: string;
  icon?: string;
  isMain: boolean;
  expertFallback: boolean;
}

export interface MemorySectionGroup {
  key: string;
  section?: string;
  entries: CoworkUserMemoryEntry[];
}

export function buildMemoryAgentOptions(
  agents: readonly MemoryAgentInput[],
  mainFallbackLabel: string,
): MemoryAgentOption[] {
  const mainAgent = agents.find((agent) => agent.id === AgentId.Main);
  const others = agents.filter((agent) => agent.id !== AgentId.Main);
  const mainName = mainAgent
    ? getAgentDisplayName(mainAgent)
    : mainFallbackLabel;

  return [
    {
      id: AgentId.Main,
      name: mainName,
      icon: mainAgent?.icon,
      isMain: true,
      expertFallback: false,
    },
    ...others.map((agent) => ({
      id: agent.id,
      name: getAgentDisplayName(agent),
      icon: agent.icon,
      isMain: false,
      expertFallback: usesManagedPresetAvatar(agent),
    })),
  ];
}

export function resolveInitialMemoryAgentId(
  requestedAgentId: string | undefined,
  options: readonly MemoryAgentOption[],
): string {
  const trimmed = requestedAgentId?.trim();
  if (trimmed && options.some((option) => option.id === trimmed)) {
    return trimmed;
  }
  return AgentId.Main;
}

export function isProjectScopedMemory(
  entry: Pick<CoworkUserMemoryEntry, 'projectKeys'>,
): boolean {
  return Array.isArray(entry.projectKeys) && entry.projectKeys.length > 0;
}

export function formatProjectKeyLabel(rawKey: string): string {
  const unescaped = rawKey
    .replace(/%3b/gi, ';')
    .replace(/%3c/gi, '<')
    .replace(/%3e/gi, '>')
    .replace(/%25/g, '%')
    .trim();
  if (!unescaped) return '';

  if (/^path:/i.test(unescaped)) {
    const rawPath = unescaped.slice(5).replace(/\\/g, '/').replace(/\/+$/, '');
    const segments = rawPath.split('/').filter(Boolean);
    return segments[segments.length - 1] || rawPath || unescaped;
  }

  const segments = unescaped.split('/').filter(Boolean);
  if (segments.length >= 3) {
    return segments.slice(-2).join('/');
  }
  return unescaped;
}

export function matchesLocalMemorySearch(
  entry: CoworkUserMemoryEntry,
  rawQuery: string,
): boolean {
  const normalized = rawQuery.trim().toLowerCase();
  if (!normalized) return true;
  if (entry.text.toLowerCase().includes(normalized)) return true;
  if (entry.section && entry.section.toLowerCase().includes(normalized)) return true;
  if (entry.sourceLabel && entry.sourceLabel.toLowerCase().includes(normalized)) return true;
  if (
    entry.projectKeys?.some((key) => (
      key.toLowerCase().includes(normalized)
      || formatProjectKeyLabel(key).toLowerCase().includes(normalized)
    ))
  ) {
    return true;
  }
  return false;
}

export function filterMemoryEntries(
  entries: readonly CoworkUserMemoryEntry[],
  options: {
    query: string;
    scope: MemoryScopeFilter;
  },
): CoworkUserMemoryEntry[] {
  return entries.filter((entry) => {
    if (options.scope === MemoryScopeFilter.Global && isProjectScopedMemory(entry)) {
      return false;
    }
    if (options.scope === MemoryScopeFilter.Project && !isProjectScopedMemory(entry)) {
      return false;
    }
    return matchesLocalMemorySearch(entry, options.query);
  });
}

export function groupMemoryEntriesBySection(
  entries: readonly CoworkUserMemoryEntry[],
): MemorySectionGroup[] {
  const groups: MemorySectionGroup[] = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last && (last.section ?? '') === (entry.section ?? '')) {
      last.entries.push(entry);
    } else {
      const sectionKey = entry.section ?? 'ungrouped';
      groups.push({
        key: `${sectionKey}-${groups.length}`,
        section: entry.section,
        entries: [entry],
      });
    }
  }
  return groups;
}
