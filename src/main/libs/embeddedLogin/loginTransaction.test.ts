import { describe, expect, test } from 'vitest';

import { createLoginTransaction, isSameState } from './loginTransaction';

// RFC 7636 Appendix B test vector.
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('createLoginTransaction', () => {
  test('derives the S256 challenge from the verifier', () => {
    const randomValues = [Buffer.from(RFC_VERIFIER, 'base64url'), Buffer.alloc(32, 7)];
    const transaction = createLoginTransaction(() => randomValues.shift()!);

    expect(transaction.codeVerifier).toBe(RFC_VERIFIER);
    expect(transaction.codeChallenge).toBe(RFC_CHALLENGE);
    expect(transaction.state).toBe(Buffer.alloc(32, 7).toString('base64url'));
  });

  test('creates independent url-safe values for each login', () => {
    const first = createLoginTransaction();
    const second = createLoginTransaction();

    expect(first.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.state).not.toBe(first.state);
    expect(second.codeVerifier).not.toBe(first.codeVerifier);
  });
});

describe('isSameState', () => {
  test('accepts only an exact match', () => {
    expect(isSameState('expected-state', 'expected-state')).toBe(true);
    expect(isSameState('expected-state', 'expected-statf')).toBe(false);
    expect(isSameState('expected-state', 'expected')).toBe(false);
    expect(isSameState('expected-state', null)).toBe(false);
  });
});
