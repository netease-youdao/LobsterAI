import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildScheduledTaskEnginePrompt,
  SCHEDULED_TASK_SWITCH_MESSAGE,
} = require('../dist-electron/main/libs/scheduledTaskEnginePrompt.js');

test('openclaw prompt points scheduled task requests to the native cron tool', () => {
  const prompt = buildScheduledTaskEnginePrompt('openclaw');

  assert.match(prompt, /native `cron` tool/i);
  assert.match(prompt, /action: "add".*cron\.add/i);
  assert.match(prompt, /active conversation context/i);
  assert.match(prompt, /follow the native `cron` tool schema/i);
  assert.match(prompt, /one-time reminders .*future iso timestamp with an explicit timezone offset/i);
  assert.match(prompt, /plugins provide session context and outbound delivery; they do not own scheduling logic/i);
  assert.match(prompt, /native im\/channel sessions, ignore channel-specific reminder helpers or reminder skills/i);
  assert.match(prompt, /do not use wrapper payloads .*qqbot_payload.*qqbot_cron.*cron_reminder/i);
  assert.match(prompt, /do not use `sessions_spawn`, `subagents`, or ad-hoc background workflows as a substitute for `cron\.add`/i);
  assert.match(prompt, /never emulate reminders .*bash.*sleep.*openclaw.*claw/i);
  assert.match(prompt, /if the native `cron` tool is unavailable/i);
});

test('yd_cowork prompt tells the user to switch engines', () => {
  const prompt = buildScheduledTaskEnginePrompt('yd_cowork');

  assert.match(prompt, new RegExp(SCHEDULED_TASK_SWITCH_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(prompt, /do not attempt to create, update, list, enable, disable, or delete scheduled tasks/i);
});
