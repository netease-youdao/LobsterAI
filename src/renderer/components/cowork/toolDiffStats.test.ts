import { expect, test } from 'vitest';

import type { ToolGroupItem } from './messageDisplayUtils';
import { getToolGroupDiffStats } from './toolDiffStats';

const group = (metadata: Record<string, unknown>): ToolGroupItem => ({
  type: 'tool_group',
  toolUse: { id: 'use-1', type: 'tool_use', content: '', timestamp: 1, metadata },
  toolResult: null,
});

test('live counts win while a file tool call is still being generated', () => {
  expect(getToolGroupDiffStats(group({
    toolName: 'write', toolInput: {}, isGenerating: true, liveEditDiff: { added: 118, removed: 0 },
  }))).toEqual({ added: 118, removed: 0 });
});

test('a written file counts every line as added and edits count their diff', () => {
  expect(getToolGroupDiffStats(group({ toolName: 'write', toolInput: { path: '/tmp/a.py', content: 'a\nb\nc' } })))
    .toEqual({ added: 3, removed: 0 });
  expect(getToolGroupDiffStats(group({
    toolName: 'edit', toolInput: { path: '/tmp/a.py', old_string: 'a\nb', new_string: 'a\nb\nc\nd' },
  }))).toEqual({ added: 2, removed: 0 });
});

test('steps that do not change files have no stats', () => {
  expect(getToolGroupDiffStats(group({ toolName: 'exec', toolInput: { command: 'ls' } }))).toBeNull();
  expect(getToolGroupDiffStats(group({ toolName: 'write', toolInput: { path: '/tmp/empty', content: '' } }))).toBeNull();
});
