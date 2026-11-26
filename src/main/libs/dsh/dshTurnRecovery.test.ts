import { describe, expect, test, vi } from 'vitest';

import { admitDshPrompt, DshAdmissionUnconfirmedError, followDshTurn, untilAborted } from './dshTurnRecovery';
import { DshRemoteError, type DshTypertClient } from './dshTypertClient';

type Frame = Record<string, unknown>;
const lost = () => new DshRemoteError('gateway/disconnected', 'mux closed');
const event = (seq: number, type: string, data: Frame = {}) => ({ type: 'event', event: { seq, type, data } });
const user = event(4, 'user/message', { source: { kind: 'user', rpcId: 'click' } });
const prompt = { sessionId: 'session', requestId: 'click', content: [{ type: 'text' as const, text: 'hello' }] };
async function* stream(frames: Frame[], drop = false) {
  yield* frames;
  if (drop) throw lost();
}
const clientWith = (methods: Partial<DshTypertClient>) => methods as DshTypertClient;

describe('DSH turn recovery', () => {
  test('an uncertain acceptance uses the journal before replaying the original request', async () => {
    const promptSession = vi.fn().mockRejectedValueOnce(lost()).mockResolvedValue({ accepted: true });
    const getSessionEvents = vi.fn().mockResolvedValueOnce({ records: [user] }).mockResolvedValue({ records: [] });
    const client = clientWith({ promptSession, getSessionEvents });
    const submit = () => admitDshPrompt(client, prompt, async () => client, new AbortController().signal);
    await expect(submit()).resolves.toEqual({ accepted: true });
    expect(promptSession).toHaveBeenCalledTimes(1);
    promptSession.mockRejectedValueOnce(lost());
    await expect(submit()).resolves.toEqual({ accepted: true });
    expect(promptSession.mock.calls.map(([params]) => params)).toEqual([prompt, prompt, prompt]);
  });

  test('a missing receipt is reconciled across journal pages before considering another send', async () => {
    const promptSession = vi.fn().mockRejectedValue(lost());
    const getSessionEvents = vi.fn().mockResolvedValueOnce({ cursor: 20, hasMore: true, records: [event(18, 'turn/end')] })
      .mockResolvedValueOnce({ records: [user] });
    const client = clientWith({ promptSession, getSessionEvents });
    await expect(admitDshPrompt(client, prompt, async () => client, new AbortController().signal)).resolves.toEqual({ accepted: true });
    expect(getSessionEvents).toHaveBeenLastCalledWith('session', { throughSeq: 20, beforeSeq: 18, maxMessages: 100 });
    expect(promptSession).toHaveBeenCalledTimes(1);
  });

  test.each([
    {}, { records: [], hasMore: true }, { records: [{}] }, { records: [event(18, 'turn/end')], hasMore: true },
  ])('an incomplete admission journal leaves the outcome unknown without sending again (%#)', async page => {
    const promptSession = vi.fn().mockRejectedValue(lost());
    const client = clientWith({ promptSession, getSessionEvents: vi.fn().mockResolvedValue(page) });
    await expect(admitDshPrompt(client, prompt, async () => client, new AbortController().signal)).rejects.toBeInstanceOf(DshAdmissionUnconfirmedError);
    expect(promptSession).toHaveBeenCalledTimes(1);
  });

  test('logical errors propagate and cancelling an offline send wakes its waiter', async () => {
    const error = new DshRemoteError('session/not-found', 'gone');
    const ready = vi.fn();
    await expect(admitDshPrompt(clientWith({ promptSession: vi.fn().mockRejectedValue(error) }),
      prompt, ready, new AbortController().signal)).rejects.toBe(error);
    expect(ready).not.toHaveBeenCalled();
    const abort = new AbortController();
    const waiting = untilAborted(new Promise<void>(() => {}), abort.signal);
    abort.abort(new Error('cancelled'));
    await expect(waiting).rejects.toThrow('cancelled');
  });

  test('backfills a paginated disconnect gap once and leaves prior turns out of the opening', async () => {
    const first = stream([{ type: 'snapshot', cursor: 2, records: [event(2, 'turn/end')] },
      event(3, 'model/change'), user], true);
    const missed = [event(5, 'turn/start'), event(6, 'tool/call'), event(7, 'tool/result')];
    const end = event(9, 'turn/end');
    const followSession = vi.fn(() => stream([{ type: 'snapshot', cursor: 9, hasMore: true,
      records: [event(8, 'assistant/message'), end] }, end]));
    const getSessionEvents = vi.fn().mockResolvedValue({ records: [user, ...missed], hasMore: true });
    const client = clientWith({ followSession, getSessionEvents });
    const recovered = [];
    for await (const frame of followDshTurn(first, 'session', 'click', async () => client,
      new AbortController().signal, vi.fn())) recovered.push(frame);
    expect(recovered).toEqual([event(3, 'model/change'), user, ...missed, event(8, 'assistant/message'), end]);
    expect(getSessionEvents).toHaveBeenCalledExactlyOnceWith('session', { throughSeq: 9, beforeSeq: 8, maxMessages: 100 });
  });

  test('replays only unseen chunks from the active model attempt', async () => {
    const chunk = (text: string, index: number) => ({ type: 'assistant-stream', frame: {
      type: 'chunk', attemptId: 'attempt', index, chunk: { type: 'text-delta', text },
    } });
    const first = stream([{ type: 'snapshot', cursor: 4, records: [user] }, chunk('A', 0)], true);
    const client = clientWith({ followSession: vi.fn(() => stream([{
      type: 'snapshot', cursor: 4, records: [user], assistantStream: { activeAttempt: {
        attemptId: 'attempt', turn: 1, nextIndex: 2, stream: [{ type: 'text-chunks', texts: ['A', 'B'] }],
      } },
    }, chunk('C', 2)])) });
    const recovered = [];
    for await (const frame of followDshTurn(first, 'session', 'click', async () => client,
      new AbortController().signal, vi.fn())) recovered.push(frame);
    expect(recovered).toEqual([user, chunk('A', 0), {
      type: 'assistant-stream', frame: { type: 'chunk', turn: 1, chunk: { type: 'text-delta', text: 'B' } },
    }, chunk('C', 2)]);
  });

  test('an exited owner with an admitted, unfinished turn leaves the session usable', async () => {
    const first = stream([{ type: 'snapshot', cursor: 4, records: [user] }], true);
    const followSession = vi.fn(() => stream([{ type: 'snapshot', cursor: 4, records: [user] }]));
    const client = clientWith({ followSession, getSessionState: vi.fn().mockResolvedValue({ cursor: 4, running: false, queue: null }) });
    const stopped = vi.fn();
    const recovered = [];
    for await (const frame of followDshTurn(first, 'session', 'click', async () => client,
      new AbortController().signal, vi.fn(), clientWith({}), stopped)) recovered.push(frame);
    expect(recovered).toEqual([user]);
    expect(stopped).toHaveBeenCalledOnce();
    expect(followSession.mock.calls[0]).toEqual([expect.objectContaining({ activate: false }), expect.any(AbortSignal)]);
  });
});
