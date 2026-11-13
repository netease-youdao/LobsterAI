import { describe, expect, test, vi } from 'vitest';

import { CoworkGoalStatus } from '../../../shared/cowork/goal';
import { CoworkMessageEditPhase } from '../../../shared/cowork/messageEdit';
import { CoworkTurnOutcome } from '../../../shared/cowork/turnOutcome';
import type { CoworkMessage, CoworkSession, CoworkStore } from '../../coworkStore';
import { t } from '../../i18n';
import type { CoworkMessageEditOperation } from '../coworkMessageEditStore';
import {
  type CoworkGatewayActivePath, type CoworkGatewayPosition, type CoworkMessageVersionSwitch, endsAtForkPoint,
} from '../coworkMessageVersionStore';
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

function fixture(options: { message?: CoworkMessage; local?: CoworkMessage[]; history?: EditHistory } = {}) {
  const message = options.message ?? user;
  let history = structuredClone(options.history ?? original);
  let pending: CoworkMessageEditOperation | null = null;
  const edits = {
    pending: () => pending,
    prepare: vi.fn((operation: CoworkMessageEditOperation) => { pending = operation; }),
    cancelPrepared: vi.fn(() => { pending = null; }),
    truncate: vi.fn(), restore: vi.fn(() => { pending = null; }),
    setPhase: vi.fn((operation: CoworkMessageEditOperation, phase: CoworkMessageEditPhase) => {
      operation.phase = phase;
      if (phase === CoworkMessageEditPhase.Committed) pending = null;
    }),
    commitRecovered: vi.fn(() => { pending = null; }),
  };
  let pendingSwitch: CoworkMessageVersionSwitch | null = null;
  /** The version a switch goes to: its stored tip, and the fork point of its group. */
  const target: { leaf: string | null; cut?: string; fork: string } = { leaf: 'old-tip', fork: 'prior' };
  const versions = {
    recordEdit: vi.fn(),
    recordUndeliveredEdit: vi.fn(),
    gatewayPosition: vi.fn((_sessionId: string, gateway: CoworkGatewayActivePath): CoworkGatewayPosition | undefined =>
      gateway.leafEntryId ? { leafEntryId: gateway.leafEntryId } : undefined),
    pendingSwitch: () => pendingSwitch,
    beginSwitch: vi.fn((sessionId: string, _messageId: string, _targetIndex: number, gateway: CoworkGatewayActivePath) => {
      const atFork = endsAtForkPoint(gateway.entryIds, target.fork);
      pendingSwitch = { sessionId, fromVersionId: 'from', toVersionId: 'to',
        activeLeafEntryId: atFork ? null : gateway.leafEntryId ?? null, activeCutEntryId: atFork ? target.fork : undefined,
        targetLeafEntryId: target.leaf, targetCutEntryId: target.leaf === null ? target.fork : target.cut };
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
  const store = { messageEdits: edits, messageVersions: versions, getSession, getMessage: () => message,
    getAllConversationMessages: () => options.local ?? [message], updateMessage: vi.fn() } as unknown as CoworkStore;
  const coordinator = new CoworkMessageEditCoordinator({ store, request: request as never,
    resolveSessionKey: () => 'key', isBusy, reset, send });
  const edit = () => coordinator.edit({ sessionId: 'session', messageId: message.id, prompt: 'corrected' }, { kitIds: ['kit'] });
  const switchVersion = () => coordinator.switchVersion({ sessionId: 'session', messageId: 'local', targetIndex: 1 });
  /** Lets the gateway answer sessions.rewind with `error` instead of rewinding. */
  const failRewind = (error: Error) => {
    const answer = request.getMockImplementation()!;
    request.mockImplementation(async (method: string) => {
      if (method === OpenClawGatewayMethod.SessionsRewind) throw error;
      return answer(method);
    });
  };
  return { coordinator, edit, edits, versions, target, switchVersion, request, failRewind, send, reset, isBusy, getSession,
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

describe('messages the gateway never recorded', () => {
  // Stopped before the gateway wrote the user turn: it exists only locally.
  const stopped: CoworkMessage = { id: 'stopped', type: 'user', content: 'hello', timestamp: 200,
    metadata: { openclawRequestId: 'stopped-run', turnOutcome: CoworkTurnOutcome.Stopped } };

  test('resends without rewinding and builds on the whole current transcript', async () => {
    const f = fixture({ message: stopped });
    await f.edit();
    expect(f.request.mock.calls.some(([method]) => method === OpenClawGatewayMethod.SessionsRewind)).toBe(false);
    const operation = f.edits.prepare.mock.calls[0][0];
    expect(operation).toMatchObject({ messageId: 'stopped', originalLeafId: 'reply', prefixEntryIds: ['prior', 'target', 'reply'] });
    expect(operation.entryId).toBeUndefined();
    expect(f.edits.truncate).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledWith('session', 'corrected', expect.objectContaining({ requestId: operation.runId }));
    expect(f.versions.recordUndeliveredEdit).toHaveBeenCalledOnce();
    expect(f.versions.recordEdit).not.toHaveBeenCalled();
  });

  test('edits the first message of a session the gateway has no transcript for', async () => {
    const f = fixture({ message: stopped, history: { messages: [], sessionInfo: {}, hasMore: false } });
    await f.edit();
    expect(f.edits.prepare.mock.calls[0][0]).toMatchObject({ prefixEntryIds: [] });
    expect(f.edits.prepare.mock.calls[0][0].originalLeafId).toBeUndefined();
    expect(f.send).toHaveBeenCalledOnce();
  });

  test('rewinds to the first later message the gateway did record', async () => {
    const f = fixture({ message: stopped, local: [stopped, user], history: original });
    await f.edit();
    expect(f.request).toHaveBeenCalledWith(OpenClawGatewayMethod.SessionsRewind, { sessionKey: 'key', entryId: 'target' });
    expect(f.edits.prepare.mock.calls[0][0]).toMatchObject({ messageId: 'stopped', entryId: 'target', prefixEntryIds: ['prior'] });
    expect(f.versions.recordEdit).toHaveBeenCalledOnce();
  });

  test('still refuses anything it cannot place in the transcript', async () => {
    const completed = { ...stopped, metadata: { ...stopped.metadata, turnOutcome: CoworkTurnOutcome.Completed } };
    const offPath = { ...stopped, metadata: { ...stopped.metadata, openclawEntryId: 'gone' } };
    const legacyLater: CoworkMessage = { id: 'legacy', type: 'user', content: 'unknown', timestamp: 300 };
    for (const options of [{ message: completed }, { message: offPath }, { message: stopped, local: [stopped, legacyLater] }]) {
      const f = fixture(options);
      await expect(f.edit()).rejects.toThrow(t('coworkEditUnsupported'));
      expect(f.edits.prepare).not.toHaveBeenCalled();
    }
  });

  test('recovers by restoring only the local conversation, even if the old turn arrived late', async () => {
    const f = fixture({ message: stopped }); f.send.mockRejectedValue(new Error('network disconnected'));
    await expect(f.edit()).rejects.toThrow('network disconnected');
    const operation = f.edits.pending()!;
    f.setHistory({ ...original, sessionInfo: { activeLeafEntryId: 'late' }, messages: [...original.messages,
      { role: 'user', content: 'hello', __openclaw: { id: 'late', idempotencyKey: 'stopped-run:user' } }] });
    await f.coordinator.recover('session', operation.operationId);
    expect(f.request.mock.calls.some(([method]) => method === OpenClawGatewayMethod.SessionsBranchesSwitch)).toBe(false);
    expect(f.edits.restore).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledOnce();
  });
});

describe('a gateway still settling a stopped run', () => {
  test('refuses the rewind without leaving anything to recover', async () => {
    const f = fixture(); f.failRewind(new Error('GatewayClientRequestError: Rewind is unavailable while the agent is working.'));
    await expect(f.edit()).rejects.toThrow(t('coworkEditBusy'));
    expect(f.edits.cancelPrepared).toHaveBeenCalledOnce();
    expect(f.edits.pending()).toBeNull();
    expect(f.edits.truncate).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  test('keeps the recovery copy when the outcome of the rewind is unknown', async () => {
    const f = fixture(); f.failRewind(new Error('gateway request timeout for sessions.rewind'));
    await expect(f.edit()).rejects.toThrow('gateway request timeout');
    expect(f.edits.cancelPrepared).not.toHaveBeenCalled();
    expect(f.edits.pending()?.phase).toBe(CoworkMessageEditPhase.Prepared);
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
    expect(f.versions.beginSwitch).toHaveBeenCalledWith('session', 'local', 1,
      { leafEntryId: 'reply', entryIds: ['prior', 'target', 'reply'] });
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
    f.versions.beginSwitch.mockImplementationOnce((sessionId, _messageId, _targetIndex, gateway) => {
      remote.set('old-tip');
      const pending = { sessionId, fromVersionId: 'from', toVersionId: 'to', activeLeafEntryId: gateway.leafEntryId ?? null,
        targetLeafEntryId: 'old-tip' };
      f.setPendingSwitch(pending);
      return pending;
    });
    await expect(f.switchVersion()).resolves.toBe('old-head');
    expect(f.versions.applySwitch).toHaveBeenCalledOnce();
  });

  test('finishes a switch that was interrupted after it was recorded', async () => {
    const f = fixture(); gateway(f);
    f.setPendingSwitch({ sessionId: 'session', fromVersionId: 'from', toVersionId: 'to', activeLeafEntryId: 'reply',
      targetLeafEntryId: 'old-tip' });
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

describe('versions whose resend the gateway never recorded', () => {
  /**
   * A gateway holding a shared prefix and version 1 as the branch [target, reply].
   * The edited resend was stopped before the gateway wrote it, so the active path
   * stops at the prefix, a fork point that is no branch tip because version 1 grows from it.
   */
  function stoppedResendGateway(f: ReturnType<typeof fixture>, prefix: EditHistory['messages']) {
    const versionOne = original.messages.slice(1);
    let path = [...prefix];
    let transcript = 0;
    let busy = false;
    f.request.mockImplementation((async (method: string, params: { leafEntryId?: string; entryId?: string }) => {
      if (method === OpenClawGatewayMethod.ChatHistory) {
        return { sessionId: `transcript-${transcript}`, sessionInfo: { activeLeafEntryId: path.at(-1)?.__openclaw?.id },
          messages: structuredClone(path), hasMore: false };
      }
      if (busy) throw new Error('GatewayClientRequestError: Rewind is unavailable while the agent is working.');
      if (method === OpenClawGatewayMethod.SessionsBranchesSwitch) {
        if (params.leafEntryId !== 'reply') throw new Error(`entry is not a branch tip: ${params.leafEntryId}`);
        path = [...prefix, ...versionOne];
      } else {
        const index = path.findIndex(entry => entry.__openclaw?.id === params.entryId);
        if (path[index]?.role !== 'user') throw new Error(`message entry is not on the active path: ${params.entryId}`);
        path = path.slice(0, index);
      }
      transcript += 1;
      return {};
    }) as never);
    return {
      entryIds: () => path.map(entry => entry.__openclaw?.id),
      showVersionOne: () => { path = [...prefix, ...versionOne]; },
      setBusy: (value: boolean) => { busy = value; },
    };
  }
  const calls = (f: ReturnType<typeof fixture>, method: string) =>
    (f.request.mock.calls as unknown as Array<[string, unknown]>).filter(([name]) => name === method);

  describe.each([
    { label: 'an empty prefix', prefix: [] as EditHistory['messages'], fork: '' },
    { label: 'a non-empty prefix', prefix: original.messages.slice(0, 1), fork: 'prior' },
  ])('with $label', ({ prefix, fork }) => {
    const prefixIds = prefix.map(entry => entry.__openclaw?.id);

    test('switches away from it and back again', async () => {
      const f = fixture(); const gateway = stoppedResendGateway(f, prefix);
      Object.assign(f.target, { leaf: 'reply', fork });
      await expect(f.switchVersion()).resolves.toBe('old-head');
      expect(f.versions.beginSwitch).toHaveBeenLastCalledWith('session', 'local', 1,
        { leafEntryId: prefixIds.at(-1), entryIds: prefixIds });
      // The version left behind keeps no tip, never the fork point.
      expect(f.versions.beginSwitch.mock.results[0].value).toMatchObject({ activeLeafEntryId: null, targetLeafEntryId: 'reply' });
      expect(gateway.entryIds()).toEqual([...prefixIds, 'target', 'reply']);

      f.target.leaf = null;
      await expect(f.switchVersion()).resolves.toBe('old-head');
      expect(f.versions.beginSwitch.mock.results[1].value).toMatchObject({ activeLeafEntryId: 'reply', targetLeafEntryId: null });
      expect(f.request).toHaveBeenCalledWith(OpenClawGatewayMethod.SessionsRewind, { sessionKey: 'key', entryId: 'target' });
      expect(gateway.entryIds()).toEqual(prefixIds);

      // Version 1 is still a branch tip after the rewind.
      f.target.leaf = 'reply';
      await expect(f.switchVersion()).resolves.toBe('old-head');
      expect(gateway.entryIds()).toEqual([...prefixIds, 'target', 'reply']);
      expect(f.versions.applySwitch).toHaveBeenCalledTimes(3);
      expect(f.versions.cancelSwitch).not.toHaveBeenCalled();
      expect(calls(f, OpenClawGatewayMethod.SessionsBranchesSwitch).map(([, params]) => params))
        .toEqual([{ sessionKey: 'key', leafEntryId: 'reply' }, { sessionKey: 'key', leafEntryId: 'reply' }]);
    });

    test('finishes an interrupted switch to it after a crash, before or after the rewind', async () => {
      const f = fixture(); const gateway = stoppedResendGateway(f, prefix);
      gateway.showVersionOne();
      const pending: CoworkMessageVersionSwitch = { sessionId: 'session', fromVersionId: 'from', toVersionId: 'to',
        activeLeafEntryId: 'reply', targetLeafEntryId: null, targetCutEntryId: fork };
      f.setPendingSwitch(pending);
      await f.coordinator.reconcileVersionSwitch('session');
      expect(calls(f, OpenClawGatewayMethod.SessionsRewind)).toHaveLength(1);
      expect(gateway.entryIds()).toEqual(prefixIds);
      expect(f.versions.applySwitch).toHaveBeenCalledOnce();
      f.request.mockClear();
      await f.coordinator.reconcileVersionSwitch('session');
      expect(f.request).not.toHaveBeenCalled();
      // The rewind reached the gateway before the crash: only the local swap is left.
      f.setPendingSwitch(pending);
      await f.coordinator.reconcileVersionSwitch('session');
      expect(calls(f, OpenClawGatewayMethod.SessionsRewind)).toHaveLength(0);
      expect(f.versions.applySwitch).toHaveBeenCalledTimes(2);
    });

    test('returns the gateway to the fork point when the local swap fails', async () => {
      const f = fixture(); const gateway = stoppedResendGateway(f, prefix);
      Object.assign(f.target, { leaf: 'reply', fork });
      f.versions.applySwitch.mockImplementationOnce(() => { throw new Error('disk full'); });
      await expect(f.switchVersion()).rejects.toThrow(t('coworkVersionSwitchFailed'));
      expect(f.versions.cancelSwitch).toHaveBeenCalledOnce();
      expect(gateway.entryIds()).toEqual(prefixIds);
    });
  });

  test('refuses to rewind when the fork point is not on the active path', async () => {
    const f = fixture(); const gateway = stoppedResendGateway(f, original.messages.slice(0, 1));
    gateway.showVersionOne();
    Object.assign(f.target, { leaf: null, fork: 'elsewhere' });
    await expect(f.switchVersion()).rejects.toThrow(t('coworkVersionSwitchFailed'));
    expect(calls(f, OpenClawGatewayMethod.SessionsRewind)).toHaveLength(0);
    expect(f.versions.cancelSwitch).toHaveBeenCalledOnce();
    expect(f.versions.applySwitch).not.toHaveBeenCalled();
  });

  test('reports a gateway still settling the stopped run as busy, with nothing left to finish', async () => {
    const f = fixture(); const gateway = stoppedResendGateway(f, original.messages.slice(0, 1));
    gateway.setBusy(true);
    Object.assign(f.target, { leaf: 'reply', fork: 'prior' });
    await expect(f.switchVersion()).rejects.toThrow(t('coworkEditBusy'));
    expect(f.versions.cancelSwitch).toHaveBeenCalledOnce();
    expect(f.versions.pendingSwitch()).toBeNull();
    expect(f.versions.applySwitch).not.toHaveBeenCalled();
  });
});

describe('a version that stops at the fork point of a version group inside it', () => {
  /**
   * Version O of the outer group is [p, pr] plus an inner group forked at pr:
   * version 1 grew [a1, r1], version 2's resend never reached the gateway.
   * The outer group's live version is N = [n, nr]. Like OpenClaw, only branch
   * tips can be switched to and only user messages on the active path rewound.
   */
  function treeGateway(f: ReturnType<typeof fixture>, leaf: string | null) {
    const parents: Record<string, string | null> = { p: null, pr: 'p', a1: 'pr', r1: 'a1', n: null, nr: 'n' };
    const users = new Set(['p', 'a1', 'n']);
    let transcript = 0;
    const path = (): string[] => {
      const ids: string[] = [];
      for (let id = leaf; id; id = parents[id]) ids.unshift(id);
      return ids;
    };
    f.request.mockImplementation((async (method: string, params: { leafEntryId?: string; entryId?: string }) => {
      if (method === OpenClawGatewayMethod.ChatHistory) {
        return { sessionId: `transcript-${transcript}`, hasMore: false, sessionInfo: { activeLeafEntryId: leaf ?? undefined },
          messages: path().map(id => ({ role: users.has(id) ? 'user' : 'assistant', content: id,
            __openclaw: { id, ...(id === 'p' ? { idempotencyKey: 'p-run:user' } : {}) } })) };
      }
      if (method === OpenClawGatewayMethod.SessionsBranchesSwitch) {
        const id = params.leafEntryId!;
        if (id === leaf) throw new Error(`branch is already active: ${id}`);
        if (Object.values(parents).includes(id)) throw new Error(`entry is not a branch tip: ${id}`);
        leaf = id;
      } else {
        if (!users.has(params.entryId!) || !path().includes(params.entryId!)) throw new Error('message entry is not on the active path');
        leaf = parents[params.entryId!];
      }
      transcript += 1;
      return {};
    }) as never);
    return { path };
  }
  const calls = (f: ReturnType<typeof fixture>, method: string) =>
    (f.request.mock.calls as unknown as Array<[string, Record<string, unknown>]>).filter(([name]) => name === method)
      .map(([, params]) => params);

  test('switches to it through a tip of the inner group, then rewinds to the inner fork point', async () => {
    const f = fixture(); const gateway = treeGateway(f, 'nr');
    Object.assign(f.target, { leaf: 'r1', cut: 'pr', fork: '' });
    await expect(f.switchVersion()).resolves.toBe('old-head');
    expect(calls(f, OpenClawGatewayMethod.SessionsBranchesSwitch)).toEqual([{ sessionKey: 'key', leafEntryId: 'r1' }]);
    expect(calls(f, OpenClawGatewayMethod.SessionsRewind)).toEqual([{ sessionKey: 'key', entryId: 'a1' }]);
    expect(gateway.path()).toEqual(['p', 'pr']);
    expect(f.versions.applySwitch).toHaveBeenCalledOnce();
  });

  test('finishes such a switch interrupted between the two gateway steps', async () => {
    const f = fixture(); const gateway = treeGateway(f, 'r1');
    f.setPendingSwitch({ sessionId: 'session', fromVersionId: 'from', toVersionId: 'to',
      activeLeafEntryId: 'nr', targetLeafEntryId: 'r1', targetCutEntryId: 'pr' });
    await f.coordinator.reconcileVersionSwitch('session');
    expect(calls(f, OpenClawGatewayMethod.SessionsBranchesSwitch)).toEqual([]);
    expect(calls(f, OpenClawGatewayMethod.SessionsRewind)).toEqual([{ sessionKey: 'key', entryId: 'a1' }]);
    expect(gateway.path()).toEqual(['p', 'pr']);
    expect(f.versions.applySwitch).toHaveBeenCalledOnce();
  });

  test('returns a failed edit made there to the inner fork point, not to a fork point it cannot switch to', async () => {
    const message: CoworkMessage = { id: 'local-p', type: 'user', content: 'p', timestamp: 1, metadata: { openclawRequestId: 'p-run' } };
    const f = fixture({ message }); const gateway = treeGateway(f, 'pr');
    f.versions.gatewayPosition.mockReturnValueOnce({ leafEntryId: 'r1', cutEntryId: 'pr' });
    f.send.mockRejectedValue(new Error('network disconnected'));
    await expect(f.edit()).rejects.toThrow('network disconnected');
    const operation = f.edits.pending()!;
    expect(operation).toMatchObject({ entryId: 'p', originalLeafId: 'r1', originalCutEntryId: 'pr', prefixEntryIds: [] });
    expect(gateway.path()).toEqual([]);
    await f.coordinator.recover('session', operation.operationId);
    expect(gateway.path()).toEqual(['p', 'pr']);
    expect(f.edits.restore).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledOnce();
  });
});
