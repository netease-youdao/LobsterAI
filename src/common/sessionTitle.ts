export const SESSION_TITLE_MAX_CHARS = 50;

export function buildSessionTitleFromInput(
  input: string | null | undefined,
  defaultTitle: string
): string {
  const normalizedInput = typeof input === 'string'
    ? input.replace(/\s+/g, ' ').trim()
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
