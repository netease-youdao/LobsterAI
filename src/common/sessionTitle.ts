export const SESSION_TITLE_MAX_CHARS = 50;
export const SESSION_TITLE_INPUT_MAX_CHARS = 1_000;

export interface GenerateSessionTitleRequest {
  sessionId: string;
  text: string;
  expectedTitle: string;
}

/** Build from the draft before file paths, images or runtime instructions are attached. */
export function buildSessionTitleInput(
  text: string,
  attachments: ReadonlyArray<{ name: string; isImage?: boolean }> = [],
): string {
  const names = attachments
    .filter(file => !file.isImage && !/\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif|tiff?)$/i.test(file.name))
    .slice(0, 3)
    .map(file => Array.from(file.name.split(/[\\/]/).pop() ?? '').slice(0, 80).join(''))
    .filter(Boolean);
  const input = [stripGoalCommandPrefixForDisplay(text).trim(), ...names].filter(Boolean).join('\n');
  // Stop at the bound without allocating a code-point array for the entire prompt.
  let result = '';
  let count = 0;
  for (const character of input) {
    if (count++ === SESSION_TITLE_INPUT_MAX_CHARS) break;
    result += character;
  }
  return result.trim();
}

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
