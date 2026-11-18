import { expect,test } from 'vitest';

import {
  buildOpenClawLocalTimeContextPrompt,
  MANAGED_LOCAL_TIME_POLICY_PROMPT,
  stripOpenClawLocalTimeContextFooter,
} from './openclawLocalTimeContextPrompt';

test('openclaw local time context carries the turn snapshot in one compact line', () => {
  const now = new Date('2026-03-15T08:28:00.000Z');
  const prompt = buildOpenClawLocalTimeContextPrompt(now);

  expect(prompt).toMatch(/^<!-- lobsterai:local-time-context:v2 -->\nLocal time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2} \(/);
  expect(prompt).toContain(`unix ms ${now.getTime()}.`);
  expect(prompt.endsWith('<!-- /lobsterai:local-time-context:v2 -->')).toBe(true);
  expect(buildOpenClawLocalTimeContextPrompt(now)).toBe(prompt);
  // The static rules moved to the cached AGENTS.md section.
  expect(prompt.length).toBeLessThan(200);
});

test('the managed local time policy keeps the scheduling rules', () => {
  expect(MANAGED_LOCAL_TIME_POLICY_PROMPT).toMatch(/authoritative current local time/i);
  expect(MANAGED_LOCAL_TIME_POLICY_PROMPT).toMatch(/future ISO 8601 timestamp with an explicit timezone offset/i);
  expect(MANAGED_LOCAL_TIME_POLICY_PROMPT).toMatch(/never one equal to or earlier/i);
});

test('strips only a complete generated tail, preserving quoted and user-authored time text', () => {
  const footer = buildOpenClawLocalTimeContextPrompt(new Date('2026-10-27T01:00:00Z'));
  const user = `Explain this quote:\n\n${footer}\n\nKeep this content.`;
  expect(stripOpenClawLocalTimeContextFooter(`${user}\n\n${footer}`)).toBe(user);
  for (const text of [
    'hello\n\n## Local Time Context\nMy own notes',
    `hello\n\n${footer}\nuser text after footer`,
    `hello\n\n${footer.replace('unix ms', 'epoch')}`,
    `hello\n\n${footer.split('\n').slice(0, -1).join('\n')}`,
  ]) {
    expect(stripOpenClawLocalTimeContextFooter(text)).toBe(text);
  }
});

test('still strips v1 footers stored in older transcripts', () => {
  const v1Body = [
    '## Local Time Context',
    '- Treat this section as the authoritative current local time for this machine.',
    '- Current local datetime: 2026-10-27 09:00:00 (timezone: Asia/Shanghai, UTC+08:00)',
    '- Current local ISO datetime (no timezone suffix): 2026-10-27T09:00:00',
    '- Current unix timestamp (ms): 1793062800000',
    '- For relative time requests (e.g. "1 minute later", "tomorrow 9am"), compute from this local time unless the user specifies another timezone.',
    '- When calling `cron.add` with `schedule.kind: "at"`, send a future ISO 8601 timestamp with an explicit timezone offset.',
    '- Never send an `at` timestamp that is equal to or earlier than the current local time.',
  ].join('\n');
  const marked = `<!-- lobsterai:local-time-context:v1 -->\n${v1Body}\n<!-- /lobsterai:local-time-context:v1 -->`;
  expect(stripOpenClawLocalTimeContextFooter(`hello\n\n${marked}`)).toBe('hello');
  expect(stripOpenClawLocalTimeContextFooter(`hello\n\n${v1Body}`)).toBe('hello');
});
