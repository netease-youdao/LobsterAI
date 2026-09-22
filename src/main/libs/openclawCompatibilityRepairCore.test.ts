import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  OPENCLAW_PLUGIN_SKILLS_DIRECTORY, OPENCLAW_REPAIR_SNAPSHOT_MANIFEST,
  OpenClawRepairPhase, OpenClawRepairPluginSource,
} from '../../shared/openclawEngine/repair';
import {
  assertOwnedRepairPath, type CompatibilityRepairOptions, type CompatibilityRepairOwners,
  type RepairInstallRecord, repairOpenClawCompatibility,
} from './openclawCompatibilityRepairCore';

const directories: string[] = [];
function fixture(phase: OpenClawRepairPhase = OpenClawRepairPhase.Snapshot): CompatibilityRepairOptions {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-repair-'));
  directories.push(root);
  const stateDir = path.join(root, 'state');
  const backupDir = path.join(root, 'backup');
  fs.mkdirSync(stateDir);
  fs.mkdirSync(backupDir);
  const configPath = path.join(stateDir, 'openclaw.json');
  fs.writeFileSync(configPath, '{}');
  return { stateDir, configPath, backupDir, phase };
}
function owners(): CompatibilityRepairOwners {
  return {
    withLock: async run => run(), verifyDatabaseSchemas: vi.fn(), loadVectorExtension: vi.fn(),
    readInstallRecords: vi.fn(() => ({})), writeInstallRecords: vi.fn(),
    validatePlugin: vi.fn(async () => {}), acceptBundledPlugin: vi.fn(async () => {}),
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test.each([false, true])('snapshots a generated skill link without creating or following it, dangling=%s', async dangling => {
  const options = fixture();
  const skills = path.join(options.stateDir, OPENCLAW_PLUGIN_SKILLS_DIRECTORY);
  const external = path.join(path.dirname(options.stateDir), 'old-installation');
  const link = path.join(skills, 'browser-automation');
  fs.mkdirSync(skills);
  if (!dangling) {
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, 'SKILL.md'), 'external source must remain unchanged');
  }
  fs.symlinkSync(external, link, 'junction');
  const linkTarget = fs.readlinkSync(link);
  fs.writeFileSync(path.join(skills, 'user-note.md'), 'keep real files');
  fs.mkdirSync(path.join(skills, 'user-directory'));
  fs.writeFileSync(path.join(skills, 'user-directory', 'SKILL.md'), 'keep real directories');
  const symlink = vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
    throw Object.assign(new Error('EPERM: cannot create symbolic links'), { code: 'EPERM' });
  });

  const report = await repairOpenClawCompatibility(options, owners());
  expect(report, report.error).toMatchObject({ success: true });
  expect(symlink).not.toHaveBeenCalled();
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(link)).toBe(linkTarget);
  const savedSkills = path.join(options.backupDir, 'original', OPENCLAW_PLUGIN_SKILLS_DIRECTORY);
  expect(fs.lstatSync(path.join(savedSkills, 'browser-automation'), { throwIfNoEntry: false })).toBeUndefined();
  expect(fs.readFileSync(path.join(savedSkills, 'user-note.md'), 'utf8')).toBe('keep real files');
  expect(fs.readFileSync(path.join(savedSkills, 'user-directory', 'SKILL.md'), 'utf8')).toBe('keep real directories');
  const manifest = JSON.parse(fs.readFileSync(path.join(options.backupDir, OPENCLAW_REPAIR_SNAPSHOT_MANIFEST), 'utf8'));
  expect(manifest.generatedPluginSkillLinks).toEqual([{ path: path.relative(options.stateDir, link), target: linkTarget }]);
  expect(manifest.restoreInstructions).toContain('openclaw skills list');
  if (!dangling) expect(fs.readFileSync(path.join(external, 'SKILL.md'), 'utf8')).toBe('external source must remain unchanged');
});

test.each(['outside-index', 'nested', 'database'])('does not suppress backup failure for a %s link', async kind => {
  const options = fixture();
  const skills = path.join(options.stateDir, OPENCLAW_PLUGIN_SKILLS_DIRECTORY);
  const link = kind === 'outside-index' ? path.join(options.stateDir, 'user-link')
    : path.join(skills, kind === 'nested' ? 'user-directory/link' : 'user.sqlite');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join(path.dirname(options.stateDir), 'absent'), link, 'junction');
  vi.spyOn(fs, 'symlinkSync').mockImplementation(() => { throw new Error('EPERM: symbolic link denied'); });
  const report = await repairOpenClawCompatibility(options, owners());
  expect(report).toMatchObject({ success: false, failurePath: link });
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.existsSync(path.join(options.backupDir, OPENCLAW_REPAIR_SNAPSHOT_MANIFEST))).toBe(false);
});

