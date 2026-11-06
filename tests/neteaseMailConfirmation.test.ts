import { afterEach, expect, test, vi } from 'vitest';

import { getMailConfirmations, MailConfirmations, type MailOperation } from '../openclaw-extensions/netease-mail/confirmation';
import manifest from '../openclaw-extensions/netease-mail/openclaw.plugin.json';
import { MailAction, MailCode, MailForwardMode, MailRpc, MailScope, MailStatus, MailTool } from '../openclaw-extensions/netease-mail/protocol';
import { NeteaseMailError, NeteaseMailForwardMode, NeteaseMailRuntimeRpc, NeteaseMailScope, NeteaseMailTool } from '../src/shared/neteaseMail/constants';

function fixture() {
  const pending = new MailConfirmations();
  const call = vi.fn().mockResolvedValueOnce({ isError: true, structuredContent: { error: { code: String(MailCode.Confirmation), details: {
    confirmation_token: 'private-token', expires_at: Date.now() + 300_000,
    operation_summary: 'Send to self@example.com',
  } } } }).mockResolvedValue({ structuredContent: { code: 0, data: { message_id: 'sent-id' } } });
  const onUpdate = vi.fn();
  const controller = new AbortController();
  const operation: MailOperation = {
    tool: MailTool.Send, toolCallId: 'call', grantId: 'grant',
    args: { to: ['self@example.com'], subject: 'test', body: 'frozen', confirmation_token: 'model-token', confirmed: true },
    summary: { from: ['self@example.com'], to: ['self@example.com'], subject: 'test', body: 'frozen' },
    assertGrant: vi.fn(), call, onUpdate, signal: controller.signal,
  };
  return { pending, operation, onUpdate, call, controller };
}
afterEach(() => vi.useRealTimers());

test('gateway and agent registrations share confirmations only within the same profile', () => {
  expect(getMailConfirmations('profile-a')).toBe(getMailConfirmations('profile-a'));
  expect(getMailConfirmations('profile-b')).not.toBe(getMailConfirmations('profile-a'));
});

test('only the matching trusted click consumes a pending operation once with frozen arguments', async () => {
  const f = fixture();
  const result = f.pending.execute(f.operation);
  await vi.waitFor(() => expect(f.onUpdate).toHaveBeenCalledOnce());
  const update = f.onUpdate.mock.calls[0][0];
  const id = update.details.data.confirmation_id;
  expect(JSON.stringify(update)).not.toContain('private-token');
  expect(JSON.stringify(update)).not.toContain('model-token');
  expect(f.call).toHaveBeenCalledTimes(1);
  expect(f.call.mock.calls[0][1]).not.toHaveProperty('confirmation_token');
  expect(f.call.mock.calls[0][1]).not.toHaveProperty('confirmed');
  expect(f.pending.resolve(id, 'wrong-call', MailAction.Confirm, 'grant')).toBe(false);
  expect(f.pending.resolve(id, 'call', MailAction.Confirm, 'new-grant')).toBe(false);
  f.operation.args.body = 'changed after prepare';
  expect(f.pending.resolve(id, 'call', MailAction.Confirm, 'grant')).toBe(true);
  expect(f.pending.resolve(id, 'call', MailAction.Confirm, 'grant')).toBe(false);
  expect((await result).details.status).toBe(MailStatus.Submitted);
  expect(f.call).toHaveBeenCalledTimes(2);
  expect(f.call.mock.calls[1][1]).toEqual({ ...f.call.mock.calls[0][1], confirmation_token: 'private-token' });
  expect(f.call.mock.calls[1][1].body).toBe('frozen');
});

test.each([MailAction.Cancel, MailStatus.Expired, 'abort'])('%s never executes the write', async action => {
  vi.useFakeTimers();
  const f = fixture();
  const result = f.pending.execute(f.operation);
  await Promise.resolve();
  const id = f.onUpdate.mock.calls[0][0].details.data.confirmation_id;
  if (action === MailAction.Cancel) f.pending.resolve(id, 'call', action, 'grant');
  else if (action === MailStatus.Expired) await vi.advanceTimersByTimeAsync(300_001);
  else f.controller.abort();
  expect((await result).details.status).toBe(action === MailStatus.Expired ? MailStatus.Expired : MailStatus.Cancelled);
  expect(f.call).toHaveBeenCalledTimes(1);
  expect(f.pending.status(id, 'call', 'grant')).toBe(false);
});

