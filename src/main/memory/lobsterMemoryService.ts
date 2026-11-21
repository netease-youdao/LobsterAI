// Engine-independent agent workspace & memory service for LobsterAI.
//
// Owns `<userData>/workspaces/<agentId>/{SOUL.md, IDENTITY.md, USER.md,
// MEMORY.md, AGENTS.md, memory/YYYY-MM-DD.md}` and maintains a rebuildable
// local SQLite FTS5 (trigram) search index at `<workspacesDir>/memory-fts.sqlite`
// so Chinese/English memory search works offline with zero engine coupling.
//
// No Electron imports so this module stays fast and unit-testable in Node.

import Database from 'better-sqlite3';
import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  filterMarkdownLinesPreservingLineNumbers,
  INVALID_PROJECT_KEY_SENTINEL,
  parseScopedMarkdownBlocks,
  resolveProjectMemoryKeys,
  stripProjectTags,
} from './projectMemoryScope';

export const WorkspaceFileName = {
  Soul: 'SOUL.md',
  Identity: 'IDENTITY.md',
  User: 'USER.md',
  Memory: 'MEMORY.md',
  Agents: 'AGENTS.md',
} as const;
export type WorkspaceFileName = typeof WorkspaceFileName[keyof typeof WorkspaceFileName];

export const MEMORY_DAILY_DIR_NAME = 'memory';
export const MEMORY_FTS_DB_NAME = 'memory-fts.sqlite';
const MANAGED_AGENTS_MARKER = '<!-- LobsterAI managed:';
const MEMORY_HEADER = '# User Memories';

const TOP_BULLET_RE = /^-\s+\S/;
const ANY_BULLET_RE = /^\s*-\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;
const TOP_HTML_COMMENT_OPEN_RE = /^<!--/;
const ANY_HTML_COMMENT_OPEN_RE = /^\s*<!--/;
const INLINE_METADATA_COMMENT_RE =
  /<!--\s*(?:(?:project|trigger|importance)\s*:|openclaw-memory-promotion:)[\s\S]*?-->/gi;

export interface MemoryEntry {
  id: string;
  text: string;
  section?: string;
}

export interface MemorySearchHit {
  agentId: string;
  relPath: string;
  lineStart: number;
  lineEnd: number;
  snippet: string;
  score: number;
}

export interface MemorySearchOptions {
  workspaceDir?: string;
  includeMainGlobal?: boolean;
}

export interface ReadMemorySnippetOptions {
  workspaceDir?: string;
  globalOnly?: boolean;
}

export interface AgentPersonaFiles {
  agentId: string;
  workspaceDir: string;
  soul: string;
  identity: string;
  user: string;
  memory: string;
  agentsMd: string;
}

interface MemorySegment {
  kind: 'entry' | 'verbatim';
  lines: string[];
  entry?: MemoryEntry;
  metadataComments?: string[];
}

export interface ParsedMemoryFile {
  segments: MemorySegment[];
  trailingSection?: string;
}

export function normalizeMemoryTextForFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function memoryFingerprint(text: string): string {
  return crypto.createHash('sha1').update(normalizeMemoryTextForFingerprint(text)).digest('hex');
}

export function getMemoryBaseFingerprint(id: string): string {
  const hashIdx = id.indexOf('#');
  return hashIdx >= 0 ? id.slice(0, hashIdx) : id;
}

function extractBlockDisplayAndMetadata(lines: string[]): {
  text: string;
  metadataComments: string[];
} {
  const [first, ...rest] = lines;
  const bulletMatch = first.match(ANY_BULLET_RE);
  const displayLines = bulletMatch
    ? [bulletMatch[1], ...rest.map((line) => (line.startsWith('  ') ? line.slice(2) : line))]
    : [first, ...rest];

  const rawJoined = displayLines.join('\n');
  INLINE_METADATA_COMMENT_RE.lastIndex = 0;
  if (!INLINE_METADATA_COMMENT_RE.test(rawJoined)) {
    INLINE_METADATA_COMMENT_RE.lastIndex = 0;
    return {
      text: bulletMatch ? rawJoined.trimEnd() : rawJoined.trim(),
      metadataComments: [],
    };
  }

  INLINE_METADATA_COMMENT_RE.lastIndex = 0;
  const metadataComments: string[] = [];
  const cleanedJoined = rawJoined.replace(INLINE_METADATA_COMMENT_RE, (match) => {
    metadataComments.push(match.trim());
    return '\u0000';
  });

  const cleanedLines: string[] = [];
  for (const rawLine of cleanedJoined.split('\n')) {
    if (!rawLine.includes('\u0000')) {
      cleanedLines.push(rawLine);
      continue;
    }
    const withoutSentinel = rawLine.replace(/\u0000/g, ' ').replace(/[ \t]+$/u, '');
    const leadingMatch = withoutSentinel.match(/^[ \t]*/);
    const leading = leadingMatch ? leadingMatch[0] : '';
    const body = withoutSentinel
      .slice(leading.length)
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    if (body) {
      cleanedLines.push(`${leading}${body}`);
    }
  }

  return {
    text: cleanedLines.join('\n').trim(),
    metadataComments,
  };
}

