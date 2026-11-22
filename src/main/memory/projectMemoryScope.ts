// Pure, engine-independent project-memory scope helpers for LobsterAI.
//
// Matches legacy OpenClaw `project-memory-scope.ts` & `<!-- project: ... -->`
// annotation formats so both fresh DSH sessions and upgraded OpenClaw
// `MEMORY.md` / `USER.md` files isolate project-specific memories strictly
// per repository / working directory without spawning external `git` processes.

import * as fs from 'fs';
import * as path from 'path';

export const MemoryScope = {
  Global: 'global',
  Project: 'project',
} as const;
export type MemoryScope = typeof MemoryScope[keyof typeof MemoryScope];

export const INVALID_PROJECT_KEY_SENTINEL = '!invalid-project-annotation';

const MAX_GIT_WALK_DEPTH = 64;
const PROJECT_MARKER_OPEN_RE = /<!--\s*project\s*:/iu;
const PROJECT_TAG_RE = /<!--\s*project\s*:\s*([^\r\n]*?)\s*-->/giu;
const PROJECT_TAG_STRIP_RE = /[ \t]*<!--\s*project\s*:[^\r\n]*?-->[ \t]*/giu;
const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;
const TOP_BULLET_RE = /^(?:[-*+]|\d+\.)\s+\S/;
const STANDALONE_HTML_COMMENT_RE = /^\s*<!--[\s\S]*?-->\s*$/;

export interface ExtractedProjectKeys {
  annotated: boolean;
  keys: string[];
}

export interface FilterMarkdownForProjectOptions {
  stripTags?: boolean;
  globalOnly?: boolean;
}

export interface ScopedMarkdownBlock {
  kind: 'heading' | 'entry' | 'verbatim';
  lineStart: number;
  lineEnd: number;
  lines: string[];
  headingLevel?: number;
  annotated: boolean;
  projectKeys: string[];
}

export function escapeProjectKey(value: string): string {
  return value
    .replaceAll('%', '%25')
    .replaceAll(';', '%3b')
    .replaceAll('<', '%3c')
    .replaceAll('>', '%3e')
    .replaceAll('\r', '%0d')
    .replaceAll('\n', '%0a');
}

function isSafeGitHost(host: string): boolean {
  return Boolean(host) && !host.includes('/') && !host.includes('\\') && host !== '.' && host !== '..';
}

function normalizeGitRepoPath(rawPath: string): string | null {
  const cleaned = rawPath
    .replace(/[?#].*$/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  const segments = cleaned.split('/');
  if (segments.length < 2) return null;
  if (segments.some((seg) => !seg || seg === '.' || seg === '..' || seg.includes('\\'))) {
    return null;
  }
  return segments.join('/');
}

/**
 * Parse a git remote URL (HTTPS/HTTP/SSH/git protocol or SCP-like `git@host:owner/repo.git`)
 * into an OpenClaw-compatible `<host>/<owner>/<repo>` project key.
 */
export function parseGitRemoteToProjectKey(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/^git:/i, '').trim();
  if (!trimmed) return null;

  let host = '';
  let repoPath = '';

  const scpMatch = trimmed.match(/^(?:[^@\s/:]+@)?([^:\s/]+):([^/\s].*)$/);
  if (scpMatch && !/^[a-zA-Z]:[\\/]/.test(trimmed) && !trimmed.includes('://')) {
    host = scpMatch[1] ?? '';
    repoPath = scpMatch[2] ?? '';
  } else if (/^(?:https?|ssh|git):\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      host = parsed.hostname;
      repoPath = parsed.pathname;
    } catch {
      return null;
    }
  } else {
    return null;
  }

  const normalizedPath = normalizeGitRepoPath(repoPath);
  if (!isSafeGitHost(host) || !normalizedPath) return null;
  return escapeProjectKey(`${host.toLowerCase()}/${normalizedPath}`);
}

export function normalizeProjectKey(rawKey: string): string | null {
  const trimmed = rawKey.trim();
  if (!trimmed || /[\r\n<>]/u.test(trimmed)) {
    return null;
  }

  if (/^path:/i.test(trimmed)) {
    let rawPath = trimmed.slice(5).trim();
    if (!rawPath) return null;
    rawPath = rawPath.replace(/\\/g, '/');
    rawPath = rawPath.startsWith('//')
      ? `//${rawPath.slice(2).replace(/\/+/g, '/')}`
      : rawPath.replace(/\/+/g, '/');
    if (rawPath.length > 1 && !/^[a-zA-Z]:\/$/.test(rawPath)) {
      rawPath = rawPath.replace(/\/+$/, '');
    }
    if (process.platform === 'win32' || /^[a-zA-Z]:\//.test(rawPath)) {
      rawPath = rawPath.toLowerCase();
    }
    return `path:${rawPath}`;
  }

  if (trimmed.includes('://') || /^[^@\s/:]+@[^:\s/]+:/.test(trimmed)) {
    const parsed = parseGitRemoteToProjectKey(trimmed);
    if (parsed) return parsed;
  }

  const sep = trimmed.indexOf('/');
  if (sep < 1) {
    return trimmed;
  }
  const host = trimmed.slice(0, sep).toLowerCase();
  const rest = trimmed.slice(sep).replace(/\/+$/, '').replace(/\.git$/i, '');
  return `${host}${rest}`;
}