test('a disconnect after a click prevents execution; an ambiguous write is never retried', async () => {
  for (const disconnect of [true, false]) {
    const f = fixture();
    const result = f.pending.execute(f.operation);
    await vi.waitFor(() => expect(f.onUpdate).toHaveBeenCalledOnce());
    const id = f.onUpdate.mock.calls[0][0].details.data.confirmation_id;
    if (disconnect) vi.mocked(f.operation.assertGrant).mockImplementation(() => { throw new Error('disconnected'); });
    else f.call.mockRejectedValueOnce(new Error('network interrupted'));
    f.pending.resolve(id, 'call', MailAction.Confirm, 'grant');
    expect((await result).details.status).toBe(disconnect ? MailStatus.Failed : MailStatus.Unknown);
    expect(f.call).toHaveBeenCalledTimes(disconnect ? 1 : 2);
  }
});

test('rate limiting is returned after one request without queuing or creating a draft', async () => {
  const f = fixture();
  f.call.mockReset().mockResolvedValue({ structuredContent: { code: MailCode.Limited } });
  expect((await f.pending.execute(f.operation)).details.code).toBe(MailCode.Limited);
  expect(f.call).toHaveBeenCalledOnce();
  expect(f.onUpdate).not.toHaveBeenCalled();
});

test('reauthorization cancels pending work without waiting for its confirmation deadline', async () => {
  const f = fixture();
  const result = f.pending.execute(f.operation);
  await vi.waitFor(() => expect(f.onUpdate).toHaveBeenCalledOnce());
  f.pending.invalidate('new-grant');
  expect((await result).details.status).toBe(MailStatus.Cancelled);
  expect(f.call).toHaveBeenCalledOnce();
});

test('provider outcome-unknown receipts preserve reconciliation IDs and never trigger a retry', async () => {
  const f = fixture();
  const result = f.pending.execute(f.operation);
  await vi.waitFor(() => expect(f.onUpdate).toHaveBeenCalledOnce());
  f.call.mockResolvedValueOnce({ isError: true, structuredContent: { error: {
    code: String(MailCode.OutcomeUnknown), details: { operation_id: 'operation-id' },
  } } });
  const id = f.onUpdate.mock.calls[0][0].details.data.confirmation_id;
  f.pending.resolve(id, 'call', MailAction.Confirm, 'grant');
  expect((await result).details).toMatchObject({ code: MailCode.OutcomeUnknown, status: MailStatus.Unknown,
    operation_id: 'operation-id', request_id: f.call.mock.calls[0][1].request_id });
  expect(f.call).toHaveBeenCalledTimes(2);
});

test.each([MailTool.Send, MailTool.Reply, MailTool.Forward])('%s accepts the real Sent-copy receipt without inventing delivery or a message ID', async tool => {
  const f = fixture();
  f.operation.tool = tool;
  const result = f.pending.execute(f.operation);
  await vi.waitFor(() => expect(f.onUpdate).toHaveBeenCalledOnce());
  const requestId = f.call.mock.calls[0][1].request_id;
  f.call.mockResolvedValueOnce({ isError: false, structuredContent: {
    request_id: requestId, operation_id: 'operation-id', saved_sent_mid: 'sent-copy-mid',
  } });
  const id = f.onUpdate.mock.calls[0][0].details.data.confirmation_id;
  f.pending.resolve(id, 'call', MailAction.Confirm, 'grant');
  const receipt = await result;
  expect(receipt.isError).not.toBe(true);
  expect(receipt.details).toMatchObject({ status: MailStatus.Submitted,
    request_id: requestId, operation_id: 'operation-id', saved_sent_mid: 'sent-copy-mid' });
  expect(receipt.details.message_id).toBeUndefined();
  expect(f.call).toHaveBeenCalledTimes(2);
});

