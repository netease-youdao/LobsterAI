import { expect,test } from 'vitest';

import { buildScheduledTaskEnginePrompt } from './enginePrompt';

test('openclaw prompt points scheduled task requests to the native cron tool', () => {
  const prompt = buildScheduledTaskEnginePrompt();

  expect(prompt).toMatch(/native `cron` tool/i);
  expect(prompt).toMatch(/action: "add".*cron\.add/i);
  expect(prompt).toMatch(/active conversation context/i);
  expect(prompt).toMatch(/follow the native `cron` tool schema/i);
  expect(prompt).toMatch(/one-time reminders .*future iso timestamp with an explicit timezone offset/i);
  expect(prompt).toMatch(/plugins provide session context and outbound delivery; they do not own scheduling logic/i);
  expect(prompt).toMatch(/native im\/channel sessions, ignore channel-specific reminder helpers or reminder skills/i);
  expect(prompt).toMatch(/do not use wrapper payloads .*qqbot_payload.*qqbot_cron.*cron_reminder/i);
  expect(prompt).toMatch(/do not use `sessions_spawn`, `subagents`, or ad-hoc background workflows as a substitute for `cron\.add`/i);
  expect(prompt).toMatch(/never emulate reminders .*bash.*sleep.*openclaw.*claw/i);
  expect(prompt).toMatch(/if the native `cron` tool is unavailable/i);

  // Message delivery guard for cron sessions
  expect(prompt).toMatch(/do NOT.*call the `message` tool directly/i);
  expect(prompt).toMatch(/cron system handles result delivery automatically/i);
  expect(prompt).toMatch(/Channel is required/i);
  expect(prompt).toMatch(/output your results as plain text/i);
});

test('scheduled task prompt always uses the openclaw instructions', () => {
  const prompt = buildScheduledTaskEnginePrompt();

  expect(prompt).not.toMatch(/switch the agent engine/i);
  expect(prompt).not.toMatch(/do not attempt to create, update, list, enable, disable, or delete scheduled tasks/i);
});
