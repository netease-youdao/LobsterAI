import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { makeSheetFixture, SHEET_FIXTURE_PARTS } from '../../../../tests/fixtures/sheet';
import { makeSlidesFixture } from '../../../../tests/fixtures/slides';
import { makeWordFixture } from '../../../../tests/fixtures/word';
import { OfficeFileError, type OfficeOpenResult, type OfficePackageInfo, type OfficeResult } from '../../../shared/office/core/officeFile';
import { SHEET_EDITOR, SLIDES_EDITOR, WORD_EDITOR } from '../../../shared/office/editors';
import { SHEET_PACKAGE_LIMITS } from '../../../shared/office/sheet/sheetFile';
import { SLIDES_PACKAGE_LIMITS } from '../../../shared/office/slides/slidesFile';
import { WORD_PACKAGE_LIMITS } from '../../../shared/office/word/wordFile';
import { inspectSheetPackage } from '../sheet/sheetPackage';
import { inspectSlidesPackage } from '../slides/slidesPackage';
import { inspectWordPackage } from '../word/wordPackage';
import { OfficeFileStore,type OfficeFormat } from './officeFileStore';

/** What the shared store needs from a format, plus packages to exercise it with. */
interface FormatKit {
  format: OfficeFormat<OfficePackageInfo>;
  /** A valid package whose contents differ by label. */
  variant: (label: string) => Promise<Uint8Array>;
  /** A valid package the editor only opens read only. */
  readOnly: () => Promise<Uint8Array>;
}

const KITS: Record<string, FormatKit> = {
  Word: {
    format: { extension: WORD_EDITOR.extension, maxFileBytes: WORD_PACKAGE_LIMITS.maxFileBytes, inspect: inspectWordPackage, logTag: '[WordFiles]' },
    variant: label => makeWordFixture(label),
    readOnly: () => makeWordFixture('审阅中的文档', {
      'word/settings.xml': '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:documentProtection w:edit="readOnly"/></w:settings>',
    }),
  },
  Excel: {
    format: { extension: SHEET_EDITOR.extension, maxFileBytes: SHEET_PACKAGE_LIMITS.maxFileBytes, inspect: inspectSheetPackage, logTag: '[SheetFiles]' },
    variant: label => makeSheetFixture({ [SHEET_FIXTURE_PARTS.custom]: `<custom xmlns="urn:lobster:test">${label}</custom>` }),
    readOnly: () => makeSheetFixture({ 'xl/pivotTables/pivotTable1.xml': '<pivotTableDefinition/>' }),
  },
  PowerPoint: {
    format: { extension: SLIDES_EDITOR.extension, maxFileBytes: SLIDES_PACKAGE_LIMITS.maxFileBytes, inspect: inspectSlidesPackage, logTag: '[SlidesFiles]' },
    variant: label => makeSlidesFixture({ 'docProps/core.xml': `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${label}</dc:title></cp:coreProperties>` }),
    readOnly: () => makeSlidesFixture({ 'ppt/vbaProject.bin': 'macro' }),
  },
};

const unwrap = <T>(result: OfficeResult<T>): T => {
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(result.code);
  return result.value;
};
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

