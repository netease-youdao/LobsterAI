export interface SearchSnippet {
  snippet: string;
  /** UTF-16 offset of the hit inside `snippet`, or -1 when it was not found. */
  highlightStart: number;
  highlightLength: number;
}

export interface SearchSnippetOptions {
  /** Characters of context kept before the hit. */
  contextBefore?: number;
  /** Maximum characters in the excerpt, ellipses excluded. */
  maxLength?: number;
}

const ELLIPSIS = '…';
const DEFAULT_CONTEXT_BEFORE = 24;
const DEFAULT_MAX_LENGTH = 120;

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

/**
 * Drop Markdown syntax that reads as noise in a one-line excerpt (emphasis,
 * code marks, headings, quotes, bullets, link targets) while keeping the text.
 */
const stripMarkdown = (value: string): string => value
  .replace(/```[\w-]*/g, ' ')
  .replace(/^[ \t]{0,3}(?:#{1,6}|>)[ \t]+/gm, '')
  .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, '')
  .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
  .replace(/\*\*|__|~~|`/g, '');

const toExcerptText = (value: string): string => collapseWhitespace(stripMarkdown(value));

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** Case-insensitive search that falls back to an exact search when lowercasing changes string length. */
const findHit = (text: string, query: string): number => {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerText.length === text.length && lowerQuery.length === query.length) {
    return lowerText.indexOf(lowerQuery);
  }
  return text.indexOf(query);
};

/**
 * Build a single-line excerpt of `content` centred on the first occurrence of
 * `query`, for showing why a task matched in the task search results.
 */
export const buildSearchSnippet = (
  content: string,
  query: string,
  options: SearchSnippetOptions = {},
): SearchSnippet => {
  const contextBefore = options.contextBefore ?? DEFAULT_CONTEXT_BEFORE;
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const text = toExcerptText(content);
  const needle = toExcerptText(query);
  const hit = needle ? findHit(text, needle) : -1;

  if (hit < 0) {
    let end = Math.min(text.length, maxLength);
    if (end < text.length && isLowSurrogate(text.charCodeAt(end))) end -= 1;
    return {
      snippet: end < text.length ? `${text.slice(0, end)}${ELLIPSIS}` : text,
      highlightStart: -1,
      highlightLength: 0,
    };
  }

  let start = Math.max(0, hit - contextBefore);
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start -= 1;
  let end = Math.min(text.length, Math.max(start + maxLength, hit + needle.length));
  if (end < text.length && isLowSurrogate(text.charCodeAt(end))) end += 1;

  const prefix = start > 0 ? ELLIPSIS : '';
  const suffix = end < text.length ? ELLIPSIS : '';
  return {
    snippet: `${prefix}${text.slice(start, end)}${suffix}`,
    highlightStart: prefix.length + hit - start,
    highlightLength: needle.length,
  };
};
