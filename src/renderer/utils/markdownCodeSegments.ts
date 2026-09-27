import { parser } from '@lezer/markdown';

const CodeSyntax = new Set(['InlineCode', 'FencedCode', 'CodeBlock']);

export type MarkdownCodeSegment =
  | { kind: 'text'; raw: string; visibleText: string }
  | { kind: 'inline-code'; raw: string; visibleText: string }
  | { kind: 'fenced-code'; raw: string; visibleText: string };

interface MarkdownFenceOpening {
  marker: '`' | '~';
  markerLength: number;
  openingLineEnd: number;
  contentStart: number;
}

interface MarkdownFenceClosing {
  closingLineStart: number;
  segmentEnd: number;
}

interface BacktickRun {
  start: number;
  end: number;
  length: number;
  isEscaped: boolean;
  nextMatchingRunIndex: number | null;
}

const getLineEnd = (content: string, lineStart: number): number => {
  const newlineIndex = content.indexOf('\n', lineStart);
  return newlineIndex < 0 ? content.length : newlineIndex;
};

const getNextLineStart = (content: string, lineEnd: number): number => (
  lineEnd < content.length ? lineEnd + 1 : content.length
);

const getMarkdownFenceOpening = (
  content: string,
  lineStart: number,
): MarkdownFenceOpening | null => {
  const lineEnd = getLineEnd(content, lineStart);
  const line = content.slice(lineStart, lineEnd).replace(/\r$/, '');
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;

  const markerRun = match[2];
  const marker = markerRun[0] as '`' | '~';
  // A CommonMark backtick fence cannot have another backtick in its info
  // string. Tilde fences have no equivalent restriction.
  if (marker === '`' && match[3].includes('`')) return null;

  return {
    marker,
    markerLength: markerRun.length,
    openingLineEnd: lineEnd,
    contentStart: getNextLineStart(content, lineEnd),
  };
};

const getMarkdownFenceClosing = (
  content: string,
  opening: MarkdownFenceOpening,
): MarkdownFenceClosing | null => {
  let lineStart = opening.contentStart;

  while (lineStart < content.length) {
    const lineEnd = getLineEnd(content, lineStart);
    const line = content.slice(lineStart, lineEnd).replace(/\r$/, '');
    const closingMatch = /^( {0,3})(`+|~+)[ \t]*$/.exec(line);
    if (
      closingMatch
      && closingMatch[2][0] === opening.marker
      && closingMatch[2].length >= opening.markerLength
    ) {
      return {
        closingLineStart: lineStart,
        segmentEnd: getNextLineStart(content, lineEnd),
      };
    }
    lineStart = getNextLineStart(content, lineEnd);
  }

  return null;
};

const collectBacktickRuns = (content: string): BacktickRun[] => {
  const runs: BacktickRun[] = [];
  let consecutiveBackslashes = 0;
  let cursor = 0;

  while (cursor < content.length) {
    const char = content[cursor];
    if (char === '\\') {
      consecutiveBackslashes += 1;
      cursor += 1;
      continue;
    }

    if (char !== '`') {
      consecutiveBackslashes = 0;
      cursor += 1;
      continue;
    }

    const start = cursor;
    while (content[cursor] === '`') cursor += 1;
    runs.push({
      start,
      end: cursor,
      length: cursor - start,
      isEscaped: consecutiveBackslashes % 2 === 1,
      nextMatchingRunIndex: null,
    });
    consecutiveBackslashes = 0;
  }

  const nextRunByLength = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    run.nextMatchingRunIndex = nextRunByLength.get(run.length) ?? null;
    nextRunByLength.set(run.length, index);
  }

  return runs;
};

export const normalizeInlineCodeText = (content: string): string => {
  const normalized = content.replace(/\r\n?|\n/g, ' ');
  if (
    normalized.startsWith(' ')
    && normalized.endsWith(' ')
    && /[^ ]/.test(normalized)
  ) {
    return normalized.slice(1, -1);
  }
  return normalized;
};

const appendInlineCodeSegments = (
  content: string,
  output: MarkdownCodeSegment[],
): void => {
  const runs = collectBacktickRuns(content);
  let textStart = 0;
  let runIndex = 0;

  while (runIndex < runs.length) {
    const openingRun = runs[runIndex];
    const closingRunIndex = openingRun.isEscaped
      ? null
      : openingRun.nextMatchingRunIndex;
    if (closingRunIndex === null) {
      runIndex += 1;
      continue;
    }

    if (textStart < openingRun.start) {
      const raw = content.slice(textStart, openingRun.start);
      output.push({ kind: 'text', raw, visibleText: raw });
    }

    const closingRun = runs[closingRunIndex];
    const codeContent = content.slice(openingRun.end, closingRun.start);
    output.push({
      kind: 'inline-code',
      raw: content.slice(openingRun.start, closingRun.end),
      visibleText: normalizeInlineCodeText(codeContent),
    });
    textStart = closingRun.end;
    runIndex = closingRunIndex + 1;
  }

  if (textStart < content.length) {
    const raw = content.slice(textStart);
    output.push({ kind: 'text', raw, visibleText: raw });
  }
};

/**
 * Splits Markdown into ordinary text, inline code spans, and fenced code
 * blocks. Fence and backtick-run scans are both linear, including when many
 * delimiters are unmatched.
 */
export const splitMarkdownCodeSegments = (content: string): MarkdownCodeSegment[] => {
  const segments: MarkdownCodeSegment[] = [];
  let plainTextStart = 0;
  let lineStart = 0;

  while (lineStart < content.length) {
    const opening = getMarkdownFenceOpening(content, lineStart);
    if (!opening) {
      const lineEnd = getLineEnd(content, lineStart);
      lineStart = getNextLineStart(content, lineEnd);
      continue;
    }

    if (plainTextStart < lineStart) {
      appendInlineCodeSegments(content.slice(plainTextStart, lineStart), segments);
    }

    const closing = getMarkdownFenceClosing(content, opening);
    const contentEnd = closing?.closingLineStart ?? content.length;
    const segmentEnd = closing?.segmentEnd ?? content.length;
    segments.push({
      kind: 'fenced-code',
      raw: content.slice(lineStart, segmentEnd),
      visibleText: content.slice(opening.contentStart, contentEnd),
    });
    plainTextStart = segmentEnd;
    lineStart = segmentEnd;
  }

  if (plainTextStart < content.length) {
    appendInlineCodeSegments(content.slice(plainTextStart), segments);
  }

  return segments;
};

export const transformMarkdownTextSegments = (
  content: string,
  transform: (text: string) => string,
): string => {
  // Use Markdown structure here: a line scan cannot distinguish indented code
  // or fences nested in lists/quotes from ordinary prose.
  const result: string[] = [];
  let cursor = 0;
  parser.parse(content).iterate({
    enter(node) {
      if (!CodeSyntax.has(node.name)) return;
      result.push(transform(content.slice(cursor, node.from)), content.slice(node.from, node.to));
      cursor = node.to;
      return false;
    },
  });
  result.push(transform(content.slice(cursor)));
  return result.join('');
};
