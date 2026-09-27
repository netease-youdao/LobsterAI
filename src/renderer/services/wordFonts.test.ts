import fs from 'node:fs';
import path from 'node:path';

import { openFontBackedDocumentForExport } from '@docx-editor.dev/core/export';
import JSZip from 'jszip';
import { beforeAll, describe, expect, test, vi } from 'vitest';

import { bufferSource, readFontFaces } from '../../main/libs/wordFonts/sfnt';
import { WordFileError, type WordFontApi } from '../../shared/artifactPreview/wordEditing';
import {
  computeWordLineMetrics, knownWordFontMetrics, type WordDocumentFontDecl, WordFontStyle, type WordSystemFontFace,
} from '../../shared/artifactPreview/wordFonts';
import { createWordFontResolver, type WordFontReportEntry,WordFontSource } from './wordFonts';

const repository = path.resolve(__dirname, '../../..');
const fontsRoot = path.join(repository, 'src/renderer/assets/word-fonts');
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

beforeAll(() => {
  // Bundled fonts resolve to Vite asset URLs; serve them from the repository in Node.
  vi.stubGlobal('fetch', async (url: string) => new Response(fs.readFileSync(path.join(repository, decodeURIComponent(url)))));
});

/** A document whose paragraphs each use one font, so every line box belongs to that font. */
async function fontSampleDocument(paragraphs: { font: string; eastAsia?: string; text: string; bold?: boolean }[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const body = paragraphs.map(({ font, eastAsia, text, bold }) => `<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${eastAsia ?? font}"/>${bold ? '<w:b/>' : ''}<w:sz w:val="24"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`).join('');
  zip.file('word/document.xml', `<w:document xmlns:w="${WORD_NS}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: 'uint8array' });
}

async function installedFace(file: string, requested: string, family: string): Promise<{ face: WordSystemFontFace; bytes: Uint8Array }> {
  const bytes = fs.readFileSync(path.join(fontsRoot, file));
  const [info] = await readFontFaces(bufferSource(bytes));
  return {
    bytes: new Uint8Array(bytes),
    face: { id: `${file}:${requested}`, family, requested, weight: info.weight, style: info.italic ? WordFontStyle.Italic : WordFontStyle.Normal,
      byteLength: bytes.length, metrics: info.metrics },
  };
}

function fakeApi(installed: Awaited<ReturnType<typeof installedFace>>[]): WordFontApi {
  return {
    resolveFonts: async families => ({ success: true, value: {
      faces: installed.filter(entry => families.includes(entry.face.requested)).map(entry => entry.face),
    } }),
    readFont: async id => {
      const entry = installed.find(candidate => candidate.face.id === id);
      return entry ? { success: true, value: entry.bytes } : { success: false, code: WordFileError.Io };
    },
  };
}

/** Lay the document out headlessly with the resolver and return each paragraph's line box height. */
async function lineHeights(bytes: Uint8Array, api: WordFontApi, declarations: WordDocumentFontDecl[] = []) {
  let report: WordFontReportEntry[] = [];
  const resolver = createWordFontResolver({ api, declarations: () => declarations, onReport: entries => { report = entries; } });
  const opened = await openFontBackedDocumentForExport(bytes, { fonts: [resolver] });
  if (!opened.ok) throw new Error(`layout refused: ${opened.reason}`);
  try {
    const layout = await opened.session.layout();
    const heights = layout.pages.flatMap(page => page.fragments.flatMap(fragment =>
      'lines' in fragment && Array.isArray(fragment.lines) ? fragment.lines.map(line => line.box.height) : []));
    return { heights, report };
  } finally {
    opened.session.dispose();
  }
}

describe('Word font resolver', () => {
  test('bundled CJK stand-in metrics match the shipped font files', async () => {
    const [face] = await readFontFaces(bufferSource(fs.readFileSync(path.join(fontsRoot, 'NotoSansSC-Regular.otf'))));
    const resolverFallback = computeWordLineMetrics({
      unitsPerEm: 1000, winAscent: 1160, winDescent: 288, hheaAscender: 1160, hheaDescender: -288, hheaLineGap: 0,
      typoAscender: 880, typoDescender: -120, typoLineGap: 0, useTypoMetrics: false, codePageRange1: 0x60060107,
    });
    expect(computeWordLineMetrics(face.metrics)).toEqual(resolverFallback);
  });

  test('missing Chinese fonts keep Word\'s CJK line box through their stand-in', async () => {
    const document = await fontSampleDocument([
      { font: '宋体', text: '宋体正文示例' },
      { font: 'Microsoft YaHei', text: '微软雅黑正文' },
      { font: 'Calibri', eastAsia: '等线', text: 'Calibri 与等线' },
    ]);
    const { heights, report } = await lineHeights(document, fakeApi([]));
    // SimSun is 1.0 em in Word's metrics, YaHei 1.3198 em; Word adds 30% to CJK fonts.
    expect(heights[0]).toBeCloseTo(12 * 1.3, 2);
    expect(heights[1]).toBeCloseTo(12 * computeWordLineMetrics(knownWordFontMetrics('Microsoft YaHei')!)!.heightEm, 2);
    expect(heights[2]).toBeGreaterThanOrEqual(12 * computeWordLineMetrics(knownWordFontMetrics('等线')!)!.heightEm - 0.01);
    expect(report).toEqual(expect.arrayContaining([
      { family: '宋体', source: WordFontSource.Substitute, substitute: 'Noto Sans SC' },
      { family: 'Microsoft YaHei', source: WordFontSource.Substitute, substitute: 'Noto Sans SC' },
      { family: 'Calibri', source: WordFontSource.Substitute, substitute: 'Carlito' },
    ]));
  });

  test('installed fonts are used directly with Word\'s Windows line box', async () => {
    const arial = await installedFace('LiberationSans-Regular.ttf', 'Arial', 'Arial');
    const document = await fontSampleDocument([{ font: 'Arial', text: 'Installed Arial line' }]);
    const { heights, report } = await lineHeights(document, fakeApi([arial]));
    expect(heights[0]).toBeCloseTo(12 * computeWordLineMetrics(arial.face.metrics)!.heightEm, 2);
    expect(heights[0]).toBeCloseTo(12 * 1.1499, 2);
    expect(report).toContainEqual({ family: 'Arial', source: WordFontSource.Available });
  });

  test('宋体 prefers an installed Song face and keeps SimSun\'s metrics', async () => {
    const song = await installedFace('NotoSansSC-Regular.otf', 'Songti SC', 'Songti SC');
    const document = await fontSampleDocument([{ font: '宋体', text: '宋体段落' }]);
    const { heights, report } = await lineHeights(document, fakeApi([song]), [{ name: '宋体', altName: 'SimSun', charset: '86' }]);
    expect(heights[0]).toBeCloseTo(12 * 1.3, 2);
    expect(report).toContainEqual({ family: '宋体', source: WordFontSource.Substitute, substitute: 'Songti SC' });
  });

  test('unknown Latin fonts fall back by class, not to a CJK face', async () => {
    const document = await fontSampleDocument([{ font: 'Garamond Premier', text: 'Serif fallback' }, { font: 'Consolas', text: 'let x = 1;' }]);
    const { report } = await lineHeights(document, fakeApi([]), [{ name: 'Consolas', pitch: 'fixed', family: 'modern' }]);
    expect(report).toEqual(expect.arrayContaining([
      { family: 'Garamond Premier', source: WordFontSource.Substitute, substitute: 'Liberation Serif' },
      { family: 'Consolas', source: WordFontSource.Substitute, substitute: 'Liberation Mono' },
    ]));
  });
});
