export interface MentionQuery {
  start: number;
  end: number;
  query: string;
}

const MENTION_TOKEN_CHARACTER_PATTERN = /[A-Za-z0-9._-]/;
const INVALID_MENTION_QUERY_CHARACTER_PATTERN = /[\s@()[\]{}<>,"'`]/;

const isMentionTokenCharacter = (value?: string): boolean => {
  return !!value && MENTION_TOKEN_CHARACTER_PATTERN.test(value);
};

export const hasMentionBoundaryBefore = (value: string, atIndex: number): boolean => {
  return atIndex === 0 || !isMentionTokenCharacter(value[atIndex - 1]);
};

export const hasMentionBoundaryAfter = (value: string, endIndex: number): boolean => {
  return endIndex >= value.length || !isMentionTokenCharacter(value[endIndex]);
};

export const parseMentionQuery = (value: string, caretPosition: number): MentionQuery | null => {
  if (caretPosition < 0) {
    return null;
  }

  const atIndex = value.lastIndexOf('@', Math.max(0, caretPosition - 1));
  if (atIndex === -1 || !hasMentionBoundaryBefore(value, atIndex)) {
    return null;
  }

  const query = value.slice(atIndex + 1, caretPosition);
  if (INVALID_MENTION_QUERY_CHARACTER_PATTERN.test(query)) {
    return null;
  }

  return {
    start: atIndex,
    end: caretPosition,
    query,
  };
};

export const extractMentionTokens = (value: string): string[] => {
  const tokens = new Set<string>();
  const pattern = /@([A-Za-z0-9._-]+)/g;
  let match: RegExpExecArray | null = pattern.exec(value);

  while (match) {
    const fullMatch = match[0];
    const mentionToken = match[1];
    const atIndex = match.index;
    const endIndex = atIndex + fullMatch.length;

    if (hasMentionBoundaryBefore(value, atIndex) && hasMentionBoundaryAfter(value, endIndex)) {
      tokens.add(mentionToken);
    }

    match = pattern.exec(value);
  }

  return Array.from(tokens);
};

export const isMentionTokenUsed = (value: string, mentionToken: string): boolean => {
  const escapedMentionToken = mentionToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[^A-Za-z0-9._-])@${escapedMentionToken}(?=$|[^A-Za-z0-9._-])`);
  return pattern.test(value);
};
