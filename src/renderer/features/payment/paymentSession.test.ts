import type {
  PaymentOrderView,
  PaymentReplacementView,
  PaymentResult,
} from '@shared/payment/constants';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { PaymentSession, type PaymentSessionOptions } from './paymentSession';

const ORDER_NO = 'LB20260924120000123456';
const NEW_ORDER_NO = 'LB20260924120000654321';
const OFFER_TOKEN = '0f8fad5bd9cb469fa16570867728950e';
const WECHAT_QR = 'weixin://wxpay/bizpayurl?pr=abc';
const ALIPAY_QR = 'https://qr.alipay.com/bax1';

const order = (patch: Partial<PaymentOrderView> = {}): PaymentOrderView => ({
  orderNo: ORDER_NO,
  status: 'pending',
  amount: 59,
  originalAmount: null,
  discountRate: null,
  baseCredits: 5900,
  bonusCredits: 0,
  totalCredits: 5900,
  creditsEstimated: true,
  orderExpiresAtEpochMs: 1_800_000,
  serverTimeEpochMs: 0,
  paymentProcessing: false,
  wechatQr: WECHAT_QR,
  alipayQr: null,
  ...patch,
});
const ok = <T,>(data: T): PaymentResult<T> => ({ success: true, data });
const rejected = (code?: number, currentOrderNo?: string): PaymentResult<never> => ({
  success: false,
  reason: 'server',
  code,
  currentOrderNo,
});
const offline: PaymentResult<never> = { success: false, reason: 'network' };
const replacement = (patch: Partial<PaymentReplacementView>): PaymentResult<PaymentReplacementView> => ok({
  requestId: 'request-00000000001',
  oldOrderNo: ORDER_NO,
  status: 'processing',
  selectionMatches: true,
  order: null,
  ...patch,
});

