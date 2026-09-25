import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { PaymentIpc } from '../../shared/payment/constants';
import { registerPaymentIpcHandlers } from './payment';

type Handler = (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>;
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const ORDER_NO = 'LB20260924120000123456';
const NEW_ORDER_NO = 'LB20260924120000654321';
const OFFER_TOKEN = '0f8fad5bd9cb469fa16570867728950e';
const json = (code: number, data: unknown = null, status = 200) => (
  new Response(JSON.stringify({ code, data }), { status })
);
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);

function harness(options: { authenticated?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const mainFrame = {};
  const webContents = { mainFrame };
  const event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  const fetchPublic = vi.fn<Fetch>();
  const fetchWithAuth = vi.fn<Fetch>();
  let ids = 0;
  let clock = 0;
  registerPaymentIpcHandlers({
    ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as unknown as IpcMain,
    getMainWindow: () => ({ isDestroyed: () => false, webContents }) as unknown as BrowserWindow,
    getServerBaseUrl: () => 'https://server.example',
    getAvailabilityUrl: () => 'https://overmind.example/in-app-payment',
    getAccountKey: () => '7',
    hasAuthTokens: () => options.authenticated ?? true,
    fetchPublic,
    fetchWithAuth,
    randomUUID: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    now: () => clock,
  });
  return {
    fetchPublic,
    fetchWithAuth,
    advance: (ms: number) => { clock += ms; },
    invoke: (channel: string, input?: unknown) => handlers.get(channel)!(event, input),
    invokeFrom: (sender: unknown, channel: string) => handlers.get(channel)!(
      { sender, senderFrame: {} } as unknown as IpcMainInvokeEvent,
    ),
  };
}

afterEach(() => vi.restoreAllMocks());

test('rejects calls that do not come from the main window', async () => {
  const h = harness();
  await expect(h.invokeFrom({}, PaymentIpc.GetOrderStatus)).rejects.toThrow('Untrusted payment sender');
  expect(h.fetchWithAuth).not.toHaveBeenCalled();
});

describe('availability switch', () => {
  test('turns in-app payment off only when the switch says off, and caches the answer', async () => {
    const h = harness();
    h.fetchPublic.mockImplementation(async () => json(0, { value: 'off' }));
    await expect(h.invoke(PaymentIpc.GetAvailability)).resolves.toEqual({ enabled: false });
    await h.invoke(PaymentIpc.GetAvailability);
    expect(h.fetchPublic).toHaveBeenCalledTimes(1);

    h.advance(5 * 60_000 + 1);
    h.fetchPublic.mockImplementation(async () => json(0, { value: 'on' }));
    await expect(h.invoke(PaymentIpc.GetAvailability)).resolves.toEqual({ enabled: true });
  });

  test('keeps in-app payment on when the switch cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness();
    h.fetchPublic.mockRejectedValue(new TypeError('offline'));
    await expect(h.invoke(PaymentIpc.GetAvailability)).resolves.toEqual({ enabled: true });
  });
});

describe('catalog', () => {
  test('reads the public catalog anonymously and the subscription with the account', async () => {
    const h = harness();
    h.fetchPublic.mockImplementation(async url => (url.endsWith('/api/plans')
      ? json(0, [{ id: 2, displayName: '标准版', monthlyPrice: 49, monthlyCredits: 5000 }])
      : json(0, [{ id: 1, displayName: '标准加油包', price: 59, credits: 4900 }])));
    h.fetchWithAuth.mockImplementation(async () => json(0, {
      subscriptionStatus: 'free', planId: null, trial: { active: false },
    }));

    await expect(h.invoke(PaymentIpc.GetCatalog)).resolves.toMatchObject({
      success: true,
      data: { plans: [{ id: 2 }], boostPacks: [{ id: 1 }], subscription: { status: 'free' } },
    });
    expect(h.fetchWithAuth).toHaveBeenCalledWith('https://server.example/api/subscription', expect.anything());
  });

  test('skips the subscription lookup when signed out', async () => {
    const h = harness({ authenticated: false });
    h.fetchPublic.mockImplementation(async () => json(0, []));
    await expect(h.invoke(PaymentIpc.GetCatalog)).resolves.toEqual({
      success: true,
      data: { plans: [], boostPacks: [], subscription: null },
    });
    expect(h.fetchWithAuth).not.toHaveBeenCalled();
  });
});