function assignUniqueEntryIds(segments: MemorySegment[]): void {
  const occurrenceCounts = new Map<string, number>();
  for (const segment of segments) {
    if (segment.kind !== 'entry' || !segment.entry) continue;
    const baseId = memoryFingerprint(segment.entry.text);
    const count = (occurrenceCounts.get(baseId) ?? 0) + 1;
    occurrenceCounts.set(baseId, count);
    segment.entry.id = count === 1 ? baseId : `${baseId}#${count}`;
  }
}

function serializeEntryLines(text: string, preservedComments?: string[]): string[] {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''))
    .filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    throw new Error('Memory text must not be empty');
  }

  const firstTrimmed = lines[0].trim();
  const bulletMatch = firstTrimmed.match(ANY_BULLET_RE);
  let head = bulletMatch ? `- ${bulletMatch[1]}` : `- ${firstTrimmed}`;

  if (preservedComments && preservedComments.length > 0) {
    const joinedInput = lines.join('\n');
    INLINE_METADATA_COMMENT_RE.lastIndex = 0;
    const inputHasMetadata = INLINE_METADATA_COMMENT_RE.test(joinedInput);
    INLINE_METADATA_COMMENT_RE.lastIndex = 0;
    if (!inputHasMetadata) {
      head = `${head} ${preservedComments.join(' ')}`;
    }
  }

  const rest = lines.slice(1).map((line) => `  ${line}`);
  return [head, ...rest];
}

export function parseMemoryMarkdown(content: string): ParsedMemoryFile {
  const rawLines = content.replace(/\r\n?/g, '\n').split('\n');
  const segments: MemorySegment[] = [];
  let verbatim: string[] = [];
  let block: string[] | null = null;
  let currentSection: string | undefined;
  let blockSection: string | undefined;
  let fence: 'verbatim' | 'block' | null = null;
  let inComment: 'verbatim' | 'block' | null = null;

  const flushVerbatim = () => {
    if (verbatim.length > 0) {
      segments.push({ kind: 'verbatim', lines: verbatim });
      verbatim = [];
    }
  };

  const closeBlock = () => {
    if (!block) return;
    const lines = block;
    block = null;
    const { text, metadataComments } = extractBlockDisplayAndMetadata(lines);
    if (!text) {
      segments.push({ kind: 'verbatim', lines });
      return;
    }
    segments.push({
      kind: 'entry',
      lines,
      metadataComments,
      entry: {
        id: memoryFingerprint(text),
        text,
        ...(blockSection ? { section: blockSection } : {}),
      },
    });
  };

  const openBlock = (line: string) => {
    closeBlock();
    flushVerbatim();
    blockSection = currentSection;
    block = [line];
  };

  for (const line of rawLines) {
    if (fence === 'block') {
      block!.push(line);
      if (FENCE_RE.test(line)) fence = null;
      continue;
    }
    if (fence === 'verbatim') {
      verbatim.push(line);
      if (FENCE_RE.test(line)) fence = null;
      continue;
    }

    if (inComment === 'block') {
      block!.push(line);
      if (line.includes('-->')) inComment = null;
      continue;
    }
    if (inComment === 'verbatim') {
      verbatim.push(line);
      if (line.includes('-->')) inComment = null;
      continue;
    }

    // Column-0 HTML comments (or indented comments outside an open block) are verbatim metadata.
    if (TOP_HTML_COMMENT_OPEN_RE.test(line) || (!block && ANY_HTML_COMMENT_OPEN_RE.test(line))) {
      closeBlock();
      verbatim.push(line);
      if (!line.includes('-->')) inComment = 'verbatim';
      continue;
    }

    if (FENCE_RE.test(line)) {
      if (block && /^\s/.test(line)) {
        block.push(line);
        fence = 'block';
      } else {
        closeBlock();
        verbatim.push(line);
        fence = 'verbatim';
      }
      continue;
    }

    if (line.trim() === '') {
      closeBlock();
      verbatim.push(line);
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      closeBlock();
      currentSection = heading[1].length >= 2 ? heading[2].trim() : undefined;
      verbatim.push(line);
      continue;
    }

    if (TOP_BULLET_RE.test(line)) {
      openBlock(line);
      continue;
    }

    if (block) {
      block.push(line);
      if (ANY_HTML_COMMENT_OPEN_RE.test(line) && !line.includes('-->')) {
        inComment = 'block';
      }
      continue;
    }

    openBlock(line);
  }

  closeBlock();
  flushVerbatim();
  assignUniqueEntryIds(segments);
  return { segments, trailingSection: currentSection };
}