describe.each(Object.entries(KITS))('%s file store', (_name, kit) => {
  const { extension } = kit.format;
  let directory: string;
  let filePath: string;
  let store: OfficeFileStore<OfficePackageInfo>;
  let opened: OfficeOpenResult<OfficePackageInfo>;
  const drafts = () => path.join(directory, 'drafts');
  const newStore = () => new OfficeFileStore(kit.format, drafts());
  const write = (bytes: Uint8Array, revision: number, baseVersion = opened.version) => ({ sessionId: opened.sessionId, bytes, baseVersion, revision });
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lobster-office-test-'));
    filePath = path.join(directory, `报告${extension}`);
    await fs.writeFile(filePath, await kit.variant('原始内容'));
    store = newStore();
    opened = unwrap(await store.open(1, filePath));
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  test('opening leaves the file alone; canonical aliases share an owner handle', async () => {
    const before = await fs.readFile(filePath);
    expect(opened.version).toBe(hash(before));
    expect(opened.readOnly).toEqual([]);
    const alias = path.join(directory, `alias${extension}`);
    await fs.symlink(filePath, alias);
    expect(unwrap(await store.open(1, alias)).sessionId).toBe(opened.sessionId);
    expect((await store.open(1, path.join(directory, 'report.txt'))).success).toBe(false);
    expect(await fs.readFile(filePath)).toEqual(before);
    expect((await fs.readdir(directory)).sort()).toEqual([`alias${extension}`, `报告${extension}`].sort());
  });

  test('atomic save keeps the mode, copies the original once and retries idempotently', async () => {
    await fs.chmod(filePath, 0o640);
    const bytes = await kit.variant('已保存的编辑');
    unwrap(await store.checkpoint(1, write(bytes, 1)));
    const receipt = unwrap(await store.save(1, write(bytes, 1)));
    expect(receipt.version).toBe(hash(bytes));
    expect(hash(await fs.readFile(receipt.originalCopyPath!))).toBe(opened.version);
    expect(await fs.readFile(filePath)).toEqual(Buffer.from(bytes));
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o640);
    expect(unwrap(await store.save(1, write(bytes, 1))).version).toBe(hash(bytes));
    expect(await fs.readdir(drafts())).toEqual(['originals']);
    expect((await fs.readdir(directory)).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  test('external edits win a conflict and unsaved bytes survive a new process', async () => {
    const mine = await kit.variant('我的编辑');
    const theirs = await kit.variant('外部修改');
    await fs.writeFile(filePath, theirs);
    expect(await store.save(1, write(mine, 2))).toEqual({ success: false, code: OfficeFileError.Conflict });
    expect(await fs.readFile(filePath)).toEqual(Buffer.from(theirs));
    const restored = unwrap(await newStore().open(2, filePath));
    expect(Buffer.from(restored.recovery!.bytes)).toEqual(Buffer.from(mine));
    expect(restored.recovery?.baseVersion).toBe(opened.version);
    expect(restored.version).toBe(hash(theirs));
    unwrap(await store.discardDraft(1, opened.sessionId));
    expect(unwrap(await newStore().open(3, filePath)).recovery).toBeUndefined();
  });

  test('the path queue serializes competing saves; an older revision never replaces a newer one', async () => {
    const a = await kit.variant('第一版');
    const b = await kit.variant('第二版');
    const [first, second] = await Promise.all([store.save(1, write(a, 1)), store.save(1, write(b, 2))]);
    unwrap(first);
    expect(second).toEqual({ success: false, code: OfficeFileError.Conflict });
    expect(await fs.readFile(filePath)).toEqual(Buffer.from(a));
    expect(await store.checkpoint(1, write(a, 1))).toEqual({ success: false, code: OfficeFileError.Conflict });
    expect(Buffer.from(unwrap(await newStore().open(3, filePath)).recovery!.bytes)).toEqual(Buffer.from(b));
  });

  test('a lost success reply does not resurrect an already saved recovery copy', async () => {
    const bytes = await kit.variant('已完成但回执丢失');
    unwrap(await store.checkpoint(1, write(bytes, 1)));
    await fs.writeFile(filePath, bytes);
    expect(unwrap(await newStore().open(2, filePath)).recovery).toBeUndefined();
  });

  test('handles cannot cross renderers or survive owner release', async () => {
    expect(await store.read(2, opened.sessionId)).toEqual({ success: false, code: OfficeFileError.Forbidden });
    store.releaseOwner(1);
    expect(await store.read(1, opened.sessionId)).toEqual({ success: false, code: OfficeFileError.Forbidden });
  });

  test('a retargeted symlink cannot redirect an approved save', async () => {
    const alias = path.join(directory, `linked${extension}`);
    const other = path.join(directory, `other${extension}`);
    await fs.writeFile(other, await kit.variant('其他文件'));
    await fs.symlink(filePath, alias);
    const owner = unwrap(await store.open(4, alias));
    await fs.unlink(alias);
    await fs.symlink(other, alias);
    const result = await store.save(4, { sessionId: owner.sessionId, bytes: await kit.variant('不能覆盖'), baseVersion: owner.version, revision: 1 });
    expect(result).toEqual({ success: false, code: OfficeFileError.Conflict });
    expect(hash(await fs.readFile(filePath))).toBe(opened.version);
  });

  test('invalid exports never replace the file or its existing recovery copy', async () => {
    const mine = await kit.variant('有效编辑');
    unwrap(await store.checkpoint(1, write(mine, 1)));
    expect((await store.save(1, write(new Uint8Array([1, 2, 3]), 2))).success).toBe(false);
    expect(hash(await fs.readFile(filePath))).toBe(opened.version);
    expect(Buffer.from(unwrap(await newStore().open(2, filePath)).recovery!.bytes)).toEqual(Buffer.from(mine));
  });

  test('read-only files are never written back, nor snapshots that would open read only', async () => {
    const locked = await kit.readOnly();
    // An editor must never turn a writable file into one it would only open read only.
    expect(await store.save(1, write(locked, 1))).toEqual({ success: false, code: OfficeFileError.Forbidden });
    await fs.writeFile(filePath, locked);
    const reopened = unwrap(await store.read(1, opened.sessionId));
    expect(reopened.readOnly.length).toBeGreaterThan(0);
    const edit = { ...write(await kit.variant('改动'), 1), baseVersion: reopened.version };
    expect(await store.checkpoint(1, edit)).toEqual({ success: false, code: OfficeFileError.Forbidden });
    expect(await store.save(1, edit)).toEqual({ success: false, code: OfficeFileError.Forbidden });
    expect(await fs.readFile(filePath)).toEqual(Buffer.from(locked));
  });
});
