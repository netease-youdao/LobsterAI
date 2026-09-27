import { describe, expect, test } from 'vitest';

import { SESSION_AGNOSTIC_PERMISSION_SESSION_ID } from '../../../shared/cowork/constants';
import { type CoworkPermissionRequest, CoworkSessionStatusValue } from '../../types/cowork';
import type { RootState } from '../index';
import {
  selectFirstCurrentSessionPendingPermission,
  selectHasRunningCoworkSessions,
} from './coworkSelectors';

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

describe('selectFirstCurrentSessionPendingPermission', () => {
  const question = (requestId: string, sessionId = 'a'): CoworkPermissionRequest => ({
    sessionId,
    requestId,
    toolName: 'AskUserQuestion',
    toolInput: { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] },
  });
  const approval: CoworkPermissionRequest = {
    sessionId: 'a', requestId: 'approval', toolName: 'Bash', toolInput: { command: 'rm -rf build' },
  };
  const stateWith = (pendingPermissions: CoworkPermissionRequest[], currentSessionId: string | null = 'a') => ({
    cowork: { pendingPermissions, currentSessionId },
  } as unknown as RootState);

  test('skips questions the inline dock renders and keeps approvals in the modal', () => {
    expect(selectFirstCurrentSessionPendingPermission(stateWith([question('q1'), approval]))).toBe(approval);
    expect(selectFirstCurrentSessionPendingPermission(stateWith([question('q1')]))).toBeNull();
  });

  test('still surfaces session-agnostic questions as the modal fallback', () => {
    const agnostic = question('q2', SESSION_AGNOSTIC_PERMISSION_SESSION_ID);
    expect(selectFirstCurrentSessionPendingPermission(stateWith([question('q1'), agnostic]))).toBe(agnostic);
    expect(selectFirstCurrentSessionPendingPermission(stateWith([agnostic], null))).toBe(agnostic);
  });
});