test('snapshot includes committed WAL data, config, and legacy transcripts without changing sources', async () => {
  const options = fixture();
  fs.writeFileSync(options.configPath, '{"token":"preserved"}');
  fs.writeFileSync(path.join(options.stateDir, 'session.jsonl'), '{"message":"keep"}\n');
  fs.writeFileSync(path.join(options.stateDir, 'tool.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const dbPath = path.join(options.stateDir, 'test.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE messages (text TEXT); INSERT INTO messages VALUES (\'committed WAL row\')');
    expect(fs.statSync(dbPath + '-wal').size).toBeGreaterThan(0);
    const report = await repairOpenClawCompatibility(options, owners());
    expect(report.success).toBe(true);
    expect(fs.existsSync(path.join(options.backupDir, 'original', 'test.sqlite-wal'))).toBe(false);
    const saved = new DatabaseSync(path.join(options.backupDir, 'original', 'test.sqlite'), { readOnly: true });
    try { expect(saved.prepare('SELECT text FROM messages').get()?.text).toBe('committed WAL row'); } finally { saved.close(); }
    expect(fs.readFileSync(path.join(options.backupDir, 'original', 'openclaw.json'), 'utf8')).toBe('{"token":"preserved"}');
    expect(fs.readFileSync(path.join(options.backupDir, 'original', 'session.jsonl'), 'utf8')).toContain('keep');
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(options.backupDir, 'original', 'tool.sh')).mode & 0o100).toBe(0o100);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n).toBe(1);
  } finally { db.close(); }
});

test('failed ownership or backup cannot run later repairs and remains diagnosable', async () => {
  const options = fixture();
  fs.writeFileSync(path.join(options.stateDir, 'broken.sqlite'), 'corrupt');
  const deps = owners();
  const result = await repairOpenClawCompatibility(options, deps);
  expect(result.success).toBe(false);
  expect(deps.verifyDatabaseSchemas).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(options.stateDir, 'broken.sqlite'), 'utf8')).toBe('corrupt');
  expect(JSON.parse(fs.readFileSync(path.join(options.backupDir, 'snapshot-report.json'), 'utf8')).success).toBe(false);
});

test('maintenance lock refusal never opens a database or changes plugins', async () => {
  const options = fixture();
  const deps = owners();
  deps.withLock = async () => { throw new Error('another gateway owns this state'); };
  expect((await repairOpenClawCompatibility(options, deps)).success).toBe(false);
  expect(fs.existsSync(path.join(options.backupDir, 'original'))).toBe(false);
  expect(deps.writeInstallRecords).not.toHaveBeenCalled();
});

test('unsafe aliases and outside paths are refused', () => {
  const options = fixture();
  const source = path.join(options.stateDir, 'db.sqlite');
  fs.writeFileSync(source, 'data');
  fs.linkSync(source, path.join(options.stateDir, 'hard.sqlite'));
  expect(() => assertOwnedRepairPath(options.stateDir, source)).toThrow('aliased');
  fs.symlinkSync(options.backupDir, path.join(options.stateDir, 'alias'));
  expect(() => assertOwnedRepairPath(options.stateDir, path.join(options.stateDir, 'alias', 'db.sqlite'))).toThrow('aliased');
  expect(() => assertOwnedRepairPath(options.stateDir, path.join(options.backupDir, 'db.sqlite'))).toThrow('outside');
});

test('a schema Doctor did not repair blocks memory and plugin writes', async () => {
  const options = fixture(OpenClawRepairPhase.Recovery);
  const deps = owners();
  deps.verifyDatabaseSchemas = () => { throw new Error('newer schema'); };
  const report = await repairOpenClawCompatibility(options, deps);
  expect(report).toMatchObject({ success: false, error: 'newer schema' });
  expect(deps.loadVectorExtension).not.toHaveBeenCalled();
});

