/**
 * Font facts shared by the main-process font catalog and the renderer's Word font resolver.
 *
 * Word lays out a line from the font's Windows metrics, not from the `hhea` extents a browser
 * or HarfBuzz reports, and it adds extra height to every font that advertises a CJK code page.
 * The editor engine only knows the `hhea` rule, so LobsterAI supplies Word's line box explicitly.
 */

/** Vertical metrics of one face, in font units. */
export interface WordFontMetrics {
  unitsPerEm: number;
  winAscent: number;
  winDescent: number;
  hheaAscender: number;
  hheaDescender: number;
  hheaLineGap: number;
  typoAscender: number;
  typoDescender: number;
  typoLineGap: number;
  useTypoMetrics: boolean;
  /** OS/2 ulCodePageRange1, used to detect the fonts Word treats as CJK. */
  codePageRange1: number;
}

/** Word's line box for a face, as em ratios of the font size. */
export interface WordLineMetrics {
  heightEm: number;
  baselineEm: number;
}

/**
 * Word (and LibreOffice's Word-compatibility mode, tdf#129808) enlarges the line box of every
 * font whose OS/2 table claims CP932, CP936, CP949 or CP950 coverage, whatever the text is.
 * Measured Word output puts the factor at about 1.3 with the extra space split evenly above and
 * below the glyphs (ONLYOFFICE DocumentServer#487); this is why 12pt SimSun is 15.6pt single.
 */
export const WORD_CJK_LINE_HEIGHT_FACTOR = 1.3;
const CJK_CODE_PAGE_BITS = [17, 18, 19, 20];
const MAX_LINE_HEIGHT_EM = 4;

export function isCjkCodePageRange(codePageRange1: number): boolean {
  return CJK_CODE_PAGE_BITS.some(bit => ((codePageRange1 >>> bit) & 1) === 1);
}

/** Word's single-spacing line box: Windows ascent/descent plus GDI's external leading. */
export function computeWordLineMetrics(metrics: WordFontMetrics): WordLineMetrics | undefined {
  const { unitsPerEm } = metrics;
  if (!Number.isFinite(unitsPerEm) || unitsPerEm <= 0) return undefined;
  let ascent: number;
  let descent: number;
  let leading: number;
  if (metrics.useTypoMetrics && metrics.typoAscender > 0) {
    ascent = metrics.typoAscender;
    descent = Math.abs(metrics.typoDescender);
    leading = Math.max(0, metrics.typoLineGap);
  } else {
    ascent = metrics.winAscent;
    descent = metrics.winDescent;
    const hheaHeight = metrics.hheaAscender - metrics.hheaDescender;
    leading = Math.max(0, metrics.hheaLineGap - ((ascent + descent) - hheaHeight));
  }
  if (!(ascent > 0) || descent < 0) return undefined;
  let height = ascent + descent + leading;
  let baseline = ascent + leading;
  if (isCjkCodePageRange(metrics.codePageRange1)) {
    const extra = height * (WORD_CJK_LINE_HEIGHT_FACTOR - 1);
    height += extra;
    baseline += extra / 2;
  }
  const heightEm = height / unitsPerEm;
  const baselineEm = baseline / unitsPerEm;
  if (!Number.isFinite(heightEm) || heightEm <= 0 || heightEm > MAX_LINE_HEIGHT_EM || baselineEm > heightEm) {
    return undefined;
  }
  return { heightEm, baselineEm };
}

export const WordFontStyle = { Normal: 'normal', Italic: 'italic' } as const;
export type WordFontStyle = typeof WordFontStyle[keyof typeof WordFontStyle];

/** One installed face found by the main-process catalog. Bytes are fetched separately. */
export interface WordSystemFontFace {
  id: string;
  /** The catalog family name that matched the request. */
  family: string;
  /** The requested name this face answers. */
  requested: string;
  weight: number;
  style: WordFontStyle;
  byteLength: number;
  metrics: WordFontMetrics;
}

export interface WordFontResolveResult {
  faces: WordSystemFontFace[];
}

/** `w:font` declarations from `word/fontTable.xml`, used to choose a stand-in class. */
export interface WordDocumentFontDecl {
  name: string;
  altName?: string;
  /** `w:family`: roman, swiss, modern, script, decorative or auto. */
  family?: string;
  /** `w:charset` as hex, e.g. 86 for GB2312. */
  charset?: string;
  /** `w:pitch`: fixed, variable or default. */
  pitch?: string;
}

/** Families Word ships under both a Chinese and an English name. */
export const WORD_FONT_ALIASES: readonly (readonly string[])[] = [
  ['宋体', 'SimSun'],
  ['新宋体', 'NSimSun'],
  ['黑体', 'SimHei'],
  ['楷体', 'KaiTi', '楷体_GB2312', 'KaiTi_GB2312'],
  ['仿宋', 'FangSong', '仿宋_GB2312', 'FangSong_GB2312'],
  ['微软雅黑', 'Microsoft YaHei'],
  ['微软雅黑 Light', 'Microsoft YaHei Light'],
  ['等线', 'DengXian'],
  ['等线 Light', 'DengXian Light'],
  ['幼圆', 'YouYuan'],
  ['隶书', 'LiSu'],
  ['华文宋体', 'STSong'],
  ['华文中宋', 'STZhongsong'],
  ['华文仿宋', 'STFangsong'],
  ['华文楷体', 'STKaiti'],
  ['华文黑体', 'STHeiti'],
  ['华文细黑', 'STXihei'],
  ['苹方-简', 'PingFang SC'],
  ['宋体-简', 'Songti SC'],
  ['黑体-简', 'Heiti SC'],
  ['楷体-简', 'Kaiti SC'],
  ['冬青黑体简体中文', 'Hiragino Sans GB'],
  ['思源黑体', 'Source Han Sans SC', 'Source Han Sans CN'],
  ['思源宋体', 'Source Han Serif SC', 'Source Han Serif CN'],
  ['Arial', 'Helvetica', 'Arial MT'],
  ['Times New Roman', 'Times'],
  ['Courier New', 'Courier'],
];

