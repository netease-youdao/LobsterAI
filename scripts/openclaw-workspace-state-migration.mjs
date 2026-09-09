// Bundled against the pinned OpenClaw source. Never run the general Doctor here:
// its config/plugin repairs also change IM settings managed by LobsterAI.
import fs from 'node:fs';
import path from 'node:path';
import {
  detectLegacyWorkspaceState,
  migrateLegacyWorkspaceState,
} from '#openclaw-workspace-migration';
import {
  OPENCLAW_WORKSPACE_MIGRATION_RESULT_PREFIX,
  OpenClawWorkspaceMigrationStatus,
} from '../src/shared/openclawEngine/workspaceMigration.ts';

let sourceCount = 0;
let report;
try {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  const homeDir = process.env.OPENCLAW_HOME;
  if (![stateDir, configPath, homeDir].every(value => value && path.isAbsolute(value))) {
    throw new Error('Workspace migration requires explicit absolute OpenClaw state, config and home paths.');
  }
  // Read the generated config without loading plugins, repairing config, or
  // acquiring openclaw.json.lock. Workspace imports use their own state lock.
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error('Workspace migration requires an OpenClaw config object.');
  }
  const detectionOptions = {
    cfg, stateDir, env: process.env, homedir: () => homeDir,
    doctorOnlyStateMigrations: true,
  };
  const detected = detectLegacyWorkspaceState(detectionOptions);
  sourceCount = detected.sources.length;
  const result = await migrateLegacyWorkspaceState({ detected, stateDir, env: process.env });
  // A successful process exit alone does not prove all sources were imported.
  // Conflicts, unreadable files and an active Gateway must remain retryable.
  const remaining = detectLegacyWorkspaceState(detectionOptions);
  const failed = result.warnings.length > 0 || remaining.hasLegacy;
  report = {
    status: failed ? OpenClawWorkspaceMigrationStatus.Failed
      : detected.hasLegacy ? OpenClawWorkspaceMigrationStatus.Migrated
        : OpenClawWorkspaceMigrationStatus.Skipped,
    sourceCount,
    changes: result.changes,
    warnings: result.warnings,
    remainingPaths: remaining.sources.map(source => source.sourcePath),
  };
} catch (error) {
  report = {
    status: OpenClawWorkspaceMigrationStatus.Failed,
    sourceCount, changes: [], remainingPaths: [],
    warnings: [error instanceof Error ? error.message : String(error)],
  };
}
console.log(OPENCLAW_WORKSPACE_MIGRATION_RESULT_PREFIX + JSON.stringify(report));
process.exitCode = report.status === OpenClawWorkspaceMigrationStatus.Failed ? 1 : 0;
