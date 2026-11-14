import { expect,test } from 'vitest';

import { buildScheduledTaskEnginePrompt } from './enginePrompt';

test('openclaw prompt names the automations tool separately from cron gateway methods', () => {
  const prompt = buildScheduledTaskEnginePrompt();

  expect(prompt).toMatch(/native `automations` tool/i);
  expect(prompt).not.toMatch(/native `cron`/i);
  expect(prompt).toMatch(/action: "add".*cron\.add/i);
  expect(prompt).toMatch(/active conversation context/i);
  expect(prompt).toMatch(/follow the native `automations` tool schema/i);
  expect(prompt).toMatch(/for scheduled-task creation, call native `automations` with `action: "add"`/i);
  expect(prompt).toMatch(/channel delivery config .*you MUST set `sessionTarget: "isolated"`/i);
  expect(prompt).toMatch(/one-time reminders .*future iso timestamp with an explicit timezone offset/i);
  expect(prompt).toMatch(/plugins provide session context and outbound delivery; they do not own scheduling logic/i);
  expect(prompt).toMatch(/native im\/channel sessions, ignore channel-specific reminder helpers or reminder skills/i);
  expect(prompt).toMatch(/do not use wrapper payloads .*qqbot_payload.*qqbot_cron.*cron_reminder/i);
  expect(prompt).toMatch(/never substitute `sessions_spawn`, `subagents`, bash, `sleep`.*openclaw.*claw.* for `cron\.add`/i);
  expect(prompt).toMatch(/if the native `automations` tool is unavailable/i);

  // Message delivery guard for cron sessions
  expect(prompt).toMatch(/do NOT.*call the `message` tool directly/i);
  expect(prompt).toMatch(/cron system handles result delivery automatically/i);
  expect(prompt).toMatch(/Channel is required/i);
  expect(prompt).toMatch(/output your results as plain text/i);
  expect(prompt).toMatch(/append a note: "（此定时任务未配置 IM 通知通道/);
});

test('scheduled task prompt states each rule once', () => {
  const prompt = buildScheduledTaskEnginePrompt();

  // The channel-helper and workaround bans used to be spelled out in several
  // bullets each; the section is part of every model request, so each is
  // stated once. The creation bullets keep their wording: a regression run
  // with a merged form took an extra `list` request before `add`.
  expect(prompt.match(/QQBOT_PAYLOAD/g)).toHaveLength(1);
  expect(prompt.match(/`sessions_spawn`/g)).toHaveLength(1);
  expect(prompt.length).toBeLessThan(2150);
});

test('scheduled task prompt always uses the openclaw instructions', () => {
  const prompt = buildScheduledTaskEnginePrompt();

  expect(prompt).not.toMatch(/switch the agent engine/i);
  expect(prompt).not.toMatch(/do not attempt to create, update, list, enable, disable, or delete scheduled tasks/i);
});
