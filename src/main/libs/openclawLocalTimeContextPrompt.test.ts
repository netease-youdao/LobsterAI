import { test, expect } from 'vitest';
import { buildOpenClawLocalTimeContextPrompt } from './openclawLocalTimeContextPrompt';

test('openclaw local time context prompt makes future at-timestamps explicit', () => {
  const now = new Date('2026-03-15T08:28:00.000Z');
  const prompt = buildOpenClawLocalTimeContextPrompt(now);

  expect(prompt).toMatch(/authoritative current local time/i);
  expect(prompt).toMatch(/Current local datetime: /);
  expect(prompt).toMatch(/UTC[+-]\d{2}:\d{2}/);
  expect(prompt).toMatch(new RegExp(`Current unix timestamp \\(ms\\): ${now.getTime()}`));
  expect(prompt).toMatch(/future ISO 8601 timestamp with an explicit timezone offset/i);
  expect(prompt).toMatch(/Never send an `at` timestamp that is equal to or earlier/i);
});
