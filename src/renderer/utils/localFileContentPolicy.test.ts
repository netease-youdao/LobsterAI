import { describe, expect, test } from 'vitest';

import { canCopyLocalFileAsText } from './localFileContentPolicy';

describe('canCopyLocalFileAsText', () => {
  test.each(['notes.txt', 'README.md', 'config.JSON', 'table.csv', 'captions.srt', '.gitignore'])(
    'allows known text file %s',
    (fileName) => expect(canCopyLocalFileAsText(fileName)).toBe(true),
  );

  test.each(['report.pdf', 'document.docx', 'slides.pptx', 'bundle.zip', 'unknown.bin', 'no-extension'])(
    'rejects binary or unknown file %s',
    (fileName) => expect(canCopyLocalFileAsText(fileName)).toBe(false),
  );
});
