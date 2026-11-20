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
const HTML_COMMENT_OPEN_RE = /^<!--/;

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
}

interface ParsedMemoryFile {
  segments: MemorySegment[];
  trailingSection?: string;
}

function normalizeForFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function memoryFingerprint(text: string): string {
  return crypto.createHash('sha1').update(normalizeForFingerprint(text)).digest('hex');
}

function blockDisplayText(lines: string[]): string {
  const [first, ...rest] = lines;
  const match = first.match(ANY_BULLET_RE);
  return [match ? match[1] : first, ...rest].join('\n');
}

export function parseMemoryMarkdown(content: string): ParsedMemoryFile {
  const rawLines = content.replace(/\r\n/g, '\n').split('\n');
  const segments: MemorySegment[] = [];
  let currentSection: string | undefined;
  let inFence = false;
  let index = 0;

  while (index < rawLines.length) {
    const line = rawLines[index];
    if (FENCE_RE.test(line)) {
      const fenceLines = [line];
      inFence = !inFence;
      index += 1;
      while (index < rawLines.length && inFence) {
        fenceLines.push(rawLines[index]);
        if (FENCE_RE.test(rawLines[index])) inFence = false;
        index += 1;
      }
      segments.push({ kind: 'verbatim', lines: fenceLines });
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      if (heading[1].length >= 2) {
        currentSection = heading[2].trim();
      }
      segments.push({ kind: 'verbatim', lines: [line] });
      index += 1;
      continue;
    }

    if (line.trim() === '' || HTML_COMMENT_OPEN_RE.test(line)) {
      segments.push({ kind: 'verbatim', lines: [line] });
      index += 1;
      continue;
    }

    if (TOP_BULLET_RE.test(line)) {
      const entryLines = [line];
      index += 1;
      while (index < rawLines.length) {
        const next = rawLines[index];
        if (
          next.trim() === ''
          || TOP_BULLET_RE.test(next)
          || HEADING_RE.test(next)
          || FENCE_RE.test(next)
          || HTML_COMMENT_OPEN_RE.test(next)
        ) {
          break;
        }
        entryLines.push(next);
        index += 1;
      }
      const text = blockDisplayText(entryLines);
      segments.push({
        kind: 'entry',
        lines: entryLines,
        entry: {
          id: memoryFingerprint(text),
          text,
          section: currentSection,
        },
      });
      continue;
    }

    const proseLines = [line];
    index += 1;
    while (index < rawLines.length) {
      const next = rawLines[index];
      if (
        next.trim() === ''
        || TOP_BULLET_RE.test(next)
        || HEADING_RE.test(next)
        || FENCE_RE.test(next)
        || HTML_COMMENT_OPEN_RE.test(next)
      ) {
        break;
      }
      proseLines.push(next);
      index += 1;
    }
    const text = proseLines.join('\n').trim();
    segments.push({
      kind: 'entry',
      lines: proseLines,
      entry: {
        id: memoryFingerprint(text),
        text,
        section: currentSection,
      },
    });
  }

  return { segments, trailingSection: currentSection };
}

