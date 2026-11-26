import { load } from 'cheerio';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const CSS_IMPORT_PATTERN = /@import\s+(?:url\(\s*)?["']([^"')]+)["']\s*\)?/gi;
const CSS_URL_PATTERN = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
const JS_REFERENCE_PATTERNS = [
  /\bimport\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gi,
  /\bexport\s+[^"']*?\s+from\s+["']([^"']+)["']/gi,
  /\bimport\(\s*["']([^"']+)["']\s*\)/gi,
  /\bnew\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/gi,
  /\bfetch\(\s*["']([^"']+)["']/gi,
  /\bnew\s+(?:Worker|SharedWorker|Audio)\(\s*["']([^"']+)["']/gi,
];

const HTML_ATTRIBUTE_REFERENCES: Array<{ selector: string; attribute: string }> = [
  { selector: 'a[href]', attribute: 'href' },
  { selector: 'area[href]', attribute: 'href' },
  { selector: 'audio[src]', attribute: 'src' },
  { selector: 'embed[src]', attribute: 'src' },
  { selector: 'iframe[src]', attribute: 'src' },
  { selector: 'img[src]', attribute: 'src' },
  { selector: 'input[src]', attribute: 'src' },
  { selector: 'link[href]', attribute: 'href' },
  { selector: 'object[data]', attribute: 'data' },
  { selector: 'script[src]', attribute: 'src' },
  { selector: 'source[src]', attribute: 'src' },
  { selector: 'track[src]', attribute: 'src' },
  { selector: 'video[poster]', attribute: 'poster' },
  { selector: 'video[src]', attribute: 'src' },
];

const SRCSET_SELECTORS = ['img[srcset]', 'source[srcset]'];

export interface HtmlDependencyScanOptions {
  allowedRoot: string;
  isAllowedFile: (filePath: string) => boolean;
  isBlockedPath: (filePath: string) => boolean;
  assertAccess?: (filePath: string) => void;
}

export interface HtmlDependencyScanResult {
  files: string[];
  missing: string[];
  blocked: string[];
}

function normalizeDisplayPath(rootDir: string, filePath: string): string {
  const relative = path.relative(rootDir, filePath);
  return (relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative
    : filePath
  ).split(path.sep).join('/');
}

function isRemoteOrSpecialReference(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:|mailto:|tel:|javascript:)/i.test(value.trim());
}

function stripReferenceQuery(value: string): string {
  return value.split(/[?#]/, 1)[0] ?? '';
}

function parseSrcset(value: string): string[] {
  return value
    .split(',')
    .map(part => part.trim().split(/\s+/, 1)[0])
    .filter(Boolean);
}

function collectPatternReferences(content: string, patterns: RegExp[]): string[] {
  const references: string[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content))) {
      if (match[1]) references.push(match[1]);
    }
  }
  return references;
}

function scanCssReferences(content: string): string[] {
  return collectPatternReferences(content, [CSS_IMPORT_PATTERN, CSS_URL_PATTERN]);
}

function scanJsReferences(content: string): string[] {
  return collectPatternReferences(content, JS_REFERENCE_PATTERNS);
}

function scanHtmlReferences(content: string): string[] {
  const references: string[] = [];
  const $ = load(content);

  for (const { selector, attribute } of HTML_ATTRIBUTE_REFERENCES) {
    $(selector).each((_, element) => {
      const value = $(element).attr(attribute);
      if (value) references.push(value);
    });
  }

  for (const selector of SRCSET_SELECTORS) {
    $(selector).each((_, element) => {
      const value = $(element).attr('srcset');
      if (value) references.push(...parseSrcset(value));
    });
  }

  $('style').each((_, element) => {
    references.push(...scanCssReferences($(element).html() ?? ''));
  });

  $('[style]').each((_, element) => {
    const value = $(element).attr('style');
    if (value) references.push(...scanCssReferences(value));
  });

  return references;
}

function isScannableFile(filePath: string): boolean {
  return /\.(?:html?|css|mjs|cjs|js|svg)$/i.test(filePath);
}

