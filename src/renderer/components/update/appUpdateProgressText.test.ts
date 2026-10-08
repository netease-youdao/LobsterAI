import { describe, expect, test } from 'vitest';

import { formatBytes, formatSpeed, formatTransferProgress } from './appUpdateProgressText';

describe('appUpdateProgressText', () => {
  test('formats bytes across units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(38_000_000)).toBe('36.2 MB');
  });

  test('treats invalid byte counts as empty', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatSpeed(undefined)).toBe('');
    expect(formatSpeed(0)).toBe('');
    expect(formatSpeed(Number.NaN)).toBe('');
  });

  test('summarises transfer progress with optional total and speed', () => {
    expect(formatTransferProgress(null)).toBeNull();
    expect(formatTransferProgress({ received: 50, total: 100, percent: 0.5, speed: 20 }))
      .toBe('50 B / 100 B · 20 B/s');
    expect(formatTransferProgress({ received: 50, total: undefined, percent: undefined, speed: undefined }))
      .toBe('50 B');
  });
});
