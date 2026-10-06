import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { i18nService } from '../../services/i18n';
import {
  formatPublishingTrialExpiry,
  getPublishingRemainingMinutes,
  parsePublishingAccessExpiry,
} from './PublishingTrialStatus';

describe('PublishingTrialStatus', () => {
  const originalLanguage = i18nService.getLanguage();

  beforeAll(() => {
    i18nService.setLanguage('zh', { persist: false });
  });

  afterAll(() => {
    i18nService.setLanguage(originalLanguage, { persist: false });
  });

  test('recognizes a server-provided share expiration timestamp', () => {
    expect(parsePublishingAccessExpiry('2026-08-20T10:00:00+08:00')).toBe(
      Date.parse('2026-08-20T10:00:00+08:00'),
    );
  });

  test('does not mark missing or malformed expiration values as trials', () => {
    expect(parsePublishingAccessExpiry(undefined)).toBeUndefined();
    expect(parsePublishingAccessExpiry('not-a-date')).toBeUndefined();
  });

  test('does not round a two-hour expiry with sub-minute clock skew up to 2h 1m', () => {
    const now = Date.parse('2026-08-20T10:00:00+08:00');
    const expiresAt = now + (2 * 60 * 60 * 1_000) + 20_000;

    expect(getPublishingRemainingMinutes(expiresAt - now)).toBe(120);
    expect(formatPublishingTrialExpiry(expiresAt, now)).toBe('链接有效期：2小时');
  });

  test('continues to show meaningful minute precision away from the clock-skew boundary', () => {
    const now = Date.parse('2026-08-20T10:00:00+08:00');
    const expiresAt = now + (1 * 60 * 60 * 1_000) + (32 * 60 * 1_000);

    expect(formatPublishingTrialExpiry(expiresAt, now)).toBe('链接有效期：1小时32分钟');
  });
});
