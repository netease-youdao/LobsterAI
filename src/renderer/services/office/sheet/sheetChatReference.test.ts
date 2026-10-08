import { describe, expect, test } from 'vitest';

import { cellsText } from './sheetChatReference';

const labels = { empty: '(empty cells)', moreRows: '… ({count} more rows)' };

describe('cellsText', () => {
  test('writes the cells as tab-separated rows', () => {
    expect(cellsText([['项目', '金额'], ['苹果', '15']], labels)).toBe('项目\t金额\n苹果\t15');
  });

  test('drops empty rows and columns after the content but keeps the ones before it', () => {
    expect(cellsText([['', 'x', ''], ['', '', ''], ['y', '', ''], ['', '', '']], labels)).toBe('\tx\n\ny');
  });

  test('says so when the cells show nothing', () => {
    expect(cellsText([['', ''], ['', '']], labels)).toBe('(empty cells)');
    expect(cellsText([], labels)).toBe('(empty cells)');
  });

  test('keeps each cell on its line', () => {
    expect(cellsText([['a\tb', 'line 1\nline 2']], labels)).toBe('a b\tline 1 line 2');
    expect(cellsText([['x'.repeat(300)]], labels)).toBe(`${'x'.repeat(199)}…`);
  });

  test('stops at a whole row and says how many rows were left out', () => {
    const rows = Array.from({ length: 10 }, (_, index) => [`row ${index}`]);
    expect(cellsText(rows, labels, 10, 20)).toBe('row 0\nrow 1\nrow 2\n… (7 more rows)');
    // Rows past the ones read count too.
    expect(cellsText(rows.slice(0, 2), labels, 50)).toBe('row 0\nrow 1\n… (48 more rows)');
  });
});
