import fs from 'node:fs';
import path from 'node:path';

import { openFontBackedDocumentForExport } from '@docx-editor.dev/core/export';
import { createLayoutShaping, disposeLayoutShaping } from '@docx-editor.dev/core/layout';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import JSZip from 'jszip';
import { beforeAll, describe, expect, test, vi } from 'vitest';

import { buildBlankWordBytes } from '../../../../main/office/blankDocuments';
import { bufferSource, readFontFaces } from '../../../../main/office/word/fonts/sfnt';
import { inspectWordPackage } from '../../../../main/office/word/wordPackage';
import { OfficeFileError } from '../../../../shared/office/core/officeFile';
import type { WordFontApi } from '../../../../shared/office/word/wordFile';
import {
  classifyWordFont, computeWordLineMetrics, knownWordFontMetrics, type WordDocumentFontDecl, WordFontClass,
  WordFontStyle, type WordSystemFontFace,
} from '../../../../shared/office/word/wordFonts';
import { createWordFontResolver, visibleSubstitutedWordFonts, type WordFontReportEntry, WordFontSource } from './wordFonts';

const repository = path.resolve(__dirname, '../../../../..');
const fontsRoot = path.join(repository, 'src/renderer/assets/office-fonts');
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
      return entry ? { success: true, value: entry.bytes } : { success: false, code: OfficeFileError.Io };
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

  test('engine fallback defaultFamily is not reported when the document names its own font', async () => {
    const document = await fontSampleDocument([{ font: '等线', text: '默认等线正文' }]);
    const { heights, report } = await lineHeights(document, fakeApi([]), [{ name: '等线', altName: 'DengXian', charset: '86' }]);
    expect(heights[0]).toBeCloseTo(12 * computeWordLineMetrics(knownWordFontMetrics('等线')!)!.heightEm, 2);
    expect(report).toEqual([{ family: '等线', source: WordFontSource.Substitute, substitute: 'Noto Sans SC' }]);
    // Seamless metric-matched CJK sans stand-in stays quiet in the status bar.
    expect(visibleSubstitutedWordFonts(report)).toEqual([]);
  });

  test('visibleSubstitutedWordFonts keeps non-seamless substitutions and missing fonts visible', () => {
    const entries: WordFontReportEntry[] = [
      { family: 'Arial', source: WordFontSource.Available },
      { family: '等线', source: WordFontSource.Substitute, substitute: 'Noto Sans SC' },
      { family: '宋体', source: WordFontSource.Substitute, substitute: 'Noto Sans SC' },
      { family: 'CustomFont', source: WordFontSource.Missing },
    ];
    expect(visibleSubstitutedWordFonts(entries)).toEqual([
      { family: '宋体', source: WordFontSource.Substitute, substitute: 'Noto Sans SC' },
      { family: 'CustomFont', source: WordFontSource.Missing },
    ]);
  });

  test('blank Word document lays out with clean title height, clear paragraph distinction, and zero visible font warnings', async () => {
    const blank = buildBlankWordBytes();
    const info = inspectWordPackage(blank);
    const parts = unzipSync(blank);
    const docXml = strFromU8(parts['word/document.xml']).replace(
      '<w:p/>',
      '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>文档标题示例</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>这是一段会自动换行到第二行的正文段落内容，用来验证段内行距与段后间距之间有清晰且舒适的视觉层次对比效果。</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>第二段正文</w:t></w:r></w:p>',
    );
    parts['word/document.xml'] = strToU8(docXml);
    const sample = zipSync(parts);

    let report: WordFontReportEntry[] = [];
    const resolver = createWordFontResolver({ api: fakeApi([]), declarations: () => info.fonts, onReport: entries => { report = entries; } });
    const opened = await openFontBackedDocumentForExport(sample, { fonts: [resolver] });
    if (!opened.ok) throw new Error(`layout refused: ${opened.reason}`);
    try {
      const layout = await opened.session.layout();
      const paragraphs = layout.pages[0].fragments.flatMap(fragment => (
        'lines' in fragment && Array.isArray(fragment.lines) ? [fragment] : []
      ));
      expect(paragraphs).toHaveLength(3);
      expect(paragraphs[0].box.height).toBeLessThan(50);
      expect(paragraphs[1].lines.length).toBeGreaterThanOrEqual(2);
      const intraLineStep = paragraphs[1].lines[1].box.y - paragraphs[1].lines[0].box.y;
      const interParaStep = paragraphs[2].lines[0].box.y - paragraphs[1].lines[paragraphs[1].lines.length - 1].box.y;
      const intraGap = intraLineStep - 12;
      const interGap = interParaStep - 12;
      expect(intraLineStep).toBeCloseTo(18.7, 0);
      expect(interParaStep - intraLineStep).toBeCloseTo(8, 1);
      expect(interGap / intraGap).toBeGreaterThan(2);
      expect(report).toEqual([{ family: '等线', source: WordFontSource.Substitute, substitute: 'Noto Sans SC' }]);
      expect(visibleSubstitutedWordFonts(report)).toEqual([]);
    } finally {
      opened.session.dispose();
    }
  });

  test('reuses cached FontSource across opens without re-reading installed font bytes', async () => {
    const face = await installedFace('LiberationSans-Regular.ttf', 'CacheProbeFont', 'CacheProbeFont');
    const readFont = vi.fn(async () => ({ success: true as const, value: face.bytes }));
    const api: WordFontApi = {
      resolveFonts: async families => ({
        success: true,
        value: { faces: families.includes('CacheProbeFont') ? [face.face] : [] },
      }),
      readFont,
    };
    const first = await fontSampleDocument([{ font: 'CacheProbeFont', text: 'First open' }]);
    const second = await fontSampleDocument([{ font: 'CacheProbeFont', text: 'Second open' }]);
    await lineHeights(first, api);
    await lineHeights(second, api);
    expect(readFont).toHaveBeenCalledTimes(1);
  });

  test('loads only the regular face for an unused engine defaultFamily', async () => {
    const resolver = createWordFontResolver({
      api: fakeApi([]),
      declarations: () => [{ name: '等线', altName: 'DengXian', charset: '86' }],
      onReport: () => undefined,
    });
    const config = await resolver({ families: ['等线'], defaultFamily: 'Calibri' });
    const calibriFaces = (config?.sources ?? []).filter(source => source.id.includes('Carlito'));
    expect(calibriFaces).toHaveLength(1);
    expect(calibriFaces[0].request).toMatchObject({ weight: 400, style: WordFontStyle.Normal });
  });

  test('skips huge installed CJK serif bold faces when a regular face is available', async () => {
    const regularBase = await installedFace('NotoSansSC-Regular.otf', 'Songti SC', 'Songti SC');
    const regular = { ...regularBase, face: { ...regularBase.face, id: 'regular-songti-probe' } };
    const boldBytes = await installedFace('NotoSansSC-Bold.otf', 'Songti SC', 'Songti SC');
    const hugeBoldFace: WordSystemFontFace = {
      ...boldBytes.face,
      id: 'huge-songti-bold',
      weight: 700,
      byteLength: 21 * 1024 * 1024,
    };
    const readFont = vi.fn(async (id: string) => (
      id === regular.face.id
        ? { success: true as const, value: regular.bytes }
        : { success: true as const, value: boldBytes.bytes }
    ));
    const api: WordFontApi = {
      resolveFonts: async families => ({
        success: true,
        value: { faces: families.includes('Songti SC') ? [regular.face, hugeBoldFace] : [] },
      }),
      readFont,
    };
    const resolver = createWordFontResolver({
      api,
      declarations: () => [{ name: 'Songti SC', charset: '86' }],
      onReport: () => undefined,
    });
    const config = await resolver({ families: ['Songti SC'], defaultFamily: 'Calibri' });
    expect(readFont).toHaveBeenCalledWith(regular.face.id);
    expect(readFont).not.toHaveBeenCalledWith('huge-songti-bold');
    expect((config?.sources ?? []).some(source => source.id === `installed:${regular.face.id}`)).toBe(true);
  });

  test('patched async WebCrypto font admission still verifies SHA-256 and rejects mismatched hashes', async () => {
    const resolver = createWordFontResolver({
      api: fakeApi([]),
      declarations: () => [{ name: '等线', altName: 'DengXian', charset: '86' }],
      onReport: () => undefined,
    });
    const config = await resolver({ families: ['等线'], defaultFamily: 'Calibri' });
    const source = config!.sources![0];
    const valid = await createLayoutShaping({
      epoch: 1,
      maxFontBytes: 64 * 1024 * 1024,
      sources: [source],
      defaultFont: { family: source.request.family, sizeHalfPoints: 22 },
    });
    try {
      expect(valid.fonts.resolve(source.request)).not.toBeInstanceOf(Error);
    } finally {
      disposeLayoutShaping(valid);
    }
    const tampered = await createLayoutShaping({
      epoch: 2,
      maxFontBytes: 64 * 1024 * 1024,
      sources: [{ ...source, hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' }],
      defaultFont: { family: source.request.family, sizeHalfPoints: 22 },
    });
    try {
      expect(tampered.fonts.resolve(source.request)).toBeInstanceOf(Error);
    } finally {
      disposeLayoutShaping(tampered);
    }
  });

  test('classifies PingFang SC as CJK sans rather than FangSong serif', async () => {
    expect(classifyWordFont('PingFang SC')).toBe(WordFontClass.CjkSans);
    expect(classifyWordFont('苹方-简')).toBe(WordFontClass.CjkSans);
    expect(classifyWordFont('仿宋')).toBe(WordFontClass.CjkSerif);
    expect(classifyWordFont('STFangsong')).toBe(WordFontClass.CjkSerif);

    const fang = await installedFace('NotoSansSC-Regular.otf', 'FangS-SC', 'FangS-SC');
    const document = await fontSampleDocument([{ font: 'PingFang SC', text: '苹方正文示例' }]);
    const { report } = await lineHeights(document, fakeApi([fang]));
    expect(report).toContainEqual({ family: 'PingFang SC', source: WordFontSource.Substitute, substitute: 'Noto Sans SC' });
  });

  test('loads only lightweight regular stand-ins for unused template fonts outside activeFonts', async () => {
    const song = await installedFace('NotoSansSC-Regular.otf', 'Songti SC', 'Songti SC');
    const readFont = vi.fn(async () => ({ success: true as const, value: song.bytes }));
    const resolveFonts = vi.fn(async (families: string[]) => ({
      success: true as const,
      value: { faces: families.includes('Songti SC') ? [song.face] : [] },
    }));
    const resolver = createWordFontResolver({
      api: { resolveFonts, readFont },
      declarations: () => [
        { name: 'PingFang SC', charset: '86' },
        { name: 'ＭＳ 明朝', charset: '80' },
        { name: 'Calibri', charset: '00' },
      ],
      activeFonts: () => ['PingFang SC'],
      onReport: () => undefined,
    });
    const config = await resolver({ families: ['PingFang SC', 'ＭＳ 明朝', 'Calibri'], defaultFamily: 'Calibri' });
    // Unused template CJK serif must not trigger a 20 MB system Songti lookup/read.
    expect(resolveFonts).toHaveBeenCalledTimes(1);
    expect(resolveFonts.mock.calls[0][0]).not.toContain('Songti SC');
    expect(readFont).not.toHaveBeenCalled();
    // Unused Calibri loads only Regular Carlito instead of all 4 faces.
    const calibriFaces = (config?.sources ?? []).filter(source => source.id.includes('Carlito'));
    expect(calibriFaces).toHaveLength(1);
    expect(calibriFaces[0].request).toMatchObject({ weight: 400, style: WordFontStyle.Normal });
  });
});
