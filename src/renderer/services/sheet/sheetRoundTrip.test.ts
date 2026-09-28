import { UniverInstanceType } from '@univerjs/core';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, test } from 'vitest';

import { makeSheetFixture, SHEET_FIXTURE_PARTS as PARTS } from '../../../../tests/fixtures/sheet';
import { createHeadlessSheetUniver } from './sheetUniverEngine';
import { exportXlsx } from './xlsxExport';
import { importXlsx } from './xlsxImport';

const OPTIONS = { name: 'fixture.xlsx', univerLocale: 'zhCN', formatLocale: 'zh' as const, maxCells: 100_000 };

async function open(bytes: Uint8Array) {
  const imported = importXlsx(bytes, OPTIONS);
  const { univer, api } = createHeadlessSheetUniver('zh');
  univer.createUnit(UniverInstanceType.UNIVER_SHEET, imported.data);
  const workbook = api.getActiveWorkbook()!;
  await api.getFormula().onCalculationResultApplied(5000);
  const save = () => exportXlsx({
    baseline: imported.baseline,
    current: workbook.save(),
    resolveFormula: (sheetId, row, column) => workbook.getSheetBySheetId(sheetId)?.getRange(row, column).getFormula() || undefined,
  }, bytes);
  return { univer, api, workbook, save };
}

const unpack = (bytes: Uint8Array) => Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name, value]) => [name, strFromU8(value)]));

describe('spreadsheet round trip through the engine', () => {
  test('an edit recalculates dependents across sheets and saves their results', async () => {
    const bytes = await makeSheetFixture();
    const { univer, api, workbook, save } = await open(bytes);
    try {
      expect(save().changed).toBe(false);
      workbook.getSheetByName('数据')!.getRange('B2').setValue(7);
      await api.getFormula().onCalculationResultApplied(5000);
      const saved = save();
      expect(saved.changed).toBe(true);
      const parts = unpack(saved.bytes);
      expect(parts[PARTS.data]).toContain('<c r="C2" s="4"><f>B2*Rate</f><v>35</v></c>');
      expect(parts[PARTS.data]).toContain('<c r="B6"><f>SUM(B2:B4)</f><v>16</v></c>');
      expect(parts[PARTS.summary]).toContain('<c r="A2"><f>数据!B6*2</f><v>32</v></c>');
      // Untouched members of the shared formula keep their markup.
      expect(parts[PARTS.data]).toContain('<c r="C3" s="4"><f t="shared" ref="C3:C4" si="0">B3*Rate</f><v>20</v></c>');
      const reopened = importXlsx(saved.bytes, OPTIONS).data.sheets['sheet-0'].cellData!;
      expect(reopened[1][1].v).toBe(7);
      expect(reopened[1][2].v).toBe(35);
    } finally {
      univer.dispose();
    }
  });

  test('replacing a shared formula anchor writes the rest of the group as plain formulas', async () => {
    const bytes = await makeSheetFixture();
    const { univer, api, workbook, save } = await open(bytes);
    try {
      const sheet = workbook.getSheetByName('数据')!;
      sheet.getRange('C3').setValue(99);
      sheet.getRange('B4').setValue(6);
      await api.getFormula().onCalculationResultApplied(5000);
      const data = unpack(save().bytes)[PARTS.data];
      expect(data).toContain('<c r="C3" s="4"><v>99</v></c>');
      expect(data).toContain('<c r="C4" s="4"><f>B4*Rate</f><v>30</v></c>');
      expect(data).not.toContain('t="shared"');
    } finally {
      univer.dispose();
    }
  });

  test('formulas saved without results get the computed result on the next save', async () => {
    const sheet = (await import('../../../../tests/fixtures/sheet')).SHEET_FIXTURE_PARTS.summary;
    const bytes = await makeSheetFixture({
      [sheet]: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><f>数据!B2+数据!B3</f></c><c r="B1"><v>5</v></c></row></sheetData></worksheet>',
    });
    const { univer, api, workbook, save } = await open(bytes);
    try {
      // Opening computes the missing result but is not an edit of its own.
      expect(workbook.getSheetByName('Summary')!.getRange('A1').getValue()).toBe(7);
      expect(save().changed).toBe(true);
      workbook.getSheetByName('Summary')!.getRange('C1').setValue('note');
      await api.getFormula().onCalculationResultApplied(5000);
      const summary = unpack(save().bytes)[PARTS.summary];
      expect(summary).toContain('<c r="A1"><f>数据!B2+数据!B3</f><v>7</v></c>');
      expect(summary).toContain('<c r="C1" t="inlineStr"><is><t>note</t></is></c>');
    } finally {
      univer.dispose();
    }
  });

  test('toolbar-style edits on the engine produce derived style records', async () => {
    const bytes = await makeSheetFixture();
    const { univer, workbook, save } = await open(bytes);
    try {
      const sheet = workbook.getSheetByName('数据')!;
      sheet.getRange('A2').setFontWeight('bold');
      sheet.getRange('B2:B3').setBackgroundColor('#ffff00');
      sheet.getRange('A1').setFontWeight('normal');
      const parts = unpack(save().bytes);
      const styles = parts[PARTS.styles];
      const xfs = [...styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)![1].matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map(match => match[0]);
      const recordOf = (reference: string) => xfs[Number(parts[PARTS.data].match(new RegExp(`<c r="${reference}" s="(\\d+)"`))![1])];
      expect(recordOf('B2')).toMatch(/fillId="3"/);
      expect(styles).toContain('<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>');
      expect(recordOf('A1')).toMatch(/fillId="2" borderId="1"/);
      expect(recordOf('A1')).not.toMatch(/fontId="1"/);
    } finally {
      univer.dispose();
    }
  });
});
