import { describe, expect, test, vi } from 'vitest';

import { CoworkGoalStatus } from '../../../shared/cowork/goal';
import { CoworkMessageEditPhase } from '../../../shared/cowork/messageEdit';
import type { CoworkMessage, CoworkSession, CoworkStore } from '../../coworkStore';
import type { CoworkMessageEditOperation } from '../coworkMessageEditStore';
import type { CoworkMessageVersionSwitch } from '../coworkMessageVersionStore';
import { buildOpenClawLocalTimeContextPrompt } from '../openclawLocalTimeContextPrompt';
import { OpenClawGatewayMethod } from './constants';
import { CoworkMessageEditCoordinator, type EditHistory,findEditableEntry, matchesEditRun } from './coworkMessageEdit';
import type { CoworkContinueOptions } from './types';

const user: CoworkMessage = { id: 'local', type: 'user', content: 'continue', timestamp: 100,
  metadata: { openclawRequestId: 'original-run', kitIds: ['kit'] } };
const original: EditHistory = {
  sessionId: 'transcript-1', sessionInfo: { activeLeafEntryId: 'reply' }, hasMore: false,
  messages: [
    { role: 'user', content: 'prior', timestamp: 1, __openclaw: { id: 'prior' } },
    { role: 'user', content: 'continue', timestamp: 100, __openclaw: { id: 'target', idempotencyKey: 'original-run:user' } },
    { role: 'assistant', content: 'old', __openclaw: { id: 'reply' } },
  ],
};
const rewound: EditHistory = { sessionId: 'transcript-2', sessionInfo: { activeLeafEntryId: 'prior' }, messages: original.messages.slice(0, 1) };

function fixture() {
  let history = structuredClone(original);
  let pending: CoworkMessageEditOperation | null = null;
  const edits = {
    pending: () => pending,
    prepare: vi.fn((operation: CoworkMessageEditOperation) => { pending = operation; }),
    truncate: vi.fn(), restore: vi.fn(() => { pending = null; }),
    setPhase: vi.fn((operation: CoworkMessageEditOperation, phase: CoworkMessageEditPhase) => {
      operation.phase = phase;
      if (phase === CoworkMessageEditPhase.Committed) pending = null;
    }),
    commitRecovered: vi.fn(() => { pending = null; }),
  };
  let pendingSwitch: CoworkMessageVersionSwitch | null = null;
  const versions = {
    recordEdit: vi.fn(),
    pendingSwitch: () => pendingSwitch,
    beginSwitch: vi.fn((sessionId: string, _messageId: string, _targetIndex: number, activeLeafEntryId: string) => {
      pendingSwitch = { sessionId, fromVersionId: 'from', toVersionId: 'to', activeLeafEntryId, targetLeafEntryId: 'old-tip' };
      return pendingSwitch;
    }),
    cancelSwitch: vi.fn(() => { pendingSwitch = null; }),
    applySwitch: vi.fn(() => { pendingSwitch = null; return 'old-head'; }),
  };
  const request = vi.fn(async (method: string) => {
    if (method === OpenClawGatewayMethod.SessionsRewind) { history = structuredClone(rewound); return {}; }
    if (method === OpenClawGatewayMethod.SessionsBranchesSwitch) { history = structuredClone(original); return {}; }
    return history;
  });
  const send = vi.fn(async (_sessionId: string, _prompt: string, options: CoworkContinueOptions) => { options.onAccepted?.(); });
  const reset = vi.fn();
  const isBusy = vi.fn(() => false);
  const getSession = vi.fn(() => ({ id: 'session', status: 'completed', goal: null as CoworkSession['goal'] }));
  const store = { messageEdits: edits, messageVersions: versions, getSession, getMessage: () => user,
    getAllConversationMessages: () => [user], updateMessage: vi.fn() } as unknown as CoworkStore;
  const coordinator = new CoworkMessageEditCoordinator({ store, request: request as never,
    resolveSessionKey: () => 'key', isBusy, reset, send });
  const edit = () => coordinator.edit({ sessionId: 'session', messageId: 'local', prompt: 'corrected' }, { kitIds: ['kit'] });
  const switchVersion = () => coordinator.switchVersion({ sessionId: 'session', messageId: 'local', targetIndex: 1 });
  return { coordinator, edit, edits, versions, switchVersion, request, send, reset, isBusy, getSession,
    setHistory: (value: EditHistory) => { history = value; },
    setPendingSwitch: (value: CoworkMessageVersionSwitch | null) => { pendingSwitch = value; } };
}

