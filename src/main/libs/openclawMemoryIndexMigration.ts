import Database from 'better-sqlite3';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const MEMORY_INDEX_REBUILD_TIMEOUT_MS = 180_000;
const LOG_TAIL_LIMIT = 4_000;
const MEMORY_INDEX_META_KEY = 'memory_index_meta_v1';
const DEFAULT_AGENT_ID = 'main';

export type MemoryIndexMigrationRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export type MemoryIndexMigrationRunner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
) => Promise<MemoryIndexMigrationRunResult>;

export type MemoryIndexMigrationResult =
  | {
      status: 'skipped';
      reason: MemoryIndexMigrationSkippedReason;
    }
  | { status: 'migrated'; code: number | null; reason: string }
  | { status: 'failed'; code: number | null; error?: string };

export type MemoryIndexMigrationSkippedReason =
  | 'missing-config'
  | 'invalid-config'
  | 'not-fts-only-config'
  | 'missing-openclaw-cli'
  | 'no-index-db'
  | 'index-meta-current';

type JsonRecord = Record<string, unknown>;

type MemoryIndexMeta = {
  model?: string;
  provider?: string;
  ftsTokenizer?: string;
};

export type MemoryIndexMigrationTarget = {
  agentId: string;
  dbPath: string;
  expectedTokenizer?: string;
  reason: string;
};

export type MemoryIndexMigrationNeed =
  | { shouldMigrate: false; reason: MemoryIndexMigrationSkippedReason }
  | { shouldMigrate: true; targets: MemoryIndexMigrationTarget[]; reason: string };

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readJsonFile(filePath: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveConfiguredAgentEntries(config: JsonRecord): JsonRecord[] {
  const agents = isRecord(config.agents) ? config.agents : null;
  const configuredEntries = isRecord(agents?.entries)
    ? Object.entries(agents.entries)
      .filter(([, entry]) => isRecord(entry))
      .map(([id, entry]) => ({ id, ...(entry as JsonRecord) }))
    : [];
  if (configuredEntries.length > 0) {
    return configuredEntries;
  }
  const list = Array.isArray(agents?.list) ? agents.list : [];
  const entries = list.filter((entry): entry is JsonRecord => (
    isRecord(entry) && typeof entry.id === 'string' && Boolean(entry.id.trim())
  ));
  return entries.length > 0 ? entries : [{ id: DEFAULT_AGENT_ID }];
}

function resolveDefaultMemorySearchConfig(config: JsonRecord): JsonRecord | null {
  const memory = isRecord(config.memory) ? config.memory : null;
  if (isRecord(memory?.search)) {
    return memory.search;
  }
  const agents = isRecord(config.agents) ? config.agents : null;
  const defaults = isRecord(agents?.defaults) ? agents.defaults : null;
  if (isRecord(defaults?.memorySearch)) {
    return defaults.memorySearch;
  }
  return isRecord(config.memorySearch) ? config.memorySearch : null;
}

function resolveAgentMemorySearchConfig(agentEntry: JsonRecord): JsonRecord | null {
  const memory = isRecord(agentEntry.memory) ? agentEntry.memory : null;
  if (isRecord(memory?.search)) {
    return memory.search;
  }
  return isRecord(agentEntry.memorySearch) ? agentEntry.memorySearch : null;
}

function mergeMemorySearchConfig(
  defaults: JsonRecord | null,
  agentEntry: JsonRecord,
): JsonRecord | null {
  const overrides = resolveAgentMemorySearchConfig(agentEntry);
  if (!overrides) {
    return defaults;
  }
  const defaultStore = isRecord(defaults?.store) ? defaults.store : {};
  const overrideStore = isRecord(overrides.store) ? overrides.store : {};
  const defaultFts = isRecord(defaultStore.fts) ? defaultStore.fts : {};
  const overrideFts = isRecord(overrideStore.fts) ? overrideStore.fts : {};
  const defaultVector = isRecord(defaultStore.vector) ? defaultStore.vector : {};
  const overrideVector = isRecord(overrideStore.vector) ? overrideStore.vector : {};
  return {
    ...(defaults ?? {}),
    ...overrides,
    store: {
      ...defaultStore,
      ...overrideStore,
      fts: { ...defaultFts, ...overrideFts },
      vector: { ...defaultVector, ...overrideVector },
    },
  };
}

function isFtsOnlyMemorySearch(memorySearch: JsonRecord | null): boolean {
  if (!memorySearch) {
    return false;
  }
  const store = isRecord(memorySearch.store) ? memorySearch.store : {};
  const vector = isRecord(store.vector) ? store.vector : {};
  return memorySearch.provider === 'none' && vector.enabled === false;
}

function resolveFtsTokenizer(memorySearch: JsonRecord): string | undefined {
  const store = isRecord(memorySearch.store) ? memorySearch.store : {};
  const fts = isRecord(store.fts) ? store.fts : {};
  return typeof fts.tokenizer === 'string' && fts.tokenizer.trim()
    ? fts.tokenizer.trim()
    : undefined;
}

function resolveUserPath(filePath: string): string {
  if (filePath === '~') {
    return os.homedir();
  }
  if (filePath.startsWith(`~${path.sep}`) || filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return path.resolve(filePath);
}

export function resolveMemoryIndexPath(params: {
  agentId: string;
  memorySearch: JsonRecord;
  stateDir: string;
}): string {
  const store = isRecord(params.memorySearch.store) ? params.memorySearch.store : {};
  const configuredPath = typeof store.path === 'string' && store.path.trim()
    ? store.path.trim().replace(/\{agentId\}/g, params.agentId)
    : null;
  if (configuredPath) {
    return resolveUserPath(configuredPath);
  }
  return path.join(params.stateDir, 'memory', `${params.agentId}.sqlite`);
}

function readMemoryIndexMeta(dbPath: string): MemoryIndexMeta | null {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    let row: { value?: unknown } | undefined;
    try {
      row = db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get(MEMORY_INDEX_META_KEY) as { value?: unknown } | undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no such table: meta/i.test(message)) {
        return null;
      }
      throw error;
    }
    if (typeof row?.value !== 'string' || !row.value.trim()) {
      return null;
    }
    const parsed = JSON.parse(row.value);
    return isRecord(parsed) ? parsed : null;
  } finally {
    db.close();
  }
}