describe('orders', () => {
  test('rejects malformed input without calling the server', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness();
    await expect(h.invoke(PaymentIpc.CreateOrder, { target: { product: 'boost_pack', amount: 9 } }))
      .resolves.toEqual({ success: false, reason: 'invalid_input' });
    await expect(h.invoke(PaymentIpc.GetOrderStatus, { orderNo: '../../admin' }))
      .resolves.toEqual({ success: false, reason: 'invalid_input' });
    expect(h.fetchWithAuth).not.toHaveBeenCalled();
  });

  test('creates a WeChat-signed subscription and a dual-QR boost order', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const h = harness();
    h.fetchWithAuth.mockImplementation(async () => json(0, { orderNo: ORDER_NO, payUrl: 'https://evil.example' }));

    await h.invoke(PaymentIpc.CreateOrder, {
      target: { product: 'subscription', planId: 2 },
      offerToken: OFFER_TOKEN,
    });
    const created = await h.invoke(PaymentIpc.CreateOrder, { target: { product: 'boost_pack', amount: 88 } });

    expect(h.fetchWithAuth.mock.calls[0][0]).toBe('https://server.example/api/subscription/create');
    expect(bodyOf(h.fetchWithAuth.mock.calls[0])).toEqual({
      planId: 2, paymentChannel: 'wechat', offerToken: OFFER_TOKEN,
    });
    expect(h.fetchWithAuth.mock.calls[1][0]).toBe('https://server.example/api/boost-packs/purchase');
    expect(bodyOf(h.fetchWithAuth.mock.calls[1])).toEqual({ amount: 88, paymentChannel: 'dual' });
    expect(created).toMatchObject({ success: true, data: { orderNo: ORDER_NO } });
    expect(JSON.stringify(created)).not.toContain('evil.example');
  });

  test('passes the order that holds the offer back with 42304', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness();
    h.fetchWithAuth.mockImplementation(async () => json(42304, { currentOrderNo: ORDER_NO }));
    await expect(h.invoke(PaymentIpc.CreateOrder, {
      target: { product: 'boost_pack', boostPackId: 1 },
      offerToken: OFFER_TOKEN,
    })).resolves.toEqual({ success: false, reason: 'server', code: 42304, currentOrderNo: ORDER_NO });
  });

  test('rejects a status response for another order', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness();
    h.fetchWithAuth.mockImplementation(async () => json(0, { orderNo: NEW_ORDER_NO, status: 'paid' }));
    await expect(h.invoke(PaymentIpc.GetOrderStatus, { orderNo: ORDER_NO }))
      .resolves.toEqual({ success: false, reason: 'invalid_response' });
  });

  test('reports network failures without transport details', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness();
    h.fetchWithAuth.mockRejectedValue(new TypeError('private transport detail'));
    await expect(h.invoke(PaymentIpc.GetOrderStatus, { orderNo: ORDER_NO }))
      .resolves.toEqual({ success: false, reason: 'network' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private transport detail');
  });
});

describe('offer order replacement', () => {
  const target = { product: 'boost_pack', boostPackId: 1 };
  const replace = { oldOrderNo: ORDER_NO, target, offerToken: OFFER_TOKEN };
  const answerWith = (status: string) => async (_url: string, init?: RequestInit) => json(0, {
    requestId: JSON.parse(init!.body as string).requestId,
    oldOrderNo: ORDER_NO,
    status,
    selectionMatches: true,
  });

  test('reuses one request id for the same product and offer until the server settles it', async () => {
    const h = harness();
    h.fetchWithAuth.mockImplementation(answerWith('processing'));
    await h.invoke(PaymentIpc.ReplaceOrder, replace);
    await h.invoke(PaymentIpc.ReplaceOrder, replace);
    expect(h.fetchWithAuth.mock.calls[0][0]).toBe(`https://server.example/api/payment/orders/${ORDER_NO}/replace`);
    expect(bodyOf(h.fetchWithAuth.mock.calls[1]).requestId).toBe(bodyOf(h.fetchWithAuth.mock.calls[0]).requestId);

    h.fetchWithAuth.mockImplementation(answerWith('retry_selection'));
    await h.invoke(PaymentIpc.ReplaceOrder, replace);
    await h.invoke(PaymentIpc.ReplaceOrder, replace);
    expect(bodyOf(h.fetchWithAuth.mock.calls[2]).requestId).toBe(bodyOf(h.fetchWithAuth.mock.calls[0]).requestId);
    expect(bodyOf(h.fetchWithAuth.mock.calls[3]).requestId).not.toBe(bodyOf(h.fetchWithAuth.mock.calls[2]).requestId);
  });

  test('forgets a request the server rejected', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness();
    h.fetchWithAuth.mockImplementation(async () => json(42302));
    await h.invoke(PaymentIpc.ReplaceOrder, replace);
    await h.invoke(PaymentIpc.ReplaceOrder, replace);
    expect(bodyOf(h.fetchWithAuth.mock.calls[1]).requestId).not.toBe(bodyOf(h.fetchWithAuth.mock.calls[0]).requestId);
  });

  test('polls a replacement by its request id', async () => {
    const h = harness();
    const requestId = '00000000-0000-4000-8000-000000000009';
    h.fetchWithAuth.mockImplementation(async () => json(0, {
      requestId,
      oldOrderNo: ORDER_NO,
      status: 'completed',
      selectionMatches: true,
      order: { orderNo: NEW_ORDER_NO, status: 'pending', wechatQrUrl: 'weixin://wxpay/bizpayurl?pr=1' },
    }));
    await expect(h.invoke(PaymentIpc.GetReplacement, { requestId })).resolves.toMatchObject({
      success: true,
      data: { status: 'completed', order: { orderNo: NEW_ORDER_NO, wechatQr: 'weixin://wxpay/bizpayurl?pr=1' } },
    });
    expect(h.fetchWithAuth.mock.calls[0][0])
      .toBe(`https://server.example/api/payment/order-replacements/${requestId}`);
  });
});
