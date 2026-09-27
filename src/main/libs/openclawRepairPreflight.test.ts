import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { OpenClawRepairPhase } from '../../shared/openclawEngine/repair';
import { repairOpenClawCompatibility } from './openclawCompatibilityRepairCore';
import { OPENCLAW_REPAIR_PREFLIGHT_REPORT, runOpenClawRepairPreflight } from './openclawRepairPreflight';
import type { StartupMigrationRunner } from './openclawStartupStateMigration';

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'lobster-repair-preflight-'));
  roots.push(root);
  const stateDir = path.join(root, 'state');
  const backupDir = path.join(root, 'backup');
  const runtimeRoot = path.join(root, 'runtime');
  for (const dir of [stateDir, backupDir, runtimeRoot]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(runtimeRoot, 'openclaw.mjs'), '');
  const configPath = path.join(stateDir, 'openclaw.json');
  fs.writeFileSync(configPath, '{}');
  const runner = vi.fn<StartupMigrationRunner>().mockResolvedValue({ code: 0, stdout: '{"valid":true}', stderr: '' });
  return { stateDir, configPath, runtimeRoot, backupDir, electronNodeRuntimePath: process.execPath, env: {}, runner };
}
async function snapshot(params: ReturnType<typeof fixture>) {
  const report = await repairOpenClawCompatibility({ ...params, phase: OpenClawRepairPhase.Snapshot }, {
    withLock: async run => run(), verifyDatabaseSchemas: vi.fn(), loadVectorExtension: vi.fn(),
    readInstallRecords: () => ({}), writeInstallRecords: vi.fn(), validatePlugin: vi.fn(), acceptBundledPlugin: vi.fn(),
  });
  expect(report, report.error).toMatchObject({ success: true });
}
function store(params: ReturnType<typeof fixture>, agent: string, content: string) {
  const filePath = path.join(params.stateDir, 'agents', agent, 'sessions', 'sessions.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  return filePath;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('a complete snapshot is mandatory before any validation or file mutation', async () => {
  const params = fixture();
  const broken = store(params, 'main', 'not json');
  await expect(runOpenClawRepairPreflight(params)).rejects.toThrow();
  expect(params.runner).not.toHaveBeenCalled();
  expect(fs.readFileSync(broken, 'utf8')).toBe('not json');
});

test('repairs BOM only, quarantines malformed indexes, and preserves exact originals and transcripts', async () => {
  const params = fixture();
  const valid = store(params, 'main', '{"agent:main:1":{"sessionId":"1"}}');
  const bom = store(params, 'bom', '\uFEFF{"agent:bom:1":{"sessionId":"2"}}');
  const truncated = store(params, 'worker', '\u0000{"agent:worker:1":');
  const array = store(params, 'array', '[]');
  const transcript = path.join(path.dirname(truncated), 'history.jsonl');
  fs.writeFileSync(transcript, '{"message":"keep this history"}\n');
  const originals = [valid, bom, truncated, array, transcript].map(file => [file, fs.readFileSync(file)] as const);
  await snapshot(params);

  const report = await runOpenClawRepairPreflight(params);

  expect(report.repairedSessionStores).toEqual([bom]);
  expect(report.quarantinedSessionStores.map(item => item.originalPath)).toEqual([array, truncated]);
  expect(fs.readFileSync(bom, 'utf8')).toBe('{"agent:bom:1":{"sessionId":"2"}}');
  if (process.platform !== 'win32') expect(fs.statSync(bom).mode & 0o777).toBe(0o600);
  for (const item of report.quarantinedSessionStores) {
    expect(fs.existsSync(item.originalPath)).toBe(false);
    expect(fs.readFileSync(item.quarantinePath)).toEqual(originals.find(([file]) => file === item.originalPath)![1]);
  }
  for (const [file, original] of originals) {
    expect(fs.readFileSync(path.join(params.backupDir, 'original', path.relative(params.stateDir, file)))).toEqual(original);
  }
  expect(fs.readFileSync(valid)).toEqual(originals[0][1]);
  expect(fs.readFileSync(transcript)).toEqual(originals[4][1]);
  expect(JSON.parse(fs.readFileSync(path.join(params.backupDir, OPENCLAW_REPAIR_PREFLIGHT_REPORT), 'utf8'))).toEqual(report);

  const next = { ...params, backupDir: path.join(path.dirname(params.stateDir), 'second-backup') };
  fs.mkdirSync(next.backupDir);
  await snapshot(next);
  expect(await runOpenClawRepairPreflight(next)).toMatchObject({ repairedSessionStores: [], quarantinedSessionStores: [] });
});

test.each(['config', 'session'])('refuses to modify %s data that changed after the backup', async kind => {
  const params = fixture();
  const broken = store(params, 'main', 'truncated');
  await snapshot(params);
  const changed = kind === 'config' ? params.configPath : broken;
  fs.writeFileSync(changed, 'new unbacked-up data');
  await expect(runOpenClawRepairPreflight(params)).rejects.toThrow('changed after the repair snapshot');
  expect(params.runner).not.toHaveBeenCalled();
  expect(fs.readFileSync(changed, 'utf8')).toBe('new unbacked-up data');
  expect(fs.existsSync(broken)).toBe(true);
});

test('rechecks sessions after asynchronous CLI validation and never quarantines permission failures', async () => {
  const params = fixture();
  const broken = store(params, 'main', 'truncated');
  await snapshot(params);
  params.runner.mockImplementation(async () => {
    fs.writeFileSync(broken, 'changed while validating');
    return { code: 0, stdout: '{"valid":true}', stderr: '' };
  });
  await expect(runOpenClawRepairPreflight(params)).rejects.toThrow('changed after the repair snapshot');
  expect(fs.readFileSync(broken, 'utf8')).toBe('changed while validating');

  const read = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
    if (file === broken) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
    return read(file, ...args);
  });
  await expect(runOpenClawRepairPreflight(params)).rejects.toThrow('access denied');
  expect(fs.readdirSync(path.dirname(broken))).toEqual(['sessions.json']);
});

test('refuses a symlink swapped into a snapshotted config', async () => {
  const params = fixture();
  await snapshot(params);
  const external = path.join(path.dirname(params.stateDir), 'external.json');
  fs.writeFileSync(external, '{}');
  fs.unlinkSync(params.configPath);
  fs.symlinkSync(external, params.configPath);
  await expect(runOpenClawRepairPreflight(params)).rejects.toThrow('aliased path');
  expect(fs.readFileSync(external, 'utf8')).toBe('{}');
});

test('replaces a missing packaged plugin directory with the current one and preserves custom paths', async () => {
  const params = fixture();
  const old = path.join(path.dirname(params.stateDir), 'old', 'resources', 'cfmind', 'third-party-extensions');
  const custom = path.join(path.dirname(params.stateDir), 'custom', 'third-party-extensions');
  const current = path.join(params.runtimeRoot, 'third-party-extensions');
  fs.mkdirSync(current);
  const original = { plugins: { load: { paths: [old, custom, current] }, entries: { 'openclaw-qqbot': { enabled: true } } } };
  fs.writeFileSync(params.configPath, JSON.stringify(original));
  await snapshot(params);
  const report = await runOpenClawRepairPreflight(params);
  expect(report.replacedPluginLoadPaths).toEqual([old]);
  expect(JSON.parse(fs.readFileSync(params.configPath, 'utf8'))).toEqual({
    plugins: { ...original.plugins, load: { paths: [custom, current] } },
  });
  expect(JSON.parse(fs.readFileSync(path.join(params.backupDir, 'original', 'openclaw.json'), 'utf8'))).toEqual(original);
});
