import { describe, expect, test } from 'vitest';

import { mergeNoProxyValue } from './noProxyEnv';

describe('mergeNoProxyValue', () => {
  test('injects loopback entries when nothing is set', () => {
    expect(mergeNoProxyValue(undefined, undefined)).toBe('localhost,127.0.0.1,::1');
  });

  test('preserves existing entries and appends missing loopback entries', () => {
    expect(mergeNoProxyValue('internal.example.com', undefined)).toBe(
      'internal.example.com,localhost,127.0.0.1,::1'
    );
  });

  test('does not duplicate loopback entries already present', () => {
    expect(mergeNoProxyValue('localhost,127.0.0.1,::1', undefined)).toBe('localhost,127.0.0.1,::1');
  });

  test('dedupes case-insensitively and keeps the first casing', () => {
    expect(mergeNoProxyValue('LOCALHOST, 127.0.0.1', undefined)).toBe('LOCALHOST,127.0.0.1,::1');
  });

  test('merges lowercase and uppercase env values in order', () => {
    expect(mergeNoProxyValue('a.internal', 'b.internal,localhost')).toBe(
      'a.internal,b.internal,localhost,127.0.0.1,::1'
    );
  });

  test('ignores empty segments and surrounding whitespace', () => {
    expect(mergeNoProxyValue(' , ,internal ,', '')).toBe('internal,localhost,127.0.0.1,::1');
  });
});
