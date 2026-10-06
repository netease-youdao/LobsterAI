import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { i18nService } from '../../services/i18n';
import { formatPublishingTrialDuration } from './PublishingTrialNoticeDialog';

describe('PublishingTrialNoticeDialog', () => {
  const originalLanguage = i18nService.getLanguage();

  beforeAll(() => {
    i18nService.setLanguage('zh', { persist: false });
  });

  afterAll(() => {
    i18nService.setLanguage(originalLanguage, { persist: false });
  });

  test('formats the server-provided two-hour trial duration', () => {
    expect(formatPublishingTrialDuration(2 * 60 * 60)).toBe('2小时');
  });

  test('keeps minute precision for non-hour trial policies', () => {
    expect(formatPublishingTrialDuration((2 * 60 + 5) * 60)).toBe('2小时5分钟');
    expect(formatPublishingTrialDuration(30 * 60)).toBe('30分钟');
  });
});