function pluginFixture() {
  const options = fixture(OpenClawRepairPhase.Plugins);
  const root = path.join(path.dirname(options.stateDir), 'shipped-deepseek');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@openclaw/deepseek-provider', version: '2026.8.1' }));
  fs.writeFileSync(path.join(root, 'openclaw.plugin.json'), JSON.stringify({ id: 'deepseek' }));
  options.plugins = [{ id: 'deepseek', packageName: '@openclaw/deepseek-provider', version: '2026.8.1', root }];
  const stale: RepairInstallRecord = { source: OpenClawRepairPluginSource.Npm, spec: '@openclaw/deepseek-provider@2026.6.1', installPath: path.join(options.stateDir, 'npm', 'missing') };
  const user: RepairInstallRecord = { source: OpenClawRepairPluginSource.Npm, spec: 'user-plugin', installPath: '/user-plugin' };
  const records = { deepseek: stale, user };
  const deps = owners();
  deps.readInstallRecords = () => records;
  deps.validatePlugin = vi.fn(async (_id, filePath) => { if (filePath !== root) throw new Error('payload missing'); });
  return { options, deps, records, root, user };
}

test('repairs a missing pinned plugin with a truthful local record and scoped consent', async () => {
  const { options, deps, root, user } = pluginFixture();
  expect((await repairOpenClawCompatibility(options, deps)).success).toBe(true);
  expect(deps.writeInstallRecords).toHaveBeenCalledWith({
    user, deepseek: expect.objectContaining({ source: OpenClawRepairPluginSource.Path, installPath: root, version: '2026.8.1' }),
  }, {});
  expect(deps.acceptBundledPlugin).toHaveBeenCalledExactlyOnceWith('deepseek', {});
});

test('healthy installations and same-ID third-party packages are retained', async () => {
  const { options, deps, records } = pluginFixture();
  deps.validatePlugin = vi.fn(async () => {});
  await repairOpenClawCompatibility(options, deps);
  expect(deps.writeInstallRecords).not.toHaveBeenCalled();
  records.deepseek.spec = '@someone/deepseek';
  deps.validatePlugin = vi.fn(async () => { throw new Error('missing'); });
  await repairOpenClawCompatibility(options, deps);
  expect(deps.writeInstallRecords).not.toHaveBeenCalled();
  expect(deps.acceptBundledPlugin).not.toHaveBeenCalled();
});

function migratedPluginFixture() {
  const context = pluginFixture();
  const base = path.dirname(context.options.stateDir);
  context.options.stateDir = path.join(base, 'admin', 'LobsterAI', 'openclaw', 'state');
  fs.mkdirSync(context.options.stateDir, { recursive: true });
  context.options.configPath = path.join(context.options.stateDir, 'openclaw.json');
  fs.writeFileSync(context.options.configPath, '{}');
  context.records.deepseek.installPath = path.join(base, 'old-user', 'LobsterAI', 'openclaw', 'state',
    'npm', 'projects', 'openclaw-deepseek-123', 'node_modules', '@openclaw', 'deepseek-provider');
  return context;
}

test('reconciles a missing previous-profile install and backs up its SQLite ledger including WAL', async () => {
  const { options, deps, records, root, user } = migratedPluginFixture();
  const dbPath = path.join(options.stateDir, 'state', 'openclaw.sqlite');
  fs.mkdirSync(path.dirname(dbPath));
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE ledger (value TEXT)');
    db.prepare('INSERT INTO ledger VALUES (?)').run(JSON.stringify(records));
    const result = await repairOpenClawCompatibility(options, deps);
    expect(result, result.error).toMatchObject({ success: true });
    expect(deps.writeInstallRecords).toHaveBeenCalledWith({
      user, deepseek: expect.objectContaining({ source: OpenClawRepairPluginSource.Path, installPath: root }),
    }, {});
    expect(deps.validatePlugin).toHaveBeenCalledExactlyOnceWith('deepseek', root);
    expect(deps.acceptBundledPlugin).toHaveBeenCalledExactlyOnceWith('deepseek', {});
    const saved = new DatabaseSync(path.join(options.backupDir, 'original', 'state', 'openclaw.sqlite'), { readOnly: true });
    try { expect(saved.prepare('SELECT value FROM ledger').get()?.value).toBe(JSON.stringify(records)); } finally { saved.close(); }
    expect(fs.existsSync(records.deepseek.installPath!)).toBe(false);
  } finally { db.close(); }
});

