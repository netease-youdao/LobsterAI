import Database from 'better-sqlite3';
import crypto from 'crypto';
import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';


// Default working directory for new users
const getDefaultWorkingDirectory = (): string => {
  return path.join(os.homedir(), 'lobsterai', 'project');
};

const TASK_WORKSPACE_CONTAINER_DIR = '.lobsterai-tasks';

const normalizeRecentWorkspacePath = (cwd: string): string => {
  const resolved = path.resolve(cwd);
  const marker = `${path.sep}${TASK_WORKSPACE_CONTAINER_DIR}${path.sep}`;
  const markerIndex = resolved.lastIndexOf(marker);
  if (markerIndex > 0) {
    return resolved.slice(0, markerIndex);
  }
  return resolved;
};

const DEFAULT_MEMORY_ENABLED = true;
const DEFAULT_MEMORY_IMPLICIT_UPDATE_ENABLED = true;
const DEFAULT_MEMORY_LLM_JUDGE_ENABLED = false;
export type CoworkMemoryGuardLevel = 'strict' | 'standard' | 'relaxed';
const DEFAULT_MEMORY_GUARD_LEVEL: CoworkMemoryGuardLevel = 'strict';
const DEFAULT_MEMORY_USER_MEMORIES_MAX_ITEMS = 12;
const MIN_MEMORY_USER_MEMORIES_MAX_ITEMS = 1;
const MAX_MEMORY_USER_MEMORIES_MAX_ITEMS = 60;
const MEMORY_NEAR_DUPLICATE_MIN_SCORE = 0.82;
const MEMORY_PROCEDURAL_TEXT_RE = /(执行以下命令|run\s+(?:the\s+)?following\s+command|\b(?:cd|npm|pnpm|yarn|node|python|bash|sh|git|curl|wget)\b|\$[A-Z_][A-Z0-9_]*|&&|--[a-z0-9-]+|\/tmp\/|\.sh\b|\.bat\b|\.ps1\b)/i;
const MEMORY_ASSISTANT_STYLE_TEXT_RE = /^(?:使用|use)\s+[A-Za-z0-9._-]+\s*(?:技能|skill)/i;

const DEFAULT_EMBEDDING_ENABLED = false;
const DEFAULT_EMBEDDING_PROVIDER = 'openai';
const DEFAULT_EMBEDDING_MODEL = '';
const DEFAULT_EMBEDDING_LOCAL_MODEL_PATH = '';
const DEFAULT_EMBEDDING_VECTOR_WEIGHT = 0.7;
const DEFAULT_EMBEDDING_REMOTE_BASE_URL = '';
const DEFAULT_EMBEDDING_REMOTE_API_KEY = '';

// Regexes and helper inlined from the removed coworkMemoryExtractor module.
// Used only by shouldAutoDeleteMemoryText() during startup memory cleanup.
const CHINESE_QUESTION_PREFIX_RE = /^(?:请问|问下|问一下|是否|能否|可否|为什么|为何|怎么|如何|谁|什么|哪(?:里|儿|个)?|几|多少|要不要|会不会|是不是|能不能|可不可以|行不行|对不对|好不好)/u;
const ENGLISH_QUESTION_PREFIX_RE = /^(?:what|who|why|how|when|where|which|is|are|am|do|does|did|can|could|would|will|should)\b/i;
const QUESTION_INLINE_RE = /(是不是|能不能|可不可以|要不要|会不会|有没有|对不对|好不好)/i;
const QUESTION_SUFFIX_RE = /(吗|么|呢|嘛)\s*$/u;

function isQuestionLikeMemoryText(text: string): boolean {
  // This function has its own normalization (strips trailing punctuation)
  // that differs from normalizeMemoryText, so it cannot reuse that helper.
  const normalized = text.replace(/\s+/g, ' ').trim().replace(/[。！!]+$/g, '').trim();
  if (!normalized) return false;
  if (/[？?]\s*$/.test(normalized)) return true;
  if (CHINESE_QUESTION_PREFIX_RE.test(normalized)) return true;
  if (ENGLISH_QUESTION_PREFIX_RE.test(normalized)) return true;
  if (QUESTION_INLINE_RE.test(normalized)) return true;
  if (QUESTION_SUFFIX_RE.test(normalized)) return true;
  return false;
}

function normalizeMemoryGuardLevel(value: string | undefined): CoworkMemoryGuardLevel {
  if (value === 'strict' || value === 'standard' || value === 'relaxed') return value;
  return DEFAULT_MEMORY_GUARD_LEVEL;
}