function scanReferencesForFile(filePath: string, content: string): string[] {
  if (/\.css$/i.test(filePath)) return scanCssReferences(content);
  if (/\.(?:mjs|cjs|js)$/i.test(filePath)) return scanJsReferences(content);
  if (/\.(?:html?|svg)$/i.test(filePath)) return scanHtmlReferences(content);
  return [];
}

function resolveReference(
  allowedRoot: string,
  fromFile: string,
  reference: string,
): { resolvedPath?: string; blocked?: string } {
  const trimmed = reference.trim();
  if (!trimmed) return {};
  if (/^file:/i.test(trimmed)) {
    try {
      return { resolvedPath: path.resolve(fileURLToPath(trimmed)) };
    } catch {
      return { blocked: trimmed };
    }
  }
  if (isRemoteOrSpecialReference(trimmed)) return {};

  const cleanReference = stripReferenceQuery(trimmed);
  if (!cleanReference) return {};

  const baseDir = cleanReference.startsWith('/') ? allowedRoot : path.dirname(fromFile);
  const resolvedPath = path.resolve(baseDir, cleanReference.replace(/^\/+/, ''));
  const relative = path.relative(allowedRoot, resolvedPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { blocked: cleanReference };
  }

  return { resolvedPath };
}

async function addReferencedFile(
  filePath: string,
  options: HtmlDependencyScanOptions,
  pending: string[],
  files: Set<string>,
  missing: Set<string>,
  blocked: Set<string>,
): Promise<void> {
  if (options.isBlockedPath(filePath) || !options.isAllowedFile(filePath)) {
    blocked.add(normalizeDisplayPath(options.allowedRoot, filePath));
    return;
  }

  try {
    const stat = await fs.promises.lstat(filePath);
    if (stat.isSymbolicLink()) {
      blocked.add(normalizeDisplayPath(options.allowedRoot, filePath));
      return;
    }
    if (!stat.isFile()) {
      missing.add(normalizeDisplayPath(options.allowedRoot, filePath));
      return;
    }
  } catch {
    missing.add(normalizeDisplayPath(options.allowedRoot, filePath));
    return;
  }

  if (files.has(filePath)) return;
  options.assertAccess?.(filePath);
  files.add(filePath);
  if (isScannableFile(filePath)) pending.push(filePath);
}

export async function scanHtmlDependencies(
  entryFilePath: string,
  options: HtmlDependencyScanOptions,
): Promise<HtmlDependencyScanResult> {
  const resolvedEntry = path.resolve(entryFilePath);
  const resolvedAllowedRoot = path.resolve(options.allowedRoot);
  const scanOptions = { ...options, allowedRoot: resolvedAllowedRoot };
  const pending: string[] = [];
  const files = new Set<string>();
  const visited = new Set<string>();
  const missing = new Set<string>();
  const blocked = new Set<string>();

  await addReferencedFile(resolvedEntry, scanOptions, pending, files, missing, blocked);

  while (pending.length) {
    const filePath = pending.shift()!;
    if (visited.has(filePath)) continue;
    visited.add(filePath);

    let content = '';
    scanOptions.assertAccess?.(filePath);
    try {
      content = await fs.promises.readFile(filePath, 'utf8');
    } catch {
      missing.add(normalizeDisplayPath(resolvedAllowedRoot, filePath));
      continue;
    }
    scanOptions.assertAccess?.(filePath);

    for (const reference of scanReferencesForFile(filePath, content)) {
      const resolved = resolveReference(resolvedAllowedRoot, filePath, reference);
      if (resolved.blocked) {
        blocked.add(resolved.blocked);
        continue;
      }
      if (!resolved.resolvedPath) continue;
      await addReferencedFile(resolved.resolvedPath, scanOptions, pending, files, missing, blocked);
    }
  }

  return {
    files: Array.from(files).sort((a, b) => a.localeCompare(b)),
    missing: Array.from(missing).sort(),
    blocked: Array.from(blocked).sort(),
  };
}
