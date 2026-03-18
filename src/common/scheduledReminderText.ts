export type ScheduledReminderPrompt = {
  reminderText: string;
  currentTime?: string;
};

const SCHEDULED_REMINDER_PREFIX = 'A scheduled reminder has been triggered. The reminder content is:';
const SCHEDULED_REMINDER_INTERNAL_INSTRUCTION = 'Handle this reminder internally. Do not relay it to the user unless explicitly requested.';
const SCHEDULED_REMINDER_RELAY_INSTRUCTION = 'Please relay this reminder to the user in a helpful and friendly way.';
const CURRENT_TIME_PREFIX = 'Current time:';
const LEGACY_SYSTEM_LINE_RE = /^System:\s*(?:\[(.+?)\]\s*)?(⏰.+)$/u;
const SIMPLE_REMINDER_RE = /^⏰(?:\s|$)/u;

export function parseScheduledReminderPrompt(text: string): ScheduledReminderPrompt | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(SCHEDULED_REMINDER_PREFIX)) {
    return null;
  }

  let remainder = trimmed.slice(SCHEDULED_REMINDER_PREFIX.length).trim();
  let currentTime: string | undefined;
  const currentTimeIndex = remainder.lastIndexOf(CURRENT_TIME_PREFIX);
  if (currentTimeIndex >= 0) {
    currentTime = remainder.slice(currentTimeIndex + CURRENT_TIME_PREFIX.length).trim() || undefined;
    remainder = remainder.slice(0, currentTimeIndex).trim();
  }

  if (remainder.endsWith(SCHEDULED_REMINDER_INTERNAL_INSTRUCTION)) {
    remainder = remainder.slice(0, -SCHEDULED_REMINDER_INTERNAL_INSTRUCTION.length).trim();
  } else if (remainder.endsWith(SCHEDULED_REMINDER_RELAY_INSTRUCTION)) {
    remainder = remainder.slice(0, -SCHEDULED_REMINDER_RELAY_INSTRUCTION.length).trim();
  }

  if (!remainder) {
    return null;
  }

  return {
    reminderText: remainder,
    ...(currentTime ? { currentTime } : {}),
  };
}

export function parseLegacyScheduledReminderSystemMessage(text: string): ScheduledReminderPrompt | null {
  const trimmed = text.trim();
  const firstLine = trimmed.split(/\r?\n/u, 1)[0]?.trim() ?? '';
  const match = firstLine.match(LEGACY_SYSTEM_LINE_RE);
  if (!match) {
    return null;
  }

  const rest = trimmed.slice(firstLine.length).trim();
  const wrappedPrompt = rest ? parseScheduledReminderPrompt(rest) : null;

  return wrappedPrompt ?? {
    reminderText: match[2].trim(),
    ...(match[1]?.trim() ? { currentTime: match[1].trim() } : {}),
  };
}

export function isSimpleScheduledReminderText(text: string): boolean {
  return SIMPLE_REMINDER_RE.test(text.trim());
}

export function parseSimpleScheduledReminderText(text: string): ScheduledReminderPrompt | null {
  const trimmed = text.trim();
  if (!isSimpleScheduledReminderText(trimmed)) {
    return null;
  }

  return {
    reminderText: trimmed,
  };
}

export function getScheduledReminderDisplayText(text: string): string | null {
  const prompt = parseScheduledReminderPrompt(text);
  if (prompt) {
    return prompt.reminderText;
  }

  const legacy = parseLegacyScheduledReminderSystemMessage(text);
  if (legacy) {
    return legacy.reminderText;
  }

  const simple = parseSimpleScheduledReminderText(text);
  if (simple) {
    return simple.reminderText;
  }

  return null;
}