export function fontNameKey(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The requested name first, then every alias Word treats as the same family. */
export function wordFontAliases(name: string): string[] {
  const key = fontNameKey(name);
  const names = [name];
  for (const group of WORD_FONT_ALIASES) {
    if (group.some(alias => fontNameKey(alias) === key)) {
      for (const alias of group) if (fontNameKey(alias) !== key) names.push(alias);
    }
  }
  return names;
}

export const WordFontClass = {
  CjkSerif: 'cjk-serif',
  CjkSans: 'cjk-sans',
  Serif: 'serif',
  Sans: 'sans',
  Mono: 'mono',
} as const;
export type WordFontClass = typeof WordFontClass[keyof typeof WordFontClass];

/** GB2312, Big5, Shift-JIS and Hangul font charsets in `fontTable.xml`. */
const CJK_CHARSETS = new Set(['86', '88', '80', '81', '82']);

/** Classify a font Word would lay out, for choosing a stand-in when it is not installed. */
export function classifyWordFont(name: string, decl?: WordDocumentFontDecl): WordFontClass {
  const text = `${name} ${decl?.altName ?? ''}`;
  const cjk = /[\u3400-\u9fff]/.test(text) || (decl?.charset !== undefined && CJK_CHARSETS.has(decl.charset.toUpperCase()))
    || /(simsun|nsimsun|simhei|simkai|simfang|kaiti|fangsong|songti|heiti|yahei|dengxian|youyuan|lisu|st(song|zhongsong|fangsong|kaiti|heiti|xihei)|pingfang|hiragino|noto (sans|serif) cjk|source han|mingliu|pmingliu|mincho|ms p?gothic|yu gothic|meiryo|batang|gulim|dotum|malgun)/i.test(text);
  if (cjk) {
    if (/(宋|明|仿|楷|song|ming|kai|fang|mincho|batang|serif)/i.test(text)) return WordFontClass.CjkSerif;
    return WordFontClass.CjkSans;
  }
  if (decl?.pitch === 'fixed' || decl?.family === 'modern' || /(mono|courier|consolas|menlo|code)/i.test(name)) {
    return WordFontClass.Mono;
  }
  if (decl?.family === 'roman' || /(times|roman|serif|georgia|garamond|cambria|book|minion|palatino|baskerville)/i.test(name)) {
    return WordFontClass.Serif;
  }
  return WordFontClass.Sans;
}

export const CjkSerifStyle = { Song: 'song', Kai: 'kai', Fang: 'fang' } as const;
export type CjkSerifStyle = typeof CjkSerifStyle[keyof typeof CjkSerifStyle];

/** 楷体 and 仿宋 look unlike 宋体; pick a stand-in of the same brush style when one is installed. */
export function cjkSerifStyle(name: string, decl?: WordDocumentFontDecl): CjkSerifStyle {
  const text = `${name} ${decl?.altName ?? ''}`;
  if (/(楷|kai)/i.test(text)) return CjkSerifStyle.Kai;
  if (/(仿|fang)/i.test(text)) return CjkSerifStyle.Fang;
  return CjkSerifStyle.Song;
}

/**
 * Windows metrics of common Office fonts, for documents opened where the font is not installed.
 * A stand-in then keeps the original line box even though its glyphs differ. Installed fonts
 * always use their own tables instead of this list.
 */
export const KNOWN_WORD_FONT_METRICS: Readonly<Record<string, WordFontMetrics>> = (() => {
  const cjk = 1 << 18;
  const metrics = (unitsPerEm: number, winAscent: number, winDescent: number, codePageRange1 = cjk): WordFontMetrics => ({
    unitsPerEm, winAscent, winDescent, hheaAscender: winAscent, hheaDescender: -winDescent, hheaLineGap: 0,
    typoAscender: winAscent, typoDescender: -winDescent, typoLineGap: 0, useTypoMetrics: false, codePageRange1,
  });
  const gb = metrics(256, 220, 36);
  const yahei = metrics(2048, 2167, 536);
  const dengxian = metrics(2048, 1659, 475);
  const table: Record<string, WordFontMetrics> = {};
  const add = (names: readonly string[], value: WordFontMetrics) => { for (const name of names) table[fontNameKey(name)] = value; };
  add(['宋体', 'SimSun', '新宋体', 'NSimSun', '黑体', 'SimHei', '楷体', 'KaiTi', '楷体_GB2312', 'KaiTi_GB2312',
    '仿宋', 'FangSong', '仿宋_GB2312', 'FangSong_GB2312'], gb);
  add(['微软雅黑', 'Microsoft YaHei', '微软雅黑 Light', 'Microsoft YaHei Light', 'Microsoft YaHei UI'], yahei);
  add(['等线', 'DengXian', '等线 Light', 'DengXian Light'], dengxian);
  add(['华文中宋', 'STZhongsong'], metrics(1000, 912, 225));
  return table;
})();

export function knownWordFontMetrics(name: string): WordFontMetrics | undefined {
  for (const alias of wordFontAliases(name)) {
    const metrics = KNOWN_WORD_FONT_METRICS[fontNameKey(alias)];
    if (metrics) return metrics;
  }
  return undefined;
}
