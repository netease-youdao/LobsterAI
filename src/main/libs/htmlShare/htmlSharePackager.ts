import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import yazl from 'yazl';

import { COWORK_TEMP_DIR_NAME } from '../../../shared/cowork/constants';
import { HtmlShareFailureKind } from '../../../shared/htmlShare/constants';
import { scanHtmlDependencies } from './htmlDependencyScanner';
import { createHtmlShareSizeError } from './htmlShareError';

const MAX_CLIENT_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_CLIENT_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_CLIENT_SINGLE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CLIENT_FILE_COUNT = 500;

const EXCLUDED_DIRECTORY_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.vite',
  '.cache',
  'coverage',
]);

const COWORK_TEMP_DIRECTORY_NAME = COWORK_TEMP_DIR_NAME;

const SENSITIVE_DIRECTORY_NAMES = new Set([
  COWORK_TEMP_DIRECTORY_NAME,
  '.openclaw',
  'memory',
]);

const EXCLUDED_FILE_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

const ALLOWED_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.txt',
  '.md',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.bmp',
  '.avif',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.wasm',
  '.mp3',
  '.mp4',
  '.webm',
  '.ogg',
]);

const SHARE_BOUNDARY_MARKER_NAMES = [
  'package.json',
  'AGENTS.md',
  '.git',
  '.openclaw',
  'MEMORY.md',
];

export interface HtmlSharePackageResult {
  archivePath: string;
  sourceSha256: string;
  entryFile: string;
  rootDir: string;
  totalFiles: number;
  totalBytes: number;
  warnings: string[];
}

interface StaticFileEntry {
  absolutePath: string;
  archiveName: string;
  size: number;
}

function normalizeArchiveName(value: string): string {
  return value.split(path.sep).join('/');
}

function isExcludedFileName(name: string): boolean {
  return EXCLUDED_FILE_NAMES.has(name) || /^\.env(?:\.|$)/i.test(name);
}