function isMemoryIndexMetaCurrent(
  meta: MemoryIndexMeta | null,
  expectedTokenizer?: string,
): boolean {
  return Boolean(
    meta?.model === 'fts-only' &&
    meta.provider === 'none' &&
    (!expectedTokenizer || meta.ftsTokenizer === expectedTokenizer),
  );
}

function describeMemoryIndexMismatch(
  meta: MemoryIndexMeta | null,
  expectedTokenizer?: string,
): string {
  return meta
    ? `index meta is ${JSON.stringify({
        model: meta.model,
        provider: meta.provider,
        ftsTokenizer: meta.ftsTokenizer,
      })}, expected fts-only/${expectedTokenizer ?? 'default'}`
    : 'index metadata is missing';
}

export function resolveFtsOnlyMemoryIndexMigrationNeed(params: {
  configPath: string;
  stateDir: string;
}): MemoryIndexMigrationNeed {
  if (!fs.existsSync(params.configPath)) {
    return { shouldMigrate: false, reason: 'missing-config' };
  }

  const config = readJsonFile(params.configPath);
  if (!config) {
    return { shouldMigrate: false, reason: 'invalid-config' };
  }

  const defaultMemorySearch = resolveDefaultMemorySearchConfig(config);
  const agentEntries = resolveConfiguredAgentEntries(config);
  const resolvedAgents = agentEntries.map((entry) => ({
    agentId: String(entry.id).trim(),
    memorySearch: mergeMemorySearchConfig(defaultMemorySearch, entry),
  }));
  if (resolvedAgents.some(({ memorySearch }) => !isFtsOnlyMemorySearch(memorySearch))) {
    return { shouldMigrate: false, reason: 'not-fts-only-config' };
  }

  let existingIndexCount = 0;
  const targets: MemoryIndexMigrationTarget[] = [];
  for (const { agentId, memorySearch } of resolvedAgents) {
    if (!memorySearch) {
      continue;
    }
    const dbPath = resolveMemoryIndexPath({
      agentId,
      memorySearch,
      stateDir: params.stateDir,
    });
    if (!fs.existsSync(dbPath)) {
      continue;
    }
    existingIndexCount += 1;
    const expectedTokenizer = resolveFtsTokenizer(memorySearch);
    const meta = readMemoryIndexMeta(dbPath);
    if (isMemoryIndexMetaCurrent(meta, expectedTokenizer)) {
      continue;
    }
    targets.push({
      agentId,
      dbPath,
      expectedTokenizer,
      reason: describeMemoryIndexMismatch(meta, expectedTokenizer),
    });
  }

  if (targets.length === 0) {
    return {
      shouldMigrate: false,
      reason: existingIndexCount === 0 ? 'no-index-db' : 'index-meta-current',
    };
  }

  const reason = targets
    .map((target) => `${target.agentId}: ${target.reason}`)
    .join('; ');
  return { shouldMigrate: true, targets, reason };
}

