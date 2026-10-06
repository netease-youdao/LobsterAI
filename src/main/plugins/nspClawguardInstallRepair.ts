import fs from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import { OpenClawRepairPluginSource } from '../../shared/openclawEngine/repair';
import type { RepairInstallRecord } from '../libs/openclawCompatibilityRepairCore';
import { isMissingUnaliasedPluginPath } from '../libs/openclawPluginRepairPaths';
import { assertOwnedRepairPath } from '../libs/openclawRepairPaths';
import { NSP_CLAWGUARD, readSupportedNspClawguardPackage } from './nspClawguardCompatibility';

interface RepairConfig {
  plugins?: {
    enabled?: boolean;
    allow?: string[];
    deny?: string[];
    entries?: Record<string, { enabled?: boolean }>;
    load?: { paths?: string[] };
  };
}

interface InstallRecordOwners {
  read: () => Record<string, RepairInstallRecord>;
  write: (records: Record<string, RepairInstallRecord>, config: RepairConfig) => Promise<unknown> | void;
  validate: (pluginDir: string) => Promise<void>;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === 'win32'
    ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

/**
 * Called only under the startup helper's stopped-gateway maintenance lock.
 * LobsterAI moved user installs out of state/extensions, but a stale npm receipt
 * can make OpenClaw try downloading an old private-registry package at startup.
 * Reconcile only this known missing install with an enabled, existing payload.
 */
export async function repairNspClawguardInstall(
  options: { stateDir: string; configPath: string; backups: string[] },
  withOwners: (run: (owners: InstallRecordOwners) => Promise<string[]>) => Promise<string[]>,
): Promise<string[]> {
  const { stateDir, configPath, backups } = options;
  if (path.basename(stateDir) !== 'state' || path.basename(path.dirname(stateDir)) !== 'openclaw') return [];
  if (!fs.existsSync(configPath)) return [];
  const configRaw = fs.readFileSync(configPath);
  let config: RepairConfig;
  try { config = JSON.parse(configRaw.toString('utf8')); } catch { return []; }
  const plugins = config?.plugins;
  const id = NSP_CLAWGUARD.Id;
  if (!plugins || plugins.enabled === false || plugins.entries?.[id]?.enabled !== true
    || !plugins.allow?.includes(id) || plugins.deny?.includes(id)) return [];

  const userDataDir = path.dirname(path.dirname(stateDir));
  const pluginDir = path.join(userDataDir, 'third-party-extensions', id);
  if (!plugins.load?.paths?.some(value => typeof value === 'string' && path.isAbsolute(value)
    && (samePath(value, pluginDir) || samePath(value, path.dirname(pluginDir))))) return [];

  const oldPath = path.join(stateDir, 'extensions', id);
  if (!isMissingUnaliasedPluginPath(oldPath)) return [];
  const payloadPaths = ['package.json', 'openclaw.plugin.json', NSP_CLAWGUARD.Entry]
    .map(file => path.join(pluginDir, file));
  const readRepairPackage = () => {
    for (const file of payloadPaths) assertOwnedRepairPath(userDataDir, file);
    try { return readSupportedNspClawguardPackage(pluginDir); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
      throw error;
    }
  };
  // Skip unrelated or missing payloads before waiting on a shared SQLite lease.
  // These are only preliminary checks; repeat them after acquiring ownership.
  if (!readRepairPackage()) return [];

  // Acquire the pinned plugin lifecycle lease before taking the record snapshot.
  // It excludes plugin CLI updates as well as the outer lock excluding gateways.
  return withOwners(async owners => {
    const records = owners.read();
    const record = records[id];
    if (record?.source !== OpenClawRepairPluginSource.Npm
      || !NSP_CLAWGUARD.Releases.some(release => record.spec === `${id}@${release.version}`)
      || (record.resolvedName !== undefined && record.resolvedName !== id)
      || typeof record.installPath !== 'string' || !path.isAbsolute(record.installPath)
      || !samePath(record.installPath, oldPath) || !isMissingUnaliasedPluginPath(oldPath)) return [];

    const pkg = readRepairPackage();
    if (!pkg) return [];
    const payload = payloadPaths.map(file => fs.readFileSync(file));
    // Use the pinned static payload validator, without executing plugin code.
    await owners.validate(pluginDir);

    const databasePath = path.join(stateDir, 'state', 'openclaw.sqlite');
    const backupRoot = path.join(stateDir, 'startup-recovery-backups');
    for (const file of [databasePath, databasePath + '-wal', databasePath + '-shm', configPath, backupRoot]) {
      assertOwnedRepairPath(stateDir, file);
    }
    const source = new DatabaseSync(databasePath, { readOnly: true });
    try {
      fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
      const directory = fs.mkdtempSync(path.join(backupRoot, 'nsp-clawguard-'));
      const backupPath = path.join(directory, 'openclaw.sqlite');
      // Include committed WAL pages, not just the main database file.
      await backup(source, backupPath);
      fs.chmodSync(backupPath, 0o600);
      backups.push(backupPath);
    } finally { source.close(); }

    if (!fs.readFileSync(configPath).equals(configRaw)
      || !isDeepStrictEqual(owners.read(), records)
      || !isMissingUnaliasedPluginPath(oldPath)
      || payloadPaths.some((file, index) => !fs.readFileSync(file).equals(payload[index]))) {
      throw new Error('Clawguard installation changed during startup repair; retry with the latest state.');
    }
    const next: RepairInstallRecord = {
      source: OpenClawRepairPluginSource.Path,
      sourcePath: pluginDir,
      installPath: pluginDir,
      version: pkg.version,
      ...(record.installedAt ? { installedAt: record.installedAt } : {}),
    };
    // Retain prior consent exactly; never accept a new capability surface here.
    // Old npm hashes/specs describe the missing artifact, not this local payload.
    for (const key of ['acceptedSurface', 'acceptedSurfaceHash', 'acceptedSurfaceAt', 'acceptedSurfaceIntegrity'] as const) {
      if (record[key] !== undefined) next[key] = record[key];
    }
    const repaired = { ...records, [id]: next };
    await owners.write(repaired, config);
    // The upstream reader intentionally returns a null-prototype record map.
    if (!isDeepStrictEqual({ ...owners.read() }, repaired)) {
      throw new Error('Clawguard install record could not be verified after startup repair.');
    }
    return [`Reconciled ${id} ${pkg.version} with its existing LobsterAI installation at ${pluginDir}.`];
  });
}
