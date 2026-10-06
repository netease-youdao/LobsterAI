import { expect, test } from 'vitest';

import {
  createAccountOwnerKey,
  resolveAccountOwnerUserId,
} from './accountOwner';

test('uses the stable server user id across exchange and profile payloads', () => {
  expect(createAccountOwnerKey({
    user: { userId: '6', yid: 'employee' },
  })).toBe('personal:6');
  expect(createAccountOwnerKey({
    user: { id: 6, yid: 'employee' },
  })).toBe('personal:6');
});

test('scopes enterprise accounts by user and enterprise', () => {
  expect(createAccountOwnerKey({
    user: { userId: '6' },
    enterpriseId: 1001,
  })).toBe('enterprise:6:1001');
});

test('fails closed while an enterprise identity is missing its enterprise context', () => {
  expect(createAccountOwnerKey({
    user: { userId: '6', accountMode: 'enterprise' },
  })).toBeNull();
  expect(createAccountOwnerKey({
    user: { userId: '6', accountMode: 'enterprise' },
    enterpriseId: 1001,
  })).toBe('enterprise:6:1001');
});

test('falls back to yid and rejects missing user identities', () => {
  expect(resolveAccountOwnerUserId({ yid: 'employee' })).toBe('employee');
  expect(createAccountOwnerKey({ user: null })).toBeNull();
});
