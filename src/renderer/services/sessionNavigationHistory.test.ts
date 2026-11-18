import { describe, expect, test } from 'vitest';

import { COWORK_TEMP_SESSION_ID_PREFIX } from '../../shared/cowork/constants';
import { SessionHistoryDirection, SessionNavigationHistory } from './sessionNavigationHistory';

const { Back, Forward } = SessionHistoryDirection;

const visit = (history: SessionNavigationHistory, ...sessionIds: string[]) => {
  for (const sessionId of sessionIds) history.observe(sessionId, 'main');
};

/** Runs one back/forward step and lets the opened session arrive like a real load. */
const go = (history: SessionNavigationHistory, direction: SessionHistoryDirection, current: string | null) => {
  const targetIndex = history.resolveTargetIndex(direction, current);
  if (targetIndex === null) return null;
  const entry = history.beginNavigation(targetIndex)!;
  history.observe(entry.sessionId, entry.agentId);
  return entry.sessionId;
};

describe('SessionNavigationHistory', () => {
  test('steps back and forward through visited sessions', () => {
    const history = new SessionNavigationHistory();
    visit(history, 'a', 'b', 'c');
    expect(go(history, Back, 'c')).toBe('b');
    expect(go(history, Back, 'b')).toBe('a');
    expect(go(history, Back, 'a')).toBeNull();
    expect(go(history, Forward, 'a')).toBe('b');
    expect(go(history, Forward, 'b')).toBe('c');
    expect(go(history, Forward, 'c')).toBeNull();
  });

  test('opening a session after going back drops the forward entries', () => {
    const history = new SessionNavigationHistory();
    visit(history, 'a', 'b', 'c');
    go(history, Back, 'c');
    visit(history, 'd');
    expect(history.snapshot()).toEqual({
      entries: ['a', 'b', 'd'].map(sessionId => ({ sessionId, agentId: 'main' })),
      index: 2,
    });
    expect(history.canNavigate(Forward, 'd')).toBe(false);
  });

  test('re-observing the current session is not a new visit', () => {
    const history = new SessionNavigationHistory();
    visit(history, 'a', 'b', 'b', 'b');
    expect(history.snapshot().entries).toHaveLength(2);
  });

  test('from the home view, back returns to the session just left', () => {
    const history = new SessionNavigationHistory();
    visit(history, 'a', 'b');
    expect(go(history, Back, null)).toBe('b');
    expect(go(history, Back, 'b')).toBe('a');
  });

  test('temporary sessions of a task that is still starting are skipped', () => {
    const history = new SessionNavigationHistory();
    visit(history, 'a', `${COWORK_TEMP_SESSION_ID_PREFIX}123`, 'b');
    expect(history.snapshot().entries.map(entry => entry.sessionId)).toEqual(['a', 'b']);
    expect(history.resolveTargetIndex(Back, `${COWORK_TEMP_SESSION_ID_PREFIX}456`)).toBe(1);
  });

  test('a click elsewhere while a step is loading counts as a new visit', () => {
    const history = new SessionNavigationHistory();
    visit(history, 'a', 'b', 'c');
    history.beginNavigation(history.resolveTargetIndex(Back, 'c')!);
    visit(history, 'x');
    expect(history.snapshot().entries.map(entry => entry.sessionId)).toEqual(['a', 'b', 'c', 'x']);
  });

  test('keeps the agent of each entry so a step can switch agents', () => {
    const history = new SessionNavigationHistory();
    history.observe('a', 'writer');
    history.observe('b', 'main');
    const targetIndex = history.resolveTargetIndex(Back, 'b')!;
    expect(history.beginNavigation(targetIndex)).toEqual({ sessionId: 'a', agentId: 'writer' });
  });

  test('removing a deleted session keeps the cursor on the same place', () => {
    const history = new SessionNavigationHistory();
    visit(history, 'a', 'b', 'c', 'd');
    go(history, Back, 'd');
    history.remove('b');
    expect(history.snapshot()).toMatchObject({ index: 1 });
    expect(go(history, Back, 'c')).toBe('a');
    expect(go(history, Forward, 'a')).toBe('c');
  });

  test('removing the session just left makes back skip it', () => {
    const history = new SessionNavigationHistory();
    visit(history, 'a', 'b');
    history.remove('b');
    expect(go(history, Back, null)).toBe('a');
  });

  test('keeps only the newest entries past the limit', () => {
    const history = new SessionNavigationHistory(3);
    visit(history, 'a', 'b', 'c', 'd');
    expect(history.snapshot()).toEqual({
      entries: ['b', 'c', 'd'].map(sessionId => ({ sessionId, agentId: 'main' })),
      index: 2,
    });
  });
});
