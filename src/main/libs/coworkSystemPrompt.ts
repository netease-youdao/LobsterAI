// Helpers for normalizing Cowork session system prompts after migrating from
// OpenClaw to DeepSeek Harness (DSH). Strips legacy OpenClaw scheduled-task
// instructions and upgrades verbatim legacy English default prompts stored on
// historical sessions to the current concise Chinese default.

const LEGACY_OPENCLAW_SCHEDULED_TASK_BLOCK_RE = /(?:^|\n)## Scheduled Tasks\n- Use the native `automations` tool[\s\S]*?(?:请在定时任务设置中配置通知通道。）"\n?|the cron system handles result delivery automatically[^\n]*\n?)/g;

const LEGACY_ENGLISH_DEFAULT_SYSTEM_PROMPT_RE = /(?:^|\n)# Style\n- Keep your response language consistent with the user's input language\.[\s\S]*?# Collaboration\n[\s\S]*?- If you change the plan, say so explicitly in the next update\./g;

/**
 * Strip legacy OpenClaw `## Scheduled Tasks` prompt blocks persisted in
 * historical session rows (`cowork_sessions.system_prompt`) and upgrade the
 * verbatim legacy English default prompt to the current default prompt.
 */
export function normalizeCoworkSystemPrompt(
  systemPrompt?: string,
  currentDefaultSystemPrompt?: string,
): string | undefined {
  if (typeof systemPrompt !== 'string') {
    const fallback = currentDefaultSystemPrompt?.trim() || '';
    return fallback || undefined;
  }

  let text = systemPrompt.replace(/\r\n/g, '\n');
  text = text.replace(LEGACY_OPENCLAW_SCHEDULED_TASK_BLOCK_RE, '\n');

  const replacementDefault = currentDefaultSystemPrompt?.trim() || '';
  if (LEGACY_ENGLISH_DEFAULT_SYSTEM_PROMPT_RE.test(text)) {
    LEGACY_ENGLISH_DEFAULT_SYSTEM_PROMPT_RE.lastIndex = 0;
    text = text.replace(
      LEGACY_ENGLISH_DEFAULT_SYSTEM_PROMPT_RE,
      replacementDefault ? `\n${replacementDefault}` : '\n',
    );
  }

  const normalized = text.replace(/\n{3,}/g, '\n\n').trim();
  return normalized.length > 0 ? normalized : undefined;
}
