import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { CoworkIpcChannel } from '../../shared/cowork/constants';
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

async function fixture(authority = false) {
  const permissionSessions = new Map<string, string>();
  const requested = vi.fn();
  const dismissed = vi.fn();
  const registered = vi.fn().mockReturnValue({});
  const settled = vi.fn();
  const runtime = new McpRuntime({
    permissionSessions,
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
