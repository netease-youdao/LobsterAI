import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';
import * as XLSX from 'xlsx';

import {
  decodeDelimitedText,
  DelimitedTextEncoding,
  DelimitedTextEncodingError,
  DelimitedTextEncodingSource,
  getDelimitedTextEncoding,
  rememberDelimitedTextEncoding,
} from './delimitedTextEncoding';
import { getSheetPreviewKey, isDelimitedTextFile, readSheetPreview } from './sheetPreview';

const EXPECTED_ROWS = [
  ['商品编号', '商品名称', '数量'],
  ['001023', '有道词典笔', '8'],
  ['004056', '降噪耳机', '12'],
];
const CSV = EXPECTED_ROWS.map(row => row.join(',')).join('\r\n');
// Fixed CP936 bytes, independent of the decoder under test. No encoding package is needed at runtime.
const GBK = Buffer.from('c9ccc6b7b1e0bac52cc9ccc6b7c3fbb3c62ccafdc1bf0d0a3030313032332cd3d0b5c0b4cab5e4b1ca2c380d0a3030343035362cbdb5d4ebb6fabbfa2c3132', 'hex');
const BIG5 = Buffer.from('b0d3ab7ebd73b8b92cb0d3ab7ea657bad92cbcc6b6710d0a3030313032332ca6b3b944b5fca8e5b5a72c38', 'hex');

