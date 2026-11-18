import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, test } from 'vitest';

import { makeSheetFixture, SHEET_FIXTURE_PARTS as PARTS } from '../../../../../tests/fixtures/sheet';
import { analyzeWorkbookStructure } from './sheetStructureSupport';
import { importXlsx } from './xlsxImport';

const OPTIONS = { name: 'fixture.xlsx', univerLocale: 'zhCN', formatLocale: 'zh' as const, maxCells: 100_000, digitWidth: 7 };

/** Whether the fixture reports references across sheets once its Summary!B1 holds `formulaXml` (as written in the part). */
async function threeDimensional(formulaXml: string): Promise<boolean> {
  const summary = strFromU8(unzipSync(await makeSheetFixture())[PARTS.summary]);
  const bytes = await makeSheetFixture({ [PARTS.summary]: summary.replace('<c r="B1"><v>5</v></c>', `<c r="B1"><f>${formulaXml}</f><v>5</v></c>`) });
  return analyzeWorkbookStructure(importXlsx(bytes, OPTIONS).baseline).threeDimensional;
}

describe('workbook structure support', () => {
  test('decodes formula text once before looking for references across sheets', async () => {
    expect(await threeDimensional('SUM(数据:Summary!A1)')).toBe(true);
    // `&amp;quot;` is the text `&quot;` inside the string, not a quote that would swallow the reference.
    expect(await threeDimensional('CONCAT("&amp;quot;",数据:Summary!A1)')).toBe(true);
    expect(await threeDimensional('CONCAT(&quot;数据:Summary!A1&quot;)')).toBe(false);
  });
});
