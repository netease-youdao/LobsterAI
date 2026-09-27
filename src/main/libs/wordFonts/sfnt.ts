import type { WordFontMetrics } from '../../../shared/artifactPreview/wordFonts';

/**
 * Minimal OpenType/TrueType reader for installed fonts: the table directory, names, style and
 * vertical metrics, plus extraction of one face from a collection. Everything is bounds-checked;
 * font files in user directories are untrusted input.
 */

export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

export interface SfntTableRecord {
  tag: string;
  checksum: number;
  offset: number;
  length: number;
}

export interface SfntFaceInfo {
  faceIndex: number;
  families: string[];
  weight: number;
  italic: boolean;
  metrics: WordFontMetrics;
  /** Size of the face once extracted into a standalone font. */
  byteLength: number;
}

export class SfntError extends Error {}

const TRUETYPE = 0x00010000;
const OPENTYPE_CFF = 0x4f54544f; // 'OTTO'
const APPLE_TRUE = 0x74727565; // 'true'
const COLLECTION = 0x74746366; // 'ttcf'
const MAX_TABLES = 128;
const MAX_FACES = 64;
const MAX_NAME_TABLE_BYTES = 1024 * 1024;
const FAMILY_NAME_ID = 1;
const TYPOGRAPHIC_FAMILY_NAME_ID = 16;
const ITALIC_SELECTION_BIT = 1;
const OBLIQUE_SELECTION_BIT = 1 << 9;
const USE_TYPO_METRICS_BIT = 1 << 7;
const MAC_STYLE_ITALIC = 1 << 1;

const fail = (message: string): never => { throw new SfntError(message); };
const pad4 = (value: number): number => (value + 3) & ~3;

export function bufferSource(bytes: Buffer): ByteSource {
  return {
    size: bytes.length,
    read: async (offset, length) => {
      if (offset < 0 || length < 0 || offset + length > bytes.length) fail('Read outside font data');
      return bytes.subarray(offset, offset + length);
    },
  };
}

async function readExact(source: ByteSource, offset: number, length: number): Promise<Buffer> {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
    || offset + length > source.size) fail('Font table out of bounds');
  const bytes = await source.read(offset, length);
  if (bytes.length !== length) fail('Short font read');
  return bytes;
}

/** Offsets of each face's table directory: one for a plain font, several for a collection. */
export async function readFaceOffsets(source: ByteSource): Promise<number[]> {
  const header = await readExact(source, 0, 12);
  const tag = header.readUInt32BE(0);
  if (tag === TRUETYPE || tag === OPENTYPE_CFF || tag === APPLE_TRUE) return [0];
  if (tag !== COLLECTION) fail('Not an OpenType font');
  const count = header.readUInt32BE(8);
  if (count < 1 || count > MAX_FACES) fail('Unsupported font collection size');
  const offsets = await readExact(source, 12, count * 4);
  return Array.from({ length: count }, (_, index) => offsets.readUInt32BE(index * 4));
}

export async function readTableDirectory(source: ByteSource, faceOffset: number): Promise<{ version: number; tables: SfntTableRecord[] }> {
  const header = await readExact(source, faceOffset, 12);
  const version = header.readUInt32BE(0);
  if (version !== TRUETYPE && version !== OPENTYPE_CFF && version !== APPLE_TRUE) fail('Invalid face header');
  const count = header.readUInt16BE(4);
  if (count < 1 || count > MAX_TABLES) fail('Unsupported table count');
  const records = await readExact(source, faceOffset + 12, count * 16);
  const tables: SfntTableRecord[] = [];
  for (let index = 0; index < count; index++) {
    const at = index * 16;
    const record = {
      tag: records.toString('latin1', at, at + 4),
      checksum: records.readUInt32BE(at + 4),
      offset: records.readUInt32BE(at + 8),
      length: records.readUInt32BE(at + 12),
    };
    if (record.offset + record.length > source.size) fail(`Table ${record.tag} out of bounds`);
    tables.push(record);
  }
  return { version, tables };
}

