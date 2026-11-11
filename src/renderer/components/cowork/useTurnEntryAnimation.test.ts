import { describe, expect, test } from 'vitest';

import { COWORK_TEMP_SESSION_ID_PREFIX } from '../../../shared/cowork/constants';
import { type EntryAnimationState, nextEntryAnimationState, resolveTurnKey } from './useTurnEntryAnimation';

const temp = `${COWORK_TEMP_SESSION_ID_PREFIX}1`;
const initial = (sessionId: string | undefined): EntryAnimationState => ({ sessionId, skipTurnId: null, mountedTurn: null });

describe('entry animation of the newest turn', () => {
  test('plays for appended turns and when a session is opened', () => {
    const state = initial('session');
    expect(nextEntryAnimationState(state, 'session', 'turn-1', false)).toBe(state);
    expect(nextEntryAnimationState(state, 'session', 'turn-2', false)).toBe(state);
    expect(nextEntryAnimationState(state, 'other', 'turn-9', false).skipTurnId).toBeNull();
  });

  test('keeps the optimistic first turn mounted when its stored copy replaces it', () => {
    const optimistic = nextEntryAnimationState(initial(undefined), temp, 'msg-1', false);
    expect(optimistic.skipTurnId).toBeNull();
    expect(resolveTurnKey(optimistic, 'msg-1')).toBe('msg-1');
    const stored = nextEntryAnimationState(optimistic, 'session', 'stored-1', false);
    // Same React key, so nothing inside the turn is mounted again; a running entry animation just finishes.
    expect(resolveTurnKey(stored, 'stored-1')).toBe('msg-1');
    expect(stored.skipTurnId).toBeNull();
    expect(nextEntryAnimationState(stored, 'session', 'stored-1', false)).toBe(stored);
    // The next turn the user sends is new again, and the first turn keeps its key.
    const followUp = nextEntryAnimationState(stored, 'session', 'stored-2', false);
    expect(followUp.skipTurnId).toBeNull();
    expect(resolveTurnKey(followUp, 'stored-2')).toBe('stored-2');
    expect(resolveTurnKey(followUp, 'stored-1')).toBe('msg-1');
  });

  test('skips the animation when the stored copy cannot take over the optimistic mount', () => {
    const stored = nextEntryAnimationState(initial(temp), 'session', 'stored-1', false);
    expect(stored).toEqual({ sessionId: 'session', skipTurnId: 'stored-1', mountedTurn: null });
  });

  test('drops the kept key when another session is opened', () => {
    const optimistic = nextEntryAnimationState(initial(undefined), temp, 'msg-1', false);
    const stored = nextEntryAnimationState(optimistic, 'session', 'stored-1', false);
    const other = nextEntryAnimationState(stored, 'other', 'stored-1', false);
    expect(resolveTurnKey(other, 'stored-1')).toBe('stored-1');
  });

  test('stays off for a turn shown during a version switch or an edit, until another turn is newest', () => {
    const before = nextEntryAnimationState(initial('session'), 'session', 'old-version', true);
    expect(before.skipTurnId).toBe('old-version');
    const swapped = nextEntryAnimationState(before, 'session', 'new-version', true);
    expect(swapped.skipTurnId).toBe('new-version');
    const settled = nextEntryAnimationState(swapped, 'session', 'new-version', false);
    expect(settled).toBe(swapped);
    expect(settled.skipTurnId).not.toBe('follow-up');
  });
});
