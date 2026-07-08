import { expect, test, vi } from 'vitest';

import { formatMessageDateTime, formatMessageTime, formatTokenCount } from './tokenFormat';

test('formatTokenCount: values below 1000 returned as-is', () => {
  expect(formatTokenCount(0)).toBe('0');
  expect(formatTokenCount(1)).toBe('1');
  expect(formatTokenCount(647)).toBe('647');
  expect(formatTokenCount(999)).toBe('999');
});

test('formatTokenCount: values in thousands formatted as k', () => {
  expect(formatTokenCount(1000)).toBe('1k');
  expect(formatTokenCount(1200)).toBe('1.2k');
  expect(formatTokenCount(29600)).toBe('29.6k');
  expect(formatTokenCount(128000)).toBe('128k');
  expect(formatTokenCount(200000)).toBe('200k');
});

test('formatTokenCount: values in millions formatted as M', () => {
  expect(formatTokenCount(1000000)).toBe('1M');
  expect(formatTokenCount(1500000)).toBe('1.5M');
  expect(formatTokenCount(2000000)).toBe('2M');
});

test('formatMessageTime: today shows only time', () => {
  const now = new Date();
  now.setHours(14, 30, 0, 0);
  const result = formatMessageTime(now.getTime());
  expect(result).toMatch(/14:30/);
  expect(result).not.toMatch(/\//);
});

test('formatMessageTime: earlier this year shows MM/DD + time', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 4, 7, 10, 0));
  const jan15 = new Date(2026, 0, 15, 9, 5).getTime();
  const result = formatMessageTime(jan15);
  expect(result).toMatch(/01\/15/);
  expect(result).toMatch(/09:05/);
  vi.useRealTimers();
});

test('formatMessageTime: different year shows YYYY/MM/DD + time', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 4, 7, 10, 0));
  const dec2025 = new Date(2025, 11, 25, 20, 0).getTime();
  const result = formatMessageTime(dec2025);
  expect(result).toMatch(/2025\/12\/25/);
  expect(result).toMatch(/20:00/);
  vi.useRealTimers();
});

test('formatMessageDateTime: always shows YYYY/MM/DD + time', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 4, 7, 10, 0));
  const today = new Date(2026, 4, 7, 17, 2).getTime();
  const result = formatMessageDateTime(today);
  expect(result).toBe('2026/05/07 17:02');
  vi.useRealTimers();
});

test('message time formatting returns empty string for invalid timestamps', () => {
  expect(formatMessageTime(Number.NaN)).toBe('');
  expect(formatMessageDateTime(Number.NaN)).toBe('');
});
