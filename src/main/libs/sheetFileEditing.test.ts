import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { makeSheetFixture, SHEET_FIXTURE_PARTS as PARTS } from '../../../tests/fixtures/sheet';
import { OfficeFileError, type OfficeOpenResult, type OfficeResult } from '../../shared/artifactPreview/officeEditing';
import { SHEET_PACKAGE_LIMITS, type SheetPackageInfo, SheetReadOnlyReason } from '../../shared/artifactPreview/sheetEditing';
import { OfficeFileStore } from './officeFileStore';
import { OfficePackageException } from './officeZip';
import { inspectSheetPackage } from './sheetPackage';

const unwrap = <T>(result: OfficeResult<T>): T => {
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(result.code);
  return result.value;
};
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
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

describe('workbook file store', () => {
  let directory: string;
  let filePath: string;
  let store: OfficeFileStore<SheetPackageInfo>;
  let opened: OfficeOpenResult<SheetPackageInfo>;
  const request = async (bytes: Uint8Array, revision: number, baseVersion = opened.version) => ({ sessionId: opened.sessionId, bytes, baseVersion, revision });
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lobster-sheet-test-'));
    filePath = path.join(directory, '报表.xlsx');
    await fs.writeFile(filePath, await makeSheetFixture());
    store = new OfficeFileStore({ extension: '.xlsx', maxFileBytes: SHEET_PACKAGE_LIMITS.maxFileBytes, inspect: inspectSheetPackage, logTag: '[SheetFiles]' }, path.join(directory, 'drafts'));
    opened = unwrap(await store.open(1, filePath));
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  test('opening is read only and scoped to the owner', async () => {
    const before = await fs.readFile(filePath);
    expect(opened.version).toBe(hash(before));
    expect(opened.hidden).toEqual([]);
    expect((await store.read(2, opened.sessionId)).success).toBe(false);
    expect((await store.open(1, path.join(directory, 'report.docx'))).success).toBe(false);
    expect(hash(await fs.readFile(filePath))).toBe(hash(before));
  });

  test('saves after a durable checkpoint, keeps the original once and detects external changes', async () => {
    const edited = await withPart(PARTS.custom, '<custom xmlns="urn:lobster:test">edited</custom>');
    unwrap(await store.checkpoint(1, await request(edited, 1)));
    const receipt = unwrap(await store.save(1, await request(edited, 1)));
    expect(receipt.version).toBe(hash(edited));
    expect(hash(await fs.readFile(filePath))).toBe(hash(edited));
    expect(receipt.originalCopyPath && hash(await fs.readFile(receipt.originalCopyPath))).toBe(opened.version);
    // A stale base version means someone else wrote the file; the draft is kept.
    await fs.writeFile(filePath, await withPart(PARTS.custom, '<custom xmlns="urn:lobster:test">external</custom>'));
    const conflict = await store.save(1, await request(await withPart(PARTS.custom, '<custom xmlns="urn:lobster:test">mine</custom>'), 2, receipt.version));
    expect(conflict).toEqual({ success: false, code: OfficeFileError.Conflict });
    const reopened = unwrap(await store.open(1, filePath));
    expect(reopened.recovery?.revision).toBe(2);
    unwrap(await store.discardDraft(1, opened.sessionId));
    expect(unwrap(await store.open(1, filePath)).recovery).toBeUndefined();
  });

  test('refuses writes to read-only workbooks and snapshots that would become read only', async () => {
    const pivot = await withPart('xl/pivotTables/pivotTable1.xml', '<pivotTableDefinition/>');
    expect(await store.save(1, await request(pivot, 1))).toEqual({ success: false, code: OfficeFileError.Forbidden });
    await fs.writeFile(filePath, pivot);
    const locked = unwrap(await store.read(1, opened.sessionId));
    expect(locked.readOnly).toEqual([SheetReadOnlyReason.PivotTables]);
    expect(await store.save(1, { ...(await request(await makeSheetFixture(), 1)), baseVersion: locked.version })).toEqual({ success: false, code: OfficeFileError.Forbidden });
  });
});
