import { expect, test } from 'vitest';

import { isP2PMessageAllowed } from './nimGateway';

test('open policy allows any sender', () => {
  const result = isP2PMessageAllowed({ p2pPolicy: 'open', p2pAllowlist: [], senderId: 'stranger-1' });
  expect(result.allowed).toBe(true);
});

test('allowlist policy allows a listed sender', () => {
  const result = isP2PMessageAllowed({
    p2pPolicy: 'allowlist',
    p2pAllowlist: ['friend-1'],
    senderId: 'friend-1',
  });
  expect(result.allowed).toBe(true);
});

test('allowlist policy denies an unlisted sender', () => {
  const result = isP2PMessageAllowed({
    p2pPolicy: 'allowlist',
    p2pAllowlist: ['friend-1'],
    senderId: 'stranger-1',
  });
  expect(result.allowed).toBe(false);
});

test('disabled policy denies every sender, including one present in a stale allowFrom list', () => {
  const result = isP2PMessageAllowed({
    p2pPolicy: 'disabled',
    p2pAllowlist: ['friend-1'],
    senderId: 'friend-1',
  });
  expect(result.allowed).toBe(false);
});

test('unset/unconfigured policy fails closed rather than defaulting to open', () => {
  const result = isP2PMessageAllowed({ p2pPolicy: undefined, p2pAllowlist: [], senderId: 'stranger-1' });
  expect(result.allowed).toBe(false);
});
