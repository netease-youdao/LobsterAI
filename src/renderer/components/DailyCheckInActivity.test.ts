import { afterEach, describe, expect, test } from 'vitest';

import { i18nService } from '../services/i18n';
import { getLocalizedDailyCheckInText } from './DailyCheckInActivity';

const originalLanguage = i18nService.getLanguage();

afterEach(() => {
  i18nService.setLanguage(originalLanguage, { persist: false });
});

describe('getLocalizedDailyCheckInText', () => {
  test('uses the English fallback when server activity text is Chinese in English UI', () => {
    i18nService.setLanguage('en', { persist: false });

    expect(getLocalizedDailyCheckInText('每日积分礼', 'Daily credit gift')).toBe('Daily credit gift');
  });

  test('keeps localized server activity text when it matches the current UI language', () => {
    i18nService.setLanguage('zh', { persist: false });

    expect(getLocalizedDailyCheckInText('每日积分礼', '每日积分礼')).toBe('每日积分礼');
  });

  test('falls back when server activity text is blank', () => {
    i18nService.setLanguage('en', { persist: false });

    expect(getLocalizedDailyCheckInText('  ', 'Daily credit gift')).toBe('Daily credit gift');
  });
});