function decoded(bytes: Uint8Array, selection: DelimitedTextEncoding = DelimitedTextEncoding.Auto) {
  const result = decodeDelimitedText(bytes, selection);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Unexpected decode failure: ${result.error}`);
  return result.decoded;
}

function rows(text: string, fileName = 'products.csv') {
  const workbook = readSheetPreview(XLSX, text, fileName);
  return XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: false });
}

describe('CSV/TSV preview decoding', () => {
  test('the reported GBK and UTF-8 files produce identical 3x3 displayed cells, including leading zeroes', () => {
    const gbk = decoded(GBK);
    const utf8 = decoded(Buffer.from(CSV));
    expect(gbk).toEqual({ text: CSV, encoding: DelimitedTextEncoding.Gb18030, source: DelimitedTextEncodingSource.Fallback });
    expect(utf8).toEqual({ text: CSV, encoding: DelimitedTextEncoding.Utf8, source: DelimitedTextEncodingSource.Utf8 });
    expect(rows(gbk.text)).toEqual(EXPECTED_ROWS);
    expect(rows(utf8.text)).toEqual(EXPECTED_ROWS);
  });

  test.each([
    [DelimitedTextEncoding.Utf8, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(CSV)])],
    [DelimitedTextEncoding.Utf16Le, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(CSV, 'utf16le')])],
    [DelimitedTextEncoding.Utf16Be, Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(CSV, 'utf16le').swap16()])],
  ])('honors a %s BOM and removes it from the first header', (encoding, bytes) => {
    const result = decoded(bytes);
    expect(result).toEqual({ text: CSV, encoding, source: DelimitedTextEncodingSource.Bom });
    expect(rows(result.text)).toEqual(EXPECTED_ROWS);
  });

  test.each(['', 'id,name,count\n001,pen,8', '商品,𠮷😀,�'])('keeps valid UTF-8, including a literal replacement character: %s', text => {
    expect(decoded(new TextEncoder().encode(text))).toEqual({
      text, encoding: DelimitedTextEncoding.Utf8, source: DelimitedTextEncodingSource.Utf8,
    });
  });

  test('supports GB18030 four-byte characters outside GBK', () => {
    expect(decoded(Buffer.from('9534b235', 'hex')).text).toBe('𠮷');
  });

  test('keeps CSV quoting, embedded commas, escaped quotes, newlines and empty cells intact', () => {
    const csv = '编号,商品,备注\r\n001023,"词典,笔","含""引号""\r\n换行"\r\n004056,耳机,';
    const text = decoded(Buffer.from(csv)).text;
    expect(text).toBe(csv);
    // SheetJS already normalizes CRLF inside cells to LF; retain its existing display behavior.
    expect(rows(text)).toEqual([
      ['编号', '商品', '备注'], ['001023', '词典,笔', '含"引号"\n换行'], ['004056', '耳机'],
    ]);
  });

  test('uses the same decoding for TSV and retains its tab delimiter, even with commas in a cell', () => {
    const tsv = '商品\t描述\t数量\n词典笔\t笔,蓝色\t8';
    expect(rows(decoded(Buffer.from(tsv)).text, 'products.TSV')).toEqual([
      ['商品', '描述', '数量'], ['词典笔', '笔,蓝色', '8'],
    ]);
    const gbkTsv = Buffer.from(GBK.map(byte => byte === 0x2c ? 0x09 : byte));
    expect(rows(decoded(gbkTsv).text, 'products.tsv')).toEqual(EXPECTED_ROWS);
  });

  test('reports an ambiguous legacy fallback as inferred, and permits a manual Big5 correction', () => {
    const automatic = decoded(BIG5);
    const manual = decoded(BIG5, DelimitedTextEncoding.Big5);
    expect(automatic.source).toBe(DelimitedTextEncodingSource.Fallback);
    expect(automatic.text).not.toBe(manual.text);
    expect(manual.source).toBe(DelimitedTextEncodingSource.Manual);
    expect(rows(manual.text)).toEqual([['商品編號', '商品名稱', '數量'], ['001023', '有道詞典筆', '8']]);
  });

  test('a manual UTF-8 failure never falls back; choosing GB18030 or Auto recovers from original bytes', () => {
    const before = Uint8Array.from(GBK);
    expect(decodeDelimitedText(GBK, DelimitedTextEncoding.Utf8)).toEqual({ ok: false, error: DelimitedTextEncodingError.Invalid });
    expect(rows(decoded(GBK, DelimitedTextEncoding.Gb18030).text)).toEqual(EXPECTED_ROWS);
    expect(rows(decoded(GBK).text)).toEqual(EXPECTED_ROWS);
    expect(Uint8Array.from(GBK)).toEqual(before);
  });

  test.each([
    [DelimitedTextEncoding.Utf16Le, Buffer.from(CSV, 'utf16le')],
    [DelimitedTextEncoding.Utf16Be, Buffer.from(CSV, 'utf16le').swap16()],
  ])('allows manual %s without a BOM', (encoding, bytes) => {
    expect(rows(decoded(bytes, encoding).text)).toEqual(EXPECTED_ROWS);
  });

  test('does not show BOM-less UTF-16 ASCII as a successful preview full of NULs', () => {
    const bytes = Buffer.from('id,name\n001,pen', 'utf16le');
    expect(decodeDelimitedText(bytes)).toEqual({ ok: false, error: DelimitedTextEncodingError.Invalid });
    expect(decoded(bytes, DelimitedTextEncoding.Utf16Le).text).toBe('id,name\n001,pen');
  });

  test.each([
    [0xc9], // Incomplete GBK/UTF-8 sequence.
    [0xef, 0xbb, 0xbf, 0xc9, 0xcc], // Invalid UTF-8 after BOM; valid GBK must not override it.
    [0xff, 0xfe, 0x41], // Odd-length UTF-16.
    [0xfe, 0xff, 0xd8, 0x00], // Unpaired UTF-16 surrogate.
  ])('rejects malformed/truncated input %j without replacement characters', (...bytes) => {
    expect(decodeDelimitedText(new Uint8Array(bytes))).toEqual({ ok: false, error: DelimitedTextEncodingError.Invalid });
  });

  test.each([[0xff, 0xfe, 0, 0], [0, 0, 0xfe, 0xff]])('does not mistake UTF-32 BOM %j for UTF-16', (...bytes) => {
    expect(decodeDelimitedText(new Uint8Array(bytes))).toEqual({ ok: false, error: DelimitedTextEncodingError.UnsupportedBom });
  });

  test('does not cache detection across content changes', () => {
    expect(decoded(GBK).encoding).toBe(DelimitedTextEncoding.Gb18030);
    expect(decoded(Buffer.from(CSV)).encoding).toBe(DelimitedTextEncoding.Utf8);
    expect(decoded(GBK).encoding).toBe(DelimitedTextEncoding.Gb18030);
  });
});

describe('per-file preview choices', () => {
  test('retains choices across tab remounts without leaking to another path or chat', () => {
    const key = getSheetPreviewKey('chat-a', 'C:\\one\\products.csv', 'artifact-1');
    rememberDelimitedTextEncoding(key, DelimitedTextEncoding.Big5);
    expect(getDelimitedTextEncoding(getSheetPreviewKey('chat-a', 'C:/one/products.csv', 'new-artifact-id'))).toBe(DelimitedTextEncoding.Big5);
    expect(getDelimitedTextEncoding(getSheetPreviewKey('chat-a', 'C:/two/products.csv', 'artifact-2'))).toBe(DelimitedTextEncoding.Auto);
    expect(getDelimitedTextEncoding(getSheetPreviewKey('chat-b', 'C:/one/products.csv', 'artifact-1'))).toBe(DelimitedTextEncoding.Auto);
    rememberDelimitedTextEncoding(key, DelimitedTextEncoding.Auto);
    expect(getDelimitedTextEncoding(key)).toBe(DelimitedTextEncoding.Auto);
  });

  test('uses artifact identity for inline files', () => {
    const key = getSheetPreviewKey('inline', undefined, 'first');
    rememberDelimitedTextEncoding(key, DelimitedTextEncoding.Gb18030);
    expect(getDelimitedTextEncoding(getSheetPreviewKey('inline', undefined, 'second'))).toBe(DelimitedTextEncoding.Auto);
    rememberDelimitedTextEncoding(key, DelimitedTextEncoding.Auto);
  });

  test('normalizes Windows drive/UNC case without merging case-sensitive POSIX files', () => {
    expect(getSheetPreviewKey('chat', 'C:\\Products\\data.csv', 'first'))
      .toBe(getSheetPreviewKey('chat', 'c:/products/DATA.CSV', 'second'));
    expect(getSheetPreviewKey('chat', '\\\\Server\\Share\\data.csv', 'first'))
      .toBe(getSheetPreviewKey('chat', '//server/share/DATA.CSV', 'second'));
    expect(getSheetPreviewKey('chat', '/data/Products.csv', 'first'))
      .not.toBe(getSheetPreviewKey('chat', '/data/products.csv', 'second'));
  });
});

describe('read-only preview boundary', () => {
  test.each(['xlsx', 'biff8'] as const)('preserves the binary %s workbook preview path', bookType => {
    const original = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(original, XLSX.utils.aoa_to_sheet(EXPECTED_ROWS), 'Products');
    const bytes: ArrayBuffer = XLSX.write(original, { bookType, type: 'array' });
    const before = new Uint8Array(bytes).slice();
    const fileName = bookType === 'xlsx' ? 'products.xlsx' : 'products.xls';
    expect(isDelimitedTextFile(fileName)).toBe(false);
    const workbook = readSheetPreview(XLSX, bytes, fileName);
    expect(XLSX.utils.sheet_to_json(workbook.Sheets.Products, { header: 1, raw: false })).toEqual(EXPECTED_ROWS);
    expect(new Uint8Array(bytes)).toEqual(before);
  });

  test('opening, changing encoding and revisiting actual CSV fixtures leave their bytes and mtime unchanged', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'lobster-csv-preview-'));
    const files = [path.join(directory, 'products-gbk.csv'), path.join(directory, 'products-utf8.csv')];
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    try {
      await writeFile(files[0], GBK);
      await writeFile(files[1], CSV, 'utf8');
      const before = await Promise.all(files.map(async file => ({ hash: hash(await readFile(file)), mtime: (await stat(file)).mtimeMs })));
      for (const index of [0, 1, 0]) {
        const bytes = await readFile(files[index]);
        const originalHash = hash(bytes);
        expect(rows(decoded(bytes).text)).toEqual(EXPECTED_ROWS);
        const manual = index === 0 ? DelimitedTextEncoding.Gb18030 : DelimitedTextEncoding.Utf8;
        expect(rows(decoded(bytes, manual).text)).toEqual(EXPECTED_ROWS);
        decodeDelimitedText(bytes, DelimitedTextEncoding.Utf8);
        expect(hash(bytes)).toBe(originalHash);
      }
      const after = await Promise.all(files.map(async file => ({ hash: hash(await readFile(file)), mtime: (await stat(file)).mtimeMs })));
      expect(after).toEqual(before);
    } finally {
      await Promise.all(files.map(file => unlink(file).catch(() => {})));
      await rmdir(directory);
    }
  });
});