function decodeName(platform: number, encoding: number, bytes: Buffer): string | undefined {
  if (platform === 0 || (platform === 3 && (encoding === 0 || encoding === 1 || encoding === 10))) {
    if (bytes.length % 2) return undefined;
    const swapped = Buffer.from(bytes);
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (platform === 1 && encoding === 0) return bytes.toString('latin1');
  return undefined;
}

/** Legacy and typographic family names in every language the font carries. */
export function parseFamilyNames(table: Buffer): string[] {
  if (table.length < 6) fail('Truncated name table');
  const count = table.readUInt16BE(2);
  const storage = table.readUInt16BE(4);
  const legacy: string[] = [];
  const typographic: string[] = [];
  for (let index = 0; index < count; index++) {
    const at = 6 + index * 12;
    if (at + 12 > table.length) break;
    const nameId = table.readUInt16BE(at + 6);
    if (nameId !== FAMILY_NAME_ID && nameId !== TYPOGRAPHIC_FAMILY_NAME_ID) continue;
    const length = table.readUInt16BE(at + 8);
    const offset = storage + table.readUInt16BE(at + 10);
    if (offset + length > table.length) continue;
    const name = decodeName(table.readUInt16BE(at), table.readUInt16BE(at + 2), table.subarray(offset, offset + length))
      ?.replace(/\0/g, '').trim();
    if (!name || name.length > 64) continue;
    (nameId === FAMILY_NAME_ID ? legacy : typographic).push(name);
  }
  // Word addresses a face by its legacy family ("Microsoft YaHei Light"); typographic
  // names group weights and only help when a document names that group.
  return [...new Set([...legacy, ...typographic])];
}

function table(tables: SfntTableRecord[], tag: string): SfntTableRecord | undefined {
  return tables.find(record => record.tag === tag);
}

export async function readFaceInfo(source: ByteSource, faceOffset: number, faceIndex: number): Promise<SfntFaceInfo> {
  const { tables } = await readTableDirectory(source, faceOffset);
  const nameRecord = table(tables, 'name');
  const os2Record = table(tables, 'OS/2');
  const headRecord = table(tables, 'head');
  const hheaRecord = table(tables, 'hhea');
  if (!nameRecord || !os2Record || !headRecord || !hheaRecord) fail('Missing required font tables');
  if (nameRecord!.length > MAX_NAME_TABLE_BYTES) fail('Name table too large');
  const [name, os2, head, hhea] = await Promise.all([
    readExact(source, nameRecord!.offset, nameRecord!.length),
    readExact(source, os2Record!.offset, Math.min(os2Record!.length, 96)),
    readExact(source, headRecord!.offset, Math.min(headRecord!.length, 54)),
    readExact(source, hheaRecord!.offset, Math.min(hheaRecord!.length, 36)),
  ]);
  if (os2.length < 78 || head.length < 54 || hhea.length < 10) fail('Truncated metrics tables');
  const families = parseFamilyNames(name);
  if (!families.length) fail('Font has no family name');
  const selection = os2.readUInt16BE(62);
  const unitsPerEm = head.readUInt16BE(18);
  if (unitsPerEm < 16 || unitsPerEm > 16384) fail('Invalid units per em');
  const metrics: WordFontMetrics = {
    unitsPerEm,
    winAscent: os2.readUInt16BE(74),
    winDescent: os2.readUInt16BE(76),
    hheaAscender: hhea.readInt16BE(4),
    hheaDescender: hhea.readInt16BE(6),
    hheaLineGap: hhea.readInt16BE(8),
    typoAscender: os2.readInt16BE(68),
    typoDescender: os2.readInt16BE(70),
    typoLineGap: os2.readInt16BE(72),
    useTypoMetrics: (selection & USE_TYPO_METRICS_BIT) !== 0,
    codePageRange1: os2.readUInt16BE(0) >= 1 && os2.length >= 82 ? os2.readUInt32BE(78) : 0,
  };
  const weight = os2.readUInt16BE(4);
  return {
    faceIndex,
    families,
    weight: weight >= 1 && weight <= 1000 ? weight : 400,
    italic: (selection & (ITALIC_SELECTION_BIT | OBLIQUE_SELECTION_BIT)) !== 0 || (head.readUInt16BE(44) & MAC_STYLE_ITALIC) !== 0,
    metrics,
    byteLength: 12 + tables.length * 16 + tables.reduce((total, record) => total + pad4(record.length), 0),
  };
}

export async function readFontFaces(source: ByteSource): Promise<SfntFaceInfo[]> {
  const offsets = await readFaceOffsets(source);
  const faces: SfntFaceInfo[] = [];
  for (const [index, offset] of offsets.entries()) {
    try {
      faces.push(await readFaceInfo(source, offset, index));
    } catch (error) {
      // One malformed face in a collection must not hide its siblings.
      if (!(error instanceof SfntError)) throw error;
    }
  }
  return faces;
}

function tableChecksum(bytes: Buffer): number {
  let sum = 0;
  const padded = bytes.length % 4 ? Buffer.concat([bytes, Buffer.alloc(4 - (bytes.length % 4))]) : bytes;
  for (let at = 0; at < padded.length; at += 4) sum = (sum + padded.readUInt32BE(at)) >>> 0;
  return sum;
}

/**
 * Copy one face out of a font file into a standalone font. For a plain font this rebuilds the
 * same tables; for a collection it drops the sibling faces so only the needed bytes travel.
 */
export async function extractFace(source: ByteSource, faceIndex: number): Promise<Buffer> {
  const offsets = await readFaceOffsets(source);
  const faceOffset = offsets[faceIndex];
  if (faceOffset === undefined) fail('Unknown face index');
  const { version, tables } = await readTableDirectory(source, faceOffset);
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const headerLength = 12 + sorted.length * 16;
  const total = headerLength + sorted.reduce((sum, record) => sum + pad4(record.length), 0);
  const output = Buffer.alloc(total);
  output.writeUInt32BE(version, 0);
  output.writeUInt16BE(sorted.length, 4);
  let power = 1;
  let log = 0;
  while (power * 2 <= sorted.length) { power *= 2; log++; }
  output.writeUInt16BE(power * 16, 6);
  output.writeUInt16BE(log, 8);
  output.writeUInt16BE(sorted.length * 16 - power * 16, 10);
  let dataOffset = headerLength;
  let headOffset = -1;
  for (const [index, record] of sorted.entries()) {
    const bytes = await readExact(source, record.offset, record.length);
    bytes.copy(output, dataOffset);
    if (record.tag === 'head' && record.length >= 12) {
      headOffset = dataOffset;
      output.writeUInt32BE(0, dataOffset + 8);
    }
    const at = 12 + index * 16;
    output.write(record.tag, at, 4, 'latin1');
    output.writeUInt32BE(record.tag === 'head' ? tableChecksum(output.subarray(dataOffset, dataOffset + record.length)) : record.checksum, at + 4);
    output.writeUInt32BE(dataOffset, at + 8);
    output.writeUInt32BE(record.length, at + 12);
    dataOffset += pad4(record.length);
  }
  if (headOffset >= 0) {
    output.writeUInt32BE((0xb1b0afba - tableChecksum(output)) >>> 0, headOffset + 8);
  }
  return output;
}
