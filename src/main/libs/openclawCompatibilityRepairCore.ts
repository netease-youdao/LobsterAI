// Offline repair only. The bundled entry injects the pinned OpenClaw owners;
// this module never runs from the ordinary gateway startup path.
import fs from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

import {
  OPENCLAW_PLUGIN_SKILLS_DIRECTORY, OPENCLAW_REPAIR_SNAPSHOT_MANIFEST,
  type OpenClawCompatibilityRepairReport, OpenClawRepairPhase, OpenClawRepairPluginSource,
  type OpenClawRepairSnapshotManifest,
} from '../../shared/openclawEngine/repair';
import { isMissingUnaliasedPluginPath, isPreviousManagedPluginPath } from './openclawPluginRepairPaths';
import { assertOwnedRepairPath } from './openclawRepairPaths';
import { resolveSnapshotSkipReason, SnapshotSkipReason } from './openclawRepairSnapshotPaths';
import {
  copySnapshotFile, measureSnapshotSource, type RepairProgressReporter, SnapshotProgress,
} from './openclawRepairSnapshotProgress';

export { assertOwnedRepairPath } from './openclawRepairPaths';

type Config = Record<string, unknown>;
export interface RepairInstallRecord {
  source: string;
  installPath?: string;
  sourcePath?: string;
  spec?: string;
  resolvedName?: string;
  version?: string;
  [key: string]: unknown;
}
export interface BundledRepairPlugin {
  id: string;
  packageName: string;
  version: string;
  root: string;
}
export interface CompatibilityRepairOwners {
  withLock: (run: () => Promise<void>) => Promise<void>;
  verifyDatabaseSchemas: () => void;
  loadVectorExtension: (db: DatabaseSync) => Promise<void>;
  readInstallRecords: () => Record<string, RepairInstallRecord>;
  writeInstallRecords: (records: Record<string, RepairInstallRecord>, config: Config) => void;
  validatePlugin: (id: string, root: string) => Promise<void>;
  acceptBundledPlugin: (id: string, config: Config) => Promise<void>;
  /** Receives snapshot progress; the bundled entry prints it for the app's wait policy. */
  reportProgress?: RepairProgressReporter;
}
export interface CompatibilityRepairOptions {
  stateDir: string;
  configPath: string;
  backupDir: string;
  phase: OpenClawRepairPhase;
  legacyConfigPath?: string;
  plugins?: BundledRepairPlugin[];
}

function readConfig(filePath: string): Config {
  if (!fs.existsSync(filePath)) return {};
  const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an OpenClaw config object.');
  return value as Config;
}

function checkDatabase(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA quick_check').all();
  if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') {
    throw new Error('SQLite quick_check failed; the original database was preserved in the repair backup.');
  }
}

async function backupDatabase(
  filePath: string, options: CompatibilityRepairOptions, report: OpenClawCompatibilityRepairReport,
  onBytes?: (bytes: number) => void,
): Promise<void> {
  assertOwnedRepairPath(options.stateDir, filePath);
  const destination = path.join(options.backupDir, 'original', path.relative(options.stateDir, filePath));
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  // Recovery reuses the complete pre-Doctor snapshot from this repair run.
  if (fs.existsSync(destination)) return;
  let reportedBytes = 0;
  const advance = (bytes: number) => {
    if (onBytes && bytes > reportedBytes) onBytes(bytes - reportedBytes);
    reportedBytes = Math.max(reportedBytes, bytes);
  };
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size) || 0;
    // SQLite's online backup includes committed WAL pages. Copying only the
    // .sqlite file loses data even after the gateway process has stopped.
    await backup(db, destination, {
      progress: ({ totalPages, remainingPages }) => advance((totalPages - remainingPages) * pageSize),
    });
  } finally {
    db.close();
  }
  fs.chmodSync(destination, 0o600);
  // The last backup step completes without a progress callback.
  advance(fs.statSync(destination).size);
  report.backups.push(destination);
}