function serializeMemorySegments(segments: MemorySegment[]): string {
  const joined = segments.map((segment) => segment.lines.join('\n')).join('\n');
  return joined.endsWith('\n') ? joined : `${joined}\n`;
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
    if (fileName === WorkspaceFileName.Memory) {
      this.indexSingleFile(sanitizeAgentId(agentId), WorkspaceFileName.Memory, content);
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
    const trimmed = text.trim();
    if (!trimmed) throw new Error('Memory text must not be empty');
    const safeId = sanitizeAgentId(agentId);
    const existing = this.readWorkspaceFile(safeId, WorkspaceFileName.Memory);
    const bulletLines = trimmed.split('\n').map((line, idx) => (idx === 0 ? `- ${line}` : `  ${line}`));
    const entry: MemoryEntry = {
      id: memoryFingerprint(trimmed),
      text: trimmed,
      section: section?.trim() || undefined,
    };

    let nextContent: string;
    if (!existing.trim()) {
      const parts = [MEMORY_HEADER, ''];
      if (entry.section) parts.push(`## ${entry.section}`, '');
      parts.push(...bulletLines, '');
      nextContent = parts.join('\n');
    } else {
      const parsed = parseMemoryMarkdown(existing);
      const duplicate = parsed.segments.find((segment) => segment.entry?.id === entry.id);
      if (duplicate?.entry) return duplicate.entry;

      const trimmedExisting = existing.replace(/\s+$/, '');
      if (entry.section && parsed.trailingSection !== entry.section) {
        nextContent = `${trimmedExisting}\n\n## ${entry.section}\n\n${bulletLines.join('\n')}\n`;
      } else {
        nextContent = `${trimmedExisting}\n${bulletLines.join('\n')}\n`;
      }
    }

    this.writeWorkspaceFile(safeId, WorkspaceFileName.Memory, nextContent);
    return entry;
  }

  updateMemory(agentId: string, id: string, nextText: string): MemoryEntry | null {
    const trimmed = nextText.trim();
    if (!trimmed) throw new Error('Memory text must not be empty');
    const safeId = sanitizeAgentId(agentId);
    const existing = this.readWorkspaceFile(safeId, WorkspaceFileName.Memory);
    if (!existing.trim()) return null;

    const parsed = parseMemoryMarkdown(existing);
    const target = parsed.segments.find((segment) => segment.kind === 'entry' && segment.entry?.id === id);
    if (!target || !target.entry) return null;

    const bulletLines = trimmed.split('\n').map((line, idx) => (idx === 0 ? `- ${line}` : `  ${line}`));
    target.lines = bulletLines;
    target.entry = {
      id: memoryFingerprint(trimmed),
      text: trimmed,
      section: target.entry.section,
    };

    this.writeWorkspaceFile(safeId, WorkspaceFileName.Memory, serializeMemorySegments(parsed.segments));
    return target.entry;
  }

  deleteMemory(agentId: string, id: string): boolean {
    const safeId = sanitizeAgentId(agentId);
    const existing = this.readWorkspaceFile(safeId, WorkspaceFileName.Memory);
    if (!existing.trim()) return false;

    const parsed = parseMemoryMarkdown(existing);
    const nextSegments = parsed.segments.filter((segment) => !(segment.kind === 'entry' && segment.entry?.id === id));
    if (nextSegments.length === parsed.segments.length) return false;

    this.writeWorkspaceFile(safeId, WorkspaceFileName.Memory, serializeMemorySegments(nextSegments));
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
    this.indexSingleFile(safeId, relPath, nextContent);
    return relPath;
  }

  readMemorySnippet(agentId: string, relPath: string, fromLine = 1, lineCount = 80): string | null {
    const safeId = sanitizeAgentId(agentId);
    const workspaceDir = this.getAgentWorkspaceDir(safeId);
    const normalizedRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const resolved = path.resolve(workspaceDir, normalizedRel);
    const relativeCheck = path.relative(workspaceDir, resolved);
    if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
      throw new Error(`Refusing path outside agent workspace: ${relPath}`);
    }
    if (!fs.existsSync(resolved)) return null;
    const lines = fs.readFileSync(resolved, 'utf8').replace(/\r\n/g, '\n').split('\n');
    const startIdx = Math.max(0, Math.floor(fromLine) - 1);
    const endIdx = Math.min(lines.length, startIdx + Math.max(1, Math.floor(lineCount)));
    return lines.slice(startIdx, endIdx).join('\n');
  }

  reindexAgent(agentId = 'main'): number {
    const safeId = sanitizeAgentId(agentId);
    const db = this.ensureIndexDb();
    const workspaceDir = this.getAgentWorkspaceDir(safeId);

    const clearStmt = db.prepare('DELETE FROM memory_chunks WHERE agent_id = ?');
    clearStmt.run(safeId);

    if (!fs.existsSync(workspaceDir)) return 0;

    let chunkCount = 0;
    const memoryPath = path.join(workspaceDir, WorkspaceFileName.Memory);
    if (fs.existsSync(memoryPath)) {
      chunkCount += this.indexSingleFile(safeId, WorkspaceFileName.Memory, fs.readFileSync(memoryPath, 'utf8'));
    }

    const dailyDir = path.join(workspaceDir, MEMORY_DAILY_DIR_NAME);
    if (fs.existsSync(dailyDir)) {
      const files = fs.readdirSync(dailyDir).filter((name) => name.endsWith('.md')).sort();
      for (const name of files) {
        const relPath = `${MEMORY_DAILY_DIR_NAME}/${name}`;
        const content = fs.readFileSync(path.join(dailyDir, name), 'utf8');
        chunkCount += this.indexSingleFile(safeId, relPath, content);
      }
    }
    return chunkCount;
  }

  search(agentId: string, query: string, limit = 10): MemorySearchHit[] {
    const safeId = sanitizeAgentId(agentId);
    const trimmed = query.trim();
    if (!trimmed) return [];

    const db = this.ensureIndexDb();
    const countRow = db.prepare('SELECT COUNT(*) AS count FROM memory_chunks WHERE agent_id = ?').get(safeId) as { count: number };
    if (countRow.count === 0) {
      this.reindexAgent(safeId);
    }

    const clampedLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    const useFts = this.ftsTokenizer !== 'trigram' || Array.from(trimmed).length >= 3;

    if (useFts) {
      const escaped = `"${trimmed.replace(/"/g, '""')}"`;
      try {
        const rows = db.prepare(`
          SELECT agent_id, rel_path, line_start, line_end, content, bm25(memory_chunks) AS score
          FROM memory_chunks
          WHERE agent_id = ? AND memory_chunks MATCH ?
          ORDER BY score ASC
          LIMIT ?
        `).all(safeId, escaped, clampedLimit) as Array<{
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
      WHERE agent_id = ? AND content LIKE ? ESCAPE '\\'
      LIMIT ?
    `).all(safeId, likePattern, clampedLimit) as Array<{
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
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks USING fts5(
          agent_id UNINDEXED,
          rel_path UNINDEXED,
          line_start UNINDEXED,
          line_end UNINDEXED,
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
          content,
          tokenize='unicode61'
        );
      `);
      this.ftsTokenizer = 'unicode61';
    }
    this.db = db;
    return db;
  }

  private indexSingleFile(agentId: string, relPath: string, content: string): number {
    const db = this.ensureIndexDb();
    const deleteStmt = db.prepare('DELETE FROM memory_chunks WHERE agent_id = ? AND rel_path = ?');
    const insertStmt = db.prepare(
      'INSERT INTO memory_chunks (agent_id, rel_path, line_start, line_end, content) VALUES (?, ?, ?, ?, ?)'
    );

    const chunks = splitMarkdownChunks(content);
    const runTx = db.transaction(() => {
      deleteStmt.run(agentId, relPath);
      for (const chunk of chunks) {
        insertStmt.run(agentId, relPath, chunk.lineStart, chunk.lineEnd, chunk.content);
      }
    });
    runTx();
    return chunks.length;
  }
}

function splitMarkdownChunks(content: string): Array<{ lineStart: number; lineEnd: number; content: string }> {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const chunks: Array<{ lineStart: number; lineEnd: number; content: string }> = [];
  let start = -1;
  let buffer: string[] = [];

  const flush = (endIdx: number) => {
    const text = buffer.join('\n').trim();
    if (text && start >= 0) {
      chunks.push({ lineStart: start + 1, lineEnd: endIdx + 1, content: text });
    }
    start = -1;
    buffer = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      flush(i - 1);
      continue;
    }
    if (start < 0) start = i;
    buffer.push(line);
    if (buffer.length >= 24) {
      flush(i);
    }
  }
  flush(lines.length - 1);
  return chunks;
}
