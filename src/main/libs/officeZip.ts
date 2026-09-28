import { crc32, inflateRawSync } from 'node:zlib';

import { OfficeFileError, type OfficePackageLimits } from '../../shared/artifactPreview/officeEditing';

export class OfficePackageException extends Error {
  constructor(readonly code: OfficeFileError, message: string) {
    super(message);
  }
}

const invalid = (message: string): never => {
  throw new OfficePackageException(OfficeFileError.InvalidFile, message);
};
const unsupported = (message: string): never => {
  throw new OfficePackageException(OfficeFileError.Unsupported, message);
};
const tooLarge = (): never => {
  throw new OfficePackageException(OfficeFileError.TooLarge, 'Package exceeds editing limits');
};

/** OLE compound files: encrypted OOXML and legacy binary formats. */
const COMPOUND_FILE_SIGNATURE = 0xe011cfd0;

export interface OfficeZipContents {
  /** Entry names in directory order. */
  names: string[];
  /** Decoded XML and relationship parts. */
  xml: Map<string, string>;
}

/**
 * Validate an OOXML ZIP directory BEFORE inflation and read its XML parts. The declared
 * expanded size is never trusted: zlib gets an output cap too, and every entry's CRC is
 * checked. Nothing is extracted to filesystem paths. Encrypted, ZIP64 and multi-disk
 * archives, DTDs and entity declarations are refused.
 */
export function readOfficeZip(input: Uint8Array, limits: OfficePackageLimits): OfficeZipContents {
  if (!(input instanceof Uint8Array)) invalid('Expected package bytes');
  if (input.byteLength > limits.maxFileBytes) tooLarge();
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length >= 8 && bytes.readUInt32LE(0) === COMPOUND_FILE_SIGNATURE) unsupported('Encrypted or legacy binary document');
  if (bytes.length < 22) invalid('Not a ZIP archive');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) {
      end = i;
      break;
    }
  }
  if (end < 0) invalid('Missing ZIP directory');
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryStart = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || directoryStart === 0xffffffff || directorySize === 0xffffffff
    || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)
    || bytes.readUInt16LE(end + 8) !== count) unsupported('ZIP64/multi-disk package');
  if (count > limits.maxParts) tooLarge();
  if (directoryStart + directorySize !== end) invalid('Invalid ZIP directory bounds');
  const names: string[] = [];
  const seen = new Set<string>();
  const xml = new Map<string, string>();
  let offset = directoryStart;
  let expandedTotal = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) invalid('Invalid ZIP entry');
    const flags = bytes.readUInt16LE(offset + 8);
    const compression = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const expanded = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const entryEnd = offset + 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    if (entryEnd > end || local + 30 > directoryStart) invalid('ZIP entry out of bounds');
    if (flags & 1 || ![0, 8].includes(compression)) unsupported('Encrypted or unsupported ZIP entry');
    if (expanded > limits.maxPartBytes || expandedTotal + expanded > limits.maxExpandedBytes) tooLarge();
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (!name || name.includes('\\') || name.startsWith('/') || name.includes('\0')
      || name.split('/').some(part => part === '..' || part === '.') || seen.has(name)) invalid('Invalid or duplicate ZIP path');
    seen.add(name);
    names.push(name);
    if (bytes.readUInt32LE(local) !== 0x04034b50
      || bytes.readUInt16LE(local + 8) !== compression || bytes.readUInt16LE(local + 6) !== flags) invalid('ZIP header mismatch');
    const localNameLength = bytes.readUInt16LE(local + 26);
    const dataStart = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    if (dataStart + compressed > directoryStart
      || decoder.decode(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name) invalid('ZIP content bounds mismatch');
    const packed = bytes.subarray(dataStart, dataStart + compressed);
    let content: Buffer;
    try {
      content = compression === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, Math.min(expanded, limits.maxPartBytes)) });
    } catch {
      invalid('Invalid or oversized ZIP stream');
    }
    if (content.length !== expanded) invalid('ZIP expanded size mismatch');
    if (crc32(content) !== bytes.readUInt32LE(offset + 16)) invalid('ZIP content checksum mismatch');
    expandedTotal += content.length;
    if (/\.xml$|\.rels$|\.vml$/i.test(name)) {
      let text: string;
      try {
        text = decoder.decode(content);
      } catch {
        invalid(`Part ${name} is not UTF-8`);
      }
      if (/<!DOCTYPE|<!ENTITY/i.test(text)) unsupported('XML entities are not supported');
      xml.set(name, text);
    }
    offset = entryEnd;
  }
  if (offset !== end) invalid('ZIP directory size mismatch');
  return { names, xml };
}

/** Decode the five predefined entities and numeric references of an attribute value. */
function decodeAttribute(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };
  return value.replace(/&(#x[\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    if (!entity.startsWith('#')) return entities[entity];
    const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  });
}

export interface PackageRelationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

/** Relationships of a `.rels` part; internal targets are resolved against the owning part. */
export function packageRelationships(xml: string | undefined, sourcePart: string): PackageRelationship[] {
  if (!xml) return [];
  const relationships: PackageRelationship[] = [];
  for (const match of xml.matchAll(/<(?:[^\s<>/=:]+:)?Relationship\b((?:[^"'>]|"[^"]*"|'[^']*')*)\/?>/g)) {
    const attributes = new Map<string, string>();
    for (const attribute of match[1].matchAll(/([^\s=/>]+)\s*=\s*(["'])([\s\S]*?)\2/g)) attributes.set(attribute[1], decodeAttribute(attribute[3]));
    const id = attributes.get('Id');
    const type = attributes.get('Type');
    const target = attributes.get('Target');
    if (!id || !type || target === undefined) continue;
    const external = attributes.get('TargetMode')?.toLowerCase() === 'external';
    let resolved = target;
    if (!external) {
      const segments = target.startsWith('/') ? [] : sourcePart.split('/').slice(0, -1);
      for (const segment of target.replace(/^\//, '').split('/')) {
        if (segment === '..') segments.pop();
        else if (segment && segment !== '.') segments.push(segment);
      }
      resolved = segments.join('/');
    }
    relationships.push({ id, type, target: resolved, external });
  }
  return relationships;
}
