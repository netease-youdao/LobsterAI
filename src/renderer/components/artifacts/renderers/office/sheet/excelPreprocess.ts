type XlsxModule = typeof import('xlsx');

const CSV_TSV_EXTENSIONS = new Set(['.csv', '.tsv']);

export function getSheetFileName(fileName: string | undefined, filePath: string | undefined): string {
  const source = fileName || filePath || 'spreadsheet.xlsx';
  const withoutQuery = source.split(/[?#]/)[0];
  const lastSlash = Math.max(withoutQuery.lastIndexOf('/'), withoutQuery.lastIndexOf('\\'));
  return lastSlash >= 0 ? withoutQuery.slice(lastSlash + 1) : withoutQuery;
}

export function getExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  return lastDot === -1 ? '' : fileName.slice(lastDot).toLowerCase();
}

export function arrayBufferToFile(data: ArrayBuffer, fileName: string): File {
  return new File([data], fileName, { type: mimeTypeForExtension(getExtension(fileName)) });
}

export async function prepareWorkbookFile(file: File): Promise<File> {
  const ext = getExtension(file.name);
  if (CSV_TSV_EXTENSIONS.has(ext)) return convertDelimitedTextToXlsx(file, ext);

  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (isLegacyXls(header)) return convertXlsToXlsx(file);

  if (ext === '.xlsx') return stripDataValidationsFromXlsx(file);
  return file;
}

export function stripQuotePrefixFromSheets<T extends Array<Record<string, unknown>>>(sheets: T): T {
  for (const sheet of sheets) {
    const celldata = sheet.celldata;
    if (!Array.isArray(celldata)) continue;

    for (const entry of celldata) {
      const cell = entry?.v;
      if (!cell || typeof cell !== 'object') continue;
      const record = cell as { v?: unknown; m?: unknown };
      if (typeof record.v === 'string' && record.v.startsWith('\'')) record.v = record.v.slice(1);
      if (typeof record.m === 'string' && record.m.startsWith('\'')) record.m = record.m.slice(1);
    }
  }
  return sheets;
}

export function sanitizeSheetsForWorkbook<T extends Array<Record<string, unknown>>>(sheets: T): T {
  for (const sheet of sheets) {
    sanitizeSheetForWorkbook(sheet);
    ensureSheetDataMatrix(sheet);
  }
  return sheets;
}

async function convertDelimitedTextToXlsx(file: File, ext: string): Promise<File> {
  const XLSX = await importXlsx();
  const text = await file.text();
  const workbook = XLSX.read(text, {
    type: 'string',
    FS: ext === '.tsv' ? '\t' : undefined,
  });
  return writeWorkbookAsXlsxFile(XLSX, workbook, file.name.replace(/\.(csv|tsv)$/i, '.xlsx'));
}

async function convertXlsToXlsx(file: File): Promise<File> {
  const XLSX = await importXlsx();
  const workbook = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
  return writeWorkbookAsXlsxFile(XLSX, workbook, file.name.replace(/\.xls$/i, '.xlsx'));
}

async function writeWorkbookAsXlsxFile(XLSX: XlsxModule, workbook: ReturnType<XlsxModule['read']>, fileName: string): Promise<File> {
  const xlsxBuffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  return new File([xlsxBuffer], fileName, { type: mimeTypeForExtension('.xlsx') });
}

async function stripDataValidationsFromXlsx(file: File): Promise<File> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  let modified = false;
  const dataValidationRegex = /<dataValidations[\s\S]*?<\/dataValidations>|<x14:dataValidations[\s\S]*?<\/x14:dataValidations>/g;

  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || !/xl\/worksheets\/.*\.xml$/i.test(name)) continue;
    const xml = await entry.async('string');
    dataValidationRegex.lastIndex = 0;
    if (!dataValidationRegex.test(xml)) continue;
    dataValidationRegex.lastIndex = 0;
    zip.file(name, xml.replace(dataValidationRegex, ''));
    modified = true;
  }

  const strikeFalseRegex = /<strike\s+val\s*=\s*"false"\s*\/>/g;
  for (const xmlPath of ['xl/styles.xml', 'xl/sharedStrings.xml']) {
    const entry = zip.file(xmlPath);
    if (!entry) continue;
    const xml = await entry.async('string');
    const cleaned = xml.replace(strikeFalseRegex, '');
    if (cleaned === xml) continue;
    zip.file(xmlPath, cleaned);
    modified = true;
  }

  if (!modified) return file;
  const blob = await zip.generateAsync({ type: 'blob' });
  return new File([blob], file.name, { type: file.type || mimeTypeForExtension('.xlsx') });
}

