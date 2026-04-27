import type { CoworkAgentEngine } from '../main/libs/agentEngine/types';

export function buildScheduledTaskEnginePrompt(_engine: CoworkAgentEngine): string {
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
    '',
    '### Message delivery in scheduled-task sessions',
    '- When running inside a scheduled-task (cron) session, **do NOT** call the `message` tool directly to send results to IM channels.',
    '- The cron system handles result delivery automatically based on the task\'s delivery configuration. Calling `message` from a cron session without an associated channel will fail with "Channel is required".',
    '- Instead, output your results as plain text in the session. If the task has a delivery channel configured, the cron system will forward the output automatically.',
    '- If the user\'s prompt asks to "send" or "notify", and you are in a cron session, produce the content as session output rather than calling `message`. Append a note: "（此定时任务未配置 IM 通知通道，结果已保存在执行记录中。如需自动推送，请在定时任务设置中配置通知通道。）"',
  ].join('\n');
}
