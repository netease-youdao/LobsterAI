import type { Tree } from '@lezer/common';
import { highlightTree } from '@lezer/highlight';

import { HighlightStatus, MAX_HIGHLIGHT_BYTES, MAX_HIGHLIGHT_CACHE_BYTES, MAX_HIGHLIGHT_CACHE_ENTRIES } from './constants';
import { loadCodeLanguage, prepareFencedLanguages, resolveCodeLanguage } from './language';
import { codeHighlighter } from './style';

export interface CodeToken { from: number; to: number; className: string }
export interface HighlightLine { number: number; tokens: CodeToken[] }
export interface HighlightRequest {
  id: number; identity: string; language?: string; path?: string; source: string; lines: number[];
}
export interface HighlightResponse { id: number; identity: string; status: HighlightStatus; lines: HighlightLine[] }
interface ParsedSource { source: string; tree: Tree; starts: number[]; ends: number[]; size: number }

/** Offsets remain in the original UTF-16 document. CRLF consumes two offsets but no visible CR. */
export function sourceLineOffsets(source: string): { starts: number[]; ends: number[] } {
  const starts = [0]; const ends: number[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) !== 10) continue;
    ends.push(index > 0 && source.charCodeAt(index - 1) === 13 ? index - 1 : index);
    starts.push(index + 1);
  }
  ends.push(source.length);
  return { starts, ends };
}

/** The cache stores full parse trees, not concatenated hunks or partial parse contexts. */
export class CodeTokenizer {
  private cache = new Map<string, ParsedSource>();
  private size = 0;
  constructor(private maxEntries = MAX_HIGHLIGHT_CACHE_ENTRIES, private maxBytes = MAX_HIGHLIGHT_CACHE_BYTES) {}
  get cacheEntries() { return this.cache.size; }
  get cacheBytes() { return this.size; }

  async highlight(request: HighlightRequest): Promise<HighlightResponse> {
    const response = (status: HighlightStatus, lines: HighlightLine[] = []): HighlightResponse => ({ id: request.id, identity: request.identity, status, lines });
    const size = new TextEncoder().encode(request.source).byteLength;
    if (size > MAX_HIGHLIGHT_BYTES) return response(HighlightStatus.TooLarge);
    if (request.source.includes('\0')) return response(HighlightStatus.Unavailable);
    const numbers = [...new Set(request.lines)].filter(line => Number.isInteger(line) && line > 0).sort((a, b) => a - b).slice(0);
    if (!numbers.length) return response(HighlightStatus.Ready);
    const language = resolveCodeLanguage(request.language, request.path);
    if (!language) return response(HighlightStatus.Unknown);
    const key = JSON.stringify([request.identity, language.name]);
    let parsed = this.cache.get(key);
    if (parsed?.source !== request.source) parsed = undefined;
    try {
      if (!parsed) {
        const support = await loadCodeLanguage(language);
        if (language.name === 'Markdown') await prepareFencedLanguages(request.source);
        // Each side is parsed from byte zero through EOF, including context outside all visible hunks.
        const tree = support.language.parser.parse(request.source);
        parsed = { source: request.source, tree, ...sourceLineOffsets(request.source), size: Math.max(size, request.source.length * 2) };
      }
      const previous = this.cache.get(key);
      if (previous) { this.cache.delete(key); this.size -= previous.size; }
      this.cache.set(key, parsed); this.size += parsed.size;
      while (this.cache.size > this.maxEntries || this.size > this.maxBytes) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.size -= this.cache.get(oldest)!.size; this.cache.delete(oldest);
      }
      const { tree, starts, ends } = parsed;
      const lines = numbers.filter(number => number <= starts.length).map(number => ({ number, tokens: [] as CodeToken[] }));
      // Range-limited tree traversal emits only the requested visible lines. Adjacent lines share a traversal.
      for (let first = 0; first < lines.length;) {
        let last = first;
        while (last + 1 < lines.length && lines[last + 1].number === lines[last].number + 1) last += 1;
        let cursor = first;
        highlightTree(tree, codeHighlighter, (from, to, className) => {
          while (cursor <= last && ends[lines[cursor].number - 1] <= from) cursor += 1;
          for (let index = cursor; index <= last && starts[lines[index].number - 1] < to; index += 1) {
            const line = lines[index]; const start = starts[line.number - 1]; const end = ends[line.number - 1];
            if (Math.min(to, end) > Math.max(from, start)) line.tokens.push({ from: Math.max(from, start) - start, to: Math.min(to, end) - start, className });
          }
        }, starts[lines[first].number - 1], ends[lines[last].number - 1]);
        first = last + 1;
      }
      return response(HighlightStatus.Ready, lines);
    } catch { return response(HighlightStatus.Unavailable); }
  }
}
