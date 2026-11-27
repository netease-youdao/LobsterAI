import { describe, expect, test } from 'vitest';

import { normalizeCoworkSystemPrompt } from './coworkSystemPrompt';

const LEGACY_SCHEDULED_TASK_BLOCK = [
  '## Scheduled Tasks',
  '- Use the native `automations` tool for any scheduled task creation or management request. The gateway RPC methods are still named `cron.*`.',
  '- Never substitute `sessions_spawn`, `subagents`, Bash, `sleep`, background jobs, the `openclaw`/`claw` CLI, or manual process management for `cron.add`.',
  '',
  '### Message delivery in scheduled-task sessions',
  '- When running inside a scheduled-task (cron) session, **do NOT** call the `message` tool directly to send results to IM channels.',
  '- If the prompt asks to "send" or "notify", still output the content in the session and append a note: "（此定时任务未配置 IM 通知通道，结果已保存在执行记录中。如需自动推送，请在定时任务设置中配置通知通道。）"',
].join('\n');

const LEGACY_ENGLISH_DEFAULT = [
  '# Style',
  '- Keep your response language consistent with the user\'s input language. Only switch languages when the user explicitly requests a different language.',
  '',
  '# File Paths',
  'Format: `[display name](file:///absolute/path)`',
  '',
  '# Working Directory',
  '- Treat the working directory as the source of truth for user files.',
  '',
  '# Collaboration',
  '- Treat the user as an equal co-builder.',
  '- If you change the plan, say so explicitly in the next update.',
].join('\n');

const NEW_ZH_DEFAULT = '# 回复风格\n- 保持回复语言与用户输入一致。';

describe('normalizeCoworkSystemPrompt', () => {
  test('falls back to current default prompt when undefined', () => {
    expect(normalizeCoworkSystemPrompt(undefined, NEW_ZH_DEFAULT)).toBe(NEW_ZH_DEFAULT);
    expect(normalizeCoworkSystemPrompt(undefined, '')).toBeUndefined();
  });

  test('strips legacy OpenClaw scheduled task prompt and upgrades legacy English default prompt', () => {
    const legacy = `${LEGACY_SCHEDULED_TASK_BLOCK}\n\n${LEGACY_ENGLISH_DEFAULT}`;
    expect(normalizeCoworkSystemPrompt(legacy, NEW_ZH_DEFAULT)).toBe(NEW_ZH_DEFAULT);
  });

  test('preserves custom user or plan-mode instructions alongside stripped legacy blocks', () => {
    const legacyWithSkill = `${LEGACY_SCHEDULED_TASK_BLOCK}\n\n## 本轮已选技能\n<selected_skills></selected_skills>\n\n${LEGACY_ENGLISH_DEFAULT}`;
    expect(normalizeCoworkSystemPrompt(legacyWithSkill, NEW_ZH_DEFAULT)).toBe(
      `## 本轮已选技能\n<selected_skills></selected_skills>\n\n${NEW_ZH_DEFAULT}`,
    );
  });

  test('keeps clean Chinese prompts untouched', () => {
    expect(normalizeCoworkSystemPrompt(NEW_ZH_DEFAULT, NEW_ZH_DEFAULT)).toBe(NEW_ZH_DEFAULT);
  });
});
