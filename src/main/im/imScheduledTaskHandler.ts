import {
  parseLegacyScheduledReminderSystemMessage,
  parseScheduledReminderPrompt,
  parseSimpleScheduledReminderText,
} from '../../scheduledTask/reminderText';

export function isReminderSystemTurn(messages: Array<{ type: string; content: string }>): boolean {
  return messages.some((message) => {
    const content = typeof message.content === 'string' ? message.content : '';
    // Only consider user and system messages — tool_use/tool_result/assistant
    // messages may contain reminder text from cron.add payloads which would
    // cause false positives on user-initiated task creation turns.
    if (message.type !== 'user' && message.type !== 'system') {
      return false;
    }
    if (message.type === 'system') {
      return parseSimpleScheduledReminderText(content) !== null
        || parseLegacyScheduledReminderSystemMessage(content) !== null;
    }
    return parseScheduledReminderPrompt(content) !== null
      || parseSimpleScheduledReminderText(content) !== null;
  });
}
