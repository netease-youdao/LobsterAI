import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { BrowserCredentialUseMode } from '../../shared/browserCredentials/constants';
import { CoworkIpcChannel, SESSION_AGNOSTIC_PERMISSION_SESSION_ID } from '../../shared/cowork/constants';
import { ConfirmationBehavior, MediaConfirmationAction } from '../../shared/media/confirmation';
import { BrowserCredentialApprovalService } from '../browserCredentials/browserCredentialApprovalService';
import { submitCoworkPermission } from '../coworkPermissionIpc';
import type { CoworkRuntime, PermissionResult } from '../libs/agentEngine/types';
import { type AskUserResponse, AskUserResponseReason, McpBridgeServer } from '../libs/mcpBridgeServer';
import { RemoteQuestionService } from '../remote/remoteQuestionService';
import type { RemoteStore } from '../remote/remoteStore';
import type { SqliteStore } from '../sqliteStore';
import { McpRuntime } from './mcpRuntime';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('electron', () => ({
  app: {},
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }] },
}));
vi.mock('../computerUse/computerUseKit', () => ({ isComputerUseKitInstalled: vi.fn() }));
vi.mock('../computerUse/computerUseMcpServer', () => ({ resolveComputerUseMcpServer: vi.fn() }));
vi.mock('../computerUse/computerUseRuntime', () => ({ installComputerUseRuntime: vi.fn() }));
vi.mock('../libs/coworkUtil', () => ({ getElectronNodeRuntimePath: vi.fn() }));
vi.mock('../libs/resolveStdioCommand', () => ({ resolveStdioCommand: vi.fn() }));
vi.mock('./mcpLaunchResolverManager', () => ({ McpLaunchResolverManager: vi.fn() }));
vi.mock('./mcpStore', () => ({ McpStore: vi.fn() }));
vi.mock('../libs/openclawLocalSessionResolver', () => ({
  resolveLocalDesktopCoworkSessionIdByOpenClawSessionKey: (_db: unknown, key: string) => (
    key === 'agent:main:lobsterai:session-a' ? 'session-a' : null
  ),
}));

const questions = [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }];
const sessionKey = 'agent:main:lobsterai:session-a';

