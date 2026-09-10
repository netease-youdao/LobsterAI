import { expect, test } from 'vitest';

import type { ApprovalState } from '../../../shared/cowork/approval';
import { resetAccountSessionData } from '../accountSessionBoundary';
import reducer, { enqueuePendingPermission, setPermissionSubmissionState, updatePendingPermissionState } from './coworkSlice';

export const approvalFixture = (overrides: Partial<ApprovalState> = {}): ApprovalState => ({
  requestId: 'approval-1', sessionId: 'session-1', runId: 'run-1', approvalVersion: '1', operationDigest: 'digest-1',
  title: 'Delete draft?', summary: 'Delete the draft file.', expiresAt: '2099-01-01T00:00:00.000Z',
  remoteAllowed: true, requiresLocalAction: false, status: 'pending', resolvedAt: null,
  resolution: { phase: 'idle', source: null, confirmedDecision: null, confirmedAt: null }, ...overrides,
});
const request = (approval: ApprovalState) => ({ sessionId: approval.sessionId, requestId: approval.requestId,
  toolName: 'Bash', toolInput: { command: 'rm -- draft.md' }, approval });

test('a state that precedes its request initializes the modal with the latest locked phase', () => {
  const first = approvalFixture();
  const submitting = approvalFixture({ approvalVersion: '2', resolution: { ...first.resolution, phase: 'submitting', source: 'mobile' } });
  let state = reducer(undefined, updatePendingPermissionState(submitting));
  state = reducer(state, enqueuePendingPermission(request(first)));
  expect(state.pendingPermissions[0].approval?.resolution.phase).toBe('submitting');
});

test('remote confirmation removes only the matching dialog and stale requests cannot reopen it', () => {
  const first = approvalFixture();
  const other = approvalFixture({ requestId: 'approval-2' });
  let state = reducer(undefined, enqueuePendingPermission(request(first)));
  state = reducer(state, enqueuePendingPermission(request(other)));
  const finished = approvalFixture({ approvalVersion: '3', status: 'approved', resolvedAt: '2026-09-10T08:00:00Z',
    resolution: { phase: 'finished', source: 'mobile', confirmedDecision: 'approve', confirmedAt: '2026-09-10T08:00:00Z' } });
  state = reducer(state, updatePendingPermissionState(finished));
  state = reducer(state, enqueuePendingPermission(request(first)));
  expect(state.pendingPermissions.map(item => item.requestId)).toEqual(['approval-2']);
  expect(state.permissionStates['approval-1'].status).toBe('approved');
});

test('higher pending versions cannot resurrect terminal approvals', () => {
  const closed = approvalFixture({ status: 'cancelled', approvalVersion: '4', resolvedAt: '2026-09-10T08:00:00Z',
    resolution: { phase: 'finished', source: 'system', confirmedDecision: null, confirmedAt: null } });
  let state = reducer(undefined, updatePendingPermissionState(closed));
  state = reducer(state, updatePendingPermissionState(approvalFixture({ approvalVersion: '5' })));
  expect(state.permissionStates['approval-1'].status).toBe('cancelled');
});

test('late confirmed evidence enriches an invalidated approval without recreating its dialog', () => {
  const closed = approvalFixture({ status: 'cancelled', approvalVersion: '4', resolvedAt: '2026-09-10T08:00:00Z',
    resolution: { phase: 'finished', source: 'system', confirmedDecision: null, confirmedAt: null } });
  let state = reducer(undefined, updatePendingPermissionState(closed));
  state = reducer(state, updatePendingPermissionState({ ...closed, approvalVersion: '5',
    resolution: { phase: 'finished', source: 'unknown', confirmedDecision: 'approve', confirmedAt: '2026-09-10T08:00:02Z' } }));
  expect(state.permissionStates['approval-1'].resolution.confirmedDecision).toBe('approve');
  expect(state.permissionStates['approval-1'].status).toBe('cancelled');
  expect(state.pendingPermissions).toHaveLength(0);
});

test('versions are compared numerically and old idle updates cannot unlock unknown submissions', () => {
  const unknown = approvalFixture({ approvalVersion: '10', resolution: { phase: 'unknown', source: 'desktop', confirmedDecision: null, confirmedAt: null } });
  let state = reducer(undefined, enqueuePendingPermission(request(unknown)));
  state = reducer(state, updatePendingPermissionState(approvalFixture({ approvalVersion: '9' })));
  expect(state.pendingPermissions[0].approval?.resolution.phase).toBe('unknown');
});

test('new account clears the dialogs, transient submissions and terminal cache together', () => {
  let state = reducer(undefined, enqueuePendingPermission(request(approvalFixture())));
  state = reducer(state, setPermissionSubmissionState({ requestId: 'approval-1', phase: 'submitting' }));
  state = reducer(state, resetAccountSessionData());
  expect(state.pendingPermissions).toEqual([]);
  expect(state.permissionStates).toEqual({});
});
