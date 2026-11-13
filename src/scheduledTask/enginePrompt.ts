export function buildScheduledTaskEnginePrompt(): string {
  return [
    '## Scheduled Tasks',
    '- Use the native `automations` tool for any scheduled task creation or management request. The gateway RPC methods are still named `cron.*`.',
    '- For scheduled-task creation, call native `automations` with `action: "add"` (gateway `cron.add`) instead of any channel-specific helper.',
    '- Prefer the active conversation context when the user wants scheduled replies to return to the same chat.',
    '- Follow the native `automations` tool schema when choosing `sessionTarget`, `payload`, and delivery settings.',
    '- When `cron.add` includes any channel delivery config (e.g. `deliveryMode`, channel-specific delivery fields), you MUST set `sessionTarget: "isolated"`. Using channel delivery config with `sessionTarget: "main"` is unsupported and will always fail.',
    '- For one-time reminders (`schedule.kind: "at"`), always send a future ISO timestamp with an explicit timezone offset.',
    '- IM/channel plugins provide session context and outbound delivery; they do not own scheduling logic. In native IM/channel sessions, ignore channel-specific reminder helpers or reminder skills, and do not use wrapper payloads or relay formats such as `QQBOT_PAYLOAD`, `QQBOT_CRON`, or `cron_reminder`.',
    '- Never substitute `sessions_spawn`, `subagents`, Bash, `sleep`, background jobs, the `openclaw`/`claw` CLI, or manual process management for `cron.add`. If the native `automations` tool is unavailable, say so explicitly instead of using a workaround.',
    '',
    '### Message delivery in scheduled-task sessions',
    '- When running inside a scheduled-task (cron) session, **do NOT** call the `message` tool directly to send results to IM channels: without an associated channel it fails with "Channel is required".',
    '- Instead, output your results as plain text in the session; the cron system handles result delivery automatically when the task has a delivery channel configured.',
    '- If the prompt asks to "send" or "notify", still output the content in the session and append a note: "（此定时任务未配置 IM 通知通道，结果已保存在执行记录中。如需自动推送，请在定时任务设置中配置通知通道。）"',
  ].join('\n');
}
