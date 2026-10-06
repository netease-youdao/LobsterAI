import { describe, expect, test } from 'vitest';

import { isClientVersionAtLeast } from './clientVersion';

describe('client version comparison', () => {
  test('compares date-based versions numerically', () => {
    expect(isClientVersionAtLeast('2026.8.26', '2026.8.26')).toBe(true);
    expect(isClientVersionAtLeast('2026.10.1', '2026.8.26')).toBe(true);
    expect(isClientVersionAtLeast('2026.8.25', '2026.8.26')).toBe(false);
  });

  test('treats a prerelease as older than its release', () => {
    expect(isClientVersionAtLeast('2026.8.26-beta.1', '2026.8.26')).toBe(false);
    expect(isClientVersionAtLeast('2026.8.26', '2026.8.26-beta.1')).toBe(true);
  });

  test('rejects missing and malformed versions', () => {
    expect(isClientVersionAtLeast(undefined, '2026.8.26')).toBe(false);
    expect(isClientVersionAtLeast('latest', '2026.8.26')).toBe(false);
    expect(isClientVersionAtLeast('2026.8.26', '2026..8')).toBe(false);
    expect(isClientVersionAtLeast('2026.8.26', '2026.2147483648.1')).toBe(false);
  });
});
