import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { computeWordLineMetrics, WORD_CJK_LINE_HEIGHT_FACTOR } from '../../../shared/artifactPreview/wordFonts';
import { bufferSource, extractFace, readFontFaces, readTableDirectory } from './sfnt';

const fontsRoot = path.resolve(__dirname, '../../../renderer/assets/word-fonts');
const readFont = (name: string): Buffer => fs.readFileSync(path.join(fontsRoot, name));

function checksum(bytes: Buffer): number {
  let sum = 0;
  for (let at = 0; at + 4 <= bytes.length; at += 4) sum = (sum + bytes.readUInt32BE(at)) >>> 0;
  return sum;
}

/** A collection whose faces share nothing: enough to prove face selection and extraction. */
async function makeCollection(fonts: Buffer[]): Promise<Buffer> {
  const directories = await Promise.all(fonts.map(font => readTableDirectory(bufferSource(font), 0)));
  const headerLength = 12 + fonts.length * 4;
  let cursor = headerLength + directories.reduce((sum, directory) => sum + 12 + directory.tables.length * 16, 0);
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(headerLength);
  header.write('ttcf', 0, 'latin1');
  header.writeUInt16BE(1, 4);
  header.writeUInt32BE(fonts.length, 8);
  let directoryOffset = headerLength;
  const tableChunks: Buffer[] = [];
  for (const [index, directory] of directories.entries()) {
    header.writeUInt32BE(directoryOffset, 12 + index * 4);
    const block = Buffer.alloc(12 + directory.tables.length * 16);
    block.writeUInt32BE(directory.version, 0);
    block.writeUInt16BE(directory.tables.length, 4);
    for (const [tableIndex, record] of directory.tables.entries()) {
      const at = 12 + tableIndex * 16;
      block.write(record.tag, at, 'latin1');
      block.writeUInt32BE(record.checksum, at + 4);
      block.writeUInt32BE(cursor, at + 8);
      block.writeUInt32BE(record.length, at + 12);
      const data = fonts[index].subarray(record.offset, record.offset + record.length);
      const padded = Buffer.alloc((record.length + 3) & ~3);
      data.copy(padded);
      tableChunks.push(padded);
      cursor += padded.length;
    }
    chunks.push(block);
    directoryOffset += block.length;
  }
  return Buffer.concat([header, ...chunks, ...tableChunks]);
}

describe('sfnt reader', () => {
  test('reads family, style and Windows metrics from a TrueType font', async () => {
    const [face] = await readFontFaces(bufferSource(readFont('Carlito-BoldItalic.ttf')));
    expect(face.families).toContain('Carlito');
    expect(face.weight).toBe(700);
    expect(face.italic).toBe(true);
    expect(face.metrics.unitsPerEm).toBe(2048);
    const line = computeWordLineMetrics(face.metrics)!;
    // Carlito keeps Calibri's Windows line box: 1.22 em.
    expect(line.heightEm).toBeCloseTo(1.2207, 3);
  });

  test('reads a CFF-flavoured CJK font and applies Word\'s CJK line box', async () => {
    const [face] = await readFontFaces(bufferSource(readFont('NotoSansSC-Regular.otf')));
    expect(face.families).toContain('Noto Sans SC');
    expect(face.weight).toBe(400);
    const plain = (face.metrics.winAscent + face.metrics.winDescent) / face.metrics.unitsPerEm;
    const line = computeWordLineMetrics(face.metrics)!;
    expect(line.heightEm).toBeCloseTo(plain * WORD_CJK_LINE_HEIGHT_FACTOR, 5);
    expect(line.baselineEm).toBeCloseTo((face.metrics.winAscent / face.metrics.unitsPerEm) + plain * 0.15, 5);
  });

  test('extracts one face of a collection into a valid standalone font', async () => {
    const collection = await makeCollection([readFont('Carlito-Regular.ttf'), readFont('Caladea-Bold.ttf')]);
    const faces = await readFontFaces(bufferSource(collection));
    expect(faces.map(face => face.families[0])).toEqual(['Carlito', 'Caladea']);
    const extracted = await extractFace(bufferSource(collection), 1);
    expect(checksum(extracted)).toBe(0xb1b0afba);
    const [face] = await readFontFaces(bufferSource(extracted));
    expect(face.families).toContain('Caladea');
    expect(face.weight).toBe(700);
    expect(extracted.length).toBe(faces[1].byteLength);
    const original = await readTableDirectory(bufferSource(readFont('Caladea-Bold.ttf')), 0);
    const copy = await readTableDirectory(bufferSource(extracted), 0);
    for (const record of original.tables) {
      if (record.tag === 'head') continue;
      const twin = copy.tables.find(candidate => candidate.tag === record.tag)!;
      expect(extracted.subarray(twin.offset, twin.offset + twin.length))
        .toEqual(readFont('Caladea-Bold.ttf').subarray(record.offset, record.offset + record.length));
    }
  });

  test('rejects data that is not a font', async () => {
    await expect(readFontFaces(bufferSource(Buffer.from('<html>not a font</html>')))).rejects.toThrow();
  });
});
