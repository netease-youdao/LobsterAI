import { BorderStyleTypes } from '@univerjs/core';
import { describe, expect, test } from 'vitest';

import { type DrawnTable, resolveTableStyle, tableCellStyle, underCellStyle } from './sheetTableStyles';
import { XlsxStyles } from './xlsxStyles';

// The Office theme: accent 1 is 4472C4.
const THEME = '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="Office">'
  + '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2>'
  + '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>'
  + '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>'
  + '<a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>'
  + '</a:clrScheme></a:themeElements></a:theme>';
const styles = new XlsxStyles(undefined, THEME, 'en');
const OPTIONS = { name: 'TableStyleMedium2', rowStripes: true, columnStripes: false, firstColumn: false, lastColumn: false };
const table = (name: string, options = {}): DrawnTable => ({
  range: { startRow: 0, endRow: 4, startColumn: 0, endColumn: 2 }, headerRow: true, totalRow: true,
  options: { ...OPTIONS, name, ...options }, style: resolveTableStyle(name, styles)!,
});

describe('table styles', () => {
  test('Medium 2 draws Excel\'s blue header, banded rows and light lines', () => {
    const medium = table('TableStyleMedium2');
    expect(tableCellStyle(medium, 0, 1)).toMatchObject({ bg: { rgb: '#4472C4' }, bl: 1, cl: { rgb: '#FFFFFF' } });
    const firstBand = tableCellStyle(medium, 1, 1)!;
    // Excel's own tint rounding lands one step lower (D9E1F2, 8EA9DB), which the eye can't tell apart.
    expect(firstBand.bg).toEqual({ rgb: '#DAE3F3' });
    // Inner horizontal lines, and none at the side of an inner column.
    expect(firstBand.bd?.b).toEqual({ s: BorderStyleTypes.THIN, cl: { rgb: '#8FAADC' } });
    expect(firstBand.bd?.l).toBeUndefined();
    expect(tableCellStyle(medium, 2, 0)!.bg).toBeUndefined();
    expect(tableCellStyle(medium, 2, 0)!.bd?.l).toEqual({ s: BorderStyleTypes.THIN, cl: { rgb: '#8FAADC' } });
    // The total row: bold with a double line above.
    expect(tableCellStyle(medium, 4, 2)).toMatchObject({ bl: 1, bd: { t: { s: BorderStyleTypes.DOUBLE, cl: { rgb: '#4472C4' } } } });
  });

  test('stripes and first/last columns follow the table options', () => {
    const plain = table('TableStyleMedium2', { rowStripes: false, firstColumn: true });
    expect(tableCellStyle(plain, 1, 1)!.bg).toBeUndefined();
    expect(tableCellStyle(plain, 2, 0)).toMatchObject({ bl: 1 });
    const columns = table('TableStyleLight9', { rowStripes: false, columnStripes: true });
    // Light 9: filled header, outlined table, lines around the first column stripe.
    expect(tableCellStyle(columns, 0, 0)).toMatchObject({ bg: { rgb: '#4472C4' } });
    expect(tableCellStyle(columns, 2, 0)!.bd).toMatchObject({ l: { cl: { rgb: '#4472C4' } }, r: { cl: { rgb: '#4472C4' } } });
    expect(resolveTableStyle('TableStyleMedium99', styles)).toBeUndefined();
  });

  test('the cell\'s own formats win over the table style', () => {
    const merged = underCellStyle({ bg: { rgb: '#D9E1F2' }, bl: 1, bd: { b: { s: BorderStyleTypes.THIN, cl: { rgb: '#8EA9DB' } } } }, { bg: { rgb: '#FFFF00' }, bd: { t: { s: BorderStyleTypes.THICK, cl: { rgb: '#000000' } } } });
    expect(merged).toEqual({ bg: { rgb: '#FFFF00' }, bl: 1, bd: { b: { s: BorderStyleTypes.THIN, cl: { rgb: '#8EA9DB' } }, t: { s: BorderStyleTypes.THICK, cl: { rgb: '#000000' } } } });
    // What the cell shares with the Normal style lets the header's white bold text through.
    const header = { bg: { rgb: '#4472C4' }, bl: 1, cl: { rgb: '#FFFFFF' }, bd: { b: { s: BorderStyleTypes.THIN, cl: { rgb: '#8EA9DB' } } } } as const;
    const normal = { ff: 'Calibri', fs: 11, cl: { rgb: '#000000' } };
    expect(underCellStyle(header, { ...normal, bl: 0, bd: { b: { s: BorderStyleTypes.NONE, cl: { rgb: '#000000' } } } }, normal)).toEqual({ ...header, ff: 'Calibri', fs: 11 });
    expect(underCellStyle(header, { ...normal, cl: { rgb: '#FF0000' } }, normal)).toMatchObject({ cl: { rgb: '#FF0000' }, bl: 1 });
  });

  test('styles defined in the workbook resolve from their differential formats', () => {
    const custom = new XlsxStyles('<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dxfs count="2">'
      + '<dxf><font><b/><color rgb="FFFFFFFF"/></font><fill><patternFill patternType="solid"><bgColor rgb="FF7030A0"/></patternFill></fill></dxf>'
      + '<dxf><fill><patternFill patternType="solid"><bgColor rgb="FFE4DFEC"/></patternFill></fill></dxf></dxfs>'
      + '<tableStyles count="1"><tableStyle name="Purple" pivot="0" count="2"><tableStyleElement type="headerRow" dxfId="0"/><tableStyleElement type="firstRowStripe" dxfId="1"/></tableStyle></tableStyles></styleSheet>', THEME, 'en');
    const xml = '<styleSheet><tableStyles count="1"><tableStyle name="Purple" pivot="0" count="2"><tableStyleElement type="headerRow" dxfId="0"/><tableStyleElement type="firstRowStripe" dxfId="1"/></tableStyle></tableStyles></styleSheet>';
    const purple: DrawnTable = { ...table('TableStyleMedium2'), style: resolveTableStyle('Purple', custom, xml)! };
    expect(tableCellStyle(purple, 0, 0)).toMatchObject({ bl: 1, bg: { rgb: '#7030A0' } });
    expect(tableCellStyle(purple, 1, 0)).toMatchObject({ bg: { rgb: '#E4DFEC' } });
  });
});
