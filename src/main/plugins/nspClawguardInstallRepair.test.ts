import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, test, vi } from 'vitest';

import { OpenClawRepairPluginSource } from '../../shared/openclawEngine/repair';
import type { RepairInstallRecord } from '../libs/openclawCompatibilityRepairCore';
import { NSP_CLAWGUARD } from './nspClawguardCompatibility';
import { repairNspClawguardInstall } from './nspClawguardInstallRepair';

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const id = NSP_CLAWGUARD.Id;

function fixture(release: typeof NSP_CLAWGUARD.Releases[number] = NSP_CLAWGUARD.Releases[0]) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nsp-install-repair-'));
  roots.push(userData);
  const stateDir = path.join(userData, 'openclaw', 'state');
  const configPath = path.join(stateDir, 'openclaw.json');
  const pluginDir = path.join(userData, 'third-party-extensions', id);
  const oldPath = path.join(stateDir, 'extensions', id);
  const databasePath = path.join(stateDir, 'state', 'openclaw.sqlite');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
    name: id, version: release.version, main: NSP_CLAWGUARD.Entry,
    openclaw: { extensions: [NSP_CLAWGUARD.Entry] },
  }));
  fs.writeFileSync(path.join(pluginDir, 'openclaw.plugin.json'), JSON.stringify({ id, version: release.manifestVersion }));
  fs.writeFileSync(path.join(pluginDir, NSP_CLAWGUARD.Entry), 'export default () => {};');
  const config = { plugins: { enabled: true, allow: [id], deny: [] as string[],
    load: { paths: [path.dirname(pluginDir)] }, entries: { [id]: { enabled: true } } } };
  fs.writeFileSync(configPath, JSON.stringify(config));
  let records: Record<string, RepairInstallRecord> = {
    [id]: { source: OpenClawRepairPluginSource.Npm, spec: `${id}@2.4.13`,
      version: '2.4.13', installPath: oldPath, resolvedName: id, integrity: 'old-npm-hash',
      acceptedSurface: { tools: ['existing-tool'] }, acceptedSurfaceHash: 'existing-consent',
      acceptedSurfaceIntegrity: 'old-npm-hash', acceptedSurfaceAt: '2026-09-20T00:00:00Z' },
    other: { source: OpenClawRepairPluginSource.Npm, installPath: '/another/plugin', spec: 'another@1.0.0' },
  };
  const db = new DatabaseSync(databasePath);
  databases.push(db);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE fixture_records (json TEXT)');
  db.prepare('INSERT INTO fixture_records VALUES (?)').run(JSON.stringify(records));
  const owners = {
    read: vi.fn((): Record<string, RepairInstallRecord> => Object.assign(Object.create(null), structuredClone(records))),
    write: vi.fn((next: Record<string, RepairInstallRecord>) => {
      db.prepare('UPDATE fixture_records SET json = ?').run(JSON.stringify(next));
      records = structuredClone(next);
    }),
    validate: vi.fn(async () => {}),
  };
  const options = { stateDir, configPath, backups: [] as string[] };
  const withOwners = vi.fn<Parameters<typeof repairNspClawguardInstall>[1]>(run => run(owners));
  return { options, owners, withOwners, config, pluginDir, oldPath, db,
    saveConfig: () => fs.writeFileSync(configPath, JSON.stringify(config)),
    setRecord: (patch: Partial<RepairInstallRecord>) => { Object.assign(records[id], patch); },
    run: () => repairNspClawguardInstall(options, withOwners) };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test.each(NSP_CLAWGUARD.Releases)('reconciles old 2.4.13 receipt to existing $version, preserving consent, config and other plugins', async release => {
  const f = fixture(release);
  const before = f.owners.read();
  const originalConfig = fs.readFileSync(f.options.configPath);
  expect(await f.run()).toHaveLength(1);
  expect(f.owners.read()[id]).toEqual({
    source: OpenClawRepairPluginSource.Path, sourcePath: f.pluginDir, installPath: f.pluginDir,
    version: release.version, acceptedSurface: before[id].acceptedSurface,
    acceptedSurfaceHash: before[id].acceptedSurfaceHash, acceptedSurfaceAt: before[id].acceptedSurfaceAt,
    acceptedSurfaceIntegrity: before[id].acceptedSurfaceIntegrity,
  });
  expect(f.owners.read().other).toEqual(before.other);
  expect(fs.readFileSync(f.options.configPath)).toEqual(originalConfig);
  expect(fs.existsSync(f.oldPath)).toBe(false);
  expect(f.options.backups).toHaveLength(1);
  const saved = new DatabaseSync(f.options.backups[0], { readOnly: true });
  try { expect(JSON.parse(String(saved.prepare('SELECT json FROM fixture_records').get()!.json))).toEqual(before); }
  finally { saved.close(); }
  expect(await f.run()).toEqual([]);
  expect(f.owners.write).toHaveBeenCalledTimes(1);
  expect(f.options.backups).toHaveLength(1);
});

test.each(['disabled', 'all-disabled', 'not-allowed', 'denied', 'external-load'])('skips %s before reading installation records', async state => {
  const f = fixture();
  if (state === 'disabled') f.config.plugins.entries[id].enabled = false;
  if (state === 'all-disabled') f.config.plugins.enabled = false;
  if (state === 'not-allowed') f.config.plugins.allow = [];
  if (state === 'denied') f.config.plugins.deny = [id];
  if (state === 'external-load') f.config.plugins.load.paths = ['/custom/plugins'];
  f.saveConfig();
  expect(await f.run()).toEqual([]);
  expect(f.owners.read).not.toHaveBeenCalled();
  expect(f.options.backups).toEqual([]);
});

