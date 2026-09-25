import { expect, test } from 'vitest';

import type { CoworkMessage, CoworkMessageMetadata } from '../../types/cowork';
import { deriveProgressActivity, selectProgressDisplay } from './progressActivity';

const user = (id = 'user', timestamp = 10): CoworkMessage => ({ id, timestamp, type: 'user', content: 'Build and verify the page' });
const call = (id: string, name = 'exec', extra: CoworkMessageMetadata = {}): CoworkMessage => ({
  id, timestamp: 20, type: 'tool_use', content: '', metadata: { toolUseId: id, toolName: name, toolInput: { description: id }, ...extra },
});
const result = (id: string, extra: CoworkMessageMetadata = {}): CoworkMessage => ({
  id: `${id}-result`, timestamp: 30, type: 'tool_result', content: 'Result', metadata: { toolUseId: id, isFinal: true, ...extra },
});
const placeholder = { sessionKey: 's', revision: 1, updatedAt: 11, markdown: '已开始执行多项工具操作；详细任务计划尚未提供。' };

test('replaces the reported static card with actual successes, failures, and running operations', () => {
  const activity = deriveProgressActivity([user(), call('Build'), result('Build'), call('Preview', 'browser'), result('Preview', { isError: true }), call('Serve')], true)!;
  const display = selectProgressDisplay(placeholder, activity);
  expect(display.card).toBeNull();
  expect(display.activity?.steps.map(s => [s.text, s.status])).toEqual([
    ['Build', 'completed'], ['Preview', 'failed'], ['Serve', 'running'],
  ]);
  expect(activity.updatedAt).toBe(30);
});

test('does not invent completion for partial results or missing results after a turn ends', () => {
  const activity = deriveProgressActivity([user(), call('A'), result('A', { isStreaming: true, isFinal: false }), call('B')], false)!;
  expect(activity.steps.map(s => s.status)).toEqual(['interrupted', 'interrupted']);
});

test('keeps the current turn only, retains same-turn steer, and excludes bridge bookkeeping', () => {
  const messages = [user('old', 1), call('old-action'), user(), call('Search', 'tool_search'), call('Invoke', 'tool_call'),
    call('Write', 'write'), result('Write'), { ...user('steer', 25), metadata: { isSteer: true } }, call('Check')];
  expect(deriveProgressActivity(messages, true)?.steps.map(s => s.text)).toEqual(['Write', 'Check']);
  expect(selectProgressDisplay(placeholder, deriveProgressActivity([...messages, user('new', 40)], true)).activity).toBeNull();
  expect(deriveProgressActivity([call('history-without-turn-boundary')], false)).toBeNull();
});

test('native plans and notes win; an older turn card does not mask current activity', () => {
  const activity = deriveProgressActivity([user(), call('A'), call('B')], true)!;
  const native = { ...placeholder, markdown: 'Creating the dashboard' };
  expect(selectProgressDisplay(native, activity)).toEqual({ card: native, activity: null });
  expect(selectProgressDisplay({ ...native, updatedAt: 1 }, activity)).toEqual({ card: null, activity });
});

test('a successful native clear is respected while a failed progress write does not suppress activity', () => {
  const messages = [user(), call('A'), call('B'), call('Plan', 'progress_card')];
  const cleared = deriveProgressActivity([...messages, result('Plan')], true);
  expect(selectProgressDisplay(null, cleared)).toEqual({ card: null, activity: null });
  const failed = deriveProgressActivity([...messages, result('Plan', { isError: true })], true);
  expect(selectProgressDisplay(null, failed).activity?.steps).toHaveLength(2);
});

test('does not show task activity for a single action or a still-generating tool input', () => {
  expect(selectProgressDisplay(null, deriveProgressActivity([user(), call('A'), call('B', 'exec', { isGenerating: true })], true)).activity).toBeNull();
});
