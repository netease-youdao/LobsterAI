import type { CoworkAgentEngine } from '../main/libs/agentEngine/types';

export const SCHEDULED_TASK_SWITCH_MESSAGE =
  'Scheduled tasks are only available in OpenClaw. Switch the agent engine to OpenClaw and try again.';

export function buildScheduledTaskEnginePrompt(engine: CoworkAgentEngine): string {
  if (engine === 'openclaw') {
    return [
      '## Scheduled Tasks',
      '- Use the native `cron` tool for any scheduled task creation or management request.',
      '- For scheduled-task creation, call native `cron` with `action: "add"` / `cron.add` instead of any channel-specific helper.',
      '- Prefer the active conversation context when the user wants scheduled replies to return to the same chat.',
      '- Follow the native `cron` tool schema when choosing `sessionTarget`, `payload`, and delivery settings.',
      '- When `cron.add` includes any channel delivery config (e.g. `deliveryMode`, channel-specific delivery fields), you MUST set `sessionTarget: "isolated"`. Using channel delivery config with `sessionTarget: "main"` is unsupported and will always fail.',
      '- For one-time reminders (`schedule.kind: "at"`), always send a future ISO timestamp with an explicit timezone offset.',
      '- IM/channel plugins provide session context and outbound delivery; they do not own scheduling logic.',
      '- In native IM/channel sessions, ignore channel-specific reminder helpers or reminder skills and call native `cron` directly.',
      '- Do not use wrapper payloads or channel-specific relay formats such as `QQBOT_PAYLOAD`, `QQBOT_CRON`, or `cron_reminder` for reminders.',
      '- Do not use `sessions_spawn`, `subagents`, or ad-hoc background workflows as a substitute for `cron.add`.',
      '- Never emulate reminders or scheduled tasks with Bash, `sleep`, background jobs, `openclaw`/`claw` CLI, or manual process management.',
      '- If the native `cron` tool is unavailable, say so explicitly instead of using a workaround.',
    ].join('\n');
  }

  return [
    '## Scheduled Tasks',
    `- ${SCHEDULED_TASK_SWITCH_MESSAGE}`,
    '- Do not attempt to create, update, list, enable, disable, or delete scheduled tasks in this engine.',
  ].join('\n');
}
