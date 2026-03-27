import { test, expect } from 'vitest';
import { buildScheduledTaskEnginePrompt, SCHEDULED_TASK_SWITCH_MESSAGE } from './enginePrompt';

test('openclaw prompt points scheduled task requests to the native cron tool', () => {
  const prompt = buildScheduledTaskEnginePrompt('openclaw');

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
});

test('yd_cowork prompt tells the user to switch engines', () => {
  const prompt = buildScheduledTaskEnginePrompt('yd_cowork');

  expect(prompt).toMatch(new RegExp(SCHEDULED_TASK_SWITCH_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  expect(prompt).toMatch(/do not attempt to create, update, list, enable, disable, or delete scheduled tasks/i);
});
