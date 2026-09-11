// Use the pinned credential owners; never substitute or discard user credentials.
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { maybeMigrateAuthProfileJsonStoresToSqlite } from '#openclaw-auth-profile-migration';
import { maybeRepairLegacyOAuthSidecarProfiles } from '#openclaw-auth-sidecar-migration';
import { listAuthProfileRepairCandidates } from '#openclaw-auth-migration-paths';
import { assertAuthProfileMigrationReady } from '#openclaw-auth-migration-diagnostic';
import { coercePersistedAuthProfileStore } from '#openclaw-auth-profile-persisted';
import {
  inspectPersistedAuthProfileStoreRaw,
  inspectPersistedSharedAuthProfileStoreRaw,
} from '#openclaw-auth-profile-sqlite';
import { createConfigIO } from '#openclaw-config-io';
import { withLegacyMigrationStateLock } from '#openclaw-migration-lock';

export async function migrateAuthProfilesBeforeStartup({ stateDir, configPath, env }) {
  const result = await withLegacyMigrationStateLock({
    stateDir, env, label: 'auth profiles', releaseLabel: 'Auth profiles',
    errorLabel: 'Auth profile migration failed',
    run: async migrationEnv => {
      // Core-only reads do not discover plugins or apply plugin defaults.
      const io = createConfigIO({
        configPath, env: migrationEnv, pluginValidation: 'core-only',
        shellEnvFallback: 'defer', observe: false,
      });
      let { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
      if (!snapshot.exists || !snapshot.parsed
        || typeof snapshot.parsed !== 'object' || Array.isArray(snapshot.parsed)) {
        throw new Error('Auth migration requires a readable generated config.');
      }
      // Inline credentials from old releases are invalid under the new schema.
      // Only the auth owner may repair them; unrelated core errors still block.
      if (!snapshot.valid && snapshot.issues.some(issue => !/^auth(?:\.|$)/.test(issue.path))) {
        throw new Error('Auth migration cannot repair unrelated config errors.');
      }
      const cfg = structuredClone(snapshot.parsed);
      const originalConfig = structuredClone(cfg);
      const warnings = [];
      const prompter = { confirmAutoFix: async () => true };
      const persistConfig = async nextConfig => {
        try {
          if (!isDeepStrictEqual({ ...originalConfig, auth: nextConfig.auth }, nextConfig)) {
            throw new Error('Auth migration attempted to change unrelated config.');
          }
          // The patched owner calls this after SQLite verification and before
          // archiving JSON, so a failed write retains its source for the retry.
          await io.writeConfigFile({ ...snapshot.parsed, auth: nextConfig.auth }, {
            ...writeOptions, baseSnapshot: snapshot, skipPluginValidation: true,
            allowConfigSizeDrop: true, skipRuntimeSnapshotRefresh: true,
            skipOutputLogs: true, auditOrigin: 'doctor',
          });
          ({ snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite());
        } catch (error) {
          warnings.push(`Auth profile config migration failed: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      };
      // Resolve decryptable OAuth sidecars before importing their profile rows.
      const sidecars = await maybeRepairLegacyOAuthSidecarProfiles({
        cfg, env: migrationEnv, prompter, emitNotes: false,
      });
      const migrated = await maybeMigrateAuthProfileJsonStoresToSqlite({
        cfg, env: migrationEnv, prompter, persistConfig,
      });
      const changes = [...sidecars.changes, ...migrated.changes];
      for (const sourcePath of migrated.detected.filter(source => fs.existsSync(source))) {
        warnings.push(`Legacy auth profile input still requires migration: ${sourcePath}`);
      }
      // Empty legacy files can be archived with a warning. They no longer block
      // requests; verify the actual runtime reader instead of matching messages.
      for (const candidate of listAuthProfileRepairCandidates(cfg, migrationEnv)) {
        try {
          assertAuthProfileMigrationReady(candidate.agentDir, migrationEnv);
          const store = candidate.agentDir === undefined
            ? inspectPersistedSharedAuthProfileStoreRaw(migrationEnv)
            : inspectPersistedAuthProfileStoreRaw(candidate.agentDir);
          if (store.status === 'unreadable'
            || (store.status === 'readable' && !coercePersistedAuthProfileStore(store.raw))) {
            throw new Error(`Auth profile SQLite store is unreadable: ${candidate.authPath}`);
          }
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : String(error));
        }
      }
      return {
        sourceCount: new Set([...sidecars.detected, ...migrated.detected]).size,
        changes, warnings,
        notices: [...sidecars.warnings, ...migrated.warnings],
      };
    },
  });
  return { sourceCount: 0, notices: [], ...result };
}
