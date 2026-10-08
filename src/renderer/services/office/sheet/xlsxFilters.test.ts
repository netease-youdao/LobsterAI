import { ColorKit, DateSystem, excelDateSerial } from '@univerjs/core';
import { describe, expect, test } from 'vitest';

import { DateGrouping, importAutoFilter, modelFilter, pendingFilterValues, rewriteAutoFilter, type SheetFilter } from './xlsxFilters';

const worksheet = (autoFilter: string) => `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/>${autoFilter}<pageMargins/></worksheet>`;
const serial = (year: number, month: number, day: number) => excelDateSerial(new Date(Date.UTC(year, month - 1, day)), DateSystem.Date1900);

describe('filter criteria', () => {
  test('criteria Excel saves with their numbers become conditions; colors resolve through the format', () => {
    const filter = importAutoFilter(worksheet('<autoFilter ref="A1:E9">'
      + '<filterColumn colId="0"><top10 val="3" filterVal="42"/></filterColumn>'
      + '<filterColumn colId="1"><top10 top="0" percent="1" val="10" filterVal="5.5"/></filterColumn>'
      + '<filterColumn colId="2"><dynamicFilter type="aboveAverage" val="54.3"/></filterColumn>'
      + '<filterColumn colId="3"><dynamicFilter type="thisMonth" val="46266" maxVal="46296"/></filterColumn>'
      + '<filterColumn colId="4"><colorFilter dxfId="0"/></filterColumn>'
      + '</autoFilter>'), row => row === 2, id => (id === 0 ? { bg: { rgb: '#FFFF00' } } : undefined))!;
    expect(filter.filterColumns).toEqual([
      { colId: 0, customFilters: { customFilters: [{ operator: 'greaterThanOrEqual', val: 42 }] } },
      { colId: 1, customFilters: { customFilters: [{ operator: 'lessThanOrEqual', val: 5.5 }] } },
      { colId: 2, customFilters: { customFilters: [{ operator: 'greaterThan', val: 54.3 }] } },
      { colId: 3, customFilters: { and: 1, customFilters: [{ operator: 'greaterThanOrEqual', val: 46266 }, { operator: 'lessThan', val: 46296 }] } },
      { colId: 4, colorFilters: { cellFillColors: [new ColorKit('#FFFF00').toRgbString()] } },
    ]);
    expect(filter.cachedFilteredOut).toEqual([2]);
    expect(filter.pending).toBeUndefined();
  });

  test('date groups, months and icon filters wait for the displayed values', () => {
    const filter = importAutoFilter(worksheet('<autoFilter ref="B1:D6">'
      + '<filterColumn colId="0"><filters blank="1"><filter val="n/a"/><dateGroupItem year="2026" month="3" dateTimeGrouping="month"/><dateGroupItem year="2025" dateTimeGrouping="year"/></filters></filterColumn>'
      + '<filterColumn colId="1"><dynamicFilter type="M9"/></filterColumn>'
      + '<filterColumn colId="2"><iconFilter iconSet="3Arrows" iconId="0"/></filterColumn>'
      + '</autoFilter>'), row => row === 3 || row === 5)!;
    expect(filter.filterColumns).toBeUndefined();
    expect(filter.cachedFilteredOut).toEqual([3, 5]);
    expect(filter.pending).toEqual([
      { colId: 1, values: ['n/a'], blank: true, dateGroups: [{ grouping: DateGrouping.Month, year: 2026, month: 3 }, { grouping: DateGrouping.Year, year: 2025 }] },
      { colId: 2, values: [], blank: false, dateGroups: [], month: 9 },
      { colId: 3, values: [], blank: false, dateGroups: [], shown: true },
    ]);
    // The filter model never sees them.
    expect(modelFilter(filter)).not.toHaveProperty('pending');

    const cells: Record<number, { text: string; serial?: number }> = {
      1: { text: '2026/3/4', serial: serial(2026, 3, 4) },
      2: { text: '2026/4/1', serial: serial(2026, 4, 1) },
      3: { text: '2025/9/9', serial: serial(2025, 9, 9) },
      4: { text: 'n/a' },
      5: { text: '' },
    };
    const read = (row: number) => cells[row] ?? { text: '' };
    const [dates, month, icons] = filter.pending!;
    expect(pendingFilterValues(dates, filter, read)).toEqual({ blank: true, filters: ['2026/3/4', '2025/9/9', 'n/a'] });
    expect(pendingFilterValues(month, filter, read)).toEqual({ filters: ['2025/9/9'] });
    // Rows the file shows pass; hidden ones do not.
    expect(pendingFilterValues(icons, filter, read)).toEqual({ filters: ['2026/3/4', '2026/4/1', 'n/a'] });
  });

  test('a rewritten filter keeps the markup of the columns it did not change', () => {
    const xml = worksheet('<autoFilter ref="A1:C9"><filterColumn colId="0"><top10 val="3" filterVal="42"/></filterColumn>'
      + '<filterColumn colId="2"><filters><dateGroupItem year="2026" month="3" dateTimeGrouping="month"/></filters></filterColumn></autoFilter>');
    const loaded: SheetFilter = {
      ref: { startRow: 0, endRow: 8, startColumn: 0, endColumn: 2 },
      filterColumns: [
        { colId: 0, customFilters: { customFilters: [{ operator: 'greaterThanOrEqual', val: 42 }] } },
        { colId: 2, filters: { filters: ['2026/3/4'] } },
      ],
    };
    const edited: SheetFilter = { ...loaded, filterColumns: [loaded.filterColumns![0], { colId: 1, filters: { filters: ['x'] } }, loaded.filterColumns![1]] };
    const next = rewriteAutoFilter(xml, edited, () => 0, loaded);
    expect(next).toContain('<autoFilter ref="A1:C9"><filterColumn colId="0"><top10 val="3" filterVal="42"/></filterColumn>'
      + '<filterColumn colId="1"><filters><filter val="x"/></filters></filterColumn>'
      + '<filterColumn colId="2"><filters><dateGroupItem year="2026" month="3" dateTimeGrouping="month"/></filters></filterColumn></autoFilter>');
    // A changed column is written from the model.
    const changed = rewriteAutoFilter(xml, { ...loaded, filterColumns: [{ colId: 0, customFilters: { customFilters: [{ operator: 'greaterThan', val: 50 }] } }] }, () => 0, loaded);
    expect(changed).toContain('<autoFilter ref="A1:C9"><filterColumn colId="0"><customFilters><customFilter operator="greaterThan" val="50"/></customFilters></filterColumn></autoFilter>');
  });
});
