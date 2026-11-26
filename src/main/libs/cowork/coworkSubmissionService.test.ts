import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SubagentCollaborationMode } from '../../../shared/agent/constants';
import type { CoworkStore } from '../../coworkStore';
import { prepareCoworkSubmission } from './coworkSubmissionService';

const remote = vi.hoisted(() => ({
  context: vi.fn(),
  permit: vi.fn(),
  dispatched: vi.fn(),
}));
vi.mock('../../remote/sessionCommandService', () => ({
  DSH_REMOTE_BINDING_VERSION: 'dsh-v1',
  currentRemoteExecution: remote.context,
  assertRemoteExecutionPermit: remote.permit,
  markRemoteExecutionDispatched: remote.dispatched,
}));

beforeEach(() => vi.resetAllMocks());

function fixture() {
  const owner = { userId: '1', scopeKey: 'personal' };
  const run = { runId: 'run' };
  const binding = new Map<string, unknown>();
  const allowed = new Set(['main', 'worker']);
  const ids = ['main', 'worker', 'foreign'];
  const agent = (id: string) => ({
    id, enabled: true, subagentCollaborationMode: SubagentCollaborationMode.All, subagentAllowAgentIds: [],
  });
  const store = {
    remote: {
      run: () => run, assertActor: vi.fn(), assertNoDeletionEffect: vi.fn(),
      get: (key: string) => binding.get(key), put: (key: string, value: unknown) => binding.set(key, value),
      transaction: (write: () => void) => write(), markExecutionDispatch: vi.fn(), markRunDispatched: vi.fn(),
    },
    agentOwnership: { canPublish: (id: string) => allowed.has(id), get: () => ({ version: '1' }) },
    getSession: () => ({ id: 'local', agentId: 'main' }), getAgent: agent, listVisibleAgents: () => ids.map(agent),
  };
  const grant = vi.fn(() => true);
  remote.context.mockReturnValue({ commandId: 'command', runId: run.runId, preparedSessionId: 'local', owner, stillPermitted: grant });
  const make = () => prepareCoworkSubmission(store as unknown as CoworkStore, 'local', () => owner);
  return { make, binding, allowed, grant, store };
}

describe('Cowork mobile dispatch', () => {
  it('persists the native binding before sending and releases the claim on matching admission', async () => {
    const { make, binding } = fixture();
    const submission = make();
    const hooks = submission.options.remoteTurn!;
    const id = submission.options.requestId!;
    expect(make().options.requestId).toBe(id);
    expect(hooks.allowedAgentIds).toEqual(['main', 'worker']);
    const completed = vi.fn();
    const waiting = submission.awaitAdmission(new Promise<void>(() => undefined)).then(completed);
    hooks.beforeDispatch('native', id);
    expect(binding.get('gatewayRun:local')).toEqual({ runId: id, remoteRunId: 'run', sessionKey: 'native', gatewayBootId: 'dsh-v1' });
    expect(() => hooks.onAccepted('other', id)).toThrow();
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    hooks.onAccepted('native', id);
    await waiting;
    expect(completed).toHaveBeenCalledOnce();
  });

  it('checks the grant again on retry and checks current delegation rights during the turn', () => {
    const { make, grant, allowed } = fixture();
    const { options } = make();
    const hooks = options.remoteTurn!;
    hooks.beforeDispatch('native', options.requestId!);
    grant.mockReturnValue(false);
    expect(() => hooks.beforeDispatch('native', options.requestId!)).toThrow();
    expect(() => hooks.assertDelegate('worker')).not.toThrow();
    allowed.delete('worker');
    expect(() => hooks.assertDelegate('worker')).toThrow();
    expect(() => hooks.assertDelegate('foreign')).toThrow();
    expect(remote.dispatched).toHaveBeenCalledOnce();
  });

  it('leaves an unconfirmed phone submission unknown and preserves the immediate desktop response', async () => {
    const { make } = fixture();
    await expect(make().awaitAdmission(Promise.resolve())).rejects.toThrow('could not be confirmed');
    remote.context.mockReturnValue(undefined);
    const local = make();
    expect(local.options.remoteTurn).toBeUndefined();
    await local.awaitAdmission(new Promise<void>(() => undefined));
  });
});
