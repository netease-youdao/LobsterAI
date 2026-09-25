import { describe, expect, it, vi } from 'vitest';

import { ProgressCardGatewayMethod, ProgressCardStepStatus } from '../../../shared/cowork/progressCard';
import { OpenClawProgressCards } from './openclawProgressCard';
const card = { sessionKey: 'agent:a:one', revision: 2, updatedAt: 100, steps: [{ step: 'Check', status: ProgressCardStepStatus.Completed }] };
function setup() {
  const request = vi.fn().mockResolvedValue({ card });
  let client = { request };
  let key = card.sessionKey;
  const changed = vi.fn();
  const controller = new OpenClawProgressCards({ client: () => client, key: () => key, changed });
  return { controller, request, changed, reconnect: () => { client = { request: vi.fn().mockResolvedValue({ card }) }; controller.reconnected(); }, switchKey: () => { key = 'agent:a:two'; } };
}
describe('native progress cards', () => {
  it('reads saved cards and forwards only watched session invalidations', async () => {
    const { controller, request, changed } = setup();
    expect(await controller.get('local')).toEqual(card);
    expect(request).toHaveBeenCalledWith(ProgressCardGatewayMethod.Get, { sessionKey: card.sessionKey });
    controller.changed({ sessionKey: 'other', revision: 3 });
    expect(changed).not.toHaveBeenCalled();
    controller.changed({ sessionKey: card.sessionKey, revision: null });
    expect(changed).toHaveBeenCalledWith('local');
  });
  it.each(['reconnect', 'switchKey'] as const)('rejects late reads after %s', async action => {
    const s = setup();
    let resolve!: (value: unknown) => void;
    s.request.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const pending = s.controller.get('local');
    s[action](); resolve({ card });
    await expect(pending).rejects.toThrow('changed');
  });
  it('clears using the displayed revision and retains a conflicting new card', async () => {
    const { controller, request } = setup();
    request.mockResolvedValueOnce({ card }).mockResolvedValueOnce({ card: { ...card, revision: 3 } });
    expect((await controller.dismiss('local', 2))?.revision).toBe(3);
    expect(request).toHaveBeenLastCalledWith(ProgressCardGatewayMethod.Put, { sessionKey: card.sessionKey, expectedRevision: 2 });
  });
  it('never clears an incomplete card or a stale displayed revision', async () => {
    const { controller, request } = setup();
    request.mockResolvedValueOnce({ card: { ...card, steps: [{ step: 'Work', status: ProgressCardStepStatus.Pending }] } });
    await expect(controller.dismiss('local', 2)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    expect(await controller.dismiss('local', 1)).toEqual(card);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('accepts clearing but rejects malformed or wrong-session data', async () => {
    const { controller, request } = setup();
    request.mockResolvedValueOnce({ card: null });
    expect(await controller.get('local')).toBeNull();
    request.mockResolvedValueOnce({ card: { ...card, sessionKey: 'other' } });
    await expect(controller.get('local')).rejects.toThrow();
    request.mockResolvedValueOnce({ card: { ...card, steps: [{ step: 'Bad', status: 'made-up' }] } });
    await expect(controller.get('local')).rejects.toThrow();
  });
});

it('refreshes using a stable request identity and keeps its receipt separate from a card', async () => {
  const s = setup();
  const receipt = { runId: 'refresh-run', status: 'accepted', revision: 2 };
  s.request.mockResolvedValue(receipt);
  expect(await s.controller.refresh('local', 'refresh-key')).toEqual(receipt);
  expect(s.request).toHaveBeenCalledWith(ProgressCardGatewayMethod.Refresh, { sessionKey: card.sessionKey, idempotencyKey: 'refresh-key' });
  expect(s.changed).not.toHaveBeenCalled();
});
it.each(['reconnect', 'switchKey'] as const)('rejects a late refresh receipt after %s', async action => {
  const s = setup();
  let resolve!: (v: unknown) => void;
  s.request.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const pending = s.controller.refresh('local', 'refresh-key');
  s[action](); resolve({ runId: 'r', status: 'accepted', revision: 2 });
  await expect(pending).rejects.toThrow('changed');
});
it('rejects malformed refresh receipts and keys', async () => {
  const s = setup();
  await expect(s.controller.refresh('local', '')).rejects.toThrow();
  s.request.mockResolvedValue({ runId: 'r', status: 'completed', revision: 2 });
  await expect(s.controller.refresh('local', 'key')).rejects.toThrow();
});
