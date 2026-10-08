import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { describe, expect, test } from 'vitest';

import { makeWordFixture } from '../../../../tests/fixtures/word';
import { OfficeFileError, type OfficeResult } from '../../../shared/office/core/officeFile';
import { WORD_EDITOR } from '../../../shared/office/editors';
import { WORD_PACKAGE_LIMITS, WordReadOnlyReason } from '../../../shared/office/word/wordFile';
import { OfficeFileStore } from '../core/officeFileStore';
import { inspectWordPackage } from './wordPackage';

const unwrap = <T>(result: OfficeResult<T>): T => {
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(result.code);
  return result.value;
};
const wordStore = (directory: string) => new OfficeFileStore({
  extension: WORD_EDITOR.extension, maxFileBytes: WORD_PACKAGE_LIMITS.maxFileBytes, inspect: inspectWordPackage, logTag: '[WordFiles]',
}, path.join(directory, 'drafts'));

describe('DOCX admission', () => {
  test.each([
    '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n  </w:comments>',
    '<comments xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><!-- no annotations --></comments>',
    '<doc:comments xmlns:doc="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
  ])('accepts an empty comment container: %s', async comments => {
    const bytes = await makeWordFixture('普通文档', { 'word/comments.xml': comments });
    expect(() => inspectWordPackage(bytes)).not.toThrow();
  });

  test.each([
    ['comments', WordReadOnlyReason.Comments, { 'word/comments.xml': '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0"><w:p><w:r><w:t>Review</w:t></w:r></w:p></w:comment></w:comments>' }],
    ['empty comment record', WordReadOnlyReason.Comments, { 'word/comments.xml': '<w:comments><w:comment w:id="0"/></w:comments>' }],
    ['comment metadata', WordReadOnlyReason.Comments, { 'word/commentsExtended.xml': '<w15:commentsEx><w15:commentEx w15:paraId="1"/></w15:commentsEx>' }],
    ['invalid comment XML', WordReadOnlyReason.Comments, { 'word/comments.xml': '<w:comments><w:comment></w:comments>' }],
    ['unexpected comment root', WordReadOnlyReason.Comments, { 'word/comments.xml': '<differentRoot/>' }],
    ['comment reference without comments part', WordReadOnlyReason.Comments, { 'word/footer2.xml': '<w:ftr><w:p><w:r><w:commentReference w:id="0"/></w:r></w:p></w:ftr>' }],
    ['comment range without comments part', WordReadOnlyReason.Comments, { 'word/header2.xml': '<w:hdr><w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Review</w:t></w:r><w:commentRangeEnd w:id="0"/></w:p></w:hdr>' }],
    ['tracked insertion', WordReadOnlyReason.Revisions, { 'word/footer2.xml': '<w:ftr><w:p><w:ins w:id="1" w:author="A"><w:r><w:t>x</w:t></w:r></w:ins></w:p></w:ftr>' }],
    ['tracked formatting', WordReadOnlyReason.Revisions, { 'word/footer2.xml': '<w:ftr><w:p><w:r><w:rPr><w:b/><w:rPrChange w:id="2" w:author="A"><w:rPr/></w:rPrChange></w:rPr><w:t>x</w:t></w:r></w:p></w:ftr>' }],
    ['embedded object', WordReadOnlyReason.Embedded, { 'word/embeddings/oleObject1.bin': 'ole' }],
    ['macros', WordReadOnlyReason.Macros, { 'word/vbaProject.bin': 'macro' }],
    ['signatures', WordReadOnlyReason.Signature, { '_xmlsignatures/sig1.xml': '<Signature/>' }],
    ['external image', WordReadOnlyReason.ExternalContent, { 'word/_rels/document.xml.rels': '<Relationships><Relationship TargetMode="External" Target="https://example.com/a.png" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/></Relationships>' }],
    ['encoded external relationship', WordReadOnlyReason.ExternalContent, { 'word/_rels/document.xml.rels': '<r-x:Relationships xmlns:r-x="urn:test"><r-x:Relationship Target="https://example.com/a>b.png" TargetMode="&#x45;xternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/></r-x:Relationships>' }],
    ['self-closing protection', WordReadOnlyReason.Protection, { 'word/settings.xml': '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:documentProtection/></w:settings>' }],
  ])('opens %s read only instead of editing around it', async (_name, reason, parts) => {
    const bytes = await makeWordFixture('fixture', parts as Record<string, string>);
    expect(inspectWordPackage(bytes).readOnly).toContain(reason);
  });

  test('a plain generated document is fully editable', async () => {
    expect(inspectWordPackage(await makeWordFixture()).readOnly).toEqual([]);
  });

  test('reads font declarations and their fallback classes from the font table', async () => {
    const fontTable = '<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + '<w:font w:name="宋体"><w:altName w:val="SimSun"/><w:panose1 w:val="02010600030101010101"/><w:charset w:val="86"/><w:family w:val="auto"/><w:pitch w:val="variable"/></w:font>'
      + '<w:font w:name="Times New Roman"><w:charset w:val="00"/><w:family w:val="roman"/><w:pitch w:val="variable"/></w:font>'
      + '<w:font w:name="Consolas"/></w:fonts>';
    const bytes = await makeWordFixture('fixture', { 'word/fontTable.xml': fontTable });
    expect(inspectWordPackage(bytes).fonts).toEqual([
      { name: '宋体', altName: 'SimSun', charset: '86', family: 'auto', pitch: 'variable' },
      { name: 'Times New Roman', charset: '00', family: 'roman', pitch: 'variable' },
      { name: 'Consolas' },
    ]);
  });

  test('rejects declared oversized entries before decompressing', async () => {
    const bytes = Buffer.from(await makeWordFixture());
    const firstEntry = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(WORD_PACKAGE_LIMITS.maxPartBytes + 1, firstEntry + 24);
    expect(() => inspectWordPackage(bytes)).toThrowError(expect.objectContaining({ code: OfficeFileError.TooLarge }));
  });

  test('rejects traversal and active XML even in an unused part', async () => {
    const zip = await JSZip.loadAsync(await makeWordFixture());
    zip.file('../outside.xml', '<x/>');
    const traversal = await zip.generateAsync({ type: 'uint8array' });
    expect(() => inspectWordPackage(traversal)).toThrow();
    const entity = await makeWordFixture('fixture', { 'customXml/item2.xml': '<!DOCTYPE root [<!ENTITY x "text">]><root>&x;</root>' });
    expect(() => inspectWordPackage(entity)).toThrow();
  });

  test('reports encrypted documents and undecodable parts as such', async () => {
    const encrypted = new Uint8Array(512);
    encrypted.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(() => inspectWordPackage(encrypted)).toThrowError(expect.objectContaining({ code: OfficeFileError.Unsupported }));
    const zip = await JSZip.loadAsync(await makeWordFixture());
    zip.file('customXml/item2.xml', new Uint8Array([0x3c, 0x78, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x78, 0x3e]));
    const latin = await zip.generateAsync({ type: 'uint8array' });
    expect(() => inspectWordPackage(latin)).toThrowError(expect.objectContaining({ code: OfficeFileError.InvalidFile }));
    const badReference = await makeWordFixture('fixture', { 'word/_rels/document.xml.rels': '<Relationships><Relationship Id="r" Type="t" Target="&#0;"/></Relationships>' });
    expect(() => inspectWordPackage(badReference)).toThrowError(expect.objectContaining({ code: OfficeFileError.InvalidFile }));
  });

  test('generator-created empty comment parts survive opening, saving and reopening', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lobster-word-comments-'));
    try {
      const filePath = path.join(directory, 'report.docx');
      const parts = {
        'word/comments.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
        'word/_rels/comments.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
      };
      const original = await makeWordFixture('生成的普通文档', parts);
      await fs.writeFile(filePath, original);
      const store = wordStore(directory);
      const file = unwrap(await store.open(1, filePath));
      expect(await fs.readFile(filePath)).toEqual(Buffer.from(original));
      const bytes = await makeWordFixture('已编辑的普通文档', parts);
      const receipt = unwrap(await store.save(1, { sessionId: file.sessionId, bytes, baseVersion: file.version, revision: 1 }));
      const reopened = unwrap(await wordStore(directory).open(2, filePath));
      expect(reopened.version).toBe(receipt.version);
      const zip = await JSZip.loadAsync(reopened.bytes);
      expect(await zip.file('word/comments.xml')!.async('string')).toBe(parts['word/comments.xml']);
      expect(await zip.file('word/document.xml')!.async('string')).toContain('已编辑的普通文档');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