export async function repairOrphanMemoryVectors(
  filePath: string, options: CompatibilityRepairOptions,
  report: OpenClawCompatibilityRepairReport, owners: CompatibilityRepairOwners,
): Promise<void> {
  assertOwnedRepairPath(options.stateDir, filePath);
  const probe = new DatabaseSync(filePath, { readOnly: true, allowExtension: true });
  let orphanIds: string[];
  const orphanSql = 'SELECT id FROM chunks_vec WHERE id NOT IN (SELECT id FROM chunks)';
  try {
    const vector = probe.prepare("SELECT sql FROM sqlite_master WHERE name = 'chunks_vec'").get();
    if (!vector) return;
    if (typeof vector.sql !== 'string' || !/USING\s+vec0\s*\(/i.test(vector.sql)
      || !probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunks'").get()) {
      throw new Error(`Unrecognized legacy memory schema: ${filePath}`);
    }
    await owners.loadVectorExtension(probe);
    checkDatabase(probe);
    orphanIds = probe.prepare(orphanSql).all().map(row => {
      if (typeof row.id !== 'string') throw new Error(`Invalid legacy vector ID in ${filePath}`);
      return row.id;
    });
  } finally {
    probe.close();
  }
  if (!orphanIds.length) return;
  await backupDatabase(filePath, options, report);
  const db = new DatabaseSync(filePath, { allowExtension: true });
  try {
    await owners.loadVectorExtension(db);
    db.exec('BEGIN IMMEDIATE');
    try {
      const currentIds = db.prepare(orphanSql).all().map(row => row.id);
      if (JSON.stringify(currentIds) !== JSON.stringify(orphanIds)) throw new Error('Memory index changed during backup; retry repair.');
      const remove = db.prepare('DELETE FROM chunks_vec WHERE id = ?');
      // vec0 must update its own shadow tables. Never delete chunks_vec_rowids
      // directly, and never mistake rowid for the text chunk ID.
      for (const id of orphanIds) remove.run(id);
      if (db.prepare(orphanSql).all().length) throw new Error('Orphan memory vector repair did not complete.');
      checkDatabase(db);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
  report.changes.push(`Removed ${orphanIds.length} orphan vectors from ${filePath}; memory text was retained.`);
}

async function snapshotState(
  options: CompatibilityRepairOptions, report: OpenClawCompatibilityRepairReport, reportProgress?: RepairProgressReporter,
): Promise<void> {
  const snapshotRoot = path.join(options.backupDir, 'original');
  if (fs.existsSync(snapshotRoot)) throw new Error('Repair snapshot already exists; start a new repair run.');
  // A large profile on slow storage copies for many minutes. Measure first and
  // report progress, so the app waits for a copy that advances and still stops
  // one that does not.
  const progress = new SnapshotProgress(OpenClawRepairPhase.Snapshot, reportProgress);
  progress.start();
  try {
    const totals = await measureSnapshotSource(options.stateDir, progress);
    progress.plan(totals);
    report.changes.push(`Snapshot measured ${totals.files} files (${Math.round(totals.bytes / (1024 * 1024))} MiB) to copy.`);
    await copySnapshot(options, report, snapshotRoot, progress);
    progress.flush();
  } finally {
    progress.stop();
  }
}

async function copySnapshot(
  options: CompatibilityRepairOptions, report: OpenClawCompatibilityRepairReport,
  snapshotRoot: string, progress: SnapshotProgress,
): Promise<void> {
  const addBytes = (bytes: number) => progress.add(0, bytes);
  const pluginSkillsRoot = path.join(options.stateDir, OPENCLAW_PLUGIN_SKILLS_DIRECTORY);
  const skippedSessionImportArchivePaths: string[] = [];
  const manifest: OpenClawRepairSnapshotManifest = {
    version: 1, generatedPluginSkillLinks: [], skippedRegenerablePaths: [], skippedSessionImportArchivePaths,
    restoreInstructions: 'Generated plugin skill links are recorded without copying their targets. After restoring, run the bundled openclaw skills list or start an agent session to rebuild them from current plugin metadata. Paths in skippedRegenerablePaths are caches (V8 compile cache, Chromium HTTP/GPU/Service Worker caches) that were not copied; OpenClaw and its browser rebuild them on demand. Paths in skippedSessionImportArchivePaths hold legacy transcripts OpenClaw had already imported into the agent databases copied here; repair only adds new files to them, so they were left in place. Restore by copying this snapshot over the state directory, not by replacing it, so those archives are kept.',
  };
  async function visit(directory: string): Promise<void> {
    const destination = path.join(snapshotRoot, path.relative(options.stateDir, directory));
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);
      const target = path.join(destination, entry.name);
      const relative = path.relative(options.stateDir, source);
      const skipReason = resolveSnapshotSkipReason(relative, entry.isDirectory());
      if (skipReason) {
        (skipReason === SnapshotSkipReason.Regenerable ? manifest.skippedRegenerablePaths : skippedSessionImportArchivePaths)
          .push(relative);
        continue;
      }
      try {
        if (entry.isSymbolicLink()) {
          if (entry.name.endsWith('.sqlite') || /^(?:state|agents|memory)(?:[/\\]|$)/.test(relative)) {
            throw new Error(`Repair cannot back up database state through a symbolic link: ${source}`);
          }
          // Only direct links in OpenClaw's generated index are regenerable.
          // Do not stat/follow them: a prior installation's target can be absent,
          // and recreating a dangling link on Windows requires extra privileges.
          if (directory === pluginSkillsRoot) {
            manifest.generatedPluginSkillLinks.push({ path: relative, target: fs.readlinkSync(source) });
            progress.add(1, 0);
            continue;
          }
          // Preserve links as links; never walk into another profile or project.
          // Windows npm host links are directory junctions. Recreating them as
          // file symlinks would unnecessarily require Developer Mode/admin rights.
          let linkType: fs.symlink.Type | undefined;
          if (process.platform === 'win32') {
            try { linkType = fs.statSync(source).isDirectory() ? 'junction' : 'file'; } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
          fs.symlinkSync(fs.readlinkSync(source), target, linkType);
          progress.add(1, 0);
        } else if (entry.isDirectory()) {
          await visit(source);
        } else if (entry.isFile()) {
          if (/\.sqlite-(?:wal|shm|journal)$/.test(entry.name) && fs.existsSync(source.replace(/-(?:wal|shm|journal)$/, ''))) {
            // Its committed pages are copied by the database's online backup.
            progress.add(1, 0);
            continue;
          }
          const stat = fs.statSync(source);
          if (entry.name.endsWith('.sqlite') && stat.size > 0) {
            await backupDatabase(source, options, report, addBytes);
          } else {
            await copySnapshotFile(source, target, stat.size, addBytes);
            fs.chmodSync(target, 0o600 | (stat.mode & 0o100));
          }
          progress.add(1, 0);
        }
      } catch (error) {
        report.failurePath ??= source;
        throw error;
      }
    }
  }
  await visit(options.stateDir);
  const manifestPath = path.join(options.backupDir, OPENCLAW_REPAIR_SNAPSHOT_MANIFEST);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  report.backups.push(manifestPath);
  if (manifest.generatedPluginSkillLinks.length) {
    report.changes.push(`Recorded ${manifest.generatedPluginSkillLinks.length} generated plugin skill links for reconstruction from current plugin metadata.`);
  }
  if (manifest.skippedRegenerablePaths.length) {
    report.changes.push(`Skipped ${manifest.skippedRegenerablePaths.length} regenerable cache directories (compile and browser caches); see ${OPENCLAW_REPAIR_SNAPSHOT_MANIFEST}.`);
  }
  if (skippedSessionImportArchivePaths.length) {
    report.changes.push(`Left ${skippedSessionImportArchivePaths.length} session import archives in place (transcripts already imported into the copied agent databases); see ${OPENCLAW_REPAIR_SNAPSHOT_MANIFEST}.`);
  }
  report.changes.push('Created a consistent snapshot of OpenClaw state before Doctor repair.');
}

async function recoverMemory(options: CompatibilityRepairOptions, report: OpenClawCompatibilityRepairReport, owners: CompatibilityRepairOwners): Promise<void> {
  // Doctor owns all schema migration. Do not continue writes if it left a
  // required schema old, unreadable, or newer than this bundled runtime.
  owners.verifyDatabaseSchemas();
  const memoryRoot = path.join(options.stateDir, 'memory');
  if (fs.existsSync(memoryRoot)) {
    assertOwnedRepairPath(options.stateDir, memoryRoot);
    for (const entry of fs.readdirSync(memoryRoot, { withFileTypes: true })) {
      if (entry.name.endsWith('.sqlite')) {
        await repairOrphanMemoryVectors(path.join(memoryRoot, entry.name), options, report, owners);
      }
    }
  }
}

async function repairPlugins(options: CompatibilityRepairOptions, report: OpenClawCompatibilityRepairReport, owners: CompatibilityRepairOwners): Promise<void> {
  const config = readConfig(options.configPath);
  let legacy: Config = {};
  if (options.legacyConfigPath) {
    try { legacy = readConfig(options.legacyConfigPath); } catch {
      report.changes.push('The unreadable legacy config remains in the backup; retained the native plugin records.');
    }
  }
  const oldRecords = (legacy.plugins as { installs?: Record<string, RepairInstallRecord> } | undefined)?.installs ?? {};
  const records = { ...oldRecords, ...owners.readInstallRecords() };
  const restored: string[] = [];
  for (const plugin of options.plugins ?? []) {
    const record = records[plugin.id];
    if (!record) continue;
    const isPriorRepair = record.source === OpenClawRepairPluginSource.Path
      && record.installPath === plugin.root && record.sourcePath === plugin.root;
    if (!isPriorRepair && record.source !== OpenClawRepairPluginSource.Npm) continue;
    // A matching ID alone does not make a user plugin a bundled plugin.
    const packageIdentities = [record.resolvedName, record.spec, record.resolvedSpec]
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (!isPriorRepair && (!packageIdentities.length || !packageIdentities.every(value =>
      value === plugin.packageName || value.startsWith(`${plugin.packageName}@`)))) continue;
    if (record.installPath && !isPriorRepair) {
      if (path.resolve(record.installPath).startsWith(path.resolve(options.stateDir) + path.sep)) {
        assertOwnedRepairPath(options.stateDir, record.installPath);
        try { await owners.validatePlugin(plugin.id, record.installPath); continue; } catch { /* restore the shipped payload */ }
      } else {
        // Only replace the ledger entry for a missing managed install from a
        // previous profile. Never mutate external files or adopt custom installs.
        if (!isPreviousManagedPluginPath({ ...options, installPath: record.installPath, pluginId: plugin.id, packageName: plugin.packageName })
          || !isMissingUnaliasedPluginPath(record.installPath, options.stateDir)) continue;
      }
    }
    const manifest = readConfig(path.join(plugin.root, 'package.json'));
    const pluginManifest = readConfig(path.join(plugin.root, 'openclaw.plugin.json'));
    if (manifest.name !== plugin.packageName || manifest.version !== plugin.version || pluginManifest.id !== plugin.id) {
      throw new Error(`Bundled plugin identity/version mismatch: ${plugin.id}`);
    }
    await owners.validatePlugin(plugin.id, plugin.root);
    // Reconcile to the exact payload already selected by LobsterAI config.
    // This is a local path install, not a fabricated npm download receipt.
    records[plugin.id] = {
      source: OpenClawRepairPluginSource.Path, sourcePath: plugin.root, installPath: plugin.root,
      version: plugin.version, installedAt: new Date().toISOString(),
    };
    restored.push(plugin.id);
  }
  if (!restored.length && !Object.keys(oldRecords).length) return;
  const database = path.join(options.stateDir, 'state', 'openclaw.sqlite');
  // The snapshot is the pre-repair backup. A plugins-only invocation
  // also backs up before modifying its authoritative ledger.
  const backupPath = path.join(options.backupDir, 'original', 'state', 'openclaw.sqlite');
  if (fs.existsSync(database) && !fs.existsSync(backupPath)) await backupDatabase(database, options, report);
  owners.writeInstallRecords(records, config);
  for (const id of restored) {
    await owners.acceptBundledPlugin(id, config);
    report.changes.push(`Restored bundled plugin ${id} from the packaged runtime.`);
  }
}

export async function repairOpenClawCompatibility(options: CompatibilityRepairOptions, owners: CompatibilityRepairOwners): Promise<OpenClawCompatibilityRepairReport> {
  const report: OpenClawCompatibilityRepairReport = { phase: options.phase, success: false, changes: [], backups: [] };
  try {
    await owners.withLock(async () => {
      if (options.phase === OpenClawRepairPhase.Snapshot) await snapshotState(options, report, owners.reportProgress);
      else if (options.phase === OpenClawRepairPhase.Recovery) await recoverMemory(options, report, owners);
      else await repairPlugins(options, report, owners);
    });
    report.success = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    const failurePath = (error as NodeJS.ErrnoException)?.path;
    if (typeof failurePath === 'string') report.failurePath ??= failurePath;
  }
  fs.writeFileSync(path.join(options.backupDir, `${options.phase}-report.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  return report;
}