function tailLog(text: string): string {
  if (text.length <= LOG_TAIL_LIMIT) {
    return text;
  }
  return text.slice(text.length - LOG_TAIL_LIMIT);
}

export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<MemoryIndexMigrationRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`OpenClaw memory index migration timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function findStaleTargets(targets: MemoryIndexMigrationTarget[]): MemoryIndexMigrationTarget[] {
  return targets.filter((target) => {
    if (!fs.existsSync(target.dbPath)) {
      return true;
    }
    return !isMemoryIndexMetaCurrent(
      readMemoryIndexMeta(target.dbPath),
      target.expectedTokenizer,
    );
  });
}

export async function migrateAllFtsOnlyMemoryIndexes(params: {
  stateDir: string;
  configPath: string;
  runtimeRoot: string;
  electronNodeRuntimePath: string;
  env: NodeJS.ProcessEnv;
  runner?: MemoryIndexMigrationRunner;
}): Promise<MemoryIndexMigrationResult> {
  let need: MemoryIndexMigrationNeed;
  try {
    need = resolveFtsOnlyMemoryIndexMigrationNeed({
      configPath: params.configPath,
      stateDir: params.stateDir,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[OpenClaw] Failed to inspect memory index metadata before migration:', error);
    return { status: 'failed', code: null, error: message };
  }

  if (need.shouldMigrate === false) {
    return { status: 'skipped', reason: need.reason };
  }

  const openclawCliPath = path.join(params.runtimeRoot, 'openclaw.mjs');
  if (!fs.existsSync(openclawCliPath)) {
    console.warn(`[OpenClaw] Memory index migration needed but OpenClaw CLI is missing: ${openclawCliPath}`);
    return { status: 'skipped', reason: 'missing-openclaw-cli' };
  }

  const runner = params.runner ?? runProcess;
  const env: NodeJS.ProcessEnv = {
    ...params.env,
    OPENCLAW_HOME: path.dirname(params.stateDir),
    OPENCLAW_STATE_DIR: params.stateDir,
    OPENCLAW_CONFIG_PATH: params.configPath,
    ELECTRON_RUN_AS_NODE: '1',
  };
  const args = [openclawCliPath, 'memory', 'index', '--force'];
  const targetAgentIds = need.targets.map((target) => target.agentId);

  console.log(
    `[OpenClaw] FTS-only memory index migration needed for agents ${JSON.stringify(targetAgentIds)}; running official all-agent reindex: ${JSON.stringify(args.slice(1))}`,
  );
  try {
    const result = await runner(params.electronNodeRuntimePath, args, {
      cwd: params.runtimeRoot,
      env,
      timeoutMs: MEMORY_INDEX_REBUILD_TIMEOUT_MS,
    });

    if (result.code === 0) {
      const staleTargets = findStaleTargets(need.targets);
      if (staleTargets.length > 0) {
        const staleAgentIds = staleTargets.map((target) => target.agentId);
        const error = `post-reindex verification failed for agents ${JSON.stringify(staleAgentIds)}`;
        console.warn(`[OpenClaw] FTS-only memory index migration ${error}.`);
        return { status: 'failed', code: result.code, error };
      }
      console.log(`[OpenClaw] FTS-only memory index migration completed: ${need.reason}`);
      return { status: 'migrated', code: result.code, reason: need.reason };
    }

    console.warn(
      [
        `[OpenClaw] FTS-only memory index migration failed with exit code ${result.code}.`,
        result.stderr ? `stderr tail:\n${tailLog(result.stderr)}` : '',
        result.stdout ? `stdout tail:\n${tailLog(result.stdout)}` : '',
      ].filter(Boolean).join('\n'),
    );
    return { status: 'failed', code: result.code };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[OpenClaw] FTS-only memory index migration failed before gateway startup:', error);
    return { status: 'failed', code: null, error: message };
  }
}
