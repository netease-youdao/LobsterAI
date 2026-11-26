import { expect, test, vi } from 'vitest';

import type { CoworkSessionSummary } from '../../coworkStore';
import { handleReorderPinnedSessions } from './handlers';

const makeSummary = (id: string, pinOrder: number): CoworkSessionSummary => ({
  id,
  title: id,
  scheduledTaskId: null,
  status: 'completed',
  pinned: true,
  pinOrder,
  cwd: '',
  agentId: 'main',
  createdAt: 1000,
  updatedAt: 2000,
});

test('handleReorderPinnedSessions filters non-string ids and returns reordered summaries', () => {
  const expected = [makeSummary('b', 200), makeSummary('a', 199)];
  const reorderPinnedSessions = vi.fn(() => expected);

  const result = handleReorderPinnedSessions(
    { getCoworkStore: () => ({ reorderPinnedSessions }) },
    { sessionIds: ['b', 123, 'a', null] },
  );

  expect(reorderPinnedSessions).toHaveBeenCalledWith(['b', 'a']);
  expect(result).toEqual({ success: true, sessions: expected });
});

test('handleReorderPinnedSessions rejects non-array payloads', () => {
  const reorderPinnedSessions = vi.fn(() => []);

  const result = handleReorderPinnedSessions(
    { getCoworkStore: () => ({ reorderPinnedSessions }) },
    { sessionIds: 'not-an-array' },
  );

  expect(reorderPinnedSessions).not.toHaveBeenCalled();
  expect(result.success).toBe(false);
  expect(result.error).toBe('sessionIds must be an array');
});
