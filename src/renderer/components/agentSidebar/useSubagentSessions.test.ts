import { describe, expect, test } from 'vitest';

import { CoworkSessionStatusValue } from '../../types/cowork';
import { shouldPollSubagentSessions } from './useSubagentSessions';

describe('shouldPollSubagentSessions', () => {
  test('polls while the parent session is running', () => {
    expect(shouldPollSubagentSessions({
      parentSessionStatus: CoworkSessionStatusValue.Running,
      hasRunningSubagents: false,
      postParentPollingDeadlineMs: 0,
      nowMs: 10,
    })).toBe(true);
  });

  test('polls running subagents after parent completion until the deadline', () => {
    expect(shouldPollSubagentSessions({
      parentSessionStatus: CoworkSessionStatusValue.Completed,
      hasRunningSubagents: true,
      postParentPollingDeadlineMs: 10_000,
      nowMs: 5_000,
    })).toBe(true);
  });

  test('stops post-parent polling after the deadline', () => {
    expect(shouldPollSubagentSessions({
      parentSessionStatus: CoworkSessionStatusValue.Completed,
      hasRunningSubagents: true,
      postParentPollingDeadlineMs: 10_000,
      nowMs: 10_001,
    })).toBe(false);
  });

  test('does not poll after parent completion when no subagents are running', () => {
    expect(shouldPollSubagentSessions({
      parentSessionStatus: CoworkSessionStatusValue.Completed,
      hasRunningSubagents: false,
      postParentPollingDeadlineMs: 10_000,
      nowMs: 5_000,
    })).toBe(false);
  });
});