function serializeMemorySegments(segments: MemorySegment[]): string {
  const joined = segments.flatMap((segment) => segment.lines).join('\n');
  if (!joined) return '';
  return joined.endsWith('\n') ? joined : `${joined}\n`;
}

function collectExistingFingerprints(segments: MemorySegment[]): Set<string> {
  const fps = new Set<string>();
  for (const segment of segments) {
    if (segment.kind !== 'entry' || !segment.entry) continue;
    fps.add(getMemoryBaseFingerprint(segment.entry.id));
    for (const line of segment.entry.text.split('\n')) {
      const match = line.match(ANY_BULLET_RE);
      const lineText = (match ? match[1] : line).trim();
      if (lineText) {
        fps.add(memoryFingerprint(lineText));
      }
    }
  }
  return fps;
}

const MANAGED_BLOCK_RE = /<!--\s*LOBSTERAI_MANAGED_START\s*-->[\s\S]*?<!--\s*LOBSTERAI_MANAGED_END\s*-->\s*/g;
const OPENCLAW_STOCK_AGENTS_RE = /^#\s+AGENTS\.md\s*-\s*Your Workspace\s*\n+This folder is home\.\s*Treat it that way\.[\s\S]*?^##\s+Make It Yours\s*\n+This is a starting point\.\s*Add your own conventions, style, and rules as you figure out what works\.(?:\s*\n+##\s+Related\s*\n+(?:-\s+\[[^\]]+\]\(\/(?:reference|concepts|automation|gateway)\/[^)]+\)\s*\n?)+)?\s*/m;
const OPENCLAW_STOCK_TOOLS_RE = /^#\s+TOOLS\.md\s*-\s*Local Notes\s*\n+Skills define _how_ tools work\.[\s\S]*?Add whatever helps you do your job\.\s*This is your cheat sheet\.\s*/m;

/**
 * Strips legacy OpenClaw managed sections (`<!-- LOBSTERAI_MANAGED_START -->...`
 * or `<!-- LobsterAI managed: ... -->` tail) and stock OpenClaw workspace/tools
 * boilerplate from a migrated `AGENTS.md` file so only user-authored
 * instructions remain.
 */
