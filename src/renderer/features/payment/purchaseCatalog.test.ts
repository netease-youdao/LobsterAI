import { describe, expect, test } from 'vitest';

import type { LowCreditPurchaseOffer } from '../../store/slices/authSlice';
import {
  boostOptionFor,
  formatYuan,
  offerTokenFor,
  parseCustomBoostAmount,
  subscriptionCheckoutFor,
} from './purchaseCatalog';

const packs = [{ id: 3, displayName: '标准加油包', displayNameEn: null, price: 59, credits: 4900 }];

test('buys a listed pack by id and other amounts as custom boosts', () => {
  expect(boostOptionFor(59, packs)).toEqual({
    amount: 59, credits: 4900, target: { product: 'boost_pack', boostPackId: 3 },
  });
  expect(boostOptionFor(50, packs)).toEqual({
    amount: 50, credits: 5000, target: { product: 'boost_pack', amount: 50 },
  });
});

test('accepts whole custom amounts from 10 to 5000', () => {
  expect(parseCustomBoostAmount('88')).toBe(88);
  expect(parseCustomBoostAmount('5000')).toBe(5000);
  for (const input of ['', '9', '5001', '10.5', '1e3', '-10', '12345']) {
    expect(parseCustomBoostAmount(input)).toBeNull();
  }
});

test('sends subscribers and trial members to the Portal for plan changes', () => {
  expect(subscriptionCheckoutFor(null)).toBe('in_app');
  expect(subscriptionCheckoutFor({ status: 'free', planId: null, trialActive: false })).toBe('in_app');
  expect(subscriptionCheckoutFor({ status: 'expired', planId: 2, trialActive: false })).toBe('in_app');
  expect(subscriptionCheckoutFor({ status: 'active', planId: 2, trialActive: false })).toBe('portal');
  expect(subscriptionCheckoutFor({ status: 'free', planId: null, trialActive: true })).toBe('portal');
});

describe('offerTokenFor', () => {
  const now = 1_000_000;
  const offer: LowCreditPurchaseOffer = {
    status: 'active',
    offerToken: 'offer-token-1',
    offerType: 'returning_purchase',
    productDiscountRates: { boost_pack: 0.8 },
    eligibleProducts: ['boost_pack'],
    serverTimeEpochMs: now,
    expiresAtEpochMs: now + 60_000,
    receivedAtEpochMs: now,
  };

  test('applies an active offer to the products it discounts', () => {
    expect(offerTokenFor(offer, 'offer-token-1', 'boost_pack', now)).toBe('offer-token-1');
    expect(offerTokenFor(offer, 'offer-token-1', 'subscription', now)).toBeUndefined();
  });

  test('ignores expired, unknown or missing offers', () => {
    expect(offerTokenFor(offer, 'offer-token-1', 'boost_pack', now + 60_001)).toBeUndefined();
    expect(offerTokenFor(offer, 'other-token', 'boost_pack', now)).toBeUndefined();
    expect(offerTokenFor(null, 'offer-token-1', 'boost_pack', now)).toBeUndefined();
    expect(offerTokenFor(offer, undefined, 'boost_pack', now)).toBeUndefined();
  });
});

test('formats prices in yuan', () => {
  expect(formatYuan(49)).toBe('¥49');
  expect(formatYuan(29.5)).toBe('¥29.5');
});
