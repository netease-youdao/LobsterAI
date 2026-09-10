// Bundle the pinned owners, without general Doctor's config/plugin repairs.
import fs from 'node:fs';
import path from 'node:path';
import { detectLegacyDeviceAuth, migrateLegacyDeviceAuth } from '#openclaw-device-auth-migration';
import { detectLegacyDeviceIdentity, migrateLegacyDeviceIdentity } from '#openclaw-device-identity-migration';
import { loadDeviceIdentityIfPresent } from '#openclaw-device-identity';
import { detectLegacyExecApprovals, migrateLegacyExecApprovals } from '#openclaw-exec-approvals-migration';
import {
  detectLegacyWorkspaceState,
  migrateLegacyWorkspaceState,
} from '#openclaw-workspace-migration';
import {
  OPENCLAW_STARTUP_MIGRATION_RESULT_PREFIX,
  OpenClawStartupMigrationOwner,
  OpenClawStartupMigrationStatus,
} from '../src/shared/openclawEngine/startupMigration.ts';

const report = {
  status: OpenClawStartupMigrationStatus.Skipped,
  sourceCount: 0,
  sourceCounts: Object.fromEntries(Object.values(OpenClawStartupMigrationOwner).map(owner => [owner, 0])),
  changes: [], notices: [], warnings: [], remainingPaths: [],
};

function pathMayExist(filePath) {
  try { fs.lstatSync(filePath); return true; }
  catch (error) { return error.code !== 'ENOENT'; }
}

// Each owner holds its own stopped-Gateway lease and verifies its SQLite write.
// Inspect every owner even after a failure, so a retry need not reveal one blocker at a time.
async function migrateOwner(owner, detect, migrate, paths, isReadable) {
  try {
    const detected = detect();
    report.sourceCounts[owner] = paths(detected).length;
    const result = await migrate(detected);
    report.changes.push(...result.changes.map(value => `[${owner}] ${value}`));
    report.notices.push(...(result.notices ?? []).map(value => `[${owner}] ${value}`));
    report.warnings.push(...result.warnings.map(value => `[${owner}] ${value}`));
    const remaining = paths(detect());
    try {
      if (result.warnings.length || !isReadable || !isReadable()) report.remainingPaths.push(...remaining);
    } catch (error) {
      report.remainingPaths.push(...remaining);
      throw error;
    }
  } catch (error) {
    report.warnings.push(`[${owner}] ${error instanceof Error ? error.message : String(error)}`);
  }
}

try {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  const homeDir = process.env.OPENCLAW_HOME;
  if (![stateDir, configPath, homeDir].every(value => value && path.isAbsolute(value))) {
    throw new Error('Startup migration requires explicit absolute OpenClaw state, config and home paths.');
  }
  // Read only the generated config. Do not load plugins or acquire its config lock.
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error('Startup migration requires an OpenClaw config object.');
  }
  const options = { stateDir, env: process.env };
  const doctorDetection = { stateDir, doctorOnlyStateMigrations: true };
  const sourcePaths = detected => detected.hasLegacy ? [detected.sourcePath] : [];
  await migrateOwner(OpenClawStartupMigrationOwner.DeviceAuth,
    () => detectLegacyDeviceAuth(doctorDetection),
    detected => migrateLegacyDeviceAuth({ ...options, detected }), sourcePaths);

  // Import the original keys under the owner's conflict/verification rules.
  // Do not authorize Doctor to generate replacement keys for damaged SQLite-only state.
  const identityOptions = { ...options, allowLegacyDeviceIdentityImport: true };
  await migrateOwner(OpenClawStartupMigrationOwner.DeviceIdentity,
    () => detectLegacyDeviceIdentity(identityOptions),
    detected => migrateLegacyDeviceIdentity({ ...identityOptions, detected }),
    detected => [detected.sourcePath, detected.claimPath, detected.nativeClaimPath].filter(pathMayExist),
    // A verified migration receipt can intentionally retain inert, divergent JSON.
    // Respect the canonical runtime reader instead of making that notice a fatal error.
    () => Boolean(loadDeviceIdentityIfPresent({ env: process.env })));
  await migrateOwner(OpenClawStartupMigrationOwner.ExecApprovals,
    () => detectLegacyExecApprovals(doctorDetection),
    detected => migrateLegacyExecApprovals({ ...options, detected }), sourcePaths);

  const workspaceOptions = { ...options, cfg, homedir: () => homeDir, doctorOnlyStateMigrations: true };
  await migrateOwner(OpenClawStartupMigrationOwner.Workspace,
    () => detectLegacyWorkspaceState(workspaceOptions),
    detected => migrateLegacyWorkspaceState({ ...options, detected }),
    detected => detected.sources.map(source => source.sourcePath));
} catch (error) {
  report.warnings.push(error instanceof Error ? error.message : String(error));
}
report.sourceCount = Object.values(report.sourceCounts).reduce((total, count) => total + count, 0);
report.status = report.warnings.length || report.remainingPaths.length ? OpenClawStartupMigrationStatus.Failed
  : report.sourceCount ? OpenClawStartupMigrationStatus.Migrated : OpenClawStartupMigrationStatus.Skipped;
console.log(OPENCLAW_STARTUP_MIGRATION_RESULT_PREFIX + JSON.stringify(report));
process.exitCode = report.status === OpenClawStartupMigrationStatus.Failed ? 1 : 0;
