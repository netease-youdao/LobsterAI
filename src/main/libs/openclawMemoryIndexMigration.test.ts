import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  type MemoryIndexMigrationRunner,
  migrateAllFtsOnlyMemoryIndexes,
  resolveFtsOnlyMemoryIndexMigrationNeed,
} from './openclawMemoryIndexMigration';

let tmpDir = '';
let stateDir = '';
let runtimeRoot = '';
let configPath = '';
let electronNodeRuntimePath = '';

type TestAgentEntry = {
  id: string;
  default?: boolean;
  memory?: { search?: Record<string, unknown> };
  memorySearch?: Record<string, unknown>;
};

function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFile(filePath: string, content: string): void {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeConfig(
  memorySearch: Record<string, unknown>,
  agents: TestAgentEntry[] = [{ id: 'main', default: true }],
): void {
  writeFile(
    configPath,
    `${JSON.stringify({
      gateway: { mode: 'local' },
      memory: { search: memorySearch },
      agents: {
        defaults: {
          workspace: path.join(stateDir, 'workspace-main'),
        },
        list: agents,
      },
    }, null, 2)}\n`,
  );
}

function defaultIndexPath(agentId: string): string {
  return path.join(stateDir, 'memory', `${agentId}.sqlite`);
}

function writeIndexMetaAtPath(filePath: string, meta: Record<string, unknown> | null): void {
  mkdirp(path.dirname(filePath));
  const db = new Database(filePath);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    if (meta) {
      db
        .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run('memory_index_meta_v1', JSON.stringify(meta));
    }
  } finally {
    db.close();
  }
}

function writeIndexMeta(agentId: string, meta: Record<string, unknown> | null): void {
  writeIndexMetaAtPath(defaultIndexPath(agentId), meta);
}

function writeEmptySqlite(agentId: string): void {
  const filePath = defaultIndexPath(agentId);
  mkdirp(path.dirname(filePath));
  const db = new Database(filePath);
  db.close();
}

function currentIndexMeta(): Record<string, unknown> {
  return {
    model: 'fts-only',
    provider: 'none',
    ftsTokenizer: 'trigram',
  };
}

function oldIndexMeta(): Record<string, unknown> {
  return {
    model: 'gemini-embedding-001',
    provider: 'gemini',
    ftsTokenizer: 'unicode61',
  };
}

function ftsOnlyMemorySearch(storePath?: string): Record<string, unknown> {
  return {
    enabled: true,
    provider: 'none',
    fallback: 'none',
    store: {
      ...(storePath ? { path: storePath } : {}),
      fts: { tokenizer: 'trigram' },
      vector: { enabled: false },
    },
  };
}

function successfulRunner(updatedIndexPaths: string[]): ReturnType<typeof vi.fn<MemoryIndexMigrationRunner>> {
  return vi.fn<MemoryIndexMigrationRunner>().mockImplementation(async () => {
    for (const indexPath of updatedIndexPaths) {
      writeIndexMetaAtPath(indexPath, currentIndexMeta());
    }
    return {
      code: 0,
      stdout: 'updated',
      stderr: '',
    };
  });
}

