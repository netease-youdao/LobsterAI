export const SESSION_TITLE_MAX_CHARS = 50;

const GOAL_START_COMMAND_PREFIX_RE = /^\/goal\s+(?:start|set|create)\s+/i;

export function stripGoalCommandPrefixForDisplay(input: string): string {
  return input.replace(GOAL_START_COMMAND_PREFIX_RE, '');
}

export function buildSessionTitleFromInput(
  input: string | null | undefined,
  defaultTitle: string
): string {
  const normalizedInput = typeof input === 'string'
    ? stripGoalCommandPrefixForDisplay(input).replace(/\s+/g, ' ').trim()
    : '';

  if (!normalizedInput) {
    return defaultTitle;
  }

  const title = Array.from(normalizedInput)
    .slice(0, SESSION_TITLE_MAX_CHARS)
    .join('')
    .trim();
  return title || defaultTitle;
}
