import { expect, it } from 'vitest';

import { mobileRemoteStartupEnabled } from './mobileRemoteStartup';

it('retains the signed-in default and requires a valid account and readable preference', () => {
  const owner = { userId: '1', scopeKey: 'personal' };
  expect(mobileRemoteStartupEnabled(null, null)).toBe(false);
  expect(mobileRemoteStartupEnabled(null, { enabled: true })).toBe(false);
  expect(mobileRemoteStartupEnabled(owner, null)).toBe(true);
  expect(mobileRemoteStartupEnabled(owner, { name: 'Laptop' })).toBe(true);
  expect(mobileRemoteStartupEnabled(owner, { enabled: false })).toBe(false);
  expect(mobileRemoteStartupEnabled(owner, { enabled: 'true' })).toBe(false);
  expect(mobileRemoteStartupEnabled(owner, undefined)).toBe(false);
});
