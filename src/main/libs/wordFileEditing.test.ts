import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { makeWordFixture } from '../../../tests/fixtures/word';
import { WORD_MAX_PART_BYTES, WordFileError, type WordOpenResult, WordReadOnlyReason, type WordResult } from '../../shared/artifactPreview/wordEditing';
import { WordFileStore } from './wordFileEditing';
import { inspectWordPackage } from './wordPackage';

const unwrap = <T>(result: WordResult<T>): T => {
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(result.code);
  return result.value;
};
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

describe('Word file editing', () => {
  let directory: string;
  let filePath: string;
  let store: WordFileStore;
  let opened: WordOpenResult;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lobster-word-test-'));
    filePath = path.join(directory, 'report.docx');
    await fs.writeFile(filePath, await makeWordFixture());
    store = new WordFileStore(path.join(directory, 'drafts'));
    opened = unwrap(await store.open(1, filePath));
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  test('opening is read only; canonical aliases share an owner handle', async () => {
    const before = await fs.readFile(filePath);
    const alias = path.join(directory, 'alias.docx');
    await fs.symlink(filePath, alias);
    const second = unwrap(await store.open(1, alias));
    expect(second.sessionId).toBe(opened.sessionId);
    expect(await fs.readFile(filePath)).toEqual(before);
    expect((await fs.readdir(directory)).sort()).toEqual(['alias.docx', 'report.docx']);
  });

  test('atomic save preserves a complete package, mode and idempotent retries', async () => {
    await fs.chmod(filePath, 0o640);
    const bytes = await makeWordFixture('已保存的编辑');
    const request = { sessionId: opened.sessionId, bytes, baseVersion: opened.version, revision: 1 };
    const receipt = unwrap(await store.save(1, request));
    expect(receipt.version).toBe(hash(bytes));
    expect(hash(await fs.readFile(receipt.originalCopyPath!))).toBe(opened.version);
    expect(await fs.readFile(filePath)).toEqual(Buffer.from(bytes));
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o640);
    expect(unwrap(await store.save(1, request)).version).toBe(hash(bytes));
    expect(await fs.readdir(path.join(directory, 'drafts'))).toEqual(['originals']);
    expect((await fs.readdir(directory)).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  test('generator-created empty comment parts survive opening, saving and reopening', async () => {
    const parts = {
      'word/comments.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
      'word/_rels/comments.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    };
    const original = await makeWordFixture('生成的普通文档', parts);
    await fs.writeFile(filePath, original);
    const file = unwrap(await store.open(1, filePath));
    expect(await fs.readFile(filePath)).toEqual(Buffer.from(original));
    const bytes = await makeWordFixture('已编辑的普通文档', parts);
    const receipt = unwrap(await store.save(1, { sessionId: file.sessionId, bytes, baseVersion: file.version, revision: 1 }));
    const reopened = unwrap(await new WordFileStore(path.join(directory, 'drafts')).open(2, filePath));
    expect(reopened.version).toBe(receipt.version);
    const zip = await JSZip.loadAsync(reopened.bytes);
    expect(await zip.file('word/comments.xml')!.async('string')).toBe(parts['word/comments.xml']);
    expect(await zip.file('word/document.xml')!.async('string')).toContain('已编辑的普通文档');
  });

  test('external edits win a conflict and unsaved bytes survive a new process/store', async () => {
    const mine = await makeWordFixture('我的编辑');
    const theirs = await makeWordFixture('外部修改');
    await fs.writeFile(filePath, theirs);
    expect(await store.save(1, { sessionId: opened.sessionId, bytes: mine, baseVersion: opened.version, revision: 2 }))
      .toEqual({ success: false, code: WordFileError.Conflict });
    expect(await fs.readFile(filePath)).toEqual(Buffer.from(theirs));
    const restarted = new WordFileStore(path.join(directory, 'drafts'));
    const restored = unwrap(await restarted.open(2, filePath));
    expect(Buffer.from(restored.recovery!.bytes)).toEqual(Buffer.from(mine));
    expect(restored.recovery?.baseVersion).toBe(opened.version);
    expect(restored.version).toBe(hash(theirs));
  });

  test('path queue serializes competing saves; a newer revision cannot be replaced by an older one', async () => {
    const a = await makeWordFixture('第一版');
    const b = await makeWordFixture('第二版');
    const [first, second] = await Promise.all([
      store.save(1, { sessionId: opened.sessionId, bytes: a, baseVersion: opened.version, revision: 1 }),
      store.save(1, { sessionId: opened.sessionId, bytes: b, baseVersion: opened.version, revision: 2 }),
    ]);
    unwrap(first);
    expect(second).toEqual({ success: false, code: WordFileError.Conflict });
    expect(await fs.readFile(filePath)).toEqual(Buffer.from(a));
    expect(await store.checkpoint(1, { sessionId: opened.sessionId, bytes: a, baseVersion: opened.version, revision: 1 }))
      .toEqual({ success: false, code: WordFileError.Conflict });
    const recovered = unwrap(await new WordFileStore(path.join(directory, 'drafts')).open(3, filePath));
    expect(Buffer.from(recovered.recovery!.bytes)).toEqual(Buffer.from(b));
  });

  test('a lost success reply does not resurrect an already saved recovery copy', async () => {
    const bytes = await makeWordFixture('已完成但回执丢失');
    unwrap(await store.checkpoint(1, { sessionId: opened.sessionId, bytes, baseVersion: opened.version, revision: 1 }));
    await fs.writeFile(filePath, bytes);
    const recovered = unwrap(await new WordFileStore(path.join(directory, 'drafts')).open(2, filePath));
    expect(recovered.recovery).toBeUndefined();
  });

  test('handles cannot cross renderers or survive owner release', async () => {
    expect(await store.read(2, opened.sessionId)).toEqual({ success: false, code: WordFileError.Forbidden });
    store.releaseOwner(1);
    expect(await store.read(1, opened.sessionId)).toEqual({ success: false, code: WordFileError.Forbidden });
  });

  test('a retargeted symlink cannot redirect an approved save', async () => {
    const alias = path.join(directory, 'linked.docx');
    const other = path.join(directory, 'other.docx');
    await fs.writeFile(other, await makeWordFixture('其他文件'));
    await fs.symlink(filePath, alias);
    const owner = unwrap(await store.open(4, alias));
    await fs.unlink(alias);
    await fs.symlink(other, alias);
    const result = await store.save(4, { sessionId: owner.sessionId, bytes: await makeWordFixture('不能覆盖'), baseVersion: owner.version, revision: 1 });
    expect(result).toEqual({ success: false, code: WordFileError.Conflict });
    expect(hash(await fs.readFile(filePath))).toBe(opened.version);
  });

  test('invalid exports never replace the original file or its existing recovery copy', async () => {
    const mine = await makeWordFixture('有效编辑');
    unwrap(await store.checkpoint(1, { sessionId: opened.sessionId, bytes: mine, baseVersion: opened.version, revision: 1 }));
    const result = await store.save(1, { sessionId: opened.sessionId, bytes: new Uint8Array([1, 2, 3]), baseVersion: opened.version, revision: 2 });
    expect(result.success).toBe(false);
    expect(hash(await fs.readFile(filePath))).toBe(opened.version);
    expect(Buffer.from(unwrap(await new WordFileStore(path.join(directory, 'drafts')).open(2, filePath)).recovery!.bytes)).toEqual(Buffer.from(mine));
  });
});

describe('Read-only Word sessions', () => {
  test('review content opens with its reasons and can never be written back', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lobster-word-readonly-'));
    try {
      const filePath = path.join(directory, 'reviewed.docx');
      const original = await makeWordFixture('审阅中的文档', { 'word/settings.xml': '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:documentProtection w:edit="readOnly"/></w:settings>' });
      await fs.writeFile(filePath, original);
      const store = new WordFileStore(path.join(directory, 'drafts'));
      const file = unwrap(await store.open(1, filePath));
      expect(file.readOnly).toEqual([WordReadOnlyReason.Protection]);
      const request = { sessionId: file.sessionId, bytes: await makeWordFixture('改动'), baseVersion: file.version, revision: 1 };
      expect(await store.checkpoint(1, request)).toEqual({ success: false, code: WordFileError.Forbidden });
      expect(await store.save(1, request)).toEqual({ success: false, code: WordFileError.Forbidden });
      expect(await fs.readFile(filePath)).toEqual(Buffer.from(original));
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

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
    bytes.writeUInt32LE(WORD_MAX_PART_BYTES + 1, firstEntry + 24);
    expect(() => inspectWordPackage(bytes)).toThrowError(expect.objectContaining({ code: WordFileError.TooLarge }));
  });

  test('rejects traversal and active XML even in an unused part', async () => {
    const zip = await JSZip.loadAsync(await makeWordFixture());
    zip.file('../outside.xml', '<x/>');
    const traversal = await zip.generateAsync({ type: 'uint8array' });
    expect(() => inspectWordPackage(traversal)).toThrow();
    const entity = await makeWordFixture('fixture', { 'customXml/item2.xml': '<!DOCTYPE root [<!ENTITY x "text">]><root>&x;</root>' });
    expect(() => inspectWordPackage(entity)).toThrow();
  });
});
