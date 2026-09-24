import { describe, expect, test } from 'vitest';

import {
  parseOfferToken,
  parseOrderNo,
  parsePaymentTarget,
  parseReplaceInput,
  parseRequestId,
  PaymentInputError,
  productKey,
  toServerSelection,
} from './paymentRequest';

const ORDER_NO = 'LB20260924120000123456';

describe('parsePaymentTarget', () => {
  test('accepts a plan, a listed boost pack and a whole custom amount', () => {
    expect(parsePaymentTarget({ product: 'subscription', planId: 2 }))
      .toEqual({ product: 'subscription', planId: 2 });
    expect(parsePaymentTarget({ product: 'boost_pack', boostPackId: 3 }))
      .toEqual({ product: 'boost_pack', boostPackId: 3 });
    expect(parsePaymentTarget({ product: 'boost_pack', amount: 88 }))
      .toEqual({ product: 'boost_pack', amount: 88 });
  });

  test.each([
    { product: 'subscription', planId: 0 },
    { product: 'subscription', planId: 1.5 },
    { product: 'subscription', planId: '2' },
    { product: 'boost_pack', boostPackId: 3, amount: 10 },
    { product: 'boost_pack', amount: 9 },
    { product: 'boost_pack', amount: 5001 },
    { product: 'boost_pack', amount: 10.5 },
    { product: 'enterprise_pack', amount: 100 },
    null,
    [],
  ])('rejects %j', (input) => {
    expect(() => parsePaymentTarget(input)).toThrow(PaymentInputError);
  });
});

describe('identifiers', () => {
  test('accepts server order numbers only', () => {
    expect(parseOrderNo(ORDER_NO)).toBe(ORDER_NO);
    for (const value of ['LB123', 'lb20260924120000123456', `${ORDER_NO}/status`, 42]) {
      expect(() => parseOrderNo(value)).toThrow(PaymentInputError);
    }
  });

  test('accepts replacement request ids in the server format', () => {
    const requestId = crypto.randomUUID();
    expect(parseRequestId(requestId)).toBe(requestId);
    expect(() => parseRequestId('../payment/orders')).toThrow(PaymentInputError);
    expect(() => parseRequestId('short')).toThrow(PaymentInputError);
  });

  test('treats an empty offer token as absent and rejects malformed ones', () => {
    expect(parseOfferToken(undefined)).toBeUndefined();
    expect(parseOfferToken('')).toBeUndefined();
    expect(parseOfferToken('0f8fad5bd9cb469fa16570867728950e')).toBe('0f8fad5bd9cb469fa16570867728950e');
    expect(() => parseOfferToken('<script>')).toThrow(PaymentInputError);
    expect(() => parseOfferToken('a'.repeat(129))).toThrow(PaymentInputError);
  });

  test('requires an offer token to replace an order', () => {
    expect(() => parseReplaceInput({
      oldOrderNo: ORDER_NO,
      target: { product: 'boost_pack', boostPackId: 1 },
    })).toThrow(PaymentInputError);
  });
});

describe('server mapping', () => {
  test('builds the server selection and the offer product key', () => {
    expect(toServerSelection({ product: 'subscription', planId: 2 }))
      .toEqual({ orderType: 'subscription', planId: 2 });
    expect(toServerSelection({ product: 'boost_pack', boostPackId: 3 }))
      .toEqual({ orderType: 'boost_pack', boostPackId: 3 });
    expect(toServerSelection({ product: 'boost_pack', amount: 88 }))
      .toEqual({ orderType: 'boost_pack', amount: 88 });
    expect(productKey({ product: 'subscription', planId: 2 })).toBe('subscription:2');
    expect(productKey({ product: 'boost_pack', boostPackId: 3 })).toBe('boost_pack:3');
    expect(productKey({ product: 'boost_pack', amount: 88 })).toBe('boost_custom:88');
  });
});