test.each(['custom-path', 'other-source', 'other-package', 'unknown-version', 'live-old-path', 'missing-payload', 'unsupported-payload'])('leaves %s unchanged', async state => {
  const f = fixture();
  if (state === 'custom-path') f.setRecord({ installPath: path.join(f.options.stateDir, 'custom', id) });
  if (state === 'other-source') f.setRecord({ source: OpenClawRepairPluginSource.Path });
  if (state === 'other-package') f.setRecord({ resolvedName: 'unrelated' });
  if (state === 'unknown-version') f.setRecord({ spec: `${id}@2.6.0` });
  if (state === 'live-old-path') fs.mkdirSync(f.oldPath, { recursive: true });
  if (state === 'missing-payload') fs.unlinkSync(path.join(f.pluginDir, 'package.json'));
  if (state === 'unsupported-payload') fs.writeFileSync(path.join(f.pluginDir, 'openclaw.plugin.json'), JSON.stringify({ id, version: '2.4.13' }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await f.run()).toEqual([]);
  expect(f.owners.write).not.toHaveBeenCalled();
  expect(f.options.backups).toEqual([]);
});

test.each(['live-old-path', 'missing-payload', 'malformed-payload', 'unsupported-2.5.3'])('skips %s even when the plugin lease is unavailable', async state => {
  const f = fixture();
  if (state === 'live-old-path') fs.mkdirSync(f.oldPath, { recursive: true });
  if (state === 'missing-payload') fs.unlinkSync(path.join(f.pluginDir, 'package.json'));
  if (state === 'malformed-payload') fs.writeFileSync(path.join(f.pluginDir, 'package.json'), '{');
  if (state === 'unsupported-2.5.3') {
    const packagePath = path.join(f.pluginDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    fs.writeFileSync(packagePath, JSON.stringify({ ...pkg, version: '2.5.3' }));
    fs.writeFileSync(path.join(f.pluginDir, 'openclaw.plugin.json'), JSON.stringify({ id, version: '2.5.3' }));
  }
  f.withOwners.mockRejectedValue(new Error('Plugin lifecycle lease unavailable'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await f.run()).toEqual([]);
  expect(f.withOwners).not.toHaveBeenCalled();
  expect(f.owners.read).not.toHaveBeenCalled();
  expect(f.owners.write).not.toHaveBeenCalled();
  expect(f.options.backups).toEqual([]);
});

test.each(['old-install', 'payload'])('rechecks %s after waiting for the plugin lease', async changed => {
  const f = fixture();
  f.withOwners.mockImplementation(async run => {
    if (changed === 'old-install') fs.mkdirSync(f.oldPath, { recursive: true });
    if (changed === 'payload') fs.unlinkSync(path.join(f.pluginDir, 'package.json'));
    return run(f.owners);
  });
  expect(await f.run()).toEqual([]);
  expect(f.withOwners).toHaveBeenCalledOnce();
  expect(f.owners.validate).not.toHaveBeenCalled();
  expect(f.owners.write).not.toHaveBeenCalled();
  expect(f.options.backups).toEqual([]);
});

test('does not continue an applicable repair without the plugin lease', async () => {
  const f = fixture();
  f.withOwners.mockRejectedValue(new Error('Plugin lifecycle lease unavailable'));
  await expect(f.run()).rejects.toThrow('Plugin lifecycle lease unavailable');
  expect(f.owners.read).not.toHaveBeenCalled();
  expect(f.owners.write).not.toHaveBeenCalled();
  expect(f.options.backups).toEqual([]);
});

test('does not follow a linked payload into an external directory', async () => {
  const f = fixture();
  const target = fixture();
  fs.renameSync(f.pluginDir, f.pluginDir + '-original');
  fs.symlinkSync(target.pluginDir, f.pluginDir, 'junction');
  await expect(f.run()).rejects.toThrow('aliased path');
  expect(f.owners.write).not.toHaveBeenCalled();
});

test('validation or backup failure prevents an install record write', async () => {
  const f = fixture();
  f.owners.validate.mockRejectedValueOnce(new Error('payload invalid'));
  await expect(f.run()).rejects.toThrow('payload invalid');
  expect(f.owners.write).not.toHaveBeenCalled();
  vi.spyOn(fs, 'mkdtempSync').mockImplementation(() => { throw new Error('backup failed'); });
  await expect(f.run()).rejects.toThrow('backup failed');
  expect(f.owners.write).not.toHaveBeenCalled();
});

test.each(['config', 'records', 'payload', 'old-install'])('does not overwrite a concurrent %s change', async changed => {
  const f = fixture();
  f.owners.validate.mockImplementationOnce(async () => {
    if (changed === 'config') fs.appendFileSync(f.options.configPath, '\n');
    if (changed === 'records') f.setRecord({ spec: `${id}@2.5.0` });
    if (changed === 'payload') fs.appendFileSync(path.join(f.pluginDir, NSP_CLAWGUARD.Entry), '\n');
    if (changed === 'old-install') fs.mkdirSync(f.oldPath, { recursive: true });
  });
  await expect(f.run()).rejects.toThrow('changed during startup repair');
  expect(f.owners.write).not.toHaveBeenCalled();
});