function parseBooleanConfig(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

function clampMemoryUserMemoriesMaxItems(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MEMORY_USER_MEMORIES_MAX_ITEMS;
  return Math.max(
    MIN_MEMORY_USER_MEMORIES_MAX_ITEMS,
    Math.min(MAX_MEMORY_USER_MEMORIES_MAX_ITEMS, Math.floor(value))
  );
}

function parseEmbeddingVectorWeight(value: string | undefined): number {
  if (!value) return DEFAULT_EMBEDDING_VECTOR_WEIGHT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_EMBEDDING_VECTOR_WEIGHT;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeMemoryText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function extractConversationSearchTerms(value: string): string[] {
  const normalized = normalizeMemoryText(value).toLowerCase();
  if (!normalized) return [];

  const terms: string[] = [];
  const seen = new Set<string>();
  const addTerm = (term: string): void => {
    const normalizedTerm = normalizeMemoryText(term).toLowerCase();
    if (!normalizedTerm) return;
    if (/^[a-z0-9]$/i.test(normalizedTerm)) return;
    if (seen.has(normalizedTerm)) return;
    seen.add(normalizedTerm);
    terms.push(normalizedTerm);
  };

  // Keep the full phrase and additionally match by per-token terms.
  addTerm(normalized);
  const tokens = normalized
    .split(/[\s,，、|/\\;；]+/g)
    .map((token) => token.replace(/^['"`]+|['"`]+$/g, '').trim())
    .filter(Boolean);

  for (const token of tokens) {
    addTerm(token);
    if (terms.length >= 8) break;
  }

  return terms.slice(0, 8);
}

function normalizeMemoryMatchKey(value: string): string {
  return normalizeMemoryText(value)
    .toLowerCase()
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMemorySemanticKey(value: string): string {
  const key = normalizeMemoryMatchKey(value);
  if (!key) return '';
  return key
    .replace(/^(?:the user|user|i am|i m|i|my|me)\s+/i, '')
    .replace(/^(?:该用户|这个用户|用户|本人|我的|我们|咱们|咱|我|你的|你)\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTokenFrequencyMap(value: string): Map<string, number> {
  const tokens = value
    .split(/\s+/g)
    .map((token) => token.trim())
    .filter(Boolean);
  const map = new Map<string, number>();
  for (const token of tokens) {
    map.set(token, (map.get(token) || 0) + 1);
  }
  return map;
}

function scoreTokenOverlap(left: string, right: string): number {
  const leftMap = buildTokenFrequencyMap(left);
  const rightMap = buildTokenFrequencyMap(right);
  if (leftMap.size === 0 || rightMap.size === 0) return 0;

  let leftCount = 0;
  let rightCount = 0;
  let intersection = 0;
  for (const count of leftMap.values()) leftCount += count;
  for (const count of rightMap.values()) rightCount += count;
  for (const [token, leftValue] of leftMap.entries()) {
    intersection += Math.min(leftValue, rightMap.get(token) || 0);
  }

  const denominator = Math.min(leftCount, rightCount);
  if (denominator <= 0) return 0;
  return intersection / denominator;
}

function buildCharacterBigramMap(value: string): Map<string, number> {
  const compact = value.replace(/\s+/g, '').trim();
  if (!compact) return new Map<string, number>();
  if (compact.length <= 1) return new Map<string, number>([[compact, 1]]);

  const map = new Map<string, number>();
  for (let index = 0; index < compact.length - 1; index += 1) {
    const gram = compact.slice(index, index + 2);
    map.set(gram, (map.get(gram) || 0) + 1);
  }
  return map;
}

function scoreCharacterBigramDice(left: string, right: string): number {
  const leftMap = buildCharacterBigramMap(left);
  const rightMap = buildCharacterBigramMap(right);
  if (leftMap.size === 0 || rightMap.size === 0) return 0;

  let leftCount = 0;
  let rightCount = 0;
  let intersection = 0;
  for (const count of leftMap.values()) leftCount += count;
  for (const count of rightMap.values()) rightCount += count;
  for (const [gram, leftValue] of leftMap.entries()) {
    intersection += Math.min(leftValue, rightMap.get(gram) || 0);
  }

  const denominator = leftCount + rightCount;
  if (denominator <= 0) return 0;
  return (2 * intersection) / denominator;
}

function scoreMemorySimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;

  const compactLeft = left.replace(/\s+/g, '');
  const compactRight = right.replace(/\s+/g, '');
  if (compactLeft && compactLeft === compactRight) {
    return 1;
  }

  let phraseScore = 0;
  if (compactLeft && compactRight && (compactLeft.includes(compactRight) || compactRight.includes(compactLeft))) {
    phraseScore = Math.min(compactLeft.length, compactRight.length) / Math.max(compactLeft.length, compactRight.length);
  }

  return Math.max(
    phraseScore,
    scoreTokenOverlap(left, right),
    scoreCharacterBigramDice(left, right)
  );
}

function scoreMemoryTextQuality(value: string): number {
  const normalized = normalizeMemoryText(value);
  if (!normalized) return 0;
  let score = normalized.length;
  if (/^(?:该用户|这个用户|用户)\s*/u.test(normalized)) {
    score -= 12;
  }
  if (/^(?:the user|user)\b/i.test(normalized)) {
    score -= 12;
  }
  if (/^(?:我|我的|我是|我有|我会|我喜欢|我偏好)/u.test(normalized)) {
    score += 4;
  }
  if (/^(?:i|i am|i'm|my)\b/i.test(normalized)) {
    score += 4;
  }
  return score;
}

function choosePreferredMemoryText(currentText: string, incomingText: string): string {
  const normalizedCurrent = truncate(normalizeMemoryText(currentText), 360);
  const normalizedIncoming = truncate(normalizeMemoryText(incomingText), 360);
  if (!normalizedCurrent) return normalizedIncoming;
  if (!normalizedIncoming) return normalizedCurrent;

  const currentScore = scoreMemoryTextQuality(normalizedCurrent);
  const incomingScore = scoreMemoryTextQuality(normalizedIncoming);
  if (incomingScore > currentScore + 1) return normalizedIncoming;
  if (currentScore > incomingScore + 1) return normalizedCurrent;
  return normalizedIncoming.length >= normalizedCurrent.length ? normalizedIncoming : normalizedCurrent;
}

function buildMemoryFingerprint(text: string): string {
  const key = normalizeMemoryMatchKey(text);
  return crypto.createHash('sha1').update(key).digest('hex');
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

function parseTimeToMs(input?: string | null): number | null {
  if (!input) return null;
  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp)) return null;
  return timestamp;
}

function shouldAutoDeleteMemoryText(text: string): boolean {
  const normalized = normalizeMemoryText(text);
  if (!normalized) return false;
  return MEMORY_ASSISTANT_STYLE_TEXT_RE.test(normalized)
    || MEMORY_PROCEDURAL_TEXT_RE.test(normalized)
    || isQuestionLikeMemoryText(normalized);
}

// Types mirroring src/types/cowork.ts for main process use
export type CoworkSessionStatus = 'idle' | 'running' | 'completed' | 'error';
export type CoworkMessageType = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';
export type CoworkExecutionMode = 'auto' | 'local' | 'sandbox';
export type CoworkAgentEngine = 'openclaw';

export type AgentSource = 'custom' | 'preset';

export interface Agent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  identity: string;
  model: string;
  icon: string;
  skillIds: string[];
  enabled: boolean;
  isDefault: boolean;
  source: AgentSource;
  presetId: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateAgentRequest {
  id?: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  identity?: string;
  model?: string;
  icon?: string;
  skillIds?: string[];
  source?: AgentSource;
  presetId?: string;
}

export interface UpdateAgentRequest {
  name?: string;
  description?: string;
  systemPrompt?: string;
  identity?: string;
  model?: string;
  icon?: string;
  skillIds?: string[];
  enabled?: boolean;
}

const COWORK_AGENT_ENGINE = 'openclaw';

function normalizeCoworkAgentEngineValue(_value?: string | null): CoworkAgentEngine {
  return COWORK_AGENT_ENGINE;
}

export interface CoworkMessageMetadata {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  toolUseId?: string | null;
  error?: string;
  isError?: boolean;
  isStreaming?: boolean;
  isFinal?: boolean;
  skillIds?: string[];
  [key: string]: unknown;
}

export interface CoworkMessage {
  id: string;
  type: CoworkMessageType;
  content: string;
  timestamp: number;
  metadata?: CoworkMessageMetadata;
}

export interface CoworkSession {
  id: string;
  title: string;
  claudeSessionId: string | null;
  status: CoworkSessionStatus;
  pinned: boolean;
  cwd: string;
  systemPrompt: string;
  modelOverride: string;
  executionMode: CoworkExecutionMode;
  activeSkillIds: string[];
  agentId: string;
  messages: CoworkMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface CoworkSessionSummary {
  id: string;
  title: string;
  status: CoworkSessionStatus;
  pinned: boolean;
  agentId: string;
  createdAt: number;
  updatedAt: number;
}

export type CoworkUserMemoryStatus = 'created' | 'stale' | 'deleted';

export interface CoworkUserMemory {
  id: string;
  text: string;
  confidence: number;
  isExplicit: boolean;
  status: CoworkUserMemoryStatus;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface CoworkUserMemorySource {
  id: string;
  memoryId: string;
  sessionId: string | null;
  messageId: string | null;
  role: 'user' | 'assistant' | 'tool' | 'system';
  isActive: boolean;
  createdAt: number;
}

export interface CoworkUserMemorySourceInput {
  sessionId?: string;
  messageId?: string;
  role?: 'user' | 'assistant' | 'tool' | 'system';
}

export interface CoworkUserMemoryStats {
  total: number;
  created: number;
  stale: number;
  deleted: number;
  explicit: number;
  implicit: number;
}

export interface CoworkConversationSearchRecord {
  sessionId: string;
  title: string;
  updatedAt: number;
  url: string;
  human: string;
  assistant: string;
}

export interface CoworkConfig {
  workingDirectory: string;
  systemPrompt: string;
  executionMode: CoworkExecutionMode;
  agentEngine: CoworkAgentEngine;
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: CoworkMemoryGuardLevel;
  memoryUserMemoriesMaxItems: number;
  skipMissedJobs: boolean;
  embeddingEnabled: boolean;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingLocalModelPath: string;
  embeddingVectorWeight: number;
  embeddingRemoteBaseUrl: string;
  embeddingRemoteApiKey: string;
}

export type CoworkConfigUpdate = Partial<Pick<
CoworkConfig,
  | 'workingDirectory'
  | 'executionMode'
  | 'agentEngine'
  | 'memoryEnabled'
  | 'memoryImplicitUpdateEnabled'
  | 'memoryLlmJudgeEnabled'
  | 'memoryGuardLevel'
  | 'memoryUserMemoriesMaxItems'
  | 'skipMissedJobs'
  | 'embeddingEnabled'
  | 'embeddingProvider'
  | 'embeddingModel'
  | 'embeddingLocalModelPath'
  | 'embeddingVectorWeight'
  | 'embeddingRemoteBaseUrl'
  | 'embeddingRemoteApiKey'
>>;


let cachedDefaultSystemPrompt: string | null = null;

const getDefaultSystemPrompt = (): string => {
  if (cachedDefaultSystemPrompt !== null) {
    return cachedDefaultSystemPrompt;
  }
  try {
    const promptPath = path.join(app.getAppPath(), 'resources', 'SYSTEM_PROMPT.md');
    cachedDefaultSystemPrompt = fs.readFileSync(promptPath, 'utf-8');
  } catch {
    cachedDefaultSystemPrompt = '';
  }
  return cachedDefaultSystemPrompt;
};

interface CoworkMessageRow {
  id: string;
  type: string;
  content: string;
  metadata: string | null;
  created_at: number;
  sequence: number | null;
}

interface CoworkUserMemoryRow {
  id: string;
  text: string;
  fingerprint: string;
  confidence: number;
  is_explicit: number;
  status: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

export class CoworkStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  private getOne<T>(sql: string, params: (string | number | null)[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private getAll<T>(sql: string, params: (string | number | null)[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private upsertConfig(key: string, value: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO cowork_config (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(key, value, now);
  }

  createSession(
    title: string,
    cwd: string,
    systemPrompt: string = '',
    executionMode: CoworkExecutionMode = 'local',
    activeSkillIds: string[] = [],
    agentId: string = 'main'
  ): CoworkSession {
    const id = uuidv4();
    const now = Date.now();

    this.db
      .prepare(
        `
      INSERT INTO cowork_sessions (id, title, claude_session_id, status, cwd, system_prompt, model_override, execution_mode, active_skill_ids, agent_id, pinned, created_at, updated_at)
      VALUES (?, ?, NULL, 'idle', ?, ?, '', ?, ?, ?, 0, ?, ?)
    `,
      )
      .run(
        id,
        title,
        cwd,
        systemPrompt,
        executionMode,
        JSON.stringify(activeSkillIds),
        agentId,
        now,
        now,
      );

    return {
      id,
      title,
      claudeSessionId: null,
      status: 'idle',
      pinned: false,
      cwd,
      systemPrompt,
      modelOverride: '',
      executionMode,
      activeSkillIds,
      agentId,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  getSession(id: string): CoworkSession | null {
    interface SessionRow {
      id: string;
      title: string;
      claude_session_id: string | null;
      status: string;
      pinned?: number | null;
      cwd: string;
      system_prompt: string;
      model_override?: string | null;
      execution_mode?: string | null;
      active_skill_ids?: string | null;
      agent_id?: string | null;
      created_at: number;
      updated_at: number;
    }

    const row = this.getOne<SessionRow>(
      `
      SELECT id, title, claude_session_id, status, pinned, cwd, system_prompt, model_override, execution_mode, active_skill_ids, agent_id, created_at, updated_at
      FROM cowork_sessions
      WHERE id = ?
    `,
      [id],
    );

    if (!row) return null;

    const messages = this.getSessionMessages(id);

    let activeSkillIds: string[] = [];
    if (row.active_skill_ids) {
      try {
        activeSkillIds = JSON.parse(row.active_skill_ids);
      } catch (e) {
        console.error('[CoworkStore] Failed to parse active_skill_ids for session', id, e);
        activeSkillIds = [];
      }
    }

    return {
      id: row.id,
      title: row.title,
      claudeSessionId: row.claude_session_id,
      status: row.status as CoworkSessionStatus,
      pinned: Boolean(row.pinned),
      cwd: row.cwd,
      systemPrompt: row.system_prompt,
      modelOverride: row.model_override || '',
      executionMode: (row.execution_mode as CoworkExecutionMode) || 'local',
      activeSkillIds,
      agentId: row.agent_id || 'main',
      messages,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  updateSession(
    id: string,
    updates: Partial<
      Pick<
        CoworkSession,
        'title' | 'claudeSessionId' | 'status' | 'cwd' | 'systemPrompt' | 'modelOverride' | 'executionMode'
      >
    >,
  ): void {
    const now = Date.now();
    const setClauses: string[] = ['updated_at = ?'];
    const values: (string | number | null)[] = [now];

    if (updates.title !== undefined) {
      setClauses.push('title = ?');
      values.push(updates.title);
    }
    if (updates.claudeSessionId !== undefined) {
      setClauses.push('claude_session_id = ?');
      values.push(updates.claudeSessionId);
    }
    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      values.push(updates.status);
    }
    if (updates.cwd !== undefined) {
      setClauses.push('cwd = ?');
      values.push(updates.cwd);
    }
    if (updates.systemPrompt !== undefined) {
      setClauses.push('system_prompt = ?');
      values.push(updates.systemPrompt);
    }
    if (updates.modelOverride !== undefined) {
      setClauses.push('model_override = ?');
      values.push(updates.modelOverride);
    }
    if (updates.executionMode !== undefined) {
      setClauses.push('execution_mode = ?');
      values.push(updates.executionMode);
    }

    values.push(id);
    this.db
      .prepare(
        `
      UPDATE cowork_sessions
      SET ${setClauses.join(', ')}
      WHERE id = ?
    `,
      )
      .run(...values);
  }

  deleteSession(id: string): void {
    this.markMemorySourcesInactiveBySession(id);
    this.db.prepare('DELETE FROM cowork_sessions WHERE id = ?').run(id);
    this.markOrphanImplicitMemoriesStale();
  }

  deleteSessions(ids: string[]): void {
    if (ids.length === 0) return;
    for (const id of ids) {
      this.markMemorySourcesInactiveBySession(id);
    }
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM cowork_sessions WHERE id IN (${placeholders})`).run(...ids);
    this.markOrphanImplicitMemoriesStale();
  }

  setSessionPinned(id: string, pinned: boolean): void {
    this.db.prepare('UPDATE cowork_sessions SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
  }

  listSessions(agentId?: string): CoworkSessionSummary[] {
    interface SessionSummaryRow {
      id: string;
      title: string;
      status: string;
      pinned: number | null;
      agent_id: string | null;
      created_at: number;
      updated_at: number;
    }

    let rows: SessionSummaryRow[];
    if (agentId) {
      rows = this.getAll<SessionSummaryRow>(
        `
        SELECT id, title, status, pinned, agent_id, created_at, updated_at
        FROM cowork_sessions
        WHERE agent_id = ?
        ORDER BY pinned DESC, updated_at DESC
      `,
        [agentId],
      );
    } else {
      rows = this.getAll<SessionSummaryRow>(`
        SELECT id, title, status, pinned, agent_id, created_at, updated_at
        FROM cowork_sessions
        ORDER BY pinned DESC, updated_at DESC
      `);
    }

    return rows.map(row => ({
      id: row.id,
      title: row.title,
      status: row.status as CoworkSessionStatus,
      pinned: Boolean(row.pinned),
      agentId: row.agent_id || 'main',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  resetRunningSessions(): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `
      UPDATE cowork_sessions
      SET status = 'idle', updated_at = ?
      WHERE status = 'running'
    `,
      )
      .run(now);
    return result.changes;
  }

  listRecentCwds(limit: number = 8): string[] {
    interface CwdRow {
      cwd: string;
      updated_at: number;
    }

    const rows = this.getAll<CwdRow>(
      `
      SELECT cwd, updated_at
      FROM cowork_sessions
      WHERE cwd IS NOT NULL AND TRIM(cwd) != ''
      ORDER BY updated_at DESC
      LIMIT ?
    `,
      [Math.max(limit * 8, limit)],
    );

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const normalized = normalizeRecentWorkspacePath(row.cwd);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      deduped.push(normalized);
      if (deduped.length >= limit) {
        break;
      }
    }

    return deduped;
  }

  private getSessionMessages(sessionId: string): CoworkMessage[] {
    const rows = this.getAll<CoworkMessageRow>(
      `
      SELECT id, type, content, metadata, created_at, sequence
      FROM cowork_messages
      WHERE session_id = ?
      ORDER BY
        COALESCE(sequence, created_at) ASC,
        created_at ASC,
        ROWID ASC
    `,
      [sessionId],
    );

    return rows.map(row => {
      let metadata: Record<string, unknown> | undefined;
      if (row.metadata) {
        try {
          metadata = JSON.parse(row.metadata);
        } catch {
          console.warn(
            `[CoworkStore] corrupt metadata detected for message ${row.id} in session ${sessionId}, discarding metadata`,
          );
          metadata = undefined;
        }
      }
      return {
        id: row.id,
        type: row.type as CoworkMessageType,
        content: row.content,
        timestamp: row.created_at,
        metadata,
      };
    });
  }

  addMessage(sessionId: string, message: Omit<CoworkMessage, 'id' | 'timestamp'>): CoworkMessage {
    const id = uuidv4();
    const now = Date.now();

    const seqRow = this.db
      .prepare(
        'SELECT COALESCE(MAX(sequence), 0) + 1 as next_seq FROM cowork_messages WHERE session_id = ?',
      )
      .get(sessionId) as { next_seq: number } | undefined;
    const sequence = seqRow?.next_seq ?? 1;

    this.db
      .prepare(
        `
      INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        sessionId,
        message.type,
        message.content,
        message.metadata ? JSON.stringify(message.metadata) : null,
        now,
        sequence,
      );

    this.db.prepare('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);

    return {
      id,
      type: message.type,
      content: message.content,
      timestamp: now,
      metadata: message.metadata,
    };
  }

  /**
   * Insert a message before an existing message (by shifting sequences).
   * Used for channel-originated sessions where user messages need to appear
   * before assistant messages that were created during streaming.
   */
  insertMessageBeforeId(
    sessionId: string,
    beforeMessageId: string,
    message: Omit<CoworkMessage, 'id' | 'timestamp'>,
  ): CoworkMessage {
    const id = uuidv4();
    const now = Date.now();

    // Get the target message's sequence
    const targetRow = this.db
      .prepare('SELECT sequence FROM cowork_messages WHERE id = ? AND session_id = ?')
      .get(beforeMessageId, sessionId) as { sequence: number } | undefined;
    const targetSequence = targetRow?.sequence;

    if (targetSequence === undefined) {
      // Fallback to normal append if the target message is not found
      return this.addMessage(sessionId, message);
    }

    this.db.transaction(() => {
      // Shift all messages with sequence >= target up by 1
      this.db
        .prepare(
          'UPDATE cowork_messages SET sequence = sequence + 1 WHERE session_id = ? AND sequence >= ?',
        )
        .run(sessionId, targetSequence);

      // Insert at the target's original sequence
      this.db
        .prepare(
          `
        INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          id,
          sessionId,
          message.type,
          message.content,
          message.metadata ? JSON.stringify(message.metadata) : null,
          now,
          targetSequence,
        );

      this.db.prepare('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
    })();

    return {
      id,
      type: message.type,
      content: message.content,
      timestamp: now,
      metadata: message.metadata,
    };
  }

  /**
   * Delete a message from a session.
   * Used by reconciliation to remove duplicate or spurious messages.
   */
  deleteMessage(sessionId: string, messageId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM cowork_messages WHERE id = ? AND session_id = ?')
      .run(messageId, sessionId);
    return result.changes > 0;
  }

  /**
   * Replace all user/assistant messages in a session with the given list.
   * Tool messages (tool_use, tool_result, system) are preserved in their existing positions.
   * Used by history reconciliation to align local state with the authoritative gateway history.
   */
  replaceConversationMessages(
    sessionId: string,
    authoritative: Array<{ role: 'user' | 'assistant'; text: string }>,
  ): void {
    const now = Date.now();

    this.db.transaction(() => {
      // Delete all existing user/assistant messages for this session
      this.db
        .prepare("DELETE FROM cowork_messages WHERE session_id = ? AND type IN ('user', 'assistant')")
        .run(sessionId);

      // Re-insert authoritative messages with correct sequence numbers
      // First, get the current max sequence from remaining messages (tool_use, tool_result, system)
      const seqRow = this.db
        .prepare(
          'SELECT COALESCE(MAX(sequence), 0) as max_seq FROM cowork_messages WHERE session_id = ?',
        )
        .get(sessionId) as { max_seq: number } | undefined;
      let nextSeq = (seqRow?.max_seq ?? 0) + 1;

      for (const entry of authoritative) {
        const id = uuidv4();
        this.db
          .prepare(
            `
          INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            id,
            sessionId,
            entry.role,
            entry.text,
            JSON.stringify({ isStreaming: false, isFinal: true }),
            now,
            nextSeq++,
          );
      }

      this.db.prepare('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
    })();
  }

  updateMessage(
    sessionId: string,
    messageId: string,
    updates: { content?: string; metadata?: CoworkMessageMetadata },
  ): void {
    const setClauses: string[] = [];
    const values: (string | null)[] = [];

    if (updates.content !== undefined) {
      setClauses.push('content = ?');
      values.push(updates.content);
    }
    if (updates.metadata !== undefined) {
      setClauses.push('metadata = ?');
      values.push(updates.metadata ? JSON.stringify(updates.metadata) : null);
    }

    if (setClauses.length === 0) return;

    values.push(messageId);
    values.push(sessionId);
    this.db
      .prepare(
        `
      UPDATE cowork_messages
      SET ${setClauses.join(', ')}
      WHERE id = ? AND session_id = ?
    `,
      )
      .run(...values);
  }

  // Config operations
  getConfig(): CoworkConfig {
    const configKeys = [
      'workingDirectory',
      'executionMode',
      'agentEngine',
      'memoryEnabled',
      'memoryImplicitUpdateEnabled',
      'memoryLlmJudgeEnabled',
      'memoryGuardLevel',
      'memoryUserMemoriesMaxItems',
      'skipMissedJobs',
      'embeddingEnabled',
      'embeddingProvider',
      'embeddingModel',
      'embeddingLocalModelPath',
      'embeddingVectorWeight',
      'embeddingRemoteBaseUrl',
      'embeddingRemoteApiKey',
    ] as const;
    const configRows = this.getAll<{ key: string; value: string }>(
      `SELECT key, value FROM cowork_config WHERE key IN (${configKeys.map(() => '?').join(', ')})`,
      [...configKeys],
    );
    const cfg = new Map(configRows.map(r => [r.key, r.value]));

    return {
      workingDirectory: cfg.get('workingDirectory') || getDefaultWorkingDirectory(),
      systemPrompt: getDefaultSystemPrompt(),
      executionMode: 'local' as CoworkExecutionMode,
      agentEngine: normalizeCoworkAgentEngineValue(cfg.get('agentEngine')),
      memoryEnabled: parseBooleanConfig(cfg.get('memoryEnabled'), DEFAULT_MEMORY_ENABLED),
      memoryImplicitUpdateEnabled: parseBooleanConfig(
        cfg.get('memoryImplicitUpdateEnabled'),
        DEFAULT_MEMORY_IMPLICIT_UPDATE_ENABLED,
      ),
      memoryLlmJudgeEnabled: parseBooleanConfig(
        cfg.get('memoryLlmJudgeEnabled'),
        DEFAULT_MEMORY_LLM_JUDGE_ENABLED,
      ),
      memoryGuardLevel: normalizeMemoryGuardLevel(cfg.get('memoryGuardLevel')),
      memoryUserMemoriesMaxItems: clampMemoryUserMemoriesMaxItems(
        Number(cfg.get('memoryUserMemoriesMaxItems')),
      ),
      skipMissedJobs: parseBooleanConfig(cfg.get('skipMissedJobs'), true),
      embeddingEnabled: parseBooleanConfig(cfg.get('embeddingEnabled'), DEFAULT_EMBEDDING_ENABLED),
      embeddingProvider: cfg.get('embeddingProvider') || DEFAULT_EMBEDDING_PROVIDER,
      embeddingModel: cfg.get('embeddingModel') || DEFAULT_EMBEDDING_MODEL,
      embeddingLocalModelPath: cfg.get('embeddingLocalModelPath') || DEFAULT_EMBEDDING_LOCAL_MODEL_PATH,
      embeddingVectorWeight: parseEmbeddingVectorWeight(cfg.get('embeddingVectorWeight')),
      embeddingRemoteBaseUrl: cfg.get('embeddingRemoteBaseUrl') || DEFAULT_EMBEDDING_REMOTE_BASE_URL,
      embeddingRemoteApiKey: cfg.get('embeddingRemoteApiKey') || DEFAULT_EMBEDDING_REMOTE_API_KEY,
    };
  }

  setConfig(config: CoworkConfigUpdate): void {
    const now = Date.now();

    if (config.workingDirectory !== undefined) {
      this.upsertConfig('workingDirectory', config.workingDirectory, now);
    }
    if (config.executionMode !== undefined) {
      this.upsertConfig('executionMode', config.executionMode, now);
    }
    if (config.agentEngine !== undefined) {
      this.upsertConfig('agentEngine', normalizeCoworkAgentEngineValue(config.agentEngine), now);
    }
    if (config.memoryEnabled !== undefined) {
      this.upsertConfig('memoryEnabled', config.memoryEnabled ? '1' : '0', now);
    }
    if (config.memoryImplicitUpdateEnabled !== undefined) {
      this.upsertConfig('memoryImplicitUpdateEnabled', config.memoryImplicitUpdateEnabled ? '1' : '0', now);
    }
    if (config.memoryLlmJudgeEnabled !== undefined) {
      this.upsertConfig('memoryLlmJudgeEnabled', config.memoryLlmJudgeEnabled ? '1' : '0', now);
    }
    if (config.memoryGuardLevel !== undefined) {
      this.upsertConfig('memoryGuardLevel', normalizeMemoryGuardLevel(config.memoryGuardLevel), now);
    }
    if (config.memoryUserMemoriesMaxItems !== undefined) {
      this.upsertConfig('memoryUserMemoriesMaxItems', String(clampMemoryUserMemoriesMaxItems(config.memoryUserMemoriesMaxItems)), now);
    }
    if (config.skipMissedJobs !== undefined) {
      this.upsertConfig('skipMissedJobs', config.skipMissedJobs ? '1' : '0', now);
    }
    if (config.embeddingEnabled !== undefined) {
      this.upsertConfig('embeddingEnabled', config.embeddingEnabled ? '1' : '0', now);
    }
    if (config.embeddingProvider !== undefined) {
      this.upsertConfig('embeddingProvider', String(config.embeddingProvider), now);
    }
    if (config.embeddingModel !== undefined) {
      this.upsertConfig('embeddingModel', String(config.embeddingModel), now);
    }
    if (config.embeddingLocalModelPath !== undefined) {
      this.upsertConfig('embeddingLocalModelPath', String(config.embeddingLocalModelPath), now);
    }
    if (config.embeddingVectorWeight !== undefined) {
      this.upsertConfig('embeddingVectorWeight', String(Math.max(0, Math.min(1, config.embeddingVectorWeight))), now);
    }
    if (config.embeddingRemoteBaseUrl !== undefined) {
      this.upsertConfig('embeddingRemoteBaseUrl', String(config.embeddingRemoteBaseUrl), now);
    }
    if (config.embeddingRemoteApiKey !== undefined) {
      this.upsertConfig('embeddingRemoteApiKey', String(config.embeddingRemoteApiKey), now);
    }
  }

  getAppLanguage(): 'zh' | 'en' {
    interface KvRow {
      value: string;
    }

    const row = this.getOne<KvRow>('SELECT value FROM kv WHERE key = ?', ['app_config']);
    if (!row?.value) {
      return 'zh';
    }

    try {
      const config = JSON.parse(row.value) as { language?: string };
      return config.language === 'en' ? 'en' : 'zh';
    } catch {
      return 'zh';
    }
  }

  private mapMemoryRow(row: CoworkUserMemoryRow): CoworkUserMemory {
    return {
      id: row.id,
      text: row.text,
      confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0.7,
      isExplicit: Boolean(row.is_explicit),
      status: (row.status === 'stale' || row.status === 'deleted'
        ? row.status
        : 'created') as CoworkUserMemoryStatus,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
    };
  }

  private addMemorySource(memoryId: string, source?: CoworkUserMemorySourceInput): void {
    const now = Date.now();
    this.db
      .prepare(
        `
      INSERT INTO user_memory_sources (id, memory_id, session_id, message_id, role, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `,
      )
      .run(
        uuidv4(),
        memoryId,
        source?.sessionId || null,
        source?.messageId || null,
        source?.role || 'system',
        now,
      );
  }

  private createOrReviveUserMemory(input: {
    text: string;
    confidence?: number;
    isExplicit?: boolean;
    source?: CoworkUserMemorySourceInput;
  }): { memory: CoworkUserMemory; created: boolean; updated: boolean } {
    const normalizedText = truncate(normalizeMemoryText(input.text), 360);
    if (!normalizedText) {
      throw new Error('Memory text is required');
    }

    const now = Date.now();
    const fingerprint = buildMemoryFingerprint(normalizedText);
    const confidence = Math.max(
      0,
      Math.min(1, Number.isFinite(input.confidence) ? Number(input.confidence) : 0.75),
    );
    const explicitFlag = input.isExplicit ? 1 : 0;

    let existing = this.getOne<CoworkUserMemoryRow>(
      `
      SELECT id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
      FROM user_memories
      WHERE fingerprint = ? AND status != 'deleted'
      ORDER BY updated_at DESC
      LIMIT 1
    `,
      [fingerprint],
    );

    if (!existing) {
      const incomingSemanticKey = normalizeMemorySemanticKey(normalizedText);
      if (incomingSemanticKey) {
        const candidates = this.getAll<CoworkUserMemoryRow>(`
          SELECT id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
          FROM user_memories
          WHERE status != 'deleted'
          ORDER BY updated_at DESC
          LIMIT 200
        `);
        let bestCandidate: CoworkUserMemoryRow | null = null;
        let bestScore = 0;
        for (const candidate of candidates) {
          const candidateSemanticKey = normalizeMemorySemanticKey(candidate.text);
          if (!candidateSemanticKey) continue;
          const score = scoreMemorySimilarity(candidateSemanticKey, incomingSemanticKey);
          if (score <= bestScore) continue;
          bestScore = score;
          bestCandidate = candidate;
        }
        if (bestCandidate && bestScore >= MEMORY_NEAR_DUPLICATE_MIN_SCORE) {
          existing = bestCandidate;
        }
      }
    }

    if (existing) {
      const mergedText = choosePreferredMemoryText(existing.text, normalizedText);
      const mergedExplicit = existing.is_explicit ? 1 : explicitFlag;
      const mergedConfidence = Math.max(Number(existing.confidence) || 0, confidence);
      this.db
        .prepare(
          `
        UPDATE user_memories
        SET text = ?, fingerprint = ?, confidence = ?, is_explicit = ?, status = 'created', updated_at = ?
        WHERE id = ?
      `,
        )
        .run(
          mergedText,
          buildMemoryFingerprint(mergedText),
          mergedConfidence,
          mergedExplicit,
          now,
          existing.id,
        );
      this.addMemorySource(existing.id, input.source);
      const memory = this.getOne<CoworkUserMemoryRow>(
        `
        SELECT id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
        FROM user_memories
        WHERE id = ?
      `,
        [existing.id],
      );
      if (!memory) {
        throw new Error('Failed to reload updated memory');
      }
      return { memory: this.mapMemoryRow(memory), created: false, updated: true };
    }

    const id = uuidv4();
    this.db
      .prepare(
        `
      INSERT INTO user_memories (
        id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, 'created', ?, ?, NULL)
    `,
      )
      .run(id, normalizedText, fingerprint, confidence, explicitFlag, now, now);
    this.addMemorySource(id, input.source);

    const memory = this.getOne<CoworkUserMemoryRow>(
      `
      SELECT id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
      FROM user_memories
      WHERE id = ?
    `,
      [id],
    );
    if (!memory) {
      throw new Error('Failed to load created memory');
    }

    return { memory: this.mapMemoryRow(memory), created: true, updated: false };
  }

  listUserMemories(
    options: {
      query?: string;
      status?: CoworkUserMemoryStatus | 'all';
      limit?: number;
      offset?: number;
      includeDeleted?: boolean;
    } = {},
  ): CoworkUserMemory[] {
    const query = normalizeMemoryText(options.query || '');
    const includeDeleted = Boolean(options.includeDeleted);
    const status = options.status || 'all';
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 200)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));

    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (!includeDeleted && status === 'all') {
      clauses.push(`status != 'deleted'`);
    }
    if (status !== 'all') {
      clauses.push('status = ?');
      params.push(status);
    }
    if (query) {
      clauses.push('LOWER(text) LIKE ?');
      params.push(`%${query.toLowerCase()}%`);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = this.getAll<CoworkUserMemoryRow>(
      `
      SELECT id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
      FROM user_memories
      ${whereClause}
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `,
      [...params, limit, offset],
    );

    return rows.map(row => this.mapMemoryRow(row));
  }

  createUserMemory(input: {
    text: string;
    confidence?: number;
    isExplicit?: boolean;
    source?: CoworkUserMemorySourceInput;
  }): CoworkUserMemory {
    const result = this.createOrReviveUserMemory(input);
    return result.memory;
  }

  updateUserMemory(input: {
    id: string;
    text?: string;
    confidence?: number;
    status?: CoworkUserMemoryStatus;
    isExplicit?: boolean;
  }): CoworkUserMemory | null {
    const current = this.getOne<CoworkUserMemoryRow>(
      `
      SELECT id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
      FROM user_memories
      WHERE id = ?
    `,
      [input.id],
    );
    if (!current) return null;

    const now = Date.now();
    const nextText =
      input.text !== undefined ? truncate(normalizeMemoryText(input.text), 360) : current.text;
    if (!nextText) {
      throw new Error('Memory text is required');
    }
    const nextConfidence =
      input.confidence !== undefined
        ? Math.max(0, Math.min(1, Number(input.confidence)))
        : Number(current.confidence);
    const nextStatus =
      input.status &&
      (input.status === 'created' || input.status === 'stale' || input.status === 'deleted')
        ? input.status
        : current.status;
    const nextExplicit =
      input.isExplicit !== undefined ? (input.isExplicit ? 1 : 0) : current.is_explicit;

    this.db
      .prepare(
        `
      UPDATE user_memories
      SET text = ?, fingerprint = ?, confidence = ?, is_explicit = ?, status = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(
        nextText,
        buildMemoryFingerprint(nextText),
        nextConfidence,
        nextExplicit,
        nextStatus,
        now,
        input.id,
      );

    const updated = this.getOne<CoworkUserMemoryRow>(
      `
      SELECT id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
      FROM user_memories
      WHERE id = ?
    `,
      [input.id],
    );

    return updated ? this.mapMemoryRow(updated) : null;
  }

  deleteUserMemory(id: string): boolean {
    const now = Date.now();
    const memResult = this.db
      .prepare(
        `
      UPDATE user_memories
      SET status = 'deleted', updated_at = ?
      WHERE id = ?
    `,
      )
      .run(now, id);
    this.db
      .prepare(
        `
      UPDATE user_memory_sources
      SET is_active = 0
      WHERE memory_id = ?
    `,
      )
      .run(id);
    return memResult.changes > 0;
  }

  getUserMemoryStats(): CoworkUserMemoryStats {
    const rows = this.getAll<{
      status: string;
      is_explicit: number;
      count: number;
    }>(`
      SELECT status, is_explicit, COUNT(*) AS count
      FROM user_memories
      GROUP BY status, is_explicit
    `);

    const stats: CoworkUserMemoryStats = {
      total: 0,
      created: 0,
      stale: 0,
      deleted: 0,
      explicit: 0,
      implicit: 0,
    };

    for (const row of rows) {
      const count = Number(row.count) || 0;
      stats.total += count;
      if (row.status === 'created') stats.created += count;
      if (row.status === 'stale') stats.stale += count;
      if (row.status === 'deleted') stats.deleted += count;
      if (row.is_explicit) stats.explicit += count;
      else stats.implicit += count;
    }

    return stats;
  }

  autoDeleteNonPersonalMemories(): number {
    const rows = this.getAll<Pick<CoworkUserMemoryRow, 'id' | 'text'>>(
      `SELECT id, text FROM user_memories WHERE status = 'created'`,
    );
    if (rows.length === 0) return 0;

    const now = Date.now();
    let deleted = 0;
    for (const row of rows) {
      if (!shouldAutoDeleteMemoryText(row.text)) {
        continue;
      }
      this.db
        .prepare(
          `
        UPDATE user_memories
        SET status = 'deleted', updated_at = ?
        WHERE id = ?
      `,
        )
        .run(now, row.id);
      this.db
        .prepare(
          `
        UPDATE user_memory_sources
        SET is_active = 0
        WHERE memory_id = ?
      `,
        )
        .run(row.id);
      deleted += 1;
    }

    return deleted;
  }

  markMemorySourcesInactiveBySession(sessionId: string): void {
    this.db
      .prepare(
        `
      UPDATE user_memory_sources
      SET is_active = 0
      WHERE session_id = ? AND is_active = 1
    `,
      )
      .run(sessionId);
  }

  markOrphanImplicitMemoriesStale(): void {
    const now = Date.now();
    this.db
      .prepare(
        `
      UPDATE user_memories
      SET status = 'stale', updated_at = ?
      WHERE is_explicit = 0
        AND status = 'created'
        AND NOT EXISTS (
          SELECT 1
          FROM user_memory_sources s
          WHERE s.memory_id = user_memories.id AND s.is_active = 1
        )
    `,
      )
      .run(now);
  }

  private getLatestMessageByType(sessionId: string, type: 'user' | 'assistant'): string {
    const row = this.getOne<{ content: string }>(
      `
      SELECT content
      FROM cowork_messages
      WHERE session_id = ? AND type = ?
      ORDER BY created_at DESC, ROWID DESC
      LIMIT 1
    `,
      [sessionId, type],
    );
    return truncate((row?.content || '').replace(/\s+/g, ' ').trim(), 280);
  }

  conversationSearch(options: {
    query: string;
    maxResults?: number;
    before?: string;
    after?: string;
  }): CoworkConversationSearchRecord[] {
    const terms = extractConversationSearchTerms(options.query);
    if (terms.length === 0) return [];

    const maxResults = Math.max(1, Math.min(10, Math.floor(options.maxResults ?? 5)));
    const beforeMs = parseTimeToMs(options.before);
    const afterMs = parseTimeToMs(options.after);

    const likeClauses = terms.map(() => 'LOWER(m.content) LIKE ?');
    const clauses: string[] = ["m.type IN ('user', 'assistant')", `(${likeClauses.join(' OR ')})`];
    const params: Array<string | number> = terms.map(term => `%${term}%`);

    if (beforeMs !== null) {
      clauses.push('m.created_at < ?');
      params.push(beforeMs);
    }
    if (afterMs !== null) {
      clauses.push('m.created_at > ?');
      params.push(afterMs);
    }

    const rows = this.getAll<{
      session_id: string;
      title: string;
      updated_at: number;
      type: string;
      content: string;
      created_at: number;
    }>(
      `
      SELECT m.session_id, s.title, s.updated_at, m.type, m.content, m.created_at
      FROM cowork_messages m
      INNER JOIN cowork_sessions s ON s.id = m.session_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY m.created_at DESC
      LIMIT ?
    `,
      [...params, maxResults * 40],
    );

    const bySession = new Map<string, CoworkConversationSearchRecord>();
    for (const row of rows) {
      if (!row.session_id) continue;
      let current = bySession.get(row.session_id);
      if (!current) {
        current = {
          sessionId: row.session_id,
          title: row.title || 'Untitled',
          updatedAt: Number(row.updated_at) || 0,
          url: `https://claude.ai/chat/${row.session_id}`,
          human: '',
          assistant: '',
        };
        bySession.set(row.session_id, current);
      }

      const snippet = truncate((row.content || '').replace(/\s+/g, ' ').trim(), 280);
      if (row.type === 'user' && !current.human) {
        current.human = snippet;
      }
      if (row.type === 'assistant' && !current.assistant) {
        current.assistant = snippet;
      }

      if (bySession.size >= maxResults) {
        const complete = Array.from(bySession.values()).every(
          entry => entry.human && entry.assistant,
        );
        if (complete) break;
      }
    }

    const records = Array.from(bySession.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, maxResults)
      .map(entry => ({
        ...entry,
        human: entry.human || this.getLatestMessageByType(entry.sessionId, 'user'),
        assistant: entry.assistant || this.getLatestMessageByType(entry.sessionId, 'assistant'),
      }));

    return records;
  }

  recentChats(options: {
    n?: number;
    sortOrder?: 'asc' | 'desc';
    before?: string;
    after?: string;
  }): CoworkConversationSearchRecord[] {
    const n = Math.max(1, Math.min(20, Math.floor(options.n ?? 3)));
    const sortOrder = options.sortOrder === 'asc' ? 'asc' : 'desc';
    const beforeMs = parseTimeToMs(options.before);
    const afterMs = parseTimeToMs(options.after);

    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (beforeMs !== null) {
      clauses.push('updated_at < ?');
      params.push(beforeMs);
    }
    if (afterMs !== null) {
      clauses.push('updated_at > ?');
      params.push(afterMs);
    }

    const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = this.getAll<{
      id: string;
      title: string;
      updated_at: number;
    }>(
      `
      SELECT id, title, updated_at
      FROM cowork_sessions
      ${whereClause}
      ORDER BY updated_at ${sortOrder.toUpperCase()}
      LIMIT ?
    `,
      [...params, n],
    );

    return rows.map(row => ({
      sessionId: row.id,
      title: row.title || 'Untitled',
      updatedAt: Number(row.updated_at) || 0,
      url: `https://claude.ai/chat/${row.id}`,
      human: this.getLatestMessageByType(row.id, 'user'),
      assistant: this.getLatestMessageByType(row.id, 'assistant'),
    }));
  }

  // ========== Agent CRUD ==========

  listAgents(): Agent[] {
    interface AgentRow {
      id: string;
      name: string;
      description: string;
      system_prompt: string;
      identity: string;
      model: string;
      icon: string;
      skill_ids: string;
      enabled: number;
      is_default: number;
      source: string;
      preset_id: string;
      created_at: number;
      updated_at: number;
    }

    const rows = this.getAll<AgentRow>(`
      SELECT * FROM agents ORDER BY is_default DESC, created_at ASC
    `);

    return rows.map(row => this.mapAgentRow(row));
  }

  getAgent(id: string): Agent | null {
    interface AgentRow {
      id: string;
      name: string;
      description: string;
      system_prompt: string;
      identity: string;
      model: string;
      icon: string;
      skill_ids: string;
      enabled: number;
      is_default: number;
      source: string;
      preset_id: string;
      created_at: number;
      updated_at: number;
    }

    const row = this.getOne<AgentRow>(`SELECT * FROM agents WHERE id = ?`, [id]);
    if (!row) return null;
    return this.mapAgentRow(row);
  }

  createAgent(request: CreateAgentRequest): Agent {
    const id =
      request.id ||
      request.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') ||
      uuidv4();
    const now = Date.now();

    // Ensure no duplicate ID
    const existing = this.getAgent(id);
    if (existing) {
      // Append timestamp to make unique
      return this.createAgent({ ...request, id: `${id}-${Date.now()}` });
    }

    this.db
      .prepare(
        `
      INSERT INTO agents (id, name, description, system_prompt, identity, model, icon, skill_ids, enabled, is_default, source, preset_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        request.name,
        request.description || '',
        request.systemPrompt || '',
        request.identity || '',
        request.model || '',
        request.icon || '',
        JSON.stringify(request.skillIds || []),
        request.source || 'custom',
        request.presetId || '',
        now,
        now,
      );

    return this.getAgent(id)!;
  }

  backfillEmptyAgentModels(modelId: string): number {
    const normalizedModelId = modelId.trim();
    if (!normalizedModelId) return 0;

    const result = this.db
      .prepare('UPDATE agents SET model = ?, updated_at = ? WHERE TRIM(COALESCE(model, \'\')) = \'\'')
      .run(normalizedModelId, Date.now());

    return result.changes;
  }

  updateAgent(id: string, updates: UpdateAgentRequest): Agent | null {
    const existing = this.getAgent(id);
    if (!existing) return null;

    const now = Date.now();
    const setClauses: string[] = ['updated_at = ?'];
    const values: (string | number | null)[] = [now];

    if (updates.name !== undefined) {
      setClauses.push('name = ?');
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      setClauses.push('description = ?');
      values.push(updates.description);
    }
    if (updates.systemPrompt !== undefined) {
      setClauses.push('system_prompt = ?');
      values.push(updates.systemPrompt);
    }
    if (updates.identity !== undefined) {
      setClauses.push('identity = ?');
      values.push(updates.identity);
    }
    if (updates.model !== undefined) {
      setClauses.push('model = ?');
      values.push(updates.model);
    }
    if (updates.icon !== undefined) {
      setClauses.push('icon = ?');
      values.push(updates.icon);
    }
    if (updates.skillIds !== undefined) {
      setClauses.push('skill_ids = ?');
      values.push(JSON.stringify(updates.skillIds));
    }
    if (updates.enabled !== undefined) {
      setClauses.push('enabled = ?');
      values.push(updates.enabled ? 1 : 0);
    }

    values.push(id);
    this.db.prepare(`UPDATE agents SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
    return this.getAgent(id);
  }

  deleteAgent(id: string): boolean {
    if (id === 'main') return false; // Cannot delete default agent
    this.db.prepare('DELETE FROM agents WHERE id = ? AND is_default = 0').run(id);
    return true;
  }

  private mapAgentRow(row: {
    id: string;
    name: string;
    description: string;
    system_prompt: string;
    identity: string;
    model: string;
    icon: string;
    skill_ids: string;
    enabled: number;
    is_default: number;
    source: string;
    preset_id: string;
    created_at: number;
    updated_at: number;
  }): Agent {
    let skillIds: string[] = [];
    try {
      skillIds = JSON.parse(row.skill_ids);
    } catch {
      skillIds = [];
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      systemPrompt: row.system_prompt,
      identity: row.identity,
      model: row.model,
      icon: row.icon,
      skillIds,
      enabled: Boolean(row.enabled),
      isDefault: Boolean(row.is_default),
      source: row.source as AgentSource,
      presetId: row.preset_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