test.each(['existing', 'custom-path', 'conflicting-package', 'linked-parent', 'permission-denied'])(
  'preserves an ambiguous previous-profile installation: %s', async scenario => {
    const { options, deps, records } = migratedPluginFixture();
    const installPath = records.deepseek.installPath!;
    if (scenario === 'existing') fs.mkdirSync(installPath, { recursive: true });
    if (scenario === 'custom-path') records.deepseek.installPath = path.join(path.dirname(options.backupDir), 'custom-plugin');
    if (scenario === 'conflicting-package') records.deepseek.resolvedName = '@someone/deepseek-provider';
    if (scenario === 'linked-parent') {
      fs.mkdirSync(path.dirname(installPath), { recursive: true });
      fs.symlinkSync(path.join(path.dirname(options.backupDir), 'absent-target'), installPath, 'junction');
    }
    if (scenario === 'permission-denied') {
      const lstat = fs.lstatSync;
      vi.spyOn(fs, 'lstatSync').mockImplementation(((filePath: fs.PathLike, ...args: []) => {
        if (String(filePath).includes('old-user')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        return lstat(filePath, ...args);
      }) as typeof fs.lstatSync);
    }
    const result = await repairOpenClawCompatibility(options, deps);
    expect(result.success).toBe(scenario !== 'permission-denied');
    expect(deps.writeInstallRecords).not.toHaveBeenCalled();
    expect(deps.acceptBundledPlugin).not.toHaveBeenCalled();
  },
);

test('bundled version mismatch stops before writing install records or consent', async () => {
  const { options, deps, root } = pluginFixture();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@openclaw/deepseek-provider', version: '9999.1.1' }));
  expect((await repairOpenClawCompatibility(options, deps)).success).toBe(false);
  expect(deps.writeInstallRecords).not.toHaveBeenCalled();
  expect(deps.acceptBundledPlugin).not.toHaveBeenCalled();
});

test('retry finishes consent if the preceding repair stopped after replacing a record', async () => {
  const { options, deps, records, root } = pluginFixture();
  records.deepseek = { source: OpenClawRepairPluginSource.Path, sourcePath: root, installPath: root, version: '2026.8.1' };
  expect((await repairOpenClawCompatibility(options, deps)).success).toBe(true);
  expect(deps.acceptBundledPlugin).toHaveBeenCalledExactlyOnceWith('deepseek', {});
});

// Real vec0 integration when the platform runtime has been built. The remaining
// tests run on clean CI checkouts without requiring a native runtime download.
let loadVec: ((db: DatabaseSync) => void) | undefined;
try {
  loadVec = createRequire(path.resolve('vendor/openclaw-runtime/current/package.json'))('sqlite-vec').load;
} catch { /* runtime optional in generic CI */ }
describe.skipIf(!loadVec)('bundled sqlite-vec integration', () => {
  test('removes only orphan IDs and preserves valid embeddings, chunks, files, and the original snapshot', async () => {
    const options = fixture(OpenClawRepairPhase.Recovery);
    const memoryRoot = path.join(options.stateDir, 'memory');
    fs.mkdirSync(memoryRoot);
    const memoryPath = path.join(memoryRoot, 'main.sqlite');
    const db = new DatabaseSync(memoryPath, { allowExtension: true });
    loadVec!(db);
    db.exec("CREATE TABLE chunks (id TEXT PRIMARY KEY, text TEXT); INSERT INTO chunks VALUES ('keep', 'memory text'); CREATE TABLE files (path TEXT); INSERT INTO files VALUES ('MEMORY.md'); CREATE VIRTUAL TABLE chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3]);");
    const insert = db.prepare('INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)');
    insert.run('keep', '[1,0,0]');
    insert.run('orphan', '[0,1,0]');
    db.close();
    const deps = owners();
    deps.loadVectorExtension = async database => { loadVec!(database); };
    const result = await repairOpenClawCompatibility(options, deps);
    expect(result.success, result.error).toBe(true);
    const repaired = new DatabaseSync(memoryPath, { allowExtension: true });
    const saved = new DatabaseSync(path.join(options.backupDir, 'original', 'memory', 'main.sqlite'), { allowExtension: true });
    try {
      loadVec!(repaired); loadVec!(saved);
      expect(repaired.prepare('SELECT id FROM chunks_vec').all()).toEqual([{ id: 'keep' }]);
      expect(repaired.prepare('SELECT embedding FROM chunks_vec WHERE id = ?').get('keep')).toEqual(saved.prepare('SELECT embedding FROM chunks_vec WHERE id = ?').get('keep'));
      expect(repaired.prepare('SELECT * FROM chunks').all()).toEqual(saved.prepare('SELECT * FROM chunks').all());
      expect(repaired.prepare('SELECT * FROM files').all()).toEqual(saved.prepare('SELECT * FROM files').all());
      expect(saved.prepare('SELECT COUNT(*) AS n FROM chunks_vec').get()?.n).toBe(2);
    } finally { repaired.close(); saved.close(); }
    expect((await repairOpenClawCompatibility(options, deps)).changes).toEqual([]);
  });
});