export function stripManagedAgentsSection(content: string): string {
  let text = content.replace(/\r\n/g, '\n').replace(MANAGED_BLOCK_RE, '');
  const markerIndex = text.indexOf(MANAGED_AGENTS_MARKER);
  if (markerIndex >= 0) {
    text = text.slice(0, markerIndex);
  }
  text = text.replace(OPENCLAW_STOCK_AGENTS_RE, '');
  text = text.replace(OPENCLAW_STOCK_TOOLS_RE, '');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

export function sanitizeAgentId(agentId: string): string {
  const trimmed = (agentId || 'main').trim();
  if (!trimmed || trimmed === '.' || trimmed === '..' || /[\\/]/.test(trimmed)) {
    throw new Error(`Invalid agentId: ${agentId}`);
  }
  return trimmed;
}

function formatDateYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export class LobsterMemoryService {
  private readonly workspacesDir: string;
  private db: Database.Database | null = null;
  private ftsTokenizer: 'trigram' | 'unicode61' = 'trigram';

  constructor(workspacesDir: string) {
    this.workspacesDir = path.resolve(workspacesDir);
  }

  getWorkspacesDir(): string {
    return this.workspacesDir;
  }

  getAgentWorkspaceDir(agentId = 'main'): string {
    return path.join(this.workspacesDir, sanitizeAgentId(agentId));
  }

  ensureAgentWorkspace(agentId = 'main'): string {
    const dir = this.getAgentWorkspaceDir(agentId);
    fs.mkdirSync(path.join(dir, MEMORY_DAILY_DIR_NAME), { recursive: true });
    return dir;
  }

  readWorkspaceFile(agentId: string, fileName: WorkspaceFileName): string {
    const filePath = path.join(this.getAgentWorkspaceDir(agentId), fileName);
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  }

  writeWorkspaceFile(agentId: string, fileName: WorkspaceFileName, content: string): void {
    const dir = this.ensureAgentWorkspace(agentId);
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, content, 'utf8');
    if (fileName === WorkspaceFileName.Memory || fileName === WorkspaceFileName.User) {
      const stat = safeStatFile(filePath);
      this.indexSingleFile(sanitizeAgentId(agentId), fileName, content, stat?.mtimeMs, stat?.size);
    }
  }

  readPersonaBundle(agentId = 'main'): AgentPersonaFiles {
    const safeId = sanitizeAgentId(agentId);
    const workspaceDir = this.getAgentWorkspaceDir(safeId);
    return {
      agentId: safeId,
      workspaceDir,
      soul: this.readWorkspaceFile(safeId, WorkspaceFileName.Soul).trim(),
      identity: this.readWorkspaceFile(safeId, WorkspaceFileName.Identity).trim(),
      user: this.readWorkspaceFile(safeId, WorkspaceFileName.User).trim(),
      memory: this.readWorkspaceFile(safeId, WorkspaceFileName.Memory).trim(),
      agentsMd: this.readWorkspaceFile(safeId, WorkspaceFileName.Agents).trim(),
    };
  }

  listMemories(agentId = 'main'): MemoryEntry[] {
    const content = this.readWorkspaceFile(agentId, WorkspaceFileName.Memory);
    if (!content.trim()) return [];
    const parsed = parseMemoryMarkdown(content);
    return parsed.segments
      .map((segment) => segment.entry)
      .filter((entry): entry is MemoryEntry => Boolean(entry));
  }

  addMemory(agentId: string, text: string, section?: string): MemoryEntry {
    const bulletLines = serializeEntryLines(text);
    const { text: displayText } = extractBlockDisplayAndMetadata(bulletLines);
    if (!displayText) {
      throw new Error('Memory text must not be empty');
    }

    const safeId = sanitizeAgentId(agentId);
    const existing = this.readWorkspaceFile(safeId, WorkspaceFileName.Memory);
    const normalizedSection = section?.trim() || undefined;
    const baseId = memoryFingerprint(displayText);

    let nextContent: string;
    let resolvedSection = normalizedSection;

    if (!existing.trim()) {
      const parts = [MEMORY_HEADER, ''];
      if (normalizedSection) parts.push(`## ${normalizedSection}`, '');
      parts.push(...bulletLines, '');
      nextContent = parts.join('\n');
    } else {
      const parsed = parseMemoryMarkdown(existing);
      const duplicate = parsed.segments.find(
        (segment) => segment.kind === 'entry' && segment.entry && getMemoryBaseFingerprint(segment.entry.id) === baseId,
      );
      if (duplicate?.entry) return duplicate.entry;

      const trimmedExisting = existing.replace(/\s+$/, '');
      if (normalizedSection && parsed.trailingSection !== normalizedSection) {
        nextContent = `${trimmedExisting}\n\n## ${normalizedSection}\n\n${bulletLines.join('\n')}\n`;
      } else {
        resolvedSection = normalizedSection ?? parsed.trailingSection;
        nextContent = `${trimmedExisting}\n${bulletLines.join('\n')}\n`;
      }
    }

    this.writeWorkspaceFile(safeId, WorkspaceFileName.Memory, nextContent);
    return {
      id: baseId,
      text: displayText,
      ...(resolvedSection ? { section: resolvedSection } : {}),
    };
  }

  /**
   * Bulk-append memory texts into `MEMORY.md`, skipping duplicates already present
   * (either as standalone entries or individual lines inside existing blocks).
   * Writes the file and updates FTS5 at most once.
   */
  importMemories(agentId: string, texts: string[], section?: string): number {
    if (texts.length === 0) return 0;

    const safeId = sanitizeAgentId(agentId);
    const existing = this.readWorkspaceFile(safeId, WorkspaceFileName.Memory);
    const parsed = parseMemoryMarkdown(existing);
    const existingFingerprints = collectExistingFingerprints(parsed.segments);

    const blocks: string[] = [];
    for (const rawText of texts) {
      let bulletLines: string[];
      try {
        bulletLines = serializeEntryLines(rawText);
      } catch {
        continue;
      }
      const { text: displayText } = extractBlockDisplayAndMetadata(bulletLines);
      if (!displayText) continue;
      const fp = memoryFingerprint(displayText);
      if (existingFingerprints.has(fp)) continue;
      existingFingerprints.add(fp);
      blocks.push(bulletLines.join('\n'));
    }

    if (blocks.length === 0) return 0;

    const normalizedSection = section?.trim() || undefined;
    let nextContent: string;
    if (!existing.trim()) {
      const parts = [MEMORY_HEADER, ''];
      if (normalizedSection) parts.push(`## ${normalizedSection}`, '');
      parts.push(blocks.join('\n'), '');
      nextContent = parts.join('\n');
    } else {
      const trimmedExisting = existing.replace(/\s+$/, '');
      if (normalizedSection && parsed.trailingSection !== normalizedSection) {
        nextContent = `${trimmedExisting}\n\n## ${normalizedSection}\n\n${blocks.join('\n')}\n`;
      } else {
        nextContent = `${trimmedExisting}\n\n${blocks.join('\n')}\n`;
      }
    }

    this.writeWorkspaceFile(safeId, WorkspaceFileName.Memory, nextContent);
    return blocks.length;
  }

  updateMemory(agentId: string, id: string, nextText: string): MemoryEntry | null {
    const safeId = sanitizeAgentId(agentId);
    const existing = this.readWorkspaceFile(safeId, WorkspaceFileName.Memory);
    if (!existing.trim()) return null;

    const parsed = parseMemoryMarkdown(existing);
    const targetIndex = parsed.segments.findIndex(
      (segment) => segment.kind === 'entry' && segment.entry?.id === id,
    );
    if (targetIndex === -1) return null;

    const target = parsed.segments[targetIndex];
    if (!target.entry) return null;

    const bulletLines = serializeEntryLines(nextText, target.metadataComments);
    const { text: displayText, metadataComments } = extractBlockDisplayAndMetadata(bulletLines);
    if (!displayText) {
      throw new Error('Memory text must not be empty');
    }

    // Preserve the original block lines byte-for-byte when display text & metadata are unchanged.
    const commentsUnchanged =
      metadataComments.length === (target.metadataComments?.length ?? 0)
      && metadataComments.every((c, idx) => c === target.metadataComments?.[idx]);
    if (target.entry.text === displayText && commentsUnchanged) {
      return target.entry;
    }

    target.lines = bulletLines;
    target.metadataComments = metadataComments;
    target.entry = {
      id: memoryFingerprint(displayText),
      text: displayText,
      ...(target.entry.section ? { section: target.entry.section } : {}),
    };
    assignUniqueEntryIds(parsed.segments);

    this.writeWorkspaceFile(safeId, WorkspaceFileName.Memory, serializeMemorySegments(parsed.segments));
    return target.entry;
  }

  deleteMemory(agentId: string, id: string): boolean {
    const safeId = sanitizeAgentId(agentId);
    const existing = this.readWorkspaceFile(safeId, WorkspaceFileName.Memory);
    if (!existing.trim()) return false;

    const parsed = parseMemoryMarkdown(existing);
    const index = parsed.segments.findIndex(
      (segment) => segment.kind === 'entry' && segment.entry?.id === id,
    );
    if (index === -1) return false;

    parsed.segments.splice(index, 1);

    // Collapse doubled blank separators around the removed block.
    const prev = index > 0 ? parsed.segments[index - 1] : undefined;
    const next = index < parsed.segments.length ? parsed.segments[index] : undefined;
    if (
      prev?.kind === 'verbatim'
      && next?.kind === 'verbatim'
      && prev.lines[prev.lines.length - 1]?.trim() === ''
      && next.lines[0]?.trim() === ''
    ) {
      prev.lines.pop();
    }

    this.writeWorkspaceFile(safeId, WorkspaceFileName.Memory, serializeMemorySegments(parsed.segments));
    return true;
  }

  appendDailyNote(agentId: string, text: string, date: Date = new Date()): string {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('Daily note text must not be empty');
    const safeId = sanitizeAgentId(agentId);
    const dir = this.ensureAgentWorkspace(safeId);
    const dateKey = formatDateYmd(date);
    const relPath = `${MEMORY_DAILY_DIR_NAME}/${dateKey}.md`;
    const filePath = path.join(dir, relPath);
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    const nextContent = existing.trim()
      ? `${existing.replace(/\s+$/, '')}\n\n${trimmed}\n`
      : `# ${dateKey}\n\n${trimmed}\n`;
    fs.writeFileSync(filePath, nextContent, 'utf8');
    const stat = safeStatFile(filePath);
    this.indexSingleFile(safeId, relPath, nextContent, stat?.mtimeMs, stat?.size);
    return relPath;
  }

  readMemorySnippet(
    agentId: string,
    relPath: string,
    fromLine = 1,
    lineCount = 80,
    options?: ReadMemorySnippetOptions,
  ): string | null {
    const safeId = sanitizeAgentId(agentId);
    const workspaceDir = this.getAgentWorkspaceDir(safeId);
    const normalizedRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const resolved = path.resolve(workspaceDir, normalizedRel);
    const relativeCheck = path.relative(workspaceDir, resolved);
    if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
      throw new Error(`Refusing path outside agent workspace: ${relPath}`);
    }
    if (!fs.existsSync(resolved)) return null;
    const rawContent = fs.readFileSync(resolved, 'utf8');
    const startIdx = Math.max(0, Math.floor(fromLine) - 1);
    const count = Math.max(1, Math.floor(lineCount));

    if (options && (options.workspaceDir !== undefined || options.globalOnly === true)) {
      const activeProjectKeys = options.globalOnly ? [] : resolveProjectMemoryKeys(options.workspaceDir);
      const filteredLines = filterMarkdownLinesPreservingLineNumbers(rawContent, activeProjectKeys, {
        stripTags: true,
        globalOnly: options.globalOnly === true,
      });
      const endIdx = Math.min(filteredLines.length, startIdx + count);
      return filteredLines
        .slice(startIdx, endIdx)
        .filter((line): line is string => line !== null)
        .join('\n');
    }

    const lines = rawContent.replace(/\r\n/g, '\n').split('\n');
    const endIdx = Math.min(lines.length, startIdx + count);
    return lines.slice(startIdx, endIdx).join('\n');
  }

  deleteAgentIndex(agentId: string): void {
    const safeId = sanitizeAgentId(agentId);
    const dbPath = path.join(this.workspacesDir, MEMORY_FTS_DB_NAME);
    if (!this.db && !fs.existsSync(dbPath)) return;
    const db = this.ensureIndexDb();
    const runTx = db.transaction(() => {
      db.prepare('DELETE FROM memory_chunks WHERE agent_id = ?').run(safeId);
      db.prepare('DELETE FROM memory_file_meta WHERE agent_id = ?').run(safeId);
    });
    runTx();
  }

  reindexAgent(agentId = 'main'): number {
    const safeId = sanitizeAgentId(agentId);
    const db = this.ensureIndexDb();
    const workspaceDir = this.getAgentWorkspaceDir(safeId);

    const clearTx = db.transaction(() => {
      db.prepare('DELETE FROM memory_chunks WHERE agent_id = ?').run(safeId);
      db.prepare('DELETE FROM memory_file_meta WHERE agent_id = ?').run(safeId);
    });
    clearTx();

    if (!fs.existsSync(workspaceDir)) return 0;

    let chunkCount = 0;
    const files = collectIndexableFiles(workspaceDir);
    for (const file of files) {
      let content: string;
      try {
        content = fs.readFileSync(file.absPath, 'utf8');
      } catch {
        continue;
      }
      chunkCount += this.indexSingleFile(safeId, file.relPath, content, file.mtimeMs, file.size);
    }
    return chunkCount;
  }

  search(
    agentId: string,
    query: string,
    limit = 10,
    options?: MemorySearchOptions,
  ): MemorySearchHit[] {
    const safeId = sanitizeAgentId(agentId);
    const trimmed = query.trim();
    if (!trimmed) return [];

    const includeMainGlobal = options?.includeMainGlobal !== false && safeId !== 'main';
    const activeProjectKeys = resolveProjectMemoryKeys(options?.workspaceDir);

    const db = this.ensureIndexDb();
    this.syncAgentIndexIfStale(safeId);
    if (includeMainGlobal) {
      this.syncAgentIndexIfStale('main');
    }

    const clampedLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    const useFts = this.ftsTokenizer !== 'trigram' || Array.from(trimmed).length >= 3;

    const ownConditions = ["project_keys = ''"];
    const scopeParams: string[] = [safeId];
    for (const key of activeProjectKeys) {
      ownConditions.push("INSTR(char(10) || project_keys || char(10), char(10) || ? || char(10)) > 0");
      scopeParams.push(key);
    }
    const ownClause = `(agent_id = ? AND (${ownConditions.join(' OR ')}))`;
    let visibilityClause = ownClause;
    if (includeMainGlobal) {
      visibilityClause = `(${ownClause} OR (agent_id = ? AND project_keys = '' AND rel_path IN (?, ?)))`;
      scopeParams.push('main', WorkspaceFileName.Memory, WorkspaceFileName.User);
    }

    if (useFts) {
      const escaped = `"${trimmed.replace(/"/g, '""')}"`;
      try {
        const rows = db.prepare(`
          SELECT agent_id, rel_path, line_start, line_end, content, bm25(memory_chunks) AS score
          FROM memory_chunks
          WHERE (${visibilityClause}) AND memory_chunks MATCH ?
          ORDER BY score ASC
          LIMIT ?
        `).all(...scopeParams, escaped, clampedLimit) as Array<{
          agent_id: string;
          rel_path: string;
          line_start: number;
          line_end: number;
          content: string;
          score: number;
        }>;
        if (rows.length > 0) {
          return rows.map((row) => ({
            agentId: row.agent_id,
            relPath: row.rel_path,
            lineStart: row.line_start,
            lineEnd: row.line_end,
            snippet: row.content,
            score: -row.score,
          }));
        }
      } catch {
        // Fall through to LIKE substring search on FTS syntax edge cases.
      }
    }

    // Substring fallback handles 1–2 char CJK queries (below trigram length 3).
    const likePattern = `%${trimmed.replace(/[\\%_]/g, '\\$&')}%`;
    const rows = db.prepare(`
      SELECT agent_id, rel_path, line_start, line_end, content
      FROM memory_chunks
      WHERE (${visibilityClause}) AND content LIKE ? ESCAPE '\\'
      LIMIT ?
    `).all(...scopeParams, likePattern, clampedLimit) as Array<{
      agent_id: string;
      rel_path: string;
      line_start: number;
      line_end: number;
      content: string;
    }>;

    return rows.map((row, idx) => ({
      agentId: row.agent_id,
      relPath: row.rel_path,
      lineStart: row.line_start,
      lineEnd: row.line_end,
      snippet: row.content,
      score: Math.max(0.1, 1 - idx * 0.05),
    }));
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private ensureIndexDb(): Database.Database {
    if (this.db) return this.db;
    fs.mkdirSync(this.workspacesDir, { recursive: true });
    const dbPath = path.join(this.workspacesDir, MEMORY_FTS_DB_NAME);
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    // Recreate derived FTS5 index cleanly if an older DB lacks `project_keys`.
    const existingTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_chunks'")
      .get() as { name?: string } | undefined;
    if (existingTable?.name) {
      const cols = db.prepare('PRAGMA table_info(memory_chunks)').all() as Array<{ name?: string }>;
      const hasProjectKeys = cols.some((col) => col.name === 'project_keys');
      if (!hasProjectKeys) {
        db.exec('DROP TABLE IF EXISTS memory_chunks; DROP TABLE IF EXISTS memory_file_meta;');
      }
    }

    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks USING fts5(
          agent_id UNINDEXED,
          rel_path UNINDEXED,
          line_start UNINDEXED,
          line_end UNINDEXED,
          project_keys UNINDEXED,
          content,
          tokenize='trigram'
        );
      `);
      this.ftsTokenizer = 'trigram';
    } catch {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks USING fts5(
          agent_id UNINDEXED,
          rel_path UNINDEXED,
          line_start UNINDEXED,
          line_end UNINDEXED,
          project_keys UNINDEXED,
          content,
          tokenize='unicode61'
        );
      `);
      this.ftsTokenizer = 'unicode61';
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_file_meta (
        agent_id TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (agent_id, rel_path)
      );
    `);

    this.db = db;
    return db;
  }

  private syncAgentIndexIfStale(agentId: string): void {
    const db = this.ensureIndexDb();
    const workspaceDir = this.getAgentWorkspaceDir(agentId);
    const metaRows = db
      .prepare('SELECT rel_path, mtime_ms, size FROM memory_file_meta WHERE agent_id = ?')
      .all(agentId) as Array<{ rel_path: string; mtime_ms: number; size: number }>;
    const metaByPath = new Map(metaRows.map((row) => [row.rel_path, row]));

    if (!fs.existsSync(workspaceDir)) {
      if (metaByPath.size > 0) {
        this.deleteAgentIndex(agentId);
      } else {
        const orphan = db
          .prepare('SELECT 1 FROM memory_chunks WHERE agent_id = ? LIMIT 1')
          .get(agentId);
        if (orphan) {
          db.prepare('DELETE FROM memory_chunks WHERE agent_id = ?').run(agentId);
        }
      }
      return;
    }

    const diskFiles = collectIndexableFiles(workspaceDir);
    const diskPathSet = new Set(diskFiles.map((f) => f.relPath));

    // Remove deleted files from FTS5 and meta table.
    for (const relPath of metaByPath.keys()) {
      if (!diskPathSet.has(relPath)) {
        const delTx = db.transaction(() => {
          db.prepare('DELETE FROM memory_chunks WHERE agent_id = ? AND rel_path = ?').run(agentId, relPath);
          db.prepare('DELETE FROM memory_file_meta WHERE agent_id = ? AND rel_path = ?').run(agentId, relPath);
        });
        delTx();
      }
    }

    // Reindex any new or modified file.
    for (const file of diskFiles) {
      const tracked = metaByPath.get(file.relPath);
      if (tracked && tracked.mtime_ms === file.mtimeMs && tracked.size === file.size) {
        continue;
      }
      let content: string;
      try {
        content = fs.readFileSync(file.absPath, 'utf8');
      } catch {
        continue;
      }
      this.indexSingleFile(agentId, file.relPath, content, file.mtimeMs, file.size);
    }
  }

  private indexSingleFile(
    agentId: string,
    relPath: string,
    content: string,
    mtimeMs?: number,
    size?: number,
  ): number {
    const db = this.ensureIndexDb();
    const deleteStmt = db.prepare('DELETE FROM memory_chunks WHERE agent_id = ? AND rel_path = ?');
    const insertStmt = db.prepare(
      'INSERT INTO memory_chunks (agent_id, rel_path, line_start, line_end, project_keys, content) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const upsertMetaStmt = db.prepare(
      'INSERT OR REPLACE INTO memory_file_meta (agent_id, rel_path, mtime_ms, size) VALUES (?, ?, ?, ?)',
    );

    const chunks = splitMarkdownChunks(content);
    const resolvedMeta = (mtimeMs !== undefined && size !== undefined)
      ? { mtimeMs, size }
      : safeStatFile(path.join(this.getAgentWorkspaceDir(agentId), relPath));

    const runTx = db.transaction(() => {
      deleteStmt.run(agentId, relPath);
      for (const chunk of chunks) {
        insertStmt.run(
          agentId,
          relPath,
          chunk.lineStart,
          chunk.lineEnd,
          chunk.projectKeys,
          chunk.content,
        );
      }
      if (resolvedMeta) {
        upsertMetaStmt.run(agentId, relPath, resolvedMeta.mtimeMs, resolvedMeta.size);
      }
    });
    runTx();
    return chunks.length;
  }
}

const PROMOTION_COMMENT_RE = /^[ \t]*<!--\s*openclaw-memory-promotion:[^>]*-->[ \t]*\r?\n?/gm;

interface IndexableFileEntry {
  relPath: string;
  absPath: string;
  mtimeMs: number;
  size: number;
}

function safeStatFile(filePath: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function walkMarkdownFilesRecursive(
  rootDir: string,
  relPrefix: string,
  out: IndexableFileEntry[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === '.dreams') continue;
    const absPath = path.join(rootDir, entry.name);
    const relPath = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      walkMarkdownFilesRecursive(absPath, relPath, out);
      continue;
    }
    if (!entry.name.endsWith('.md')) continue;
    const stat = safeStatFile(absPath);
    if (stat) {
      out.push({ relPath, absPath, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
}

function collectIndexableFiles(workspaceDir: string): IndexableFileEntry[] {
  const files: IndexableFileEntry[] = [];
  for (const rootFile of [WorkspaceFileName.Memory, WorkspaceFileName.User]) {
    const absPath = path.join(workspaceDir, rootFile);
    const stat = safeStatFile(absPath);
    if (stat) {
      files.push({ relPath: rootFile, absPath, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
  const dailyDir = path.join(workspaceDir, MEMORY_DAILY_DIR_NAME);
  if (fs.existsSync(dailyDir)) {
    walkMarkdownFilesRecursive(dailyDir, MEMORY_DAILY_DIR_NAME, files);
  }
  return files;
}

interface MarkdownSearchChunk {
  lineStart: number;
  lineEnd: number;
  content: string;
  projectKeys: string;
}

function splitMarkdownChunks(content: string): MarkdownSearchChunk[] {
  const blocks = parseScopedMarkdownBlocks(content);
  const chunks: MarkdownSearchChunk[] = [];

  for (const block of blocks) {
    if (block.kind !== 'entry') continue;
    const projectKeys = !block.annotated
      ? ''
      : block.projectKeys.length > 0
        ? block.projectKeys.join('\n')
        : INVALID_PROJECT_KEY_SENTINEL;

    for (let offset = 0; offset < block.lines.length; offset += 24) {
      const slice = block.lines.slice(offset, offset + 24);
      const cleaned = stripProjectTags(slice.join('\n'))
        .replace(PROMOTION_COMMENT_RE, '')
        .trim();
      if (!cleaned) continue;
      chunks.push({
        lineStart: block.lineStart + offset,
        lineEnd: block.lineStart + offset + slice.length - 1,
        content: cleaned,
        projectKeys,
      });
    }
  }

  return chunks;
}