describe('precise transcript anchors', () => {
  test('uses request identity including native :user admission, even for duplicate text', () => {
    expect(matchesEditRun(original.messages[1], 'original-run')).toBe(true);
    expect(matchesEditRun(original.messages[1], 'original')).toBe(false);
    expect(findEditableEntry(user, [user, user], original)?.__openclaw?.id).toBe('target');
    expect(findEditableEntry({ ...user, metadata: { openclawEntryId: 'off-path' } }, [user], original)).toBeUndefined();
  });
  test('only migrates complete, unique, time-matched legacy text with known wrappers', () => {
    const legacy = { ...user, metadata: undefined };
    const history = structuredClone(original);
    history.messages[1].content = '[Session info]\nmodel\n\n[Current user request]\ncontinue\n\n' + buildOpenClawLocalTimeContextPrompt();
    expect(findEditableEntry(legacy, [legacy], history)?.__openclaw?.id).toBe('target');
    expect(findEditableEntry(legacy, [legacy, legacy], history)).toBeUndefined();
    expect(findEditableEntry(legacy, [legacy], { ...history, hasMore: true })).toBeUndefined();
    history.messages[1].timestamp = 50_000;
    expect(findEditableEntry(legacy, [legacy], history)).toBeUndefined();
  });
});

describe('rewind and resend operation', () => {
  test('checkpoints before rewind and commits only once the replacement is accepted', async () => {
    const f = fixture();
    await f.edit();
    expect(f.edits.prepare).toHaveBeenCalledOnce();
    expect(f.edits.truncate).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledWith('session', 'corrected', expect.objectContaining({ kitIds: ['kit'], requestId: expect.any(String) }));
    expect(f.edits.pending()).toBeNull();
    expect(f.edits.prepare.mock.invocationCallOrder[0]).toBeLessThan(f.edits.truncate.mock.invocationCallOrder[0]);
    // The replaced conversation is only kept as a version once the edit is committed.
    expect(f.versions.recordEdit).toHaveBeenCalledOnce();
    expect(f.versions.recordEdit.mock.calls[0][0]).toMatchObject({ messageId: 'local', originalLeafId: 'reply', prefixEntryIds: ['prior'] });
  });
  test('rejects active runs before touching history or local data', async () => {
    const f = fixture(); f.isBusy.mockReturnValue(true);
    await expect(f.edit()).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.edits.prepare).not.toHaveBeenCalled();
  });
  test('rejects a reserved send and goal state that lives outside the transcript', async () => {
    const f = fixture();
    f.getSession.mockReturnValue({ id: 'session', status: 'running', goal: null });
    await expect(f.edit()).rejects.toThrow();
    f.getSession.mockReturnValue({ id: 'session', status: 'completed', goal: {
      id: 'goal', objective: 'External goal state', status: CoworkGoalStatus.Complete,
      createdAt: 1, updatedAt: 2, tokensUsed: 1,
    } });
    await expect(f.edit()).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.edits.prepare).not.toHaveBeenCalled();
  });
  test('leaves a durable recovery operation after send failure and restores the old branch without resending', async () => {
    const f = fixture(); f.send.mockRejectedValue(new Error('network disconnected'));
    await expect(f.edit()).rejects.toThrow('network disconnected');
    expect(f.versions.recordEdit).not.toHaveBeenCalled();
    const operation = f.edits.pending()!;
    expect(operation.phase).toBe(CoworkMessageEditPhase.Sending);
    await expect(f.edit()).rejects.toThrow();
    await f.coordinator.recover('session', operation.operationId);
    expect(f.request).toHaveBeenCalledWith(OpenClawGatewayMethod.SessionsBranchesSwitch, { sessionKey: 'key', leafEntryId: 'reply' });
    expect(f.edits.restore).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledOnce();
  });
  test('does not rewind or resend an accepted request whose acknowledgement was lost', async () => {
    const f = fixture();
    f.send.mockImplementation(async (_id, _prompt, options) => {
      f.setHistory({ ...rewound, messages: [...rewound.messages,
        { role: 'user', content: 'corrected', __openclaw: { id: 'new', idempotencyKey: `${options.requestId}:user` } },
        { role: 'assistant', content: 'new reply', __openclaw: { id: 'new-reply' } }] });
      throw new Error('ack timeout');
    });
    await expect(f.edit()).rejects.toThrow('ack timeout');
    const operation = f.edits.pending()!;
    await f.coordinator.recover('session', operation.operationId);
    expect(f.edits.commitRecovered).toHaveBeenCalledOnce();
    expect(f.edits.restore).not.toHaveBeenCalled();
    expect(f.request.mock.calls.some(([method]) => method === OpenClawGatewayMethod.SessionsBranchesSwitch)).toBe(false);
    expect(f.send).toHaveBeenCalledOnce();
  });
  test('refuses recovery over unrelated newer work', async () => {
    const f = fixture(); f.send.mockRejectedValue(new Error('failed'));
    await expect(f.edit()).rejects.toThrow();
    const operation = f.edits.pending()!;
    f.setHistory({ ...rewound, sessionInfo: { activeLeafEntryId: 'other' }, messages: [
      ...rewound.messages, { role: 'user', content: 'external work', __openclaw: { id: 'other' } },
    ] });
    await expect(f.coordinator.recover('session', operation.operationId)).rejects.toThrow();
    expect(f.edits.restore).not.toHaveBeenCalled();
    expect(f.edits.pending()).not.toBeNull();
  });
});

