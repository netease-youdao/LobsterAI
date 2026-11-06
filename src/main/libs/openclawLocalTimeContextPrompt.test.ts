import { expect,test } from 'vitest';

import { buildOpenClawLocalTimeContextPrompt, stripOpenClawLocalTimeContextFooter } from './openclawLocalTimeContextPrompt';

test('openclaw local time context preserves the supplied turn snapshot and time precision', () => {
  const now = new Date('2026-03-15T08:28:00.000Z');
  const prompt = buildOpenClawLocalTimeContextPrompt(now);

  expect(prompt).toContain('## Local Time Context');
  expect(prompt).toMatch(/authoritative current local time/i);
  expect(prompt).toMatch(/Current local datetime: /);
  expect(prompt).toMatch(/UTC[+-]\d{2}:\d{2}/);
  expect(prompt).toMatch(new RegExp(`Current unix timestamp \\(ms\\): ${now.getTime()}`));
  expect(prompt).toMatch(/Current local ISO datetime \(no timezone suffix\): /);
  expect(buildOpenClawLocalTimeContextPrompt(now)).toBe(prompt);
  expect(prompt).toMatch(/future ISO 8601 timestamp with an explicit timezone offset/i);
  expect(prompt).toMatch(/Never send an `at` timestamp that is equal to or earlier/i);
});


test('strips only a complete generated tail, preserving quoted and user-authored time text', () => {
  const footer = buildOpenClawLocalTimeContextPrompt(new Date('2026-10-27T01:00:00Z'));
  const user = `Explain this quote:\n\n${footer}\n\nKeep this content.`;
  expect(stripOpenClawLocalTimeContextFooter(`${user}\n\n${footer}`)).toBe(user);
  for (const text of [
    'hello\n\n## Local Time Context\nMy own notes',
    `hello\n\n${footer}\nuser text after footer`,
    `hello\n\n${footer.replace('cron.add', 'custom-tool')}`,
    `hello\n\n${footer.split('\n').slice(0, -2).join('\n')}`,
  ]) {
    expect(stripOpenClawLocalTimeContextFooter(text)).toBe(text);
  }
});
