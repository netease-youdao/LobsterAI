import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '../../services/i18n';
import { formatAgentTaskRelativeTime } from './time';

const now = 1_700_000_000_000;

afterEach(() => {
  vi.restoreAllMocks();
  i18nService.setLanguage('zh', { persist: false });
});

test('formatAgentTaskRelativeTime uses Chinese compact minute hour and day units', () => {
  i18nService.setLanguage('zh', { persist: false });
  vi.spyOn(Date, 'now').mockReturnValue(now);

  expect(formatAgentTaskRelativeTime(now - 30 * 1000).compact).toBe('1 分钟');
  expect(formatAgentTaskRelativeTime(now - 4 * 60000).compact).toBe('4 分钟');
  expect(formatAgentTaskRelativeTime(now - 60 * 60000).compact).toBe('60 分钟');
  expect(formatAgentTaskRelativeTime(now - 61 * 60000).compact).toBe('1 小时');
  expect(formatAgentTaskRelativeTime(now - 10 * 3600000).compact).toBe('10 小时');
  expect(formatAgentTaskRelativeTime(now - 25 * 3600000).compact).toBe('1 天');
});

test('formatAgentTaskRelativeTime uses English compact minute hour and day units', () => {
  i18nService.setLanguage('en', { persist: false });
  vi.spyOn(Date, 'now').mockReturnValue(now);

  expect(formatAgentTaskRelativeTime(now - 30 * 1000).compact).toBe('1m');
  expect(formatAgentTaskRelativeTime(now - 4 * 60000).compact).toBe('4m');
  expect(formatAgentTaskRelativeTime(now - 60 * 60000).compact).toBe('60m');
  expect(formatAgentTaskRelativeTime(now - 61 * 60000).compact).toBe('1h');
  expect(formatAgentTaskRelativeTime(now - 10 * 3600000).compact).toBe('10h');
  expect(formatAgentTaskRelativeTime(now - 25 * 3600000).compact).toBe('1d');
});

test('formatAgentTaskRelativeTime switches to week month and year units', () => {
  i18nService.setLanguage('zh', { persist: false });
  vi.spyOn(Date, 'now').mockReturnValue(now);

  expect(formatAgentTaskRelativeTime(now - 7 * 86400000).compact).toBe('1 周');
  expect(formatAgentTaskRelativeTime(now - 30 * 86400000).compact).toBe('1 月');
  expect(formatAgentTaskRelativeTime(now - 360 * 86400000).compact).toBe('1 年');
});

test('formatAgentTaskRelativeTime provides an exact date-time string in full', () => {
  const sample = new Date(2026, 10, 24, 17, 11).getTime();
  vi.spyOn(Date, 'now').mockReturnValue(sample + 2 * 3600000);

  const result = formatAgentTaskRelativeTime(sample);
  expect(result.full).toBe('2026/11/24 17:11');
  expect(result.full).not.toBe(result.compact);
});
