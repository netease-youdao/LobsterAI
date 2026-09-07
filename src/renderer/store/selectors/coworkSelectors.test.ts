import { describe, expect, test } from 'vitest';

import { CoworkSessionStatusValue } from '../../types/cowork';
import type { RootState } from '../index';
import { selectHasRunningCoworkSessions } from './coworkSelectors';

type SessionLike = { id: string; status: string };

const createState = (overrides: {
  sessions?: SessionLike[];
  currentSession?: SessionLike | null;
  isStreaming?: boolean;
} = {}): RootState => ({
  cowork: {
    sessions: overrides.sessions ?? [],
    currentSession: overrides.currentSession ?? null,
    isStreaming: overrides.isStreaming ?? false,
  },
} as unknown as RootState);

describe('selectHasRunningCoworkSessions', () => {
  test('is false when nothing is loaded or every session is settled', () => {
    expect(selectHasRunningCoworkSessions(createState())).toBe(false);
    expect(selectHasRunningCoworkSessions(createState({
      sessions: [
        { id: 'a', status: CoworkSessionStatusValue.Completed },
        { id: 'b', status: CoworkSessionStatusValue.Idle },
      ],
      currentSession: { id: 'a', status: CoworkSessionStatusValue.Completed },
    }))).toBe(false);
  });

  test('is true when any loaded session is running', () => {
    expect(selectHasRunningCoworkSessions(createState({
      sessions: [
        { id: 'a', status: CoworkSessionStatusValue.Completed },
        { id: 'b', status: CoworkSessionStatusValue.Running },
      ],
    }))).toBe(true);
  });

  test('trusts the opened session and streaming flag on their own', () => {
    expect(selectHasRunningCoworkSessions(createState({
      currentSession: { id: 'a', status: CoworkSessionStatusValue.Running },
    }))).toBe(true);
    expect(selectHasRunningCoworkSessions(createState({ isStreaming: true }))).toBe(true);
  });
});
