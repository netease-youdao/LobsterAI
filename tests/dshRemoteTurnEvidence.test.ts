import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test, vi } from 'vitest';

const plugin = pathToFileURL(path.resolve('dsh-bundles/lobsterai-host/plugins/remote-turn.mjs')).href;
const { inspectRemoteTurn, remoteTurnOperation } = await import(plugin);
const input = (id: string) => ({ id, source: { kind: 'user', rpcId: id } });
const row = (seq: number, type: string, data: object) => ({ seq, type, data });
const inbox = (seq: number, inserted: object[], removedCount = 0) =>
  row(seq, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount, inserted });
const start = (seq: number, turn: number) => row(seq, 'turn/start', { turn });
const end = (seq: number, turn: number) => row(seq, 'turn/end', { turn, reason: { kind: 'completed' } });

test('an older request cannot cancel its successor even while the next turn is open', async () => {
  const events = [inbox(0, [input('a')]), start(1, 1), inbox(2, [], 1), end(3, 1),
    inbox(4, [input('b')]), start(5, 2), inbox(6, [], 1)];
  const cancel = vi.fn();
  const agent = { session: { snapshotEvents: () => events, inheritedEventCount: 0 }, cancel };
  const context = { get: () => ({ get: () => agent }) };
  expect(await remoteTurnOperation(context, { sessionId: 's', requestId: 'a' }, true))
    .toMatchObject({ status: 'succeeded', hasActiveRun: true, canCancel: false });
  expect(cancel).not.toHaveBeenCalled();
  await remoteTurnOperation(context, { sessionId: 's', requestId: 'b' }, true);
  expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true });
});

test('a replayed inherited identity and a batch of different users inputs cannot authorize cancellation', () => {
  const replay = [inbox(0, [input('a')]), row(1, 'agent/inbox/spliced',
    { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }),
  inbox(2, [input('a')]), start(3, 1), inbox(4, [], 1)];
  expect(inspectRemoteTurn(replay, 2, 'a')).toMatchObject({ status: 'unknown', canCancel: false });
  const shared = [inbox(0, [input('a'), input('b')]), start(1, 1), inbox(2, [], 2)];
  expect(inspectRemoteTurn(shared, 0, 'a')).toMatchObject({ status: 'running', canCancel: false });
});

test('a delegated request completes only after the correlated child notice and parent continuation end', () => {
  const events = [inbox(0, [input('a')]), start(1, 1), inbox(2, [], 1),
    row(3, 'subagent/catalog', { childId: 'child' }), end(4, 1)];
  expect(inspectRemoteTurn(events, 0, 'a')).toMatchObject({ status: 'running', hasActiveRun: true });
  const notice = { id: 'notice', source: { kind: 'subagent-settled', senderSessionId: 'child' } };
  const complete = [...events, inbox(5, [notice]), start(6, 2), inbox(7, [], 1),
    row(8, 'user/message', notice), end(9, 2)];
  expect(inspectRemoteTurn(complete, 0, 'a')).toMatchObject({ status: 'succeeded', hasActiveRun: false });
});

test('only unambiguous completed source turns can add messages to a recovery page', () => {
  const assistant = (seq: number) => row(seq, 'assistant/message', { content: 'reply' });
  const events = [inbox(0, [input('a')]), start(1, 1), inbox(2, [], 1), assistant(3), end(4, 1),
    inbox(5, [input('b')]), start(6, 2), inbox(7, [], 1), assistant(8), end(9, 2)];
  expect(inspectRemoteTurn(events, 0, 'a', -1).records.map((event: { seq: number }) => event.seq)).toEqual([3]);
  expect(inspectRemoteTurn(events, 0, 'a', 3).records).toEqual([]);
  const shared = [inbox(0, [input('a'), input('b')]), start(1, 1), inbox(2, [], 2), assistant(3), end(4, 1)];
  expect(inspectRemoteTurn(shared, 0, 'a', -1).records).toEqual([]);
});