function harness(options: Partial<PaymentSessionOptions> = {}) {
  const gateway = {
    createOrder: vi.fn(async () => ok(order())),
    replaceOrder: vi.fn(async () => replacement({})),
    getReplacement: vi.fn(async () => replacement({})),
    initAlipayQr: vi.fn(async () => ok(order({ alipayQr: ALIPAY_QR }))),
    getOrderStatus: vi.fn(async () => ok(order())),
  };
  const onEntitlementsChanged = vi.fn();
  const session = new PaymentSession({
    target: { product: 'boost_pack', boostPackId: 1 },
    gateway,
    onChange: () => undefined,
    onEntitlementsChanged,
    now: () => Date.now(),
    ...options,
  });
  return { session, gateway, onEntitlementsChanged, state: () => session.getState() };
}
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PaymentSession', () => {
  test('shows the WeChat code of a new order and settles when the order is paid', async () => {
    const h = harness();
    h.session.start();
    await settle();
    expect(h.state()).toMatchObject({ phase: 'waiting', qr: WECHAT_QR, remainingSeconds: 1800 });

    h.gateway.getOrderStatus.mockResolvedValue(ok(order({ status: 'paid', wechatQr: null })));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.state()).toMatchObject({ phase: 'paid', qr: null });
    expect(h.onEntitlementsChanged).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(9_000);
    expect(h.gateway.getOrderStatus).toHaveBeenCalledTimes(1);
  });

  test('keeps subscriptions on WeChat', async () => {
    const h = harness({ target: { product: 'subscription', planId: 2 } });
    h.session.start();
    await settle();
    h.session.switchChannel('alipay');
    expect(h.state()).toMatchObject({ channel: 'wechat', qr: WECHAT_QR });
    expect(h.gateway.initAlipayQr).not.toHaveBeenCalled();
  });

  test('asks for the Alipay code only when the buyer switches to Alipay', async () => {
    const h = harness();
    h.session.start();
    await settle();
    expect(h.gateway.initAlipayQr).not.toHaveBeenCalled();

    h.session.switchChannel('alipay');
    expect(h.state()).toMatchObject({ channel: 'alipay', channelLoading: true, qr: null });
    await settle();
    expect(h.state()).toMatchObject({ channelLoading: false, qr: ALIPAY_QR });

    h.session.switchChannel('wechat');
    h.session.switchChannel('alipay');
    expect(h.state().qr).toBe(ALIPAY_QR);
    expect(h.gateway.initAlipayQr).toHaveBeenCalledTimes(1);
  });

  test('stops asking for an Alipay code the server cannot issue', async () => {
    const h = harness();
    h.gateway.initAlipayQr.mockResolvedValue(rejected(40506));
    h.session.start();
    await settle();
    h.session.switchChannel('alipay');
    await settle();
    expect(h.state()).toMatchObject({ phase: 'waiting', channelLoading: false, qr: null });

    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.gateway.initAlipayQr).toHaveBeenCalledTimes(1);
  });

  test('hides the code while the payment is processing', async () => {
    const h = harness();
    h.session.start();
    await settle();
    h.gateway.getOrderStatus.mockResolvedValue(ok(order({ paymentProcessing: true, wechatQr: null })));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.state()).toMatchObject({ phase: 'processing', qr: null });
  });

  test.each([
    ['payment_review', 'review', null],
    ['refunded', 'failed', 'refunded'],
    ['closed', 'failed', 'payment_failed'],
  ] as const)('settles a %s order as %s', async (status, phase, failure) => {
    const h = harness();
    h.session.start();
    await settle();
    h.gateway.getOrderStatus.mockResolvedValue(ok(order({ status })));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.state()).toMatchObject({ phase, failure, qr: null });

    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.gateway.getOrderStatus).toHaveBeenCalledTimes(1);
  });

  test('counts down with the server clock, expires, and still reports a late payment', async () => {
    const h = harness();
    const expiresAt = Date.now() + 10_000;
    const pending = () => ok(order({ serverTimeEpochMs: Date.now(), orderExpiresAtEpochMs: expiresAt }));
    h.gateway.createOrder.mockImplementation(async () => pending());
    h.gateway.getOrderStatus.mockImplementation(async () => pending());
    h.session.start();
    await settle();
    expect(h.state()).toMatchObject({ phase: 'waiting', remainingSeconds: 10 });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.state()).toMatchObject({ phase: 'expired', qr: null });

    h.gateway.getOrderStatus.mockImplementation(async () => ok(order({ status: 'paid' })));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.state().phase).toBe('paid');
  });

  test('offers a manual check after five failed status queries', async () => {
    const h = harness();
    h.session.start();
    await settle();
    h.gateway.getOrderStatus.mockResolvedValue(offline);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.state()).toMatchObject({ phase: 'status_unavailable', qr: null });

    h.gateway.getOrderStatus.mockResolvedValue(ok(order()));
    h.session.recheck();
    await settle();
    expect(h.state()).toMatchObject({ phase: 'waiting', qr: WECHAT_QR });
  });

  test('replaces the order that holds the offer and continues with the new one', async () => {
    const h = harness({ offerToken: OFFER_TOKEN });
    h.gateway.createOrder.mockResolvedValueOnce(rejected(42304, ORDER_NO));
    h.gateway.getReplacement.mockResolvedValue(replacement({
      status: 'completed',
      order: order({ orderNo: NEW_ORDER_NO }),
    }));
    h.session.start();
    await settle();
    expect(h.state().phase).toBe('replacing');
    expect(h.gateway.replaceOrder).toHaveBeenCalledWith({
      oldOrderNo: ORDER_NO,
      target: { product: 'boost_pack', boostPackId: 1 },
      offerToken: OFFER_TOKEN,
    });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.state()).toMatchObject({ phase: 'waiting', order: { orderNo: NEW_ORDER_NO }, qr: WECHAT_QR });
  });

  test('starts over when the replacement settled for another selection', async () => {
    const h = harness({ offerToken: OFFER_TOKEN });
    h.gateway.createOrder.mockResolvedValueOnce(rejected(42304, ORDER_NO));
    h.gateway.replaceOrder.mockResolvedValue(replacement({
      status: 'completed',
      selectionMatches: false,
      order: order({ orderNo: NEW_ORDER_NO }),
    }));
    h.session.start();
    await settle();
    expect(h.gateway.createOrder).toHaveBeenCalledTimes(2);
    expect(h.state()).toMatchObject({ phase: 'waiting', order: { orderNo: ORDER_NO } });
  });

  test('waits for the previous order to close before replacing it again', async () => {
    const h = harness({ offerToken: OFFER_TOKEN });
    h.gateway.createOrder.mockResolvedValueOnce(rejected(42304, ORDER_NO));
    h.gateway.replaceOrder
      .mockResolvedValueOnce(replacement({ status: 'old_order_closing' }))
      .mockResolvedValueOnce(replacement({ status: 'completed', order: order({ orderNo: NEW_ORDER_NO }) }));
    h.gateway.getOrderStatus.mockResolvedValueOnce(ok(order({ status: 'closed' })));
    h.session.start();
    await settle();
    expect(h.gateway.replaceOrder).toHaveBeenCalledTimes(2);
    expect(h.state()).toMatchObject({ phase: 'waiting', order: { orderNo: NEW_ORDER_NO } });
  });

  test('stops when the previous order turns out to be paid', async () => {
    const h = harness({ offerToken: OFFER_TOKEN });
    h.gateway.createOrder.mockResolvedValueOnce(rejected(42304, ORDER_NO));
    h.gateway.replaceOrder.mockResolvedValue(replacement({ status: 'old_order_closing' }));
    h.gateway.getOrderStatus.mockResolvedValueOnce(ok(order({ status: 'paid' })));
    h.session.start();
    await settle();
    expect(h.state()).toMatchObject({ phase: 'failed', failure: 'old_order_paid' });
    expect(h.onEntitlementsChanged).toHaveBeenCalledTimes(1);
  });

  test('reuses a pending order from an earlier checkout', async () => {
    const h = harness({ reusableOrder: order({ wechatQr: 'weixin://wxpay/bizpayurl?pr=earlier' }) });
    h.gateway.getOrderStatus.mockResolvedValueOnce(ok(order({ wechatQr: null })));
    h.session.start();
    await settle();
    expect(h.gateway.createOrder).not.toHaveBeenCalled();
    expect(h.state()).toMatchObject({ phase: 'waiting', qr: 'weixin://wxpay/bizpayurl?pr=earlier' });
  });

  test('creates a new order when the earlier one can no longer be paid', async () => {
    const h = harness({ reusableOrder: order() });
    h.gateway.getOrderStatus.mockResolvedValueOnce(ok(order({ status: 'closed' })));
    h.session.start();
    await settle();
    expect(h.gateway.createOrder).toHaveBeenCalledTimes(1);
  });

  test.each([
    [40100, 'login_required'],
    [42302, 'offer_unavailable'],
    [40506, 'create_failed'],
  ] as const)('reports a %s order rejection as %s', async (code, failure) => {
    const h = harness();
    h.gateway.createOrder.mockResolvedValue(rejected(code));
    h.session.start();
    await settle();
    expect(h.state()).toMatchObject({ phase: 'failed', failure });
  });

  test('creates a fresh order on regenerate', async () => {
    const h = harness();
    h.gateway.createOrder.mockResolvedValueOnce(rejected(40506));
    h.session.start();
    await settle();
    h.session.regenerate();
    await settle();
    expect(h.state()).toMatchObject({ phase: 'waiting', qr: WECHAT_QR });
    expect(h.gateway.createOrder).toHaveBeenCalledTimes(2);
  });

  test('stops polling once disposed', async () => {
    const h = harness();
    h.session.start();
    await settle();
    h.session.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.gateway.getOrderStatus).not.toHaveBeenCalled();
  });
});
