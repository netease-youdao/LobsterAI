import JSZip from 'jszip';
import { describe, expect, test } from 'vitest';

import { makeSheetFixture, SHEET_FIXTURE_PARTS as PARTS } from '../../../../tests/fixtures/sheet';
import { OfficeFileError } from '../../../shared/office/core/officeFile';
import { SheetReadOnlyReason } from '../../../shared/office/sheet/sheetFile';
import type { OfficePackageException } from '../core/officeZip';
import { inspectSheetPackage } from './sheetPackage';

const codeOf = (operation: () => unknown) => {
  try { operation(); } catch (error) { return (error as OfficePackageException).code; }
  return undefined;
};

async function withPart(name: string, contents: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await makeSheetFixture());
  zip.file(name, contents);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

describe('workbook admission', () => {
  test('classifies what is kept but not shown', async () => {
    const info = inspectSheetPackage(await makeSheetFixture());
    expect(info.readOnly).toEqual([]);
    expect(info.hidden).toEqual([]);
  });

  test('opens pivot tables, array formulas, protection and external links read only', async () => {
    expect(inspectSheetPackage(await withPart('xl/pivotTables/pivotTable1.xml', '<pivotTableDefinition/>')).readOnly).toEqual([SheetReadOnlyReason.PivotTables]);
    expect(inspectSheetPackage(await withPart('xl/externalLinks/externalLink1.xml', '<externalLink/>')).readOnly).toEqual([SheetReadOnlyReason.ExternalLinks]);
    const summary = await (await JSZip.loadAsync(await makeSheetFixture())).file(PARTS.summary)!.async('string');
    const withProtection = summary.replace('</sheetData>', '</sheetData><sheetProtection sheet="1" objects="1"/>');
    expect(inspectSheetPackage(await withPart(PARTS.summary, withProtection)).readOnly).toEqual([SheetReadOnlyReason.Protection]);
    const withArray = summary.replace('<c r="B1"><v>5</v></c>', '<c r="B1"><f t="array" ref="B1:B2">A1:A2</f><v>5</v></c>');
    expect(inspectSheetPackage(await withPart(PARTS.summary, withArray)).readOnly).toEqual([SheetReadOnlyReason.ArrayFormulas]);
    const withDynamic = summary.replace('<c r="B1">', '<c r="B1" cm="1">');
    expect(inspectSheetPackage(await withPart(PARTS.summary, withDynamic)).readOnly).toEqual([SheetReadOnlyReason.ArrayFormulas]);
  });

  test('refuses malformed, entity-bearing, encrypted, strict and non-spreadsheet packages', async () => {
    expect(codeOf(() => inspectSheetPackage(new TextEncoder().encode('not a zip')))).toBe(OfficeFileError.InvalidFile);
    const encrypted = new Uint8Array(512);
    encrypted.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(codeOf(() => inspectSheetPackage(encrypted))).toBe(OfficeFileError.Unsupported);
    const withEntity = await withPart(PARTS.strings, '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><sst/>');
    expect(codeOf(() => inspectSheetPackage(withEntity))).toBe(OfficeFileError.Unsupported);
    const zip = await JSZip.loadAsync(await makeSheetFixture());
    const workbook = await zip.file(PARTS.workbook)!.async('string');
    zip.file(PARTS.workbook, workbook.replace('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main'));
    const strict = await zip.generateAsync({ type: 'uint8array' });
    expect(codeOf(() => inspectSheetPackage(strict))).toBe(OfficeFileError.Unsupported);
    const notSheet = await JSZip.loadAsync(await makeSheetFixture());
    notSheet.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    const notSheetBytes = await notSheet.generateAsync({ type: 'uint8array' });
    expect(codeOf(() => inspectSheetPackage(notSheetBytes))).toBe(OfficeFileError.InvalidFile);
  });
});