function buildPathProjectKey(absPath: string): string | null {
  const escaped = escapeProjectKey(absPath);
  return normalizeProjectKey(`path:${escaped}`);
}

function safeRealpath(targetPath: string): string | null {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return null;
  }
}

function extractOriginUrlFromGitConfig(configText: string): string | null {
  const lines = configText.replace(/\r\n/g, '\n').split('\n');
  let inOriginSection = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const header = sectionMatch[1].trim();
      inOriginSection = /^remote\s+"origin"$/i.test(header);
      continue;
    }
    if (!inOriginSection) continue;
    const urlMatch = line.match(/^url\s*=\s*(.+)$/i);
    if (urlMatch) {
      let value = urlMatch[1].trim();
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        value = value.slice(1, -1);
      }
      if (value) return value;
    }
  }
  return null;
}

function readGitConfigOriginUrl(gitDir: string): string | null {
  const configPath = path.join(gitDir, 'config');
  try {
    if (!fs.existsSync(configPath)) return null;
    const stat = fs.statSync(configPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    return extractOriginUrlFromGitConfig(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

function findGitRootAndOriginUrl(startDir: string): { gitRoot: string; originUrl: string | null } | null {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < MAX_GIT_WALK_DEPTH; depth += 1) {
    const dotGit = path.join(current, '.git');
    try {
      if (fs.existsSync(dotGit)) {
        const stat = fs.statSync(dotGit);
        if (stat.isDirectory()) {
          return { gitRoot: current, originUrl: readGitConfigOriginUrl(dotGit) };
        }
        if (stat.isFile()) {
          const pointer = fs.readFileSync(dotGit, 'utf8');
          const gitDirMatch = pointer.match(/^gitdir:\s*(.+)$/mi);
          if (gitDirMatch) {
            const gitDir = path.resolve(current, gitDirMatch[1].trim());
            let commonGitDir = gitDir;
            const commonDirPath = path.join(gitDir, 'commondir');
            try {
              if (fs.existsSync(commonDirPath)) {
                const rel = fs.readFileSync(commonDirPath, 'utf8').trim();
                if (rel) commonGitDir = path.resolve(gitDir, rel);
              }
            } catch {
              // ignore unreadable commondir
            }
            const originUrl = readGitConfigOriginUrl(gitDir)
              ?? (commonGitDir !== gitDir ? readGitConfigOriginUrl(commonGitDir) : null);
            return { gitRoot: current, originUrl };
          }
        }
      }
    } catch {
      // ignore unreadable ancestor
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Resolve all normalized project memory keys for a working directory without
 * spawning `git`. The first key (index 0) is the canonical primary key:
 * `<host>/<owner>/<repo>` when inside a git repo with an `origin` remote,
 * otherwise `path:<normalizedAbsPath>`.
 */
export function resolveProjectMemoryKeys(cwd?: string | null): string[] {
  if (typeof cwd !== 'string' || !cwd.trim()) return [];
  const absCwd = path.resolve(cwd.trim());
  const realCwd = safeRealpath(absCwd);
  const keys = new Set<string>();

  const gitInfo = findGitRootAndOriginUrl(absCwd)
    ?? (realCwd && realCwd !== absCwd ? findGitRootAndOriginUrl(realCwd) : null);

  if (gitInfo) {
    if (gitInfo.originUrl) {
      const remoteKey = parseGitRemoteToProjectKey(gitInfo.originUrl);
      if (remoteKey) keys.add(remoteKey);
    }
    const gitRootKey = buildPathProjectKey(gitInfo.gitRoot);
    if (gitRootKey) keys.add(gitRootKey);
    const realGitRoot = safeRealpath(gitInfo.gitRoot);
    if (realGitRoot && realGitRoot !== gitInfo.gitRoot) {
      const realGitRootKey = buildPathProjectKey(realGitRoot);
      if (realGitRootKey) keys.add(realGitRootKey);
    }
  }

  const cwdKey = buildPathProjectKey(absCwd);
  if (cwdKey) keys.add(cwdKey);
  if (realCwd && realCwd !== absCwd) {
    const realCwdKey = buildPathProjectKey(realCwd);
    if (realCwdKey) keys.add(realCwdKey);
  }

  return [...keys];
}

export function resolvePrimaryProjectKey(cwd?: string | null): string | null {
  return resolveProjectMemoryKeys(cwd)[0] ?? null;
}

/**
 * Extract normalized project keys from all `<!-- project: ... -->` HTML
 * comments in `text`. Supports semicolon, comma, whitespace (for non-path
 * keys or multiple `path:` tokens), and multiple comments on the same block.
 */
export function extractProjectKeys(text: string): ExtractedProjectKeys {
  if (typeof text !== 'string' || !text) {
    return { annotated: false, keys: [] };
  }
  const annotated = PROJECT_MARKER_OPEN_RE.test(text);
  if (!annotated) {
    return { annotated: false, keys: [] };
  }

  const keys = new Set<string>();
  for (const match of text.matchAll(PROJECT_TAG_RE)) {
    const body = (match[1] ?? '').trim();
    if (!body) continue;
    for (const semiPart of body.split(';')) {
      for (const commaPart of semiPart.split(',')) {
        const piece = commaPart.trim();
        if (!piece) continue;
        const tokens = /^path:/i.test(piece)
          ? piece.split(/\s+(?=path:)/i)
          : piece.split(/\s+/);
        for (const token of tokens) {
          const normalized = normalizeProjectKey(token);
          if (normalized) keys.add(normalized);
        }
      }
    }
  }
  return { annotated: true, keys: [...keys] };
}

export function parseProjectTagFromLine(line: string): ExtractedProjectKeys {
  return extractProjectKeys(line);
}

/**
 * Strip raw `<!-- project: ... -->` annotations cleanly while keeping
 * surrounding markdown text formatting intact.
 */
export function stripProjectTags(text: string): string {
  if (typeof text !== 'string' || !text) return '';
  if (!PROJECT_MARKER_OPEN_RE.test(text)) return text;
  return text
    .split('\n')
    .map((line) => {
      if (!PROJECT_MARKER_OPEN_RE.test(line)) return line;
      const cleaned = line
        .replace(PROJECT_TAG_STRIP_RE, (match, offset: number, source: string) => {
          const before = offset > 0 ? source[offset - 1] : '';
          const after = offset + match.length < source.length ? source[offset + match.length] : '';
          return before && after && !/\s/.test(before) && !/\s/.test(after) ? ' ' : '';
        })
        .replace(/[ \t]+$/, '');
      return cleaned;
    })
    .join('\n');
}

/**
 * Attach `<!-- project: <projectKey> -->` to a memory entry (on the first
 * line for multi-line entries) unless an equivalent project tag is already present.
 */
export function appendProjectTag(text: string, projectKey: string): string {
  const normalizedKey = normalizeProjectKey(projectKey);
  if (!normalizedKey) return text;
  const existing = extractProjectKeys(text);
  if (existing.keys.includes(normalizedKey)) {
    return text;
  }
  const normalized = text.replace(/\r\n/g, '\n');
  const newlineIdx = normalized.indexOf('\n');
  const tag = `<!-- project: ${normalizedKey} -->`;
  if (newlineIdx < 0) {
    return `${normalized.trimEnd()} ${tag}`;
  }
  const firstLine = normalized.slice(0, newlineIdx).trimEnd();
  const rest = normalized.slice(newlineIdx);
  return `${firstLine} ${tag}${rest}`;
}

function mergeProjectScope(
  inherited: ExtractedProjectKeys,
  own: ExtractedProjectKeys,
): ExtractedProjectKeys {
  if (!inherited.annotated && !own.annotated) {
    return { annotated: false, keys: [] };
  }
  // Own explicit project tag takes precedence over inherited section tag if present;
  // otherwise inherit section tag.
  if (own.annotated) {
    return own;
  }
  return inherited;
}

/**
 * Parse markdown into line-tracked blocks (headings, top-level bullets with
 * indented continuations, prose paragraphs, fenced code blocks, and blank/comment
 * lines) with inherited heading-level and block-level project scope metadata.
 */
export function parseScopedMarkdownBlocks(markdown: string): ScopedMarkdownBlock[] {
  const rawLines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: ScopedMarkdownBlock[] = [];
  const headingScopeStack: Array<{ level: number; scope: ExtractedProjectKeys }> = [];

  const getInheritedScope = (): ExtractedProjectKeys => {
    for (let i = headingScopeStack.length - 1; i >= 0; i -= 1) {
      if (headingScopeStack[i].scope.annotated) {
        return headingScopeStack[i].scope;
      }
    }
    return { annotated: false, keys: [] };
  };

  let index = 0;
  while (index < rawLines.length) {
    const line = rawLines[index];

    if (FENCE_RE.test(line)) {
      const start = index;
      const fenceLines = [line];
      index += 1;
      while (index < rawLines.length) {
        fenceLines.push(rawLines[index]);
        const closing = FENCE_RE.test(rawLines[index]);
        index += 1;
        if (closing) break;
      }
      const inherited = getInheritedScope();
      blocks.push({
        kind: 'entry',
        lineStart: start + 1,
        lineEnd: index,
        lines: fenceLines,
        annotated: inherited.annotated,
        projectKeys: inherited.keys,
      });
      continue;
    }

    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      const level = headingMatch[1].length;
      while (
        headingScopeStack.length > 0
        && headingScopeStack[headingScopeStack.length - 1].level >= level
      ) {
        headingScopeStack.pop();
      }
      const ownScope = extractProjectKeys(line);
      const effectiveScope = mergeProjectScope(getInheritedScope(), ownScope);
      headingScopeStack.push({ level, scope: effectiveScope });
      blocks.push({
        kind: 'heading',
        lineStart: index + 1,
        lineEnd: index + 1,
        lines: [line],
        headingLevel: level,
        annotated: effectiveScope.annotated,
        projectKeys: effectiveScope.keys,
      });
      index += 1;
      continue;
    }

    if (line.trim() === '' || STANDALONE_HTML_COMMENT_RE.test(line)) {
      blocks.push({
        kind: 'verbatim',
        lineStart: index + 1,
        lineEnd: index + 1,
        lines: [line],
        annotated: false,
        projectKeys: [],
      });
      index += 1;
      continue;
    }

    if (TOP_BULLET_RE.test(line)) {
      const start = index;
      const entryLines = [line];
      index += 1;
      let inNestedFence = false;
      while (index < rawLines.length) {
        const next = rawLines[index];
        if (FENCE_RE.test(next)) {
          inNestedFence = !inNestedFence;
          entryLines.push(next);
          index += 1;
          continue;
        }
        if (inNestedFence) {
          entryLines.push(next);
          index += 1;
          continue;
        }
        if (
          next.trim() === ''
          || TOP_BULLET_RE.test(next)
          || HEADING_RE.test(next)
          || STANDALONE_HTML_COMMENT_RE.test(next)
        ) {
          break;
        }
        entryLines.push(next);
        index += 1;
      }
      const ownScope = extractProjectKeys(entryLines.join('\n'));
      const effective = mergeProjectScope(getInheritedScope(), ownScope);
      blocks.push({
        kind: 'entry',
        lineStart: start + 1,
        lineEnd: index,
        lines: entryLines,
        annotated: effective.annotated,
        projectKeys: effective.keys,
      });
      continue;
    }

    const start = index;
    const proseLines = [line];
    index += 1;
    while (index < rawLines.length) {
      const next = rawLines[index];
      if (
        next.trim() === ''
        || TOP_BULLET_RE.test(next)
        || HEADING_RE.test(next)
        || FENCE_RE.test(next)
        || STANDALONE_HTML_COMMENT_RE.test(next)
      ) {
        break;
      }
      proseLines.push(next);
      index += 1;
    }
    const ownScope = extractProjectKeys(proseLines.join('\n'));
    const effective = mergeProjectScope(getInheritedScope(), ownScope);
    blocks.push({
      kind: 'entry',
      lineStart: start + 1,
      lineEnd: index,
      lines: proseLines,
      annotated: effective.annotated,
      projectKeys: effective.keys,
    });
  }

  return blocks;
}

export function isProjectBlockVisible(
  annotated: boolean,
  blockProjectKeys: readonly string[],
  activeKeySet: ReadonlySet<string>,
  globalOnly = false,
): boolean {
  if (!annotated) return true;
  if (globalOnly) return false;
  if (blockProjectKeys.length === 0 || activeKeySet.size === 0) return false;
  return blockProjectKeys.some((key) => activeKeySet.has(key));
}

function computeScopedBlockVisibility(
  blocks: readonly ScopedMarkdownBlock[],
  activeKeySet: ReadonlySet<string>,
  globalOnly: boolean,
): boolean[] {
  interface HeadingTracker {
    blockIndex: number;
    level: number;
    keptEntries: number;
    droppedEntries: number;
    selfVisible: boolean;
  }

  const headingTrackers = new Map<number, HeadingTracker>();
  const activeHeadings: HeadingTracker[] = [];
  const blockVisible = new Array<boolean>(blocks.length).fill(true);

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.kind === 'heading') {
      const level = block.headingLevel ?? 1;
      while (activeHeadings.length > 0 && activeHeadings[activeHeadings.length - 1].level >= level) {
        activeHeadings.pop();
      }
      const selfVisible = isProjectBlockVisible(
        block.annotated,
        block.projectKeys,
        activeKeySet,
        globalOnly,
      );
      const tracker: HeadingTracker = {
        blockIndex: i,
        level,
        keptEntries: 0,
        droppedEntries: 0,
        selfVisible,
      };
      headingTrackers.set(i, tracker);
      activeHeadings.push(tracker);
      blockVisible[i] = selfVisible;
      continue;
    }

    if (block.kind === 'entry') {
      const visible = isProjectBlockVisible(
        block.annotated,
        block.projectKeys,
        activeKeySet,
        globalOnly,
      );
      blockVisible[i] = visible;
      for (const h of activeHeadings) {
        if (visible) h.keptEntries += 1;
        else h.droppedEntries += 1;
      }
      continue;
    }

    // Never leak standalone `<!-- project: ... -->` comment lines.
    if (block.kind === 'verbatim' && PROJECT_MARKER_OPEN_RE.test(block.lines.join('\n'))) {
      blockVisible[i] = false;
    }
  }

  for (const tracker of headingTrackers.values()) {
    if (!tracker.selfVisible || (tracker.droppedEntries > 0 && tracker.keptEntries === 0)) {
      blockVisible[tracker.blockIndex] = false;
    }
  }

  return blockVisible;
}

/**
 * Filter a markdown document (`MEMORY.md` / `USER.md`) for the active project:
 * - Keeps all untagged (global) blocks.
 * - Keeps project-tagged blocks ONLY if at least one tag matches `activeProjectKeys`
 *   (or drops all project-tagged blocks when `options.globalOnly` is true).
 * - Prunes headings whose entries were all filtered out so foreign project
 *   section titles do not leak either.
 * - Strips raw `<!-- project: ... -->` comments from output by default.
 */
export function filterMarkdownForProject(
  markdown: string,
  activeProjectKeys: readonly string[] = [],
  options: FilterMarkdownForProjectOptions = {},
): string {
  if (typeof markdown !== 'string' || !markdown.trim()) return '';
  const stripTags = options.stripTags !== false;
  const globalOnly = options.globalOnly === true;
  const activeKeySet = new Set(
    activeProjectKeys
      .map((key) => normalizeProjectKey(key))
      .filter((key): key is string => Boolean(key)),
  );

  const blocks = parseScopedMarkdownBlocks(markdown);
  const blockVisible = computeScopedBlockVisibility(blocks, activeKeySet, globalOnly);

  const keptLines: string[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    if (!blockVisible[i]) continue;
    const block = blocks[i];
    const blockText = block.lines.join('\n');
    const outputText = stripTags && block.kind !== 'verbatim'
      ? stripProjectTags(blockText)
      : blockText;
    keptLines.push(outputText);
  }

  return keptLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Filter markdown lines by project scope while preserving 1-based line indices
 * (lines belonging to invisible project blocks become `null`), suitable for
 * line-range reads (`lobster_memory_get`) that must match FTS5 line numbers.
 */
export function filterMarkdownLinesPreservingLineNumbers(
  markdown: string,
  activeProjectKeys: readonly string[] = [],
  options: FilterMarkdownForProjectOptions = {},
): Array<string | null> {
  if (typeof markdown !== 'string' || !markdown) return [];
  const stripTags = options.stripTags !== false;
  const globalOnly = options.globalOnly === true;
  const activeKeySet = new Set(
    activeProjectKeys
      .map((key) => normalizeProjectKey(key))
      .filter((key): key is string => Boolean(key)),
  );

  const blocks = parseScopedMarkdownBlocks(markdown);
  const blockVisible = computeScopedBlockVisibility(blocks, activeKeySet, globalOnly);
  const rawLines = markdown.replace(/\r\n/g, '\n').split('\n');
  const result: Array<string | null> = new Array(rawLines.length).fill(null);

  for (let i = 0; i < blocks.length; i += 1) {
    if (!blockVisible[i]) continue;
    const block = blocks[i];
    for (let offset = 0; offset < block.lines.length; offset += 1) {
      const lineIdx = block.lineStart - 1 + offset;
      const line = block.lines[offset];
      result[lineIdx] = stripTags && block.kind !== 'verbatim' ? stripProjectTags(line) : line;
    }
  }
  return result;
}