describe('openclawMemoryIndexMigration', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-openclaw-memory-migration-'));
    stateDir = path.join(tmpDir, 'openclaw', 'state');
    runtimeRoot = path.join(tmpDir, 'runtime');
    configPath = path.join(stateDir, 'openclaw.json');
    electronNodeRuntimePath = process.execPath;
    mkdirp(runtimeRoot);
    writeFile(path.join(runtimeRoot, 'openclaw.mjs'), 'console.log("openclaw");\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('skips when config still uses an embedding provider', async () => {
    writeConfig({
      enabled: true,
      provider: 'gemini',
      model: 'gemini-embedding-001',
      store: { fts: { tokenizer: 'trigram' } },
    });
    writeIndexMeta('main', oldIndexMeta());
    const runner = vi.fn<MemoryIndexMigrationRunner>();

    const result = await migrateAllFtsOnlyMemoryIndexes({
      stateDir,
      configPath,
      runtimeRoot,
      electronNodeRuntimePath,
      env: {},
      runner,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'not-fts-only-config' });
    expect(runner).not.toHaveBeenCalled();
  });

  test('skips all-agent reindex when an agent overrides defaults with an embedding provider', () => {
    writeConfig(ftsOnlyMemorySearch(), [
      { id: 'main', default: true },
      {
        id: 'custom-agent',
        memory: {
          search: {
            provider: 'gemini',
            model: 'gemini-embedding-001',
          },
        },
      },
    ]);
    writeIndexMeta('main', currentIndexMeta());
    writeIndexMeta('custom-agent', oldIndexMeta());

    expect(resolveFtsOnlyMemoryIndexMigrationNeed({ configPath, stateDir })).toEqual({
      shouldMigrate: false,
      reason: 'not-fts-only-config',
    });
  });

  test('skips when every configured index metadata is current', async () => {
    writeConfig(ftsOnlyMemorySearch(), [
      { id: 'main', default: true },
      { id: 'custom-agent' },
    ]);
    writeIndexMeta('main', currentIndexMeta());
    writeIndexMeta('custom-agent', currentIndexMeta());
    const runner = vi.fn<MemoryIndexMigrationRunner>();

    const result = await migrateAllFtsOnlyMemoryIndexes({
      stateDir,
      configPath,
      runtimeRoot,
      electronNodeRuntimePath,
      env: {},
      runner,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'index-meta-current' });
    expect(runner).not.toHaveBeenCalled();
  });

  test('runs one official all-agent reindex when only a custom agent has old metadata', async () => {
    writeConfig(ftsOnlyMemorySearch(), [
      { id: 'main', default: true },
      { id: 'custom-agent' },
    ]);
    writeIndexMeta('main', currentIndexMeta());
    writeIndexMeta('custom-agent', oldIndexMeta());
    const runner = successfulRunner([defaultIndexPath('custom-agent')]);

    const need = resolveFtsOnlyMemoryIndexMigrationNeed({ configPath, stateDir });
    expect(need).toMatchObject({
      shouldMigrate: true,
      targets: [{ agentId: 'custom-agent', dbPath: defaultIndexPath('custom-agent') }],
    });

    const result = await migrateAllFtsOnlyMemoryIndexes({
      stateDir,
      configPath,
      runtimeRoot,
      electronNodeRuntimePath,
      env: { EXISTING: '1' },
      runner,
    });

    expect(result.status).toBe('migrated');
    expect(runner).toHaveBeenCalledTimes(1);
    const [command, args, options] = runner.mock.calls[0];
    expect(command).toBe(electronNodeRuntimePath);
    expect(args).toEqual([
      path.join(runtimeRoot, 'openclaw.mjs'),
      'memory',
      'index',
      '--force',
    ]);
    expect(options.cwd).toBe(runtimeRoot);
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.env.EXISTING).toBe('1');
    expect(options.env.OPENCLAW_HOME).toBe(path.dirname(stateDir));
    expect(options.env.OPENCLAW_STATE_DIR).toBe(stateDir);
    expect(options.env.OPENCLAW_CONFIG_PATH).toBe(configPath);
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  test('collects every stale configured agent before running one reindex', async () => {
    writeConfig(ftsOnlyMemorySearch(), [
      { id: 'main', default: true },
      { id: 'custom-one' },
      { id: 'custom-two' },
    ]);
    writeIndexMeta('main', oldIndexMeta());
    writeIndexMeta('custom-one', oldIndexMeta());
    writeIndexMeta('custom-two', currentIndexMeta());
    const runner = successfulRunner([
      defaultIndexPath('main'),
      defaultIndexPath('custom-one'),
    ]);

    const need = resolveFtsOnlyMemoryIndexMigrationNeed({ configPath, stateDir });
    expect(need.shouldMigrate).toBe(true);
    if (need.shouldMigrate) {
      expect(need.targets.map((target) => target.agentId)).toEqual(['main', 'custom-one']);
    }

    const result = await migrateAllFtsOnlyMemoryIndexes({
      stateDir,
      configPath,
      runtimeRoot,
      electronNodeRuntimePath,
      env: {},
      runner,
    });

    expect(result.status).toBe('migrated');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  test('detects missing metadata and a missing sqlite meta table', () => {
    writeConfig(ftsOnlyMemorySearch(), [
      { id: 'main', default: true },
      { id: 'custom-agent' },
    ]);
    writeIndexMeta('main', null);
    writeEmptySqlite('custom-agent');

    const need = resolveFtsOnlyMemoryIndexMigrationNeed({ configPath, stateDir });
    expect(need.shouldMigrate).toBe(true);
    if (need.shouldMigrate) {
      expect(need.targets.map((target) => target.agentId)).toEqual(['main', 'custom-agent']);
      expect(need.targets.every((target) => target.reason === 'index metadata is missing')).toBe(true);
    }
  });

  test('ignores orphan indexes until the agent is configured again', async () => {
    writeConfig(ftsOnlyMemorySearch());
    writeIndexMeta('main', currentIndexMeta());
    writeIndexMeta('deleted-agent', oldIndexMeta());
    const runner = vi.fn<MemoryIndexMigrationRunner>();

    const result = await migrateAllFtsOnlyMemoryIndexes({
      stateDir,
      configPath,
      runtimeRoot,
      electronNodeRuntimePath,
      env: {},
      runner,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'index-meta-current' });
    expect(runner).not.toHaveBeenCalled();

    writeConfig(ftsOnlyMemorySearch(), [
      { id: 'main', default: true },
      { id: 'deleted-agent' },
    ]);
    const reenabledNeed = resolveFtsOnlyMemoryIndexMigrationNeed({ configPath, stateDir });
    expect(reenabledNeed).toMatchObject({
      shouldMigrate: true,
      targets: [{ agentId: 'deleted-agent', dbPath: defaultIndexPath('deleted-agent') }],
    });
  });

  test('skips when no configured agent has an index database', () => {
    writeConfig(ftsOnlyMemorySearch(), [
      { id: 'main', default: true },
      { id: 'custom-agent' },
    ]);

    expect(resolveFtsOnlyMemoryIndexMigrationNeed({ configPath, stateDir })).toEqual({
      shouldMigrate: false,
      reason: 'no-index-db',
    });
  });

  test('resolves the configured index path separately for each agent', () => {
    const storePath = path.join(stateDir, 'custom-memory', '{agentId}.sqlite');
    writeConfig(ftsOnlyMemorySearch(storePath), [
      { id: 'main', default: true },
      { id: 'custom-agent' },
    ]);
    const customIndexPath = path.join(stateDir, 'custom-memory', 'custom-agent.sqlite');
    writeIndexMetaAtPath(customIndexPath, oldIndexMeta());

    const need = resolveFtsOnlyMemoryIndexMigrationNeed({ configPath, stateDir });
    expect(need).toMatchObject({
      shouldMigrate: true,
      targets: [{ agentId: 'custom-agent', dbPath: customIndexPath }],
    });
  });

  test('skips when bundled OpenClaw CLI is missing', async () => {
    fs.rmSync(path.join(runtimeRoot, 'openclaw.mjs'), { force: true });
    writeConfig(ftsOnlyMemorySearch());
    writeIndexMeta('main', oldIndexMeta());
    const runner = vi.fn<MemoryIndexMigrationRunner>();

    const result = await migrateAllFtsOnlyMemoryIndexes({
      stateDir,
      configPath,
      runtimeRoot,
      electronNodeRuntimePath,
      env: {},
      runner,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'missing-openclaw-cli' });
    expect(runner).not.toHaveBeenCalled();
  });

  test('returns failed when all-agent reindex exits non-zero', async () => {
    writeConfig(ftsOnlyMemorySearch());
    writeIndexMeta('main', oldIndexMeta());
    const runner = vi.fn<MemoryIndexMigrationRunner>().mockResolvedValue({
      code: 2,
      stdout: '',
      stderr: 'failed',
    });

    const result = await migrateAllFtsOnlyMemoryIndexes({
      stateDir,
      configPath,
      runtimeRoot,
      electronNodeRuntimePath,
      env: {},
      runner,
    });

    expect(result).toEqual({ status: 'failed', code: 2 });
  });

  test('returns failed when successful CLI exit leaves a stale target index', async () => {
    writeConfig(ftsOnlyMemorySearch());
    writeIndexMeta('main', oldIndexMeta());
    const runner = vi.fn<MemoryIndexMigrationRunner>().mockResolvedValue({
      code: 0,
      stdout: 'updated',
      stderr: '',
    });

    const result = await migrateAllFtsOnlyMemoryIndexes({
      stateDir,
      configPath,
      runtimeRoot,
      electronNodeRuntimePath,
      env: {},
      runner,
    });

    expect(result).toEqual({
      status: 'failed',
      code: 0,
      error: 'post-reindex verification failed for agents ["main"]',
    });
  });
});
