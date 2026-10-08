import { afterEach, expect, test, vi } from 'vitest';

import { WEIXIN_QR_ACTIVATION_TIMEOUT_MS } from '../../shared/im/weixin';
import { WeixinPluginActivation } from './weixinPluginActivation';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture() {
  vi.useFakeTimers();
  const states: boolean[] = [];
  const sync = vi.fn(async () => { states.push(activation.isActive()); });
  const activation = new WeixinPluginActivation(sync);
  return { activation, sync, states };
}

test('loads the plugin before login RPC and releases activation after waiting', async () => {
  const { activation, states } = fixture();
  await activation.start(async () => {
    expect(states).toEqual([true]);
    return { qrDataUrl: 'qr', sessionKey: 'one' };
  });
  expect(activation.isActive()).toBe(true);
  await activation.wait('one', async assertCurrent => { assertCurrent(); return { connected: false }; });
  expect(states).toEqual([true, false]);
  expect(activation.isActive()).toBe(false);
});

test('failed activation cannot send a login RPC and restores the disabled config', async () => {
  const { activation, sync, states } = fixture();
  sync.mockRejectedValueOnce(new Error('config delivery failed'));
  const rpc = vi.fn(async () => ({ qrDataUrl: 'qr', sessionKey: 'one' }));
  await expect(activation.start(rpc)).rejects.toThrow('config delivery failed');
  expect(rpc).not.toHaveBeenCalled();
  expect(states).toEqual([false]);
});

test('failed QR generation and abandoned login expire without persisting enablement', async () => {
  const { activation, states } = fixture();
  await activation.start(async () => ({}));
  expect(states).toEqual([true, false]);
  await activation.start(async () => ({ qrDataUrl: 'qr', sessionKey: 'one' }));
  await vi.advanceTimersByTimeAsync(WEIXIN_QR_ACTIVATION_TIMEOUT_MS);
  expect(states).toEqual([true, false, true, false]);
  await expect(activation.wait('one', async () => ({}))).rejects.toThrow();
});

test('an old wait cannot persist credentials or disable a newer QR session', async () => {
  const { activation, states } = fixture();
  await activation.start(async () => ({ qrDataUrl: 'qr', sessionKey: 'old' }));
  let complete!: () => void;
  const response = new Promise<void>(resolve => { complete = resolve; });
  const persist = vi.fn();
  const oldWait = activation.wait('old', async assertCurrent => { await response; assertCurrent(); persist(); });
  const rejection = expect(oldWait).rejects.toThrow();
  await activation.start(async () => ({ qrDataUrl: 'qr2', sessionKey: 'new' }));
  complete();
  await rejection;
  expect(persist).not.toHaveBeenCalled();
  expect(states).toEqual([true, true]);
  expect(activation.isActive()).toBe(true);
  activation.cancel();
});

test('explicit settings disable invalidates a pending successful login', async () => {
  const { activation } = fixture();
  await activation.start(async () => ({ qrDataUrl: 'qr', sessionKey: 'one' }));
  const persist = vi.fn();
  await expect(activation.wait('one', async assertCurrent => {
    activation.cancel();
    assertCurrent();
    persist();
  })).rejects.toThrow();
  expect(persist).not.toHaveBeenCalled();
});