function isAllowedStaticFile(filePath: string): boolean {
  return ALLOWED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isBlockedStaticPath(rootDir: string, filePath: string): boolean {
  const relative = path.relative(rootDir, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return true;
  const parts = relative.split(path.sep).filter(Boolean);
  return parts.some(part => EXCLUDED_DIRECTORY_NAMES.has(part) || SENSITIVE_DIRECTORY_NAMES.has(part))
    || isExcludedFileName(path.basename(filePath));
}

async function hasShareBoundaryMarker(dir: string): Promise<boolean> {
  for (const markerName of SHARE_BOUNDARY_MARKER_NAMES) {
    try {
      await fs.promises.access(path.join(dir, markerName));
      return true;
    } catch {
      // Keep walking until a project boundary is found.
    }
  }
  return false;
}

async function findShareBoundaryRoot(startDir: string): Promise<string> {
  const resolvedStartDir = path.resolve(startDir);
  let current = resolvedStartDir;
  while (true) {
    if (await hasShareBoundaryMarker(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return resolvedStartDir;
    current = parent;
  }
}

function resolveHtmlFileShareRoot(resolvedFilePath: string, boundaryRoot: string): string {
  const relative = path.relative(boundaryRoot, resolvedFilePath);
  const relativeParts = relative.split(path.sep).filter(Boolean);
  if (relativeParts.includes(COWORK_TEMP_DIRECTORY_NAME)) {
    return path.dirname(resolvedFilePath);
  }
  return boundaryRoot;
}

function findCommonDirectory(filePaths: string[]): string {
  if (!filePaths.length) {
    throw new Error('Shared output did not contain any files.');
  }

  const directoryParts = filePaths.map(filePath => path.dirname(path.resolve(filePath)).split(path.sep));
  const first = directoryParts[0];
  let commonLength = first.length;
  for (const parts of directoryParts.slice(1)) {
    commonLength = Math.min(commonLength, parts.length);
    for (let index = 0; index < commonLength; index += 1) {
      if (parts[index] !== first[index]) {
        commonLength = index;
        break;
      }
    }
  }

  return first.slice(0, commonLength).join(path.sep) || path.parse(filePaths[0]).root;
}

async function buildStaticFileEntries(
  archiveRoot: string,
  filePaths: string[],
): Promise<StaticFileEntry[]> {
  if (filePaths.length > MAX_CLIENT_FILE_COUNT) {
    throw createHtmlShareSizeError(
      HtmlShareFailureKind.FileCountExceeded,
      `Too many files to share. The limit is ${MAX_CLIENT_FILE_COUNT}.`,
      { limitCount: MAX_CLIENT_FILE_COUNT },
    );
  }

  const entries: StaticFileEntry[] = [];
  for (const filePath of filePaths) {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > MAX_CLIENT_SINGLE_FILE_BYTES) {
      throw createHtmlShareSizeError(
        HtmlShareFailureKind.FileTooLarge,
        `File is too large to share: ${path.relative(archiveRoot, filePath)}`,
        {
          fileName: path.basename(filePath),
          limitBytes: MAX_CLIENT_SINGLE_FILE_BYTES,
          actualBytes: stat.size,
        },
      );
    }
    entries.push({
      absolutePath: filePath,
      archiveName: normalizeArchiveName(path.relative(archiveRoot, filePath)),
      size: stat.size,
    });
  }

  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes > MAX_CLIENT_TOTAL_BYTES) {
    throw createHtmlShareSizeError(
      HtmlShareFailureKind.TotalSizeExceeded,
      `Share content is too large. The limit is ${Math.floor(MAX_CLIENT_TOTAL_BYTES / 1024 / 1024)}MB.`,
      {
        limitBytes: MAX_CLIENT_TOTAL_BYTES,
        actualBytes: totalBytes,
      },
    );
  }

  return entries.sort((a, b) => a.archiveName.localeCompare(b.archiveName));
}

async function writeZip(entries: StaticFileEntry[]): Promise<{ archivePath: string; sourceSha256: string }> {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lobster-html-share-'));
  const archivePath = path.join(tempDir, 'share.zip');
  const zipFile = new yazl.ZipFile();
  console.debug(`[HtmlShare] writing share archive with ${entries.length} files`);

  zipFile.on('error', (err) => {
    (zipFile.outputStream as unknown as { destroy(err: Error): void }).destroy(err as Error);
  });

  for (const entry of entries) {
    zipFile.addFile(entry.absolutePath, entry.archiveName);
  }

  const outputStream = fs.createWriteStream(archivePath);
  const pipelinePromise = pipeline(zipFile.outputStream, outputStream);
  zipFile.end();
  await pipelinePromise;

  const stat = await fs.promises.stat(archivePath);
  if (stat.size > MAX_CLIENT_ARCHIVE_BYTES) {
    throw createHtmlShareSizeError(
      HtmlShareFailureKind.ArchiveSizeExceeded,
      `Share archive is too large. The limit is ${Math.floor(MAX_CLIENT_ARCHIVE_BYTES / 1024 / 1024)}MB.`,
      {
        limitBytes: MAX_CLIENT_ARCHIVE_BYTES,
        actualBytes: stat.size,
      },
    );
  }

  const buffer = await fs.promises.readFile(archivePath);
  const sourceSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  console.debug(
    `[HtmlShare] wrote share archive with ${stat.size} bytes and hash ${sourceSha256}`,
  );
  return {
    archivePath,
    sourceSha256,
  };
}

export async function packageHtmlFile(filePath: string): Promise<HtmlSharePackageResult> {
  const resolvedFilePath = path.resolve(filePath);
  console.debug(`[HtmlShare] packaging HTML file at ${resolvedFilePath}`);
  const stat = await fs.promises.stat(resolvedFilePath);
  if (!stat.isFile()) {
    throw new Error('HTML artifact file does not exist.');
  }
  if (!/\.html?$/i.test(resolvedFilePath)) {
    throw new Error('Only HTML files can be shared.');
  }

  const boundaryRoot = await findShareBoundaryRoot(path.dirname(resolvedFilePath));
  const shareRoot = resolveHtmlFileShareRoot(resolvedFilePath, boundaryRoot);
  return packageStaticDirectory(shareRoot, path.relative(shareRoot, resolvedFilePath));
}

export async function packageStaticDirectory(rootDir: string, entryFile = 'index.html'): Promise<HtmlSharePackageResult> {
  const resolvedRootDir = path.resolve(rootDir);
  const entryPath = path.resolve(resolvedRootDir, entryFile);
  const relativeEntry = path.relative(resolvedRootDir, entryPath);
  console.debug(`[HtmlShare] packaging static directory ${resolvedRootDir} with entry ${entryFile}`);
  if (!relativeEntry || relativeEntry.startsWith('..') || path.isAbsolute(relativeEntry)) {
    throw new Error('Entry HTML must be inside the shared directory.');
  }

  const entryStat = await fs.promises.stat(entryPath);
  if (!entryStat.isFile()) {
    throw new Error('Shared output directory must contain an entry HTML file.');
  }

  const dependencyScan = await scanHtmlDependencies(entryPath, {
    allowedRoot: resolvedRootDir,
    isAllowedFile: isAllowedStaticFile,
    isBlockedPath: filePath => isBlockedStaticPath(resolvedRootDir, filePath),
  });
  console.debug(
    `[HtmlShare] dependency scan found ${dependencyScan.files.length} files, ${dependencyScan.missing.length} missing referenced resources, and ${dependencyScan.blocked.length} blocked resources`,
  );
  const archiveRoot = findCommonDirectory(dependencyScan.files);
  const files = await buildStaticFileEntries(archiveRoot, dependencyScan.files);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  console.debug(
    `[HtmlShare] collected ${files.length} referenced static files with ${totalBytes} bytes before compression`,
  );
  const archiveEntry = normalizeArchiveName(path.relative(archiveRoot, entryPath));
  if (!files.some(file => file.archiveName === archiveEntry)) {
    throw new Error('Entry HTML was excluded from the share archive.');
  }

  const { archivePath, sourceSha256 } = await writeZip(files);

  return {
    archivePath,
    sourceSha256,
    entryFile: archiveEntry,
    rootDir: archiveRoot,
    totalFiles: files.length,
    totalBytes,
    warnings: [
      ...dependencyScan.missing.map(item => `Missing referenced resource: ${item}`),
      ...dependencyScan.blocked.map(item => `Blocked referenced resource: ${item}`),
    ],
  };
}