test.each([
  { isError: false, structuredContent: { saved_sent_mid: ' ' } },
  { isError: false, structuredContent: { operation_id: 'operation-id' } },
  { isError: true, structuredContent: { saved_sent_mid: 'sent-copy-mid' } },
  { isError: true, structuredContent: { error: { code: String(MailCode.OutcomeUnknown), details: { saved_sent_mid: 'sent-copy-mid' } } } },
])('an absent or error-bearing Sent-copy receipt stays unknown', async response => {
  const f = fixture();
  const result = f.pending.execute(f.operation);
  await vi.waitFor(() => expect(f.onUpdate).toHaveBeenCalledOnce());
  f.call.mockResolvedValueOnce(response);
  const id = f.onUpdate.mock.calls[0][0].details.data.confirmation_id;
  f.pending.resolve(id, 'call', MailAction.Confirm, 'grant');
  expect((await result).details.status).toBe(MailStatus.Unknown);
  expect(f.call).toHaveBeenCalledTimes(2);
});

test('malformed execution receipts stay unknown and transport quota failures stay quota failures', async () => {
  for (const quota of [false, true]) {
    const f = fixture();
    const result = f.pending.execute(f.operation);
    await vi.waitFor(() => expect(f.onUpdate).toHaveBeenCalledOnce());
    if (quota) f.call.mockRejectedValueOnce(Object.assign(new Error('Too many requests'), { code: 429 }));
    else f.call.mockResolvedValueOnce({ structuredContent: { error: 'operation_outcome_unknown' }, isError: true });
    const id = f.onUpdate.mock.calls[0][0].details.data.confirmation_id;
    f.pending.resolve(id, 'call', MailAction.Confirm, 'grant');
    const details = (await result).details;
    expect(details.status).toBe(quota ? MailStatus.Failed : MailStatus.Unknown);
    if (quota) expect(details.code).toBe(MailCode.Limited);
    expect(f.call).toHaveBeenCalledTimes(2);
  }
});

test.each([
  [{ structuredContent: { message_id: 'received-id', operation_id: 'trash-operation' } }, MailStatus.Trashed],
  [{ structuredContent: { message_id: 'another-message' } }, MailStatus.Unknown],
  [{ structuredContent: { message_id: ' ' } }, MailStatus.Unknown],
  [{ structuredContent: { saved_sent_mid: 'received-id' } }, MailStatus.Unknown],
  [{ isError: true, structuredContent: { message_id: 'received-id' } }, MailStatus.Unknown],
  [{ structuredContent: { code: 500, message_id: 'received-id' } }, MailStatus.Unknown],
] as const)('a trash receipt confirms only the original message identity', async (response, expected) => {
  const f = fixture();
  f.operation.tool = MailTool.Trash;
  f.operation.args = { message_id: 'received-id' };
  f.operation.summary = { message_id: 'received-id', subject: 'Delete this sample' };
  const result = f.pending.execute(f.operation);
  await vi.waitFor(() => expect(f.onUpdate).toHaveBeenCalledOnce());
  f.call.mockResolvedValueOnce(response);
  const id = f.onUpdate.mock.calls[0][0].details.data.confirmation_id;
  expect(f.pending.resolve(id, 'call', MailAction.Confirm, 'grant')).toBe(true);
  expect(f.pending.resolve(id, 'call', MailAction.Confirm, 'grant')).toBe(false);
  const receipt = await result;
  expect(receipt.details).toMatchObject({ status: expected,
    operation_summary: f.operation.summary, request_id: f.call.mock.calls[0][1].request_id });
  if (expected === MailStatus.Trashed) {
    expect(receipt.details.operation_id).toBe('trash-operation');
    expect(receipt.details.instruction).toContain('moved this message to Trash');
  }
  expect(f.call).toHaveBeenCalledTimes(2);
  expect(f.call.mock.calls[1][1]).toEqual({ ...f.call.mock.calls[0][1], confirmation_token: 'private-token' });
});

test('deployed plugin wire values match the desktop boundary', () => {
  expect(MailRpc.Resolve).toBe(NeteaseMailRuntimeRpc.ResolveConfirmation);
  expect(MailRpc.Status).toBe(NeteaseMailRuntimeRpc.ConfirmationStatus);
  expect(MailTool.Send).toBe(NeteaseMailTool.SendMessage);
  expect(MailTool.Trash).toBe(NeteaseMailTool.TrashMessage);
  expect(MailScope.Send).toBe(NeteaseMailScope.Send);
  expect(MailForwardMode).toEqual(NeteaseMailForwardMode);
  expect(MailCode.OutcomeUnknown).toBe(NeteaseMailError.OutcomeUnknown);
  expect(manifest.contracts.tools).toEqual([MailTool.Send, MailTool.Reply, MailTool.Forward, MailTool.Trash]);
});