beforeEach(() => {
  vi.useFakeTimers();
  send.mockReset();
  // Use the real question bridge and timers without binding a local HTTP port.
  vi.spyOn(McpBridgeServer.prototype, 'start').mockResolvedValue(1234);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture(authority = false, account = { generation: 0 }) {
  const permissionSessions = new Map<string, string>();
  const requested = vi.fn();
  const dismissed = vi.fn();
  const registered = vi.fn().mockReturnValue({});
  const settled = vi.fn();
  const runtime = new McpRuntime({
    permissionSessions,
    captureAccountSnapshot: () => {
      const generation = account.generation;
      return () => account.generation === generation;
    },
    getStore: () => ({ getDatabase: () => ({}) }) as unknown as SqliteStore,
    syncOpenClawConfig: vi.fn(),
    onAskUserRequested: requested,
    onAskUserDismissed: dismissed,
    ...(authority ? { registerQuestion: registered, settleQuestion: settled } : {}),
  });
  await runtime.startAskUserServer();
  const deps = {
    runtime: { getPermissionState: () => null } as unknown as CoworkRuntime,
    sessionForRequest: (id: string) => permissionSessions.get(id),
    isRuntimeRequest: () => false,
    canAccessSession: vi.fn((id: string) => id === 'session-a'),
    canAccessLocalQuestion: (id: string) => runtime.canAccessLocalQuestion(id),
    accountKey: () => 'account-a',
    resolveQuestion: vi.fn((id: string, result: PermissionResult) => {
      const response: AskUserResponse = {
        behavior: result.behavior,
        answers: result.behavior === 'allow' ? result.updatedInput?.answers as Record<string, string> : undefined,
      };
      if (!runtime.resolveAskUser(id, response)) throw new Error('QUESTION_UNAVAILABLE');
    }),
  };
  return { runtime, permissionSessions, requested, dismissed, registered, settled, deps };
}

describe('AskUserQuestion creation to IPC response', () => {
  test.each([true, false])('saved login with session binding=%s accepts allow, deny choice and close locally', async bound => {
    const { runtime, requested, registered, dismissed, deps } = await fixture(true);
    const service = new BrowserCredentialApprovalService({
      askUser: (items, timeout, options) => runtime.askUserInternal(items, timeout, options),
      translate: key => key,
    });
    const results: PermissionResult[] = [
      { behavior: 'allow', updatedInput: { answers: { browserCredentialApprovalQuestion: 'browserCredentialApprovalAllow' } } },
      { behavior: 'allow', updatedInput: { answers: { browserCredentialApprovalQuestion: 'browserCredentialApprovalDeny' } } },
      { behavior: 'deny' },
    ];
    for (const [index, result] of results.entries()) {
      const response = service.requestApproval({
        sessionId: bound ? 'session-a' : undefined, sessionKey: bound ? sessionKey : undefined,
        origin: 'https://example.com', useMode: BrowserCredentialUseMode.AlwaysAsk,
        candidates: [{ id: 'credential-1', origin: 'https://example.com', username: 'alice', createdAt: 1, updatedAt: 1 }],
      });
      const requestId = requested.mock.calls[index][1].requestId;
      expect(registered).not.toHaveBeenCalled();
      await expect(submitCoworkPermission({ requestId, result }, deps)).resolves.toEqual({ kind: 'question_resolved' });
      await expect(response).resolves.toMatchObject({ approved: index === 0 });
      expect(send).toHaveBeenCalledWith(CoworkIpcChannel.StreamPermissionDismiss, { requestId });
      expect(runtime.canAccessLocalQuestion(requestId)).toBe(false);
      await expect(submitCoworkPermission({ requestId, result }, deps)).rejects.toThrow('APPROVAL_ACCESS_DENIED');
    }
    expect(dismissed).toHaveBeenCalledTimes(3);
  });

  test.each([true, false])('local questions with session binding=%s reject unknown IDs and account changes', async bound => {
    const account = { generation: 0 };
    const { runtime, requested, deps, permissionSessions } = await fixture(false, account);
    permissionSessions.set('unknown', SESSION_AGNOSTIC_PERMISSION_SESSION_ID);
    await expect(submitCoworkPermission({ requestId: 'unknown', result: { behavior: 'allow' } }, deps))
      .rejects.toThrow('APPROVAL_ACCESS_DENIED');
    const response = runtime.askUserInternal(questions, 1_000, { sessionKey: bound ? sessionKey : undefined, localOnly: true });
    const requestId = requested.mock.calls[0][1].requestId;
    account.generation += 1;
    // Even a return to the same account must not revive its earlier request.
    for (const behavior of ['allow', 'deny'] as const) {
      await expect(submitCoworkPermission({ requestId, result: { behavior } }, deps)).rejects.toThrow('APPROVAL_ACCESS_DENIED');
    }
    expect(deps.resolveQuestion).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(response).resolves.toMatchObject({ behavior: 'deny', reason: AskUserResponseReason.Timeout });
    expect(runtime.canAccessLocalQuestion(requestId)).toBe(false);
  });

  test('account capture failure denies the request without displaying a stranded dialog or retaining a timer', async () => {
    const error = new Error('Account state unavailable');
    const { runtime, permissionSessions, requested, dismissed } = await fixture(false, {
      get generation(): number { throw error; },
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runtime.askUserInternal(questions, 1_000)).resolves.toMatchObject({
      behavior: 'deny', reason: AskUserResponseReason.Unavailable,
    });
    expect(permissionSessions.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(requested).not.toHaveBeenCalled();
    expect(send.mock.calls.some(([channel]) => channel === CoworkIpcChannel.StreamPermission)).toBe(false);
    expect(dismissed).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[AskUser] Failed to capture request account', expect.any(Object), error);
  });

  test.each([undefined, () => () => false])('unavailable account guard denies before showing the question', async captureAccountSnapshot => {
    const permissionSessions = new Map<string, string>();
    const runtime = new McpRuntime({
      permissionSessions, captureAccountSnapshot,
      getStore: () => { throw new Error('Unexpected database access'); },
      syncOpenClawConfig: vi.fn(),
    });
    await runtime.startAskUserServer();
    await expect(runtime.askUserInternal(questions, 1_000)).resolves.toMatchObject({
      behavior: 'deny', reason: AskUserResponseReason.Unavailable,
    });
    expect(permissionSessions.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(send.mock.calls.some(([channel]) => channel === CoworkIpcChannel.StreamPermission)).toBe(false);
  });

  test('bridge shutdown releases local account guards and timers for global and bound questions', async () => {
    let stopBridge!: () => Promise<void>;
    vi.spyOn(McpBridgeServer.prototype, 'start').mockImplementation(async function (this: McpBridgeServer) {
      stopBridge = this.stop.bind(this);
      return 1234;
    });
    const { runtime, requested, permissionSessions } = await fixture();
    const responses = [runtime.askUserInternal(questions, 1_000), runtime.askUserInternal(questions, 1_000, { sessionKey })];
    const requests = requested.mock.calls.map(([sessionId, request]) => ({ sessionId, requestId: request.requestId }));
    for (const { requestId } of requests) expect(runtime.canAccessLocalQuestion(requestId)).toBe(true);
    await stopBridge();
    expect(await Promise.all(responses)).toEqual([
      { behavior: 'deny', reason: AskUserResponseReason.Unavailable },
      { behavior: 'deny', reason: AskUserResponseReason.Unavailable },
    ]);
    expect(vi.getTimerCount()).toBe(0);
    expect(permissionSessions.size).toBe(0);
    for (const { requestId, sessionId } of requests) {
      // Restoring the routing record cannot revive a released account guard.
      permissionSessions.set(requestId, sessionId);
      expect(runtime.canAccessLocalQuestion(requestId)).toBe(false);
    }
  });

  test('global questions reject responses at the deadline even before the timeout callback runs', async () => {
    vi.setSystemTime(1_000);
    const { runtime, requested, deps, dismissed } = await fixture();
    const response = runtime.askUserInternal(questions, 1_000);
    const requestId = requested.mock.calls[0][1].requestId;
    vi.setSystemTime(2_000);
    await expect(submitCoworkPermission({ requestId, result: { behavior: 'allow' } }, deps)).rejects.toThrow('APPROVAL_ACCESS_DENIED');
    expect(deps.resolveQuestion).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(response).resolves.toMatchObject({ behavior: 'deny', reason: AskUserResponseReason.Timeout });
    expect(dismissed).toHaveBeenCalledExactlyOnceWith(requestId);
    expect(send).toHaveBeenCalledWith(CoworkIpcChannel.StreamPermissionDismiss, { requestId });
  });

  test.each(['allow', 'deny'] as const)('registers the session before showing a question and submits %s', async behavior => {
    const { runtime, permissionSessions, requested, dismissed, deps } = await fixture();
    send.mockImplementation((channel: string, payload: { request?: { requestId: string } }) => {
      if (channel === CoworkIpcChannel.StreamPermission) {
        expect(permissionSessions.get(payload.request!.requestId)).toBe('session-a');
      }
    });
    const response = runtime.askUserInternal(questions, 1_000, { sessionKey });
    const requestId = requested.mock.calls[0][1].requestId as string;
    const result = { behavior, updatedInput: { answers: { Continue: 'Yes' } } };
    await expect(submitCoworkPermission({ requestId, result }, deps)).resolves.toEqual({ kind: 'question_resolved' });
    await expect(response).resolves.toEqual({ behavior, answers: behavior === 'allow' ? result.updatedInput.answers : undefined });
    expect(permissionSessions.has(requestId)).toBe(false);
    expect(dismissed).toHaveBeenCalledExactlyOnceWith(requestId);
    expect(send).toHaveBeenCalledWith(CoworkIpcChannel.StreamPermissionDismiss, { requestId });
    expect(runtime.resolveAskUser(requestId, { behavior })).toBe(false);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(dismissed).toHaveBeenCalledTimes(1);
  });

  test('account access denial does not consume or resolve the pending question', async () => {
    const { runtime, permissionSessions, requested, deps } = await fixture();
    const response = runtime.askUserInternal(questions, 1_000, { sessionKey });
    const requestId = requested.mock.calls[0][1].requestId as string;
    deps.canAccessSession.mockReturnValue(false);
    await expect(submitCoworkPermission({ requestId, result: { behavior: 'allow' } }, deps))
      .rejects.toThrow('APPROVAL_ACCESS_DENIED');
    expect(deps.resolveQuestion).not.toHaveBeenCalled();
    expect(permissionSessions.get(requestId)).toBe('session-a');
    runtime.resolveAskUser(requestId, { behavior: 'deny' });
    await expect(response).resolves.toMatchObject({ behavior: 'deny' });
  });

  test('timeout removes session ownership, dismisses the dialog, and rejects a late submission', async () => {
    const { runtime, permissionSessions, requested, dismissed, deps } = await fixture();
    const response = runtime.askUserInternal(questions, 1_000, { sessionKey });
    const requestId = requested.mock.calls[0][1].requestId as string;
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(response).resolves.toMatchObject({ behavior: 'deny', reason: AskUserResponseReason.Timeout });
    expect(permissionSessions.has(requestId)).toBe(false);
    expect(dismissed).toHaveBeenCalledExactlyOnceWith(requestId);
    expect(send).toHaveBeenCalledWith(CoworkIpcChannel.StreamPermissionDismiss, { requestId });
    await expect(submitCoworkPermission({ requestId, result: { behavior: 'allow' } }, deps))
      .rejects.toThrow('APPROVAL_ACCESS_DENIED');
    expect(deps.resolveQuestion).not.toHaveBeenCalled();
    expect(runtime.resolveAskUser(requestId, { behavior: 'allow' })).toBe(false);
  });

  test('unrecognized desktop sessions cannot create a visible question or ownership record', async () => {
    const { runtime, permissionSessions, requested } = await fixture();
    await expect(runtime.askUserInternal(questions, 1_000, { sessionKey: 'unknown' }))
      .resolves.toMatchObject({ behavior: 'deny' });
    expect(permissionSessions.size).toBe(0);
    expect(requested).not.toHaveBeenCalled();
    expect(send.mock.calls.some(([channel]) => channel === CoworkIpcChannel.StreamPermission)).toBe(false);
  });
});


describe('MCP question authority bridge', () => {
  test('registers the original form and actual lifetime before display; adapts canonical answers once', async () => {
    vi.setSystemTime(1_000);
    const { runtime, registered, settled } = await fixture(true);
    send.mockImplementation(channel => {
      if (channel === CoworkIpcChannel.StreamPermission) expect(registered).toHaveBeenCalledTimes(1);
    });
    const form = [
      { question: 'Which platforms?', header: 'Targets', multiSelect: true,
        options: [{ label: 'macOS', description: 'Desktop' }, { label: 'Windows' }] },
      { question: 'Release label?', options: [] },
    ];
    const response = runtime.askUserInternal(form, 10_000, { sessionKey });
    const registration = registered.mock.calls[0][0];
    expect(registration).toMatchObject({ kind: 'legacy', sessionId: 'session-a', createdAt: 1_000, expiresAt: 11_000,
      questions: [{ questionId: 'q_0', question: 'Which platforms?', header: 'Targets', multiSelect: true,
        isOther: true, allowSkip: true, options: form[0].options },
      { questionId: 'q_1', question: 'Release label?', allowSkip: true }] });
    const answer = { q_0: ['macOS', 'Windows'], q_1: ['Preview'] };
    expect(registration.resolve({ action: 'answer', answers: answer })).toEqual({ kind: 'confirmed', status: 'answered', answers: answer });
    await expect(response).resolves.toEqual({ behavior: 'allow', answers: { 'Which platforms?': 'macOS|||Windows', 'Release label?': 'Preview' } });
    expect(settled).toHaveBeenCalledExactlyOnceWith(registration.requestId, { status: 'answered', answers: answer });
    expect(registration.resolve({ action: 'answer', answers: answer })).toEqual({ kind: 'known_not_applied', reason: 'QUESTION_UNAVAILABLE' });
    expect(settled).toHaveBeenCalledTimes(1);
  });

  test('arbitrates competing mobile and desktop answers through the real authority', async () => {
    const { runtime, registered, settled } = await fixture(true);
    const rows = new Map<string, string>();
    const authority = new RemoteQuestionService({
      get: (key: string) => rows.has(key) ? JSON.parse(rows.get(key)!) : undefined,
      put: (key: string, value: unknown) => rows.set(key, JSON.stringify(value)),
      transaction: (operation: () => unknown) => operation(), updateQuestion: () => {},
    } as unknown as RemoteStore, () => ({ runId: 'run-a', owner: { userId: 'user-a', scopeKey: 'personal' }, agentId: 'main', cwd: '/workspace' }));
    registered.mockImplementation(input => authority.register(input));
    settled.mockImplementation((id, result) => authority.settle(id, result));
    const localResponse = runtime.askUserInternal(questions, 10_000, { sessionKey });
    const requestId = registered.mock.calls[0][0].requestId;
    const state = authority.getState(requestId)!;
    const mobile = authority.submit(state.questionId, { behavior: 'allow', updatedInput: { answers: { q_0: ['Yes'] } } }, {
      submissionId: 'mobile-submit', source: 'mobile', expectedVersion: state.questionVersion,
      operationDigest: state.operationDigest, beforeDispatch: () => {},
    });
    await expect(authority.submit(requestId, { behavior: 'deny' }, { submissionId: 'desktop-submit', source: 'desktop' }))
      .resolves.toMatchObject({ kind: 'known_not_applied', reason: 'QUESTION_STALE' });
    await expect(mobile).resolves.toMatchObject({ kind: 'confirmed', status: 'answered', answers: { q_0: ['Yes'] } });
    await expect(localResponse).resolves.toEqual({ behavior: 'allow', answers: { 'Continue?': 'Yes' } });
    expect(settled).toHaveBeenCalledTimes(1);
    expect(authority.getState(requestId)?.status).toBe('answered');
  });

  test.each(['desktop', 'mobile'] as const)('preserves skipped plugin question IDs through %s authority responses', async source => {
    const { runtime, registered, settled, deps } = await fixture(true);
    const rows = new Map<string, string>();
    const authority = new RemoteQuestionService({
      get: (key: string) => rows.has(key) ? JSON.parse(rows.get(key)!) : undefined,
      put: (key: string, value: unknown) => rows.set(key, JSON.stringify(value)),
      transaction: (operation: () => unknown) => operation(), updateQuestion: () => {},
    } as unknown as RemoteStore, () => ({ runId: 'run-a', owner: { userId: 'user-a', scopeKey: 'personal' }, agentId: 'main', cwd: '/workspace' }));
    registered.mockImplementation(input => authority.register(input));
    settled.mockImplementation((id, result) => authority.settle(id, result));
    deps.runtime.getQuestionState = id => authority.getState(id);
    deps.runtime.respondToQuestionConfirmed = (id, result, options) => authority.submit(id, result, options);
    const localResponse = runtime.askUserInternal([
      questions[0],
      { ...questions[0], id: 'release-label', question: 'Release label?' },
      { ...questions[0], question: 'Release date?' },
    ], 10_000, { sessionKey });
    const requestId = registered.mock.calls[0][0].requestId;
    const state = authority.getState(requestId)!;
    const result = source === 'desktop'
      ? submitCoworkPermission({ requestId, result: { behavior: 'allow', updatedInput: {
        answers: { 'Continue?': 'Yes' }, skippedQuestionIds: ['release-label', 'question-3'],
      } } }, deps)
      : authority.submit(state.questionId, { behavior: 'allow', updatedInput: {
        answers: { q_0: ['Yes'], q_1: [], q_2: [] },
      } }, {
        submissionId: 'mobile-skip', source, expectedVersion: state.questionVersion,
        operationDigest: state.operationDigest, beforeDispatch: () => {},
      });
    await expect(result).resolves.toMatchObject({ kind: 'confirmed', status: 'answered' });
    await expect(localResponse).resolves.toEqual({
      behavior: 'allow', answers: { 'Continue?': 'Yes' }, skippedQuestionIds: ['release-label', 'question-3'],
    });
    expect(authority.getState(requestId)?.resolution.answers).toEqual({ q_0: ['Yes'], q_1: [], q_2: [] });
    expect(deps.resolveQuestion).not.toHaveBeenCalled();
  });

  test('does not publish session-agnostic or duplicate legacy keys to remote control', async () => {
    const { runtime, registered, requested } = await fixture(true);
    const global = runtime.askUserInternal(questions, 1_000);
    expect(registered).not.toHaveBeenCalled();
    runtime.resolveAskUser(requested.mock.calls[0][1].requestId, { behavior: 'deny' });
    await expect(global).resolves.toEqual({ behavior: 'deny' });
    const duplicate = runtime.askUserInternal([...questions, ...questions], 1_000, { sessionKey });
    expect(registered).not.toHaveBeenCalled();
    runtime.resolveAskUser(requested.mock.calls[1][1].requestId, { behavior: 'deny' });
    await expect(duplicate).resolves.toEqual({ behavior: 'deny' });
  });

  test('keeps secret-marked forms local instead of stripping their marker during adaptation', async () => {
    const { runtime, registered, requested } = await fixture(true);
    const response = runtime.askUserInternal([{ ...questions[0], isSecret: true } as typeof questions[number]], 1_000, { sessionKey });
    expect(registered).not.toHaveBeenCalled();
    runtime.resolveAskUser(requested.mock.calls[0][1].requestId, { behavior: 'deny' });
    await expect(response).resolves.toEqual({ behavior: 'deny' });
  });

  test('reports timeout to authority and never calls the old resolver as a second attempt', async () => {
    const { runtime, registered, settled } = await fixture(true);
    const response = runtime.askUserInternal(questions, 1_000, { sessionKey });
    const registration = registered.mock.calls[0][0];
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(response).resolves.toMatchObject({ reason: AskUserResponseReason.Timeout });
    expect(settled).toHaveBeenCalledExactlyOnceWith(registration.requestId, { status: 'expired' });
    const resolve = vi.spyOn(runtime, 'resolveAskUser');
    expect(registration.resolve({ action: 'cancel', answers: {} })).toEqual({ kind: 'known_not_applied', reason: 'QUESTION_UNAVAILABLE' });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test('keeps the original local form usable if remote registration fails', async () => {
    const { runtime, registered, requested, settled } = await fixture(true);
    registered.mockImplementation(() => { throw new Error('derived database unavailable'); });
    const response = runtime.askUserInternal(questions, 1_000, { sessionKey });
    const requestId = requested.mock.calls[0][1].requestId;
    expect(send).toHaveBeenCalledWith(CoworkIpcChannel.StreamPermission, expect.any(Object));
    expect(runtime.resolveAskUser(requestId, { behavior: 'allow', answers: { 'Continue?': 'Yes' } })).toBe(true);
    await expect(response).resolves.toMatchObject({ behavior: 'allow' });
    expect(settled).not.toHaveBeenCalled();
  });

  test('returns the actual expiry outcome when an answer races the local deadline', async () => {
    vi.setSystemTime(1_000);
    const { runtime, registered } = await fixture(true);
    const response = runtime.askUserInternal(questions, 1_000, { sessionKey });
    const registration = registered.mock.calls[0][0];
    vi.setSystemTime(2_001);
    expect(registration.resolve({ action: 'answer', answers: { q_0: ['Yes'] } })).toEqual({ kind: 'known_not_applied', status: 'expired', reason: 'QUESTION_UNAVAILABLE' });
    await expect(response).resolves.toMatchObject({ behavior: 'deny', reason: AskUserResponseReason.Timeout });
  });
});


test('recoverable video confirmation stays on desktop and uses revision-checked consent', async () => {
  const { runtime, registered, settled, permissionSessions } = await fixture(true);
  const response = runtime.askUserInternal(questions, 1_000, {
    sessionKey,
    recoverableMedia: { isCurrent: () => true, refresh: async () => questions, onEvent: vi.fn() },
  });
  const [pending] = runtime.getPendingMediaConfirmations();
  expect(pending).toMatchObject({ sessionId: 'session-a', toolInput: { mediaConfirmation: { revision: 0 } } });
  expect(permissionSessions.get(pending.requestId)).toBe('session-a');
  expect(registered).not.toHaveBeenCalled();
  expect(await runtime.actOnMediaConfirmation({
    requestId: pending.requestId, revision: 0, action: MediaConfirmationAction.Shown,
  })).toBe(true);
  expect(await runtime.actOnMediaConfirmation({
    requestId: pending.requestId, revision: 1, action: MediaConfirmationAction.Respond,
    response: { behavior: ConfirmationBehavior.Allow, answers: { 'Continue?': 'Yes' } },
  })).toBe(false);
  expect(await runtime.actOnMediaConfirmation({
    requestId: pending.requestId, revision: 0, action: MediaConfirmationAction.Respond,
    response: { behavior: ConfirmationBehavior.Allow, answers: { 'Continue?': 'Yes' } },
  })).toBe(true);
  await expect(response).resolves.toMatchObject({ behavior: ConfirmationBehavior.Allow });
  expect(runtime.getPendingMediaConfirmations()).toEqual([]);
  expect(permissionSessions.has(pending.requestId)).toBe(false);
  expect(settled).not.toHaveBeenCalled();
});