describe('switching between message versions', () => {
  const onTip = (leaf: string): EditHistory => ({ ...structuredClone(original), sessionInfo: { activeLeafEntryId: leaf } });
  /** A gateway that honours branch switches, unless told to refuse them. */
  function gateway(f: ReturnType<typeof fixture>, refuse = false) {
    f.request.mockImplementation((async (method: string, params: { leafEntryId?: string }) => {
      if (method !== OpenClawGatewayMethod.SessionsBranchesSwitch) return current;
      if (refuse) throw new Error('not-branch-tip');
      current = onTip(params.leafEntryId!);
      return {};
    }) as never);
    let current = onTip('reply');
    return { set: (leaf: string) => { current = onTip(leaf); } };
  }

  test('points the gateway at the stored branch before swapping the local conversation', async () => {
    const f = fixture(); gateway(f);
    await expect(f.switchVersion()).resolves.toBe('old-head');
    expect(f.versions.beginSwitch).toHaveBeenCalledWith('session', 'local', 1, 'reply');
    expect(f.request).toHaveBeenCalledWith(OpenClawGatewayMethod.SessionsBranchesSwitch, { sessionKey: 'key', leafEntryId: 'old-tip' });
    expect(f.versions.applySwitch).toHaveBeenCalledOnce();
    expect(f.reset).toHaveBeenCalledWith('session');
    expect(f.versions.pendingSwitch()).toBeNull();
  });

  test('leaves the conversation alone when the gateway does not move to the branch', async () => {
    const f = fixture(); gateway(f, true);
    await expect(f.switchVersion()).rejects.toThrow();
    expect(f.versions.applySwitch).not.toHaveBeenCalled();
    expect(f.versions.cancelSwitch).toHaveBeenCalledOnce();
    expect(f.reset).not.toHaveBeenCalled();
  });

  test('trusts the transcript over a lost acknowledgement', async () => {
    const f = fixture(); const remote = gateway(f, true);
    f.versions.beginSwitch.mockImplementationOnce((sessionId, _messageId, _targetIndex, activeLeafEntryId) => {
      remote.set('old-tip');
      const pending = { sessionId, fromVersionId: 'from', toVersionId: 'to', activeLeafEntryId, targetLeafEntryId: 'old-tip' };
      f.setPendingSwitch(pending);
      return pending;
    });
    await expect(f.switchVersion()).resolves.toBe('old-head');
    expect(f.versions.applySwitch).toHaveBeenCalledOnce();
  });

  test('finishes a switch that was interrupted after it was recorded', async () => {
    const f = fixture(); gateway(f);
    f.setPendingSwitch({ sessionId: 'session', fromVersionId: 'from', toVersionId: 'to', activeLeafEntryId: 'reply', targetLeafEntryId: 'old-tip' });
    await f.coordinator.reconcileVersionSwitch('session');
    expect(f.request).toHaveBeenCalledWith(OpenClawGatewayMethod.SessionsBranchesSwitch, { sessionKey: 'key', leafEntryId: 'old-tip' });
    expect(f.versions.applySwitch).toHaveBeenCalledOnce();
    f.request.mockClear();
    await f.coordinator.reconcileVersionSwitch('session');
    expect(f.request).not.toHaveBeenCalled();
  });

  test('refuses to switch under a running turn or an unconfirmed edit', async () => {
    const f = fixture(); gateway(f);
    f.isBusy.mockReturnValue(true);
    await expect(f.switchVersion()).rejects.toThrow();
    f.isBusy.mockReturnValue(false);
    f.send.mockRejectedValue(new Error('network disconnected'));
    await expect(f.edit()).rejects.toThrow();
    await expect(f.switchVersion()).rejects.toThrow();
    expect(f.versions.beginSwitch).not.toHaveBeenCalled();
  });
});