function sanitizeSheetForWorkbook(sheet: Record<string, unknown>) {
  const { maxRow, maxCol } = deriveMaxRowColFromCelldata(sheet);
  const row = normalizePositiveNumber(sheet.row);
  const column = normalizePositiveNumber(sheet.column);
  sheet.row = normalizePreviewExtent(row, maxRow, 84);
  sheet.column = normalizePreviewExtent(column, maxCol, 60);

  const config = sheet.config;
  if (config && typeof config === 'object') {
    const record = config as Record<string, unknown>;
    const rowlen = sanitizeSizeMap(record.rowlen);
    const columnlen = sanitizeSizeMap(record.columnlen);
    if (rowlen === undefined) delete record.rowlen;
    else record.rowlen = rowlen;
    if (columnlen === undefined) delete record.columnlen;
    else record.columnlen = columnlen;
  }

  const selection = sanitizeSelectionEntries(sheet.luckysheet_select_save);
  if (selection === undefined) delete sheet.luckysheet_select_save;
  else sheet.luckysheet_select_save = selection;
}

function ensureSheetDataMatrix(sheet: Record<string, unknown>) {
  if (hasCellMatrix(sheet.data)) return;

  const celldata = sheet.celldata;
  if (!Array.isArray(celldata) || celldata.length === 0) return;

  const maxRowIndex = Math.max(...celldata.map(entry => normalizeNonNegativeInteger((entry as { r?: unknown })?.r) ?? 0));
  const maxColumnIndex = Math.max(...celldata.map(entry => normalizeNonNegativeInteger((entry as { c?: unknown })?.c) ?? 0));
  const rowCount = Math.max(normalizePositiveInteger(sheet.row) ?? 0, maxRowIndex + 1);
  const columnCount = Math.max(normalizePositiveInteger(sheet.column) ?? 0, maxColumnIndex + 1);

  const data = Array.from({ length: rowCount }, () => Array.from({ length: columnCount }, () => null as unknown));
  for (const entry of celldata) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as { r?: unknown; c?: unknown; v?: unknown };
    const row = normalizeNonNegativeInteger(record.r);
    const column = normalizeNonNegativeInteger(record.c);
    if (row === undefined || column === undefined) continue;
    data[row][column] = record.v ?? null;
  }

  sheet.data = data;
}

function hasCellMatrix(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.some(row => Array.isArray(row) && row.some(cell => cell !== null && cell !== undefined));
}

function deriveMaxRowColFromCelldata(sheet: Record<string, unknown>): { maxRow: number; maxCol: number } {
  let maxRow = 0;
  let maxCol = 0;
  const celldata = sheet.celldata;
  if (!Array.isArray(celldata)) return { maxRow, maxCol };

  for (const entry of celldata) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as { r?: unknown; c?: unknown };
    const row = normalizeNonNegativeInteger(record.r);
    const col = normalizeNonNegativeInteger(record.c);
    if (row !== undefined && row > maxRow) maxRow = row;
    if (col !== undefined && col > maxCol) maxCol = col;
  }
  return { maxRow, maxCol };
}

function sanitizeSizeMap(map: unknown): Record<string, number> | undefined {
  if (!map || typeof map !== 'object') return undefined;
  const sanitized: Record<string, number> = {};
  for (const [key, value] of Object.entries(map)) {
    const keyNum = Number(key);
    const size = normalizePositiveNumber(value);
    if (Number.isInteger(keyNum) && keyNum >= 0 && size !== undefined) sanitized[String(keyNum)] = size;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeSelectionEntries(selection: unknown): unknown[] | undefined {
  if (!Array.isArray(selection)) return undefined;
  const sanitized = selection.filter((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as { row?: unknown; column?: unknown };
    return isValidRange(record.row) && isValidRange(record.column);
  });
  return sanitized.length > 0 ? sanitized : undefined;
}

function isValidRange(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const start = normalizeNonNegativeInteger(value[0]);
  const end = normalizeNonNegativeInteger(value[1]);
  return start !== undefined && end !== undefined && end >= start;
}

function normalizePositiveNumber(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) && num > 0 ? num : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(num) && num > 0 ? num : undefined;
}

function normalizePreviewExtent(value: number | undefined, maxUsedIndex: number, fallback: number): number {
  const contentExtent = maxUsedIndex + 1;
  if (value === undefined) return Math.max(contentExtent, fallback);
  return Math.max(Math.min(Math.floor(value), Math.max(contentExtent + 20, fallback)), contentExtent, fallback);
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(num) && num >= 0 ? num : undefined;
}

function isLegacyXls(header: Uint8Array): boolean {
  return header[0] === 0xd0 && header[1] === 0xcf && header[2] === 0x11 && header[3] === 0xe0;
}

async function importXlsx(): Promise<XlsxModule> {
  return import('xlsx');
}

function mimeTypeForExtension(ext: string): string {
  switch (ext) {
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.xls':
      return 'application/vnd.ms-excel';
    case '.csv':
      return 'text/csv';
    case '.tsv':
      return 'text/tab-separated-values';
    default:
      return 'application/octet-stream';
  }
}
