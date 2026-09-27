import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  fontNameKey, wordFontAliases, type WordFontMetrics, WordFontStyle, type WordSystemFontFace,
} from '../../../shared/artifactPreview/wordFonts';
import { type ByteSource, extractFace, readFontFaces, SfntError, type SfntFaceInfo } from './sfnt';

const CACHE_VERSION = 1;
const FONT_FILE = /\.(ttf|otf|ttc|otc)$/i;
const MAX_DIRECTORY_DEPTH = 5;
const MAX_FONT_FILES = 20000;
const PARSE_CONCURRENCY = 8;
/** The editor engine refuses larger faces. */
export const MAX_WORD_FONT_FACE_BYTES = 64 * 1024 * 1024;
const MAX_FAMILIES_PER_REQUEST = 64;
const REGULAR_WEIGHT = 400;
const BOLD_WEIGHT = 700;

interface CatalogFile {
  path: string;
  size: number;
  mtimeMs: number;
  faces: SfntFaceInfo[];
}

interface CatalogFace {
  id: string;
  path: string;
  faceIndex: number;
  families: string[];
  weight: number;
  italic: boolean;
  metrics: WordFontMetrics;
  byteLength: number;
}

interface CatalogCache {
  version: number;
  files: CatalogFile[];
}

export interface WordFontCatalogOptions {
  directories: string[];
  cachePath?: string;
}

/** Where Word-relevant fonts live on each platform, including Office's private font folders. */
export function defaultWordFontDirectories(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string[] {
  if (platform === 'win32') {
    const windows = env.WINDIR || env.SystemRoot || 'C:\\Windows';
    const local = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
    return [path.win32.join(windows, 'Fonts'), path.win32.join(local, 'Microsoft', 'Windows', 'Fonts')];
  }
  if (platform === 'darwin') {
    return [
      '/System/Library/Fonts',
      '/Library/Fonts',
      path.join(home, 'Library', 'Fonts'),
      // Office for Mac and WPS keep the Windows fonts they need inside their bundles.
      '/Applications/Microsoft Word.app/Contents/Resources/DFonts',
      '/Applications/Microsoft PowerPoint.app/Contents/Resources/DFonts',
      '/Applications/Microsoft Excel.app/Contents/Resources/DFonts',
      '/Applications/wpsoffice.app/Contents/Resources/office6/fonts',
    ];
  }
  return ['/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.local', 'share', 'fonts'), path.join(home, '.fonts')];
}

function positionedSource(handle: fs.FileHandle, size: number): ByteSource {
  return {
    size,
    read: async (offset, length) => {
      const bytes = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await handle.read(bytes, done, length - done, offset + done);
        if (!bytesRead) break;
        done += bytesRead;
      }
      return bytes.subarray(0, done);
    },
  };
}

async function withFontFile<T>(filePath: string, operation: (source: ByteSource) => Promise<T>): Promise<T> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    return await operation(positionedSource(handle, stat.size));
  } finally {
    await handle.close();
  }
}

async function listFontFiles(directories: string[]): Promise<string[]> {
  const files: string[] = [];
  const seen = new Set<string>();
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DIRECTORY_DEPTH || files.length >= MAX_FONT_FILES) return;
    let real: string;
    let entries: Dirent[];
    try {
      real = await fs.realpath(directory);
      if (seen.has(real)) return;
      seen.add(real);
      entries = await fs.readdir(real, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || files.length >= MAX_FONT_FILES) continue;
      const full = path.join(real, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if ((entry.isFile() || entry.isSymbolicLink()) && FONT_FILE.test(entry.name)) files.push(full);
    }
  };
  for (const directory of directories) await walk(directory, 0);
  return files;
}

const faceId = (file: CatalogFile, faceIndex: number): string =>
  createHash('sha256').update(`${file.path}\0${faceIndex}\0${file.size}\0${file.mtimeMs}`).digest('hex').slice(0, 24);

function isFaceCandidate(face: CatalogFace, italic: boolean): boolean {
  return face.italic === italic && face.byteLength <= MAX_WORD_FONT_FACE_BYTES;
}

/** CSS-style weight matching inside one family, preferring the requested slant. */
function pickFace(faces: CatalogFace[], weight: number, italic: boolean): CatalogFace | undefined {
  const pool = faces.filter(face => isFaceCandidate(face, italic));
  if (!pool.length) return undefined;
  const score = (face: CatalogFace): number => {
    const distance = Math.abs(face.weight - weight);
    // Bold wants something heavier than regular; regular must not pick a bold face.
    const wrongSide = weight >= 600 ? face.weight < 600 : face.weight >= 600;
    return (wrongSide ? 1000 : 0) + distance;
  };
  return pool.reduce((best, face) => (score(face) < score(best) ? face : best));
}

/** Indexes installed fonts once, then answers family lookups and single-face reads. */
export class WordFontCatalog {
  private faces = new Map<string, CatalogFace>();
  private families = new Map<string, CatalogFace[]>();
  private scanning?: Promise<void>;

  constructor(private readonly options: WordFontCatalogOptions) {}

