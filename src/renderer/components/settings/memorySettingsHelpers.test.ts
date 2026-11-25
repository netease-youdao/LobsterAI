import { describe, expect, test } from 'vitest';

import { AgentId, AgentSource } from '../../../shared/agent/constants';
import type { CoworkUserMemoryEntry } from '../../types/cowork';
import {
  buildMemoryAgentOptions,
  filterMemoryEntries,
  formatProjectKeyLabel,
  groupMemoryEntriesBySection,
  isProjectScopedMemory,
  type MemoryAgentInput,
  MemoryScopeFilter,
  resolveInitialMemoryAgentId,
} from './memorySettingsHelpers';

function makeAgent(partial: Partial<MemoryAgentInput> & { id: string; name: string }): MemoryAgentInput {
  return {
    icon: '',
    source: AgentSource.Custom,
    presetId: '',
    ...partial,
  };
}

describe('memorySettingsHelpers', () => {
  test('buildMemoryAgentOptions places main first and preserves non-main order', () => {
    const options = buildMemoryAgentOptions(
      [
        makeAgent({ id: 'coder', name: 'Code Expert' }),
        makeAgent({ id: AgentId.Main, name: 'LobsterAI' }),
        makeAgent({ id: 'writer', name: 'Writer', source: AgentSource.Preset, presetId: 'writer' }),
      ],
      'Main Assistant',
    );

    expect(options.map((item) => item.id)).toEqual([AgentId.Main, 'coder', 'writer']);
    expect(options[0].isMain).toBe(true);
    expect(options[1].isMain).toBe(false);
    expect(options[2].expertFallback).toBe(true);
  });

  test('resolveInitialMemoryAgentId falls back to main when requested id is absent', () => {
    const options = buildMemoryAgentOptions(
      [
        makeAgent({ id: AgentId.Main, name: 'LobsterAI' }),
        makeAgent({ id: 'coder', name: 'Code Expert' }),
      ],
      'Main Assistant',
    );

    expect(resolveInitialMemoryAgentId('coder', options)).toBe('coder');
    expect(resolveInitialMemoryAgentId('missing', options)).toBe(AgentId.Main);
    expect(resolveInitialMemoryAgentId(undefined, options)).toBe(AgentId.Main);
  });

  test('formatProjectKeyLabel formats git remotes and local paths cleanly', () => {
    expect(formatProjectKeyLabel('github.com/acme/lobsterai')).toBe('acme/lobsterai');
    expect(formatProjectKeyLabel('path:/Users/dev/projects/my-app/')).toBe('my-app');
    expect(formatProjectKeyLabel('path:C:\\Users\\dev\\demo')).toBe('demo');
    expect(formatProjectKeyLabel('lobsterai')).toBe('lobsterai');
  });

  test('filterMemoryEntries filters by scope and matches text, section, and formatted project labels', () => {
    const entries: CoworkUserMemoryEntry[] = [
      { id: '1', text: 'Likes cats' },
      {
        id: '2',
        text: 'Use pnpm build in CI',
        section: 'Build Rules',
        projectKeys: ['github.com/acme/lobsterai'],
      },
      {
        id: '3',
        text: 'Prefers concise Chinese replies',
        section: 'Style',
      },
    ];

    expect(isProjectScopedMemory(entries[0])).toBe(false);
    expect(isProjectScopedMemory(entries[1])).toBe(true);

    expect(
      filterMemoryEntries(entries, { query: '', scope: MemoryScopeFilter.Global }).map((e) => e.id),
    ).toEqual(['1', '3']);
    expect(
      filterMemoryEntries(entries, { query: '', scope: MemoryScopeFilter.Project }).map((e) => e.id),
    ).toEqual(['2']);
    expect(
      filterMemoryEntries(entries, { query: 'acme/lobsterai', scope: MemoryScopeFilter.All }).map((e) => e.id),
    ).toEqual(['2']);
    expect(
      filterMemoryEntries(entries, { query: 'style', scope: MemoryScopeFilter.All }).map((e) => e.id),
    ).toEqual(['3']);
  });

  test('groupMemoryEntriesBySection preserves order and groups consecutive section siblings', () => {
    const groups = groupMemoryEntriesBySection([
      { id: '1', text: 'A' },
      { id: '2', text: 'B' },
      { id: '3', text: 'C', section: 'Promoted From Short-Term Memory (2026-06-28)' },
      { id: '4', text: 'D', section: 'Promoted From Short-Term Memory (2026-06-28)' },
      { id: '5', text: 'E', section: 'Work' },
    ]);

    expect(groups).toHaveLength(3);
    expect(groups[0].section).toBeUndefined();
    expect(groups[0].entries.map((e) => e.id)).toEqual(['1', '2']);
    expect(groups[1].section).toBe('Promoted From Short-Term Memory (2026-06-28)');
    expect(groups[1].entries.map((e) => e.id)).toEqual(['3', '4']);
    expect(groups[2].section).toBe('Work');
    expect(groups[2].entries.map((e) => e.id)).toEqual(['5']);
  });
});
