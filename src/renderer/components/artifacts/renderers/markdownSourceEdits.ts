import type { ChangeSet } from '@codemirror/state';

export const normalizeMarkdownLineEndings = (content: string): string => content.replace(/\r\n?/g, '\n');

/** Apply editor offsets to the original bytes' text, preserving untouched line endings. */
export function applyMarkdownSourceChanges(content: string, changes: ChangeSet): string {
  const lineEnding = content.match(/\r\n?|\n/)?.[0] ?? '\n';
  let offset = 0;
  let sourceOffset = 0;
  let copiedThrough = 0;
  let result = '';
  const advanceTo = (target: number) => {
    while (offset < target) {
      sourceOffset += content[sourceOffset] === '\r' && content[sourceOffset + 1] === '\n' ? 2 : 1;
      offset++;
    }
    return sourceOffset;
  };
  changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
    const start = advanceTo(from);
    result += content.slice(copiedThrough, start) + inserted.toString().replace(/\n/g, lineEnding);
    copiedThrough = advanceTo(to);
  });
  return result + content.slice(copiedThrough);
}
