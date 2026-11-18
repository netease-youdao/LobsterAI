import type { ICellData, IWorksheetData } from '@univerjs/core';
import { describe, expect, test } from 'vitest';

import { hyperlinkChanges, linkCell, workbookLink } from './xlsxHyperlinks';

const linked = (text: string, url: string): ICellData => {
  const cell: ICellData = { v: text, t: 1 };
  linkCell(cell, url, `link-${text}`, { ff: 'Arial' });
  return cell;
};
const sheet = (cells: Record<number, Record<number, ICellData>>): Partial<IWorksheetData> => ({ cellData: cells });

describe('hyperlinks', () => {
  test('links become one-link documents that keep the cell font', () => {
    const cell = linked('Home', 'https://a.example');
    expect(cell.p?.body?.dataStream).toBe('Home\r\n');
    expect(cell.p?.body?.customRanges?.[0]).toMatchObject({ startIndex: 0, endIndex: 3, properties: { url: 'https://a.example' } });
    expect(cell.p?.body?.textRuns).toEqual([{ st: 0, ed: 4, ts: { ff: 'Arial' } }]);
    // Numbers, formulas and multi-line text keep their plain value.
    expect(linkCell({ v: 3 }, 'https://a.example', 'x', {})).toBe(false);
    expect(linkCell({ v: 'a', f: '=B1' }, 'https://a.example', 'x', {})).toBe(false);
    expect(linkCell({ v: 'a\nb', t: 1 }, 'https://a.example', 'x', {})).toBe(false);
  });

  test('places in the workbook resolve to sheet ids', () => {
    const ids = new Map([['明细', 'sheet-1'], ['q1 data', 'sheet-2']]);
    const lookup = (name: string) => ids.get(name.toLowerCase());
    expect(workbookLink('明细!A1', 'sheet-0', lookup)).toBe('#gid=sheet-1&range=A1');
    expect(workbookLink("'Q1 Data'!$B$2:$C$3", 'sheet-0', lookup)).toBe('#gid=sheet-2&range=B2:C3');
    expect(workbookLink('D4', 'sheet-0', lookup)).toBe('#gid=sheet-0&range=D4');
    expect(workbookLink('SalesTotal', 'sheet-0', lookup)).toBeUndefined();
  });

  test('typing over a link keeps it, unlinking drops it, a moved cell takes it along', () => {
    const before = sheet({ 0: { 0: linked('Home', 'https://a.example') }, 1: { 0: linked('Docs', 'https://b.example') }, 2: { 0: linked('Wiki', 'https://c.example') } });
    const unlinked = linked('Wiki', 'https://c.example');
    unlinked.p!.body!.customRanges = [];
    const now = sheet({
      0: { 2: linked('Home', 'https://a.example') },
      1: { 0: { v: 'Manual', t: 1 } },
      2: { 0: unlinked },
    });
    const changes = hyperlinkChanges(before, now)!;
    expect([...changes.dropped].sort()).toEqual(['0:0', '2:0']);
    expect([...changes.written]).toEqual([['0:2', { url: 'https://a.example' }]]);
    expect(hyperlinkChanges(before, before)).toBeUndefined();
  });

  test('a sort that moves links onto other linked cells leaves none behind', () => {
    const before = sheet({ 2: { 2: linked('alice', 'https://a.example') }, 4: { 2: linked('bob', 'https://b.example') } });
    const now = sheet({ 2: { 2: { v: 'carol', t: 1 } }, 3: { 2: linked('bob', 'https://b.example') }, 4: { 2: linked('alice', 'https://a.example') } });
    const changes = hyperlinkChanges(before, now)!;
    expect([...changes.dropped].sort()).toEqual(['2:2', '4:2']);
    expect(new Map(changes.written)).toEqual(new Map([['3:2', { url: 'https://b.example' }], ['4:2', { url: 'https://a.example' }]]));
  });
});
