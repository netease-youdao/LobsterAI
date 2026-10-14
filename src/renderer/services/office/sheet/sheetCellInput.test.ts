import type { ICellData, ITextRun } from '@univerjs/core';
import { describe, expect, test } from 'vitest';

import { plainTypedCell } from './sheetCellInput';

const DEFAULT = '#1B1C1F';
const typed = (dataStream: string, textRuns: ITextRun[], extra: Record<string, unknown> = {}): ICellData => ({
  p: { id: 'd', documentStyle: {}, body: { dataStream, textRuns, paragraphs: [{ startIndex: dataStream.length - 2, paragraphId: 'p1' }], ...extra } },
  v: null,
});

describe('plainTypedCell', () => {
  test('text typed into a cell\'s own text stays a plain value', () => {
    const cell = typed('已完成zz\r\n', [{ st: 3, ed: 5, ts: { cl: { rgb: DEFAULT } } }]);
    expect(plainTypedCell(cell, DEFAULT)).toEqual({ p: null, v: '已完成zz', f: null, si: null });
  });

  test('the default color matches whatever its case', () => {
    expect(plainTypedCell(typed('ab\r\n', [{ st: 1, ed: 2, ts: { cl: { rgb: '#1b1c1f' } } }]), DEFAULT)?.v).toBe('ab');
  });

  test('other formatting keeps the rich text, without the default color', () => {
    const cell = typed('abc\r\n', [{ st: 0, ed: 1, ts: { bl: 1 } }, { st: 1, ed: 3, ts: { cl: { rgb: DEFAULT }, it: 1 } }]);
    expect(plainTypedCell(cell, DEFAULT)?.p?.body?.textRuns).toEqual([{ st: 0, ed: 1, ts: { bl: 1 } }, { st: 1, ed: 3, ts: { it: 1 } }]);
  });

  test('a color the user picked stays', () => {
    const cell = typed('abc\r\n', [{ st: 1, ed: 3, ts: { cl: { rgb: '#FF0000' } } }]);
    expect(plainTypedCell(cell, DEFAULT)).toBe(cell);
  });

  test('line breaks and links keep the document', () => {
    const lines: ICellData = {
      p: { id: 'd', documentStyle: {}, body: { dataStream: 'a\rb\r\n', textRuns: [{ st: 2, ed: 3, ts: { cl: { rgb: DEFAULT } } }], paragraphs: [{ startIndex: 1, paragraphId: 'p1' }, { startIndex: 3, paragraphId: 'p2' }] } },
    };
    expect(plainTypedCell(lines, DEFAULT)?.p?.body?.textRuns).toEqual([]);
    const link = typed('see\r\n', [{ st: 0, ed: 3, ts: { cl: { rgb: DEFAULT } } }], { customRanges: [{ startIndex: 0, endIndex: 2, rangeId: 'l', rangeType: 0 }] });
    expect(plainTypedCell(link, DEFAULT)?.p).toBeTruthy();
  });

  test('cells without typed rich text pass through', () => {
    const plain: ICellData = { v: 12 };
    expect(plainTypedCell(plain, DEFAULT)).toBe(plain);
    expect(plainTypedCell(null, DEFAULT)).toBeNull();
  });
});
