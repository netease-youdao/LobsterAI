import { expect, test, vi } from 'vitest';

import { type RemoteStore } from '../../remote/remoteStore';
import { type PermissionRequest } from '../agentEngine/types';
import { DshRemoteInteractions } from './dshRemoteInteractions';
import { type DshRemoteTurnEvidence } from './dshRemoteTurnEvidence';
import { DshWaterfallReceipt } from './dshTypertClient';

function setup() {
  const kv = new Map<string, unknown>();
  const store = {
    get: (key: string) => structuredClone(kv.get(key) ?? null),
    put: (key: string, value: unknown) => kv.set(key, structuredClone(value)),
    entries: () => [], transaction: (fn: () => void) => fn(), updateQuestion: vi.fn(),
    owner: () => ({ userId: 'user', scopeKey: 'personal' }),
  } as unknown as RemoteStore;
  const decisions = new DshRemoteInteractions({ remote: store, getSession: () => ({ id: 's', cwd: process.cwd() }),
    evidence: { binding: () => ({ remoteRunId: 'run' }) } as unknown as DshRemoteTurnEvidence, ready: () => true,
    client: () => null, emit: vi.fn() });
  decisions.configure({ enabled: true, projectionSupported: true });
  const req: PermissionRequest = { requestId: 'req', toolUseId: 'call', toolName: 'bash', toolInput: {} };
  const resolve = vi.fn();
  const delivery = Promise.withResolvers<DshWaterfallReceipt>();
  const live = { request: req, sessionId: 's', resolve, event: { eventId: 'evt', event: 'approval/request', agentId: 'native',
    request: {}, signal: new AbortController().signal, confirmDelivery: () => delivery.promise },
  nativeApproval: { toolName: 'bash', nativeSessionId: 'native', coworkSessionId: 's', recordedAt: Date.now(),
    args: { command: 'rm -- example.txt', workdir: process.cwd() } } };
  return { decisions, live, delivery, resolve };
}

test('a phone only wins the original approved operation after the actual owner receipt', async () => {
  const { decisions, live, delivery, resolve } = setup();
  expect(decisions.register(live, 'approval', 'nativeRequest')).toBe(true);
  const state = decisions.approvals.getState('req')!;
  expect(state.remoteAllowed).toBe(true);
  const phone = decisions.submitApproval('req', { behavior: 'allow' }, { submissionId: 'phone',
    source: 'mobile', expectedVersion: state.approvalVersion, operationDigest: state.operationDigest, beforeDispatch: vi.fn() });
  expect((await decisions.submitApproval('req', { behavior: 'deny', message: 'Denied' })).kind).toBe('known_not_applied');
  expect(resolve).toHaveBeenCalledWith({ kind: 'result', value: 'allowed-once' });
  delivery.resolve(DshWaterfallReceipt.Applied);
  expect((await phone).kind).toBe('confirmed');
  expect(resolve).toHaveBeenCalledTimes(1);
});

test('a mismatched native session or sensitive field keeps the request local', () => {
  const { decisions, live } = setup();
  expect(decisions.register({ ...live, nativeApproval: { ...live.nativeApproval, nativeSessionId: 'different' } }, 'approval', 'a')).toBe(false);
  expect(decisions.register({ ...live, request: { ...live.request, toolInput: {
    questions: [{ id: 'password', question: 'Password', inputType: 'password' }],
  } } }, 'user-questions', 'a')).toBe(false);
});
