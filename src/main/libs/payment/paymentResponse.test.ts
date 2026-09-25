import { describe, expect, test } from 'vitest';

import {
  sanitizeBoostPacks,
  sanitizeOrder,
  sanitizePlans,
  sanitizeReplacement,
  sanitizeSubscription,
  validAlipayQr,
  validWechatQr,
} from './paymentResponse';

const ORDER_NO = 'LB20260924120000123456';
const OTHER_ORDER_NO = 'LB20260924120000654321';
const SIGN_PAGE = `https://lobsterai.youdao.com/portal?wechatSign=1&orderNo=${ORDER_NO}`;

describe('QR codes', () => {
  test('accepts WeChat Native codes and the signing page for the same order', () => {
    expect(validWechatQr('weixin://wxpay/bizpayurl?pr=AbC123', ORDER_NO)).toBe('weixin://wxpay/bizpayurl?pr=AbC123');
    expect(validWechatQr(SIGN_PAGE, ORDER_NO)).toBe(SIGN_PAGE);
    expect(validWechatQr(
      `https://lobsterai.inner.youdao.com/portal?wechatSign=1&orderNo=${ORDER_NO}`,
      ORDER_NO,
    )).not.toBeNull();
  });

  test.each([
    `https://lobsterai.youdao.com/portal?wechatSign=1&orderNo=${OTHER_ORDER_NO}`,
    `https://evil.example/portal?wechatSign=1&orderNo=${ORDER_NO}`,
    `http://lobsterai.youdao.com/portal?wechatSign=1&orderNo=${ORDER_NO}`,
    `https://lobsterai.youdao.com/portal/pay?wechatSign=1&orderNo=${ORDER_NO}`,
    `https://lobsterai.youdao.com/portal?orderNo=${ORDER_NO}`,
    `https://lobsterai.youdao.com/portal?wechatSign=1&orderNo=${ORDER_NO}#/login`,
    'weixin://wxpay/other?pr=1',
    'weixin://wxpay/bizpayurl?pr=a b',
    'javascript:alert(1)',
    42,
  ])('rejects the WeChat value %s', (value) => {
    expect(validWechatQr(value, ORDER_NO)).toBeNull();
  });

  test('accepts only Alipay precreate codes', () => {
    expect(validAlipayQr('https://qr.alipay.com/bax03431ljhokirwl38f00a7'))
      .toBe('https://qr.alipay.com/bax03431ljhokirwl38f00a7');
    for (const value of [
      'http://qr.alipay.com/bax1',
      'https://qr.alipay.com.evil.example/bax1',
      'https://user@qr.alipay.com/bax1',
      'https://qr.alipay.com:8443/bax1',
      'https://qr.alipay.com/bax1\n',
      `https://qr.alipay.com/${'a'.repeat(2048)}`,
    ]) {
      expect(validAlipayQr(value)).toBeNull();
    }
  });
});

describe('sanitizeOrder', () => {
  test('keeps only the whitelisted fields', () => {
    expect(sanitizeOrder({
      orderNo: ORDER_NO,
      status: 'pending',
      amount: 29.5,
      originalAmount: 59,
      discountRate: 0.5,
      baseCredits: 4900,
      bonusCredits: 490,
      totalCredits: 5390,
      creditsEstimated: true,
      orderExpiresAtEpochMs: 1_800_000,
      serverTimeEpochMs: 0,
      paymentProcessing: false,
      wechatQrUrl: 'weixin://wxpay/bizpayurl?pr=AbC123',
      alipayQrUrl: 'https://qr.alipay.com/bax1',
      qrCodeUrl: 'https://evil.example/pay',
      payUrl: 'https://evil.example/pay',
      userId: 7,
    })).toEqual({
      orderNo: ORDER_NO,
      status: 'pending',
      amount: 29.5,
      originalAmount: 59,
      discountRate: 0.5,
      baseCredits: 4900,
      bonusCredits: 490,
      totalCredits: 5390,
      creditsEstimated: true,
      orderExpiresAtEpochMs: 1_800_000,
      serverTimeEpochMs: 0,
      paymentProcessing: false,
      wechatQr: 'weixin://wxpay/bizpayurl?pr=AbC123',
      alipayQr: 'https://qr.alipay.com/bax1',
    });
  });

  test('rejects another order and drops unknown statuses', () => {
    expect(sanitizeOrder({ orderNo: ORDER_NO }, OTHER_ORDER_NO)).toBeNull();
    expect(sanitizeOrder({ orderNo: 'LB1' })).toBeNull();
    expect(sanitizeOrder({ orderNo: ORDER_NO, status: 'hacked' })?.status).toBeNull();
  });
});

describe('sanitizeReplacement', () => {
  const requestId = '0f8fad5b-d9cb-469f-a165-70867728950e';

  test('passes the replacement state with a sanitized order', () => {
    expect(sanitizeReplacement({
      requestId,
      oldOrderNo: ORDER_NO,
      status: 'completed',
      selectionMatches: true,
      order: { orderNo: OTHER_ORDER_NO, status: 'pending', payUrl: 'https://evil.example/pay' },
    }, ORDER_NO)).toMatchObject({
      requestId,
      oldOrderNo: ORDER_NO,
      status: 'completed',
      selectionMatches: true,
      order: { orderNo: OTHER_ORDER_NO, status: 'pending' },
    });
  });

  test('rejects a result for another order, an unknown status or a malformed order', () => {
    expect(sanitizeReplacement({ requestId, oldOrderNo: ORDER_NO, status: 'processing' }, OTHER_ORDER_NO)).toBeNull();
    expect(sanitizeReplacement({ requestId, oldOrderNo: ORDER_NO, status: 'unknown' })).toBeNull();
    expect(sanitizeReplacement({
      requestId, oldOrderNo: ORDER_NO, status: 'completed', order: { orderNo: 'bad' },
    })).toBeNull();
  });
});

describe('catalog', () => {
  test('lists paid plans and valid packs only', () => {
    expect(sanitizePlans([
      { id: 1, name: 'free', displayName: '免费版', monthlyPrice: 0, monthlyCredits: 300 },
      {
        id: 2, name: 'standard', displayName: '标准版', displayNameEn: 'Standard',
        monthlyPrice: 49, monthlyCredits: 5000, bonusCredits: 500, tag: '推荐', features: '{}',
      },
      { id: 'x', displayName: 'broken', monthlyPrice: 9, monthlyCredits: 1 },
    ])).toEqual([{
      id: 2, displayName: '标准版', displayNameEn: 'Standard', monthlyPrice: 49,
      monthlyCredits: 5000, bonusCredits: 500, tag: '推荐', tagEn: null,
    }]);
    expect(sanitizeBoostPacks([{ id: 1, displayName: '标准加油包', price: 59, credits: 4900, validityDays: 365 }]))
      .toEqual([{ id: 1, displayName: '标准加油包', displayNameEn: null, price: 59, credits: 4900 }]);
    expect(sanitizePlans({})).toBeNull();
  });

  test('summarizes the subscription fields the purchase flow depends on', () => {
    expect(sanitizeSubscription({
      subscriptionStatus: 'active', planId: 2, trial: { active: false }, autoRenew: true,
    })).toEqual({ status: 'active', planId: 2, trialActive: false });
    expect(sanitizeSubscription({})).toBeNull();
  });
});