  private async readCache(): Promise<Map<string, CatalogFile>> {
    if (!this.options.cachePath) return new Map();
    try {
      const cache = JSON.parse(await fs.readFile(this.options.cachePath, 'utf8')) as CatalogCache;
      if (cache.version !== CACHE_VERSION || !Array.isArray(cache.files)) return new Map();
      return new Map(cache.files.map(file => [file.path, file]));
    } catch {
      return new Map();
    }
  }

  private async writeCache(files: CatalogFile[]): Promise<void> {
    if (!this.options.cachePath) return;
    try {
      await fs.mkdir(path.dirname(this.options.cachePath), { recursive: true });
      const temporary = `${this.options.cachePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ version: CACHE_VERSION, files } satisfies CatalogCache));
      await fs.rename(temporary, this.options.cachePath);
    } catch (error) {
      console.warn('[WordFonts] Could not write the font catalog cache:', error);
    }
  }

  private async scanFiles(): Promise<void> {
    const startedAt = Date.now();
    const cached = await this.readCache();
    const paths = await listFontFiles(this.options.directories);
    const files: CatalogFile[] = [];
    let parsed = 0;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < paths.length) {
        const filePath = paths[next++];
        try {
          const stat = await fs.stat(filePath);
          const hit = cached.get(filePath);
          if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
            files.push(hit);
            continue;
          }
          const faces = await withFontFile(filePath, readFontFaces);
          parsed++;
          files.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs, faces });
        } catch (error) {
          if (!(error instanceof SfntError) && (error as NodeJS.ErrnoException).code !== 'ENOENT'
            && (error as NodeJS.ErrnoException).code !== 'EACCES' && (error as NodeJS.ErrnoException).code !== 'EPERM') {
            console.debug('[WordFonts] Skipped unreadable font file:', filePath, error);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: PARSE_CONCURRENCY }, worker));
    files.sort((a, b) => a.path.localeCompare(b.path));
    this.index(files);
    if (parsed || cached.size !== files.length) await this.writeCache(files);
    console.log(`[WordFonts] Indexed ${this.faces.size} font faces from ${files.length} files (${parsed} parsed) in ${Date.now() - startedAt}ms`);
  }

  private index(files: CatalogFile[]): void {
    this.faces.clear();
    this.families.clear();
    for (const file of files) {
      for (const info of file.faces) {
        const face: CatalogFace = { id: faceId(file, info.faceIndex), path: file.path, faceIndex: info.faceIndex,
          families: info.families, weight: info.weight, italic: info.italic, metrics: info.metrics, byteLength: info.byteLength };
        this.faces.set(face.id, face);
        for (const family of new Set(info.families.map(fontNameKey))) {
          const list = this.families.get(family) ?? [];
          list.push(face);
          this.families.set(family, list);
        }
      }
    }
  }

  /** Scan lazily and only once per process; later callers share the same pass. */
  ensureScanned(): Promise<void> {
    this.scanning ??= this.scanFiles().catch(error => {
      console.error('[WordFonts] Font catalog scan failed:', error);
      this.scanning = undefined;
    });
    return this.scanning;
  }

  /**
   * Installed faces for each requested family, trying Word's aliases (宋体 = SimSun) in turn.
   * Returns at most the regular, bold, italic and bold-italic faces that actually exist.
   */
  async resolve(families: readonly string[]): Promise<WordSystemFontFace[]> {
    await this.ensureScanned();
    const result: WordSystemFontFace[] = [];
    for (const requested of families.slice(0, MAX_FAMILIES_PER_REQUEST)) {
      if (typeof requested !== 'string' || !requested.trim() || requested.length > 64) continue;
      let faces: CatalogFace[] | undefined;
      let matched = '';
      for (const alias of wordFontAliases(requested)) {
        faces = this.families.get(fontNameKey(alias));
        if (faces?.length) { matched = alias; break; }
      }
      if (!faces?.length) continue;
      const chosen = new Map<string, CatalogFace>();
      for (const weight of [REGULAR_WEIGHT, BOLD_WEIGHT]) {
        for (const italic of [false, true]) {
          const face = pickFace(faces, weight, italic);
          if (face && !chosen.has(face.id)) chosen.set(face.id, face);
        }
      }
      for (const face of chosen.values()) {
        const family = face.families.find(name => fontNameKey(name) === fontNameKey(matched)) ?? face.families[0];
        result.push({ id: face.id, family, requested, weight: face.weight, byteLength: face.byteLength,
          style: face.italic ? WordFontStyle.Italic : WordFontStyle.Normal, metrics: face.metrics });
      }
    }
    return result;
  }

  /** A standalone font for one indexed face; unknown ids are refused. */
  async readFace(id: string): Promise<Buffer> {
    await this.ensureScanned();
    const face = typeof id === 'string' ? this.faces.get(id) : undefined;
    if (!face) throw new SfntError('Unknown font face');
    if (face.byteLength > MAX_WORD_FONT_FACE_BYTES) throw new SfntError('Font face too large');
    return withFontFile(face.path, source => extractFace(source, face.faceIndex));
  }
}
