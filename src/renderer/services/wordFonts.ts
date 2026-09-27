import type { FontFaceRequest, FontSource, FontSourceSubstitution } from '@docx-editor.dev/core/contracts/editor';
import {
  createFontSource, defineFontResolver, type FontConfigurationFragment, type FontResolutionRequest, type MarkedFontResolver,
} from '@docx-editor.dev/core/editor';
import wasmUrl from '@docx-editor.dev/core/harfbuzz.wasm?url';
import { initializeHarfBuzz, setHarfBuzzWasmUrl } from '@docx-editor.dev/core/layout';

import type { WordFontApi } from '../../shared/artifactPreview/wordEditing';
import {
CjkSerifStyle, cjkSerifStyle,   classifyWordFont, computeWordLineMetrics, fontNameKey, knownWordFontMetrics,
  type WordDocumentFontDecl, WordFontClass, type WordFontMetrics, WordFontStyle, type WordLineMetrics, type WordSystemFontFace,
} from '../../shared/artifactPreview/wordFonts';

const fontUrls = import.meta.glob('../assets/word-fonts/*.{ttf,otf}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

/** The engine refuses faces over 64 MiB and font sets over 128 MiB per document. */
const MAX_FACE_BYTES = 64 * 1024 * 1024;
const DOCUMENT_FONT_BUDGET = 120 * 1024 * 1024;
const CACHE_BUDGET = 160 * 1024 * 1024;
const REGULAR = 400;
const BOLD = 700;
const SLOTS: readonly FontFaceRequest[] = [
  { family: '', weight: REGULAR, style: WordFontStyle.Normal },
  { family: '', weight: BOLD, style: WordFontStyle.Normal },
  { family: '', weight: REGULAR, style: WordFontStyle.Italic },
  { family: '', weight: BOLD, style: WordFontStyle.Italic },
];

export const WordFontSource = { Available: 'available', Substitute: 'substitute', Missing: 'missing' } as const;
export type WordFontSource = typeof WordFontSource[keyof typeof WordFontSource];

/** What the document asked for and what actually draws it, for the status bar. */
export interface WordFontReportEntry {
  family: string;
  source: WordFontSource;
  /** The stand-in family when the requested one is not installed. */
  substitute?: string;
}

interface BundledFace {
  url: string;
  family: string;
  weight: number;
  style: WordFontStyle;
}

/** Bundled open-licensed faces: Word's metric-compatible twins plus a CJK stand-in. */
const BUNDLED_FACES: BundledFace[] = Object.entries(fontUrls).flatMap(([filePath, url]) => {
  const match = /\/(Carlito|Caladea|LiberationSans|LiberationSerif|LiberationMono|NotoSansSC)-(Regular|Bold|Italic|BoldItalic)\.(?:ttf|otf)$/.exec(filePath);
  if (!match) return [];
  const family = { LiberationSans: 'Liberation Sans', LiberationSerif: 'Liberation Serif', LiberationMono: 'Liberation Mono', NotoSansSC: 'Noto Sans SC' }[match[1]] ?? match[1];
  return [{ url, family, weight: match[2].startsWith('Bold') ? BOLD : REGULAR, style: match[2].endsWith('Italic') ? WordFontStyle.Italic : WordFontStyle.Normal }];
});

const BundledFamily = {
  Sans: 'Liberation Sans', Serif: 'Liberation Serif', Mono: 'Liberation Mono', Calibri: 'Carlito', Cambria: 'Caladea', Cjk: 'Noto Sans SC',
} as const;

/** Faces whose advance widths match the Word font, so line breaks survive the swap. */
const METRIC_TWINS: Readonly<Record<string, string>> = Object.fromEntries([
  ...['Calibri', 'Carlito'].map(name => [fontNameKey(name), BundledFamily.Calibri]),
  ...['Cambria', 'Caladea'].map(name => [fontNameKey(name), BundledFamily.Cambria]),
  ...['Arial', 'Helvetica', 'Arial MT', 'Arimo', 'Liberation Sans'].map(name => [fontNameKey(name), BundledFamily.Sans]),
  ...['Times New Roman', 'Times', 'Tinos', 'Liberation Serif'].map(name => [fontNameKey(name), BundledFamily.Serif]),
  ...['Courier New', 'Courier', 'Cousine', 'Liberation Mono'].map(name => [fontNameKey(name), BundledFamily.Mono]),
  [fontNameKey('Noto Sans SC'), BundledFamily.Cjk],
]);

const CLASS_STAND_INS: Readonly<Record<WordFontClass, string>> = {
  [WordFontClass.Sans]: BundledFamily.Sans,
  [WordFontClass.Serif]: BundledFamily.Serif,
  [WordFontClass.Mono]: BundledFamily.Mono,
  [WordFontClass.CjkSans]: BundledFamily.Cjk,
  [WordFontClass.CjkSerif]: BundledFamily.Cjk,
};

/** Installed Song faces: the stand-in for 宋体, and the fallback for 楷体 and 仿宋. */
const INSTALLED_SONG = ['SimSun', 'Songti SC', 'STSong', 'ShuS-SC', 'Noto Serif CJK SC', 'Noto Serif SC', 'Source Han Serif SC', 'AR PL UMing CN'];
/** Installed faces of the same brush style, tried before the bundled sans stand-in. */
const INSTALLED_CJK_SERIF: Readonly<Record<CjkSerifStyle, readonly string[]>> = {
  [CjkSerifStyle.Song]: INSTALLED_SONG,
  [CjkSerifStyle.Kai]: ['KaiTi', 'KaiTi_GB2312', 'STKaiti', 'Kaiti SC', 'HYKaiTiJ', 'AR PL UKai CN', ...INSTALLED_SONG],
  [CjkSerifStyle.Fang]: ['FangSong', 'FangSong_GB2312', 'STFangsong', 'FangS-SC', ...INSTALLED_SONG],
};

/** Measured from the bundled NotoSansSC OTF files (see wordFonts.test.ts). */
const NOTO_SANS_SC_METRICS: WordFontMetrics = {
  unitsPerEm: 1000, winAscent: 1160, winDescent: 288, hheaAscender: 1160, hheaDescender: -288, hheaLineGap: 0,
  typoAscender: 880, typoDescender: -120, typoLineGap: 0, useTypoMetrics: false, codePageRange1: 0x60060107,
};

let harfBuzz: Promise<void> | undefined;
/** HarfBuzz and every font resolve locally, before the editor accepts its first keystroke. */
export function prepareWordLayout(): Promise<void> {
  harfBuzz ??= (async () => {
    setHarfBuzzWasmUrl(wasmUrl);
    await initializeHarfBuzz();
  })().catch(error => { harfBuzz = undefined; throw error; });
  return harfBuzz;
}

interface CachedBytes { bytes: Promise<Uint8Array>; size: number }
const byteCache = new Map<string, CachedBytes>();
let cachedBytes = 0;

function cached(key: string, size: number, load: () => Promise<Uint8Array>): Promise<Uint8Array> {
  const hit = byteCache.get(key);
  if (hit) {
    byteCache.delete(key);
    byteCache.set(key, hit);
    return hit.bytes;
  }
  const entry: CachedBytes = { bytes: load(), size };
  byteCache.set(key, entry);
  cachedBytes += size;
  entry.bytes.catch(() => {
    if (byteCache.get(key) === entry) { byteCache.delete(key); cachedBytes -= size; }
  });
  for (const [oldest, value] of byteCache) {
    if (cachedBytes <= CACHE_BUDGET || oldest === key) break;
    byteCache.delete(oldest);
    cachedBytes -= value.size;
  }
  return entry.bytes;
}

async function fetchBundled(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Bundled Word font unavailable');
  return new Uint8Array(await response.arrayBuffer());
}

interface PlannedFace {
  key: string;
  request: FontFaceRequest;
  size: number;
  lineMetrics?: WordLineMetrics;
  load: () => Promise<Uint8Array>;
}

interface FamilyPlan {
  family: string;
  faces: PlannedFace[];
  report: WordFontReportEntry;
}

const slotWeight = (weight: number): number => (weight >= 600 ? BOLD : REGULAR);

/**
 * Every face registers under its own private family. A document family then always reaches it
 * through a substitution, which is where Word's line box is attached; a source named like the
 * document's family would make the engine skip that substitution and use browser metrics.
 */
function privateFamily(key: string): string {
  let hash = 0x811c9dc5;
  for (const char of key) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0;
  return `LobsterAI Word ${hash.toString(36)}`;
}

/** Nearest planned face for a slot: same slant first, then the closest weight. */
function nearest(faces: PlannedFace[], slot: FontFaceRequest): PlannedFace | undefined {
  const score = (face: PlannedFace) => (face.request.style === slot.style ? 0 : 1000) + Math.abs(face.request.weight - slot.weight);
  return faces.reduce<PlannedFace | undefined>((best, face) => (!best || score(face) < score(best) ? face : best), undefined);
}

export interface WordFontResolverOptions {
  api: WordFontApi;
  declarations: () => readonly WordDocumentFontDecl[];
  onReport: (entries: WordFontReportEntry[]) => void;
}

/**
 * Resolve the document's fonts the way Word would find them on this machine:
 * the installed font first (宋体 = SimSun), then a width-compatible twin, then a stand-in of
 * the same class. Every face carries Word's line box, including the CJK line height rule.
 */
export function createWordFontResolver(options: WordFontResolverOptions): MarkedFontResolver {
  return defineFontResolver(async (request: FontResolutionRequest): Promise<FontConfigurationFragment | undefined> => {
    const declarations = new Map(options.declarations().map(decl => [fontNameKey(decl.name), decl]));
    const wanted: string[] = [];
    for (const family of [...request.families, request.defaultFamily]) {
      if (family && !wanted.some(name => fontNameKey(name) === fontNameKey(family))) wanted.push(family);
    }
    const lookups = new Set<string>(wanted);
    for (const family of wanted) {
      const altName = declarations.get(fontNameKey(family))?.altName;
      if (altName) lookups.add(altName);
    }
    for (const family of wanted) {
      const decl = declarations.get(fontNameKey(family));
      if (classifyWordFont(family, decl) !== WordFontClass.CjkSerif) continue;
      for (const name of INSTALLED_CJK_SERIF[cjkSerifStyle(family, decl)]) lookups.add(name);
    }
    let installed: WordSystemFontFace[] = [];
    const resolved = await options.api.resolveFonts([...lookups]);
    if (resolved.success) installed = resolved.value.faces;
    else console.warn('[WordFonts] Installed fonts unavailable:', resolved.code);
    const installedFor = (name: string | undefined) => installed.filter(face => name && fontNameKey(face.requested) === fontNameKey(name));

    const systemFaces = (faces: WordSystemFontFace[], metricsFor: (face: WordSystemFontFace) => WordFontMetrics): PlannedFace[] =>
      faces.filter(face => face.byteLength <= MAX_FACE_BYTES).map(face => ({
        key: `installed:${face.id}`,
        request: { family: privateFamily(`installed:${face.id}`), weight: slotWeight(face.weight), style: face.style },
        size: face.byteLength,
        lineMetrics: computeWordLineMetrics(metricsFor(face)),
        load: () => cached(`installed:${face.id}`, face.byteLength, async () => {
          const bytes = await options.api.readFont(face.id);
          if (!bytes.success) throw new Error(`Installed font unavailable: ${bytes.code}`);
          return bytes.value;
        }),
      }));
    const bundledFaces = (family: string, lineMetrics?: WordLineMetrics): PlannedFace[] =>
      BUNDLED_FACES.filter(face => face.family === family).map(face => ({
        key: `bundled:${face.url}`,
        request: { family: privateFamily(`bundled:${face.url}`), weight: face.weight, style: face.style },
        // Bundled faces are small except the CJK stand-in; estimate until fetched.
        size: family === BundledFamily.Cjk ? 8.5 * 1024 * 1024 : 512 * 1024,
        lineMetrics,
        load: () => cached(`bundled:${face.url}`, 0, () => fetchBundled(face.url)),
      }));

    const plans: FamilyPlan[] = wanted.map(family => {
      const decl = declarations.get(fontNameKey(family));
      const own = installedFor(family).length ? installedFor(family) : installedFor(decl?.altName);
      if (own.length) {
        return { family, faces: systemFaces(own, face => face.metrics), report: { family, source: WordFontSource.Available } };
      }
      const original = knownWordFontMetrics(family) ?? (decl?.altName ? knownWordFontMetrics(decl.altName) : undefined);
      const fontClass = classifyWordFont(family, decl);
      const cjk = fontClass === WordFontClass.CjkSans || fontClass === WordFontClass.CjkSerif;
      const twin = METRIC_TWINS[fontNameKey(family)];
      if (!twin && fontClass === WordFontClass.CjkSerif) {
        const serif = INSTALLED_CJK_SERIF[cjkSerifStyle(family, decl)].find(name => installedFor(name).length);
        if (serif) {
          // 宋体, 楷体 and 仿宋 have no bold face in Windows: Word emboldens the regular one.
          // Doing the same keeps their look and skips a second 20 MB face.
          const regular = installedFor(serif).filter(face => face.weight < 600);
          const faces = systemFaces(regular.length ? regular : installedFor(serif), face => original ?? face.metrics);
          return { family, faces, report: { family, source: WordFontSource.Substitute, substitute: installedFor(serif)[0].family } };
        }
      }
      const standIn = twin ?? CLASS_STAND_INS[fontClass];
      // A twin already has the original's line box; a CJK stand-in borrows the original's.
      const lineMetrics = original ? computeWordLineMetrics(original) : cjk ? computeWordLineMetrics(NOTO_SANS_SC_METRICS) : undefined;
      const same = fontNameKey(standIn) === fontNameKey(family);
      return {
        family,
        faces: bundledFaces(standIn, lineMetrics),
        report: same ? { family, source: WordFontSource.Available } : { family, source: WordFontSource.Substitute, substitute: standIn },
      };
    });

    // Regular faces first so a large document keeps every family readable within budget.
    const order = [...plans.flatMap(plan => plan.faces.map(face => ({ plan, face })))]
      .sort((a, b) => (a.face.request.weight + (a.face.request.style === WordFontStyle.Italic ? 1000 : 0))
        - (b.face.request.weight + (b.face.request.style === WordFontStyle.Italic ? 1000 : 0)));
    const chosen = new Map<string, PlannedFace>();
    let budget = DOCUMENT_FONT_BUDGET;
    for (const { face } of order) {
      if (chosen.has(face.key) || face.size > budget) continue;
      chosen.set(face.key, face);
      budget -= face.size;
    }
    const loaded = new Map<string, FontSource>();
    await Promise.all([...chosen.values()].map(async face => {
      try {
        const bytes = await face.load();
        const source = createFontSource(bytes, face.request, { id: face.key, maxFontBytes: MAX_FACE_BYTES });
        if ('failure' in source) console.warn('[WordFonts] Font face refused:', face.request.family, source.failure.reason);
        else loaded.set(face.key, source.source);
      } catch (error) {
        console.warn('[WordFonts] Could not load font face:', face.request.family, error);
      }
    }));

    const sources = [...loaded.values()];
    const substitutions: FontSourceSubstitution[] = [];
    const report: WordFontReportEntry[] = [];
    for (const plan of plans) {
      const available = plan.faces.filter(face => loaded.has(face.key));
      if (!available.length) {
        report.push({ family: plan.family, source: WordFontSource.Missing });
        continue;
      }
      report.push(plan.report);
      for (const slot of SLOTS) {
        const target = nearest(available, slot)!;
        substitutions.push({
          from: { family: plan.family, weight: slot.weight, style: slot.style },
          to: target.request,
          ...(target.lineMetrics ? { lineMetrics: target.lineMetrics } : {}),
        });
      }
    }
    options.onReport(report);
    return { sources, substitutions };
  });
}
