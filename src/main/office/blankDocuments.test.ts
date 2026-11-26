import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createServerAutomationHost } from '@docx-editor.dev/core/automation';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, test } from 'vitest';

import { nodeXmlCodec } from '../../../tests/fixtures/slides';
import { importXlsxPackage, readXlsxPackage } from '../../renderer/services/office/sheet/xlsxImport';
import { RelType, SlidesPackage } from '../../renderer/services/office/slides/slidesPackage';
import { BlankDocumentKind } from '../../shared/artifactPreview/blankDocument';
import {
  buildBlankSheetBytes,
  buildBlankSlidesBytes,
  buildBlankWordBytes,
  createBlankDocumentInDirectory,
  sanitizeBlankDocumentBaseName,
} from './blankDocuments';
import { inspectSheetPackage } from './sheet/sheetPackage';
import { inspectSlidesPackage } from './slides/slidesPackage';
import { inspectWordPackage } from './word/wordPackage';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe('blank OOXML document builders', () => {
  test('blank Word package passes admission, includes complete OOXML parts/styles, and opens in the docx editor engine', () => {
    const bytes = buildBlankWordBytes();
    const info = inspectWordPackage(bytes);
    expect(info.readOnly).toEqual([]);
    expect(info.fonts).toEqual([
      expect.objectContaining({ name: '等线', altName: 'DengXian' }),
    ]);
    expect(info.fonts.map(font => font.name)).not.toContain('Calibri');

    const parts = unzipSync(bytes);
    expect(parts['word/settings.xml']).toBeDefined();
    expect(parts['docProps/core.xml']).toBeDefined();
    expect(parts['docProps/app.xml']).toBeDefined();

    const settingsXml = strFromU8(parts['word/settings.xml']);
    expect(settingsXml).toContain('compatibilityMode');
    expect(settingsXml).toContain('compressPunctuation');

    const stylesXml = strFromU8(parts['word/styles.xml']);
    expect(stylesXml).toContain('w:after="160" w:line="276" w:lineRule="auto"');
    expect(stylesXml).toContain('w:styleId="DefaultParagraphFont"');
    expect(stylesXml).toContain('w:styleId="TableNormal"');
    expect(stylesXml).toContain('w:styleId="NoList"');
    expect(stylesXml).toContain('w:styleId="Subtitle"');
    expect(stylesXml).toContain('w:styleId="Heading4"');
    expect(stylesXml).toContain('w:styleId="Quote"');
    expect(stylesXml).toContain('w:styleId="ListParagraph"');
    expect(stylesXml).toContain('w:styleId="NoSpacing"');
    // Headings and titles return to Normal on Enter and do not inherit body 1.15x line spacing.
    expect(stylesXml).toContain('w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>');
    expect(stylesXml).toContain('w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>');

    const opened = createServerAutomationHost(bytes);
    expect(opened.ok).toBe(true);
  });

  test('blank Sheet package passes admission and opens in the sheet editor client', () => {
    const bytes = buildBlankSheetBytes();
    const info = inspectSheetPackage(bytes);
    expect(info.readOnly).toEqual([]);
    expect(info.hidden).toEqual([]);
    const imported = importXlsxPackage(readXlsxPackage(bytes), { formatLocale: 'zh' });
    expect(imported.data.sheetOrder).toHaveLength(1);
  });

  test('blank Slides package passes admission and opens in the slides package engine', () => {
    const bytes = buildBlankSlidesBytes();
    const info = inspectSlidesPackage(bytes);
    expect(info.readOnly).toEqual([]);
    const pkg = SlidesPackage.open(bytes, nodeXmlCodec);
    const slideRels = pkg.relationships('ppt/presentation.xml').filter(rel => rel.type === RelType.Slide);
    expect(slideRels).toHaveLength(1);
    expect(pkg.xml(slideRels[0].target)).toBeTruthy();
  });
});

describe('createBlankDocumentInDirectory', () => {
  test('sanitizes invalid characters and falls back to kind default', () => {
    expect(sanitizeBlankDocumentBaseName('  /bad:*name?.  ', BlankDocumentKind.Word)).toBe('bad name');
    expect(sanitizeBlankDocumentBaseName('   ', BlankDocumentKind.Slides)).toBe('Untitled Presentation');
  });

  test('creates non-colliding files on disk and preserves valid package bytes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lobster-blank-docs-'));
    tempDirs.push(dir);

    const first = await createBlankDocumentInDirectory(dir, BlankDocumentKind.Word, '未命名文档');
    const second = await createBlankDocumentInDirectory(dir, BlankDocumentKind.Word, '未命名文档');
    const md = await createBlankDocumentInDirectory(dir, BlankDocumentKind.Markdown, '笔记');

    expect(first.fileName).toBe('未命名文档.docx');
    expect(second.fileName).toBe('未命名文档 2.docx');
    expect(md.fileName).toBe('笔记.md');

    const firstBytes = new Uint8Array(await fs.readFile(first.filePath));
    expect(inspectWordPackage(firstBytes).readOnly).toEqual([]);
    expect(await fs.readFile(md.filePath, 'utf8')).toBe('');
  });

  test('rejects relative directories', async () => {
    await expect(
      createBlankDocumentInDirectory('relative/dir', BlankDocumentKind.Markdown),
    ).rejects.toThrow('absolute path');
  });
});
