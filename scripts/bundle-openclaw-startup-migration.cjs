'use strict';

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const rootDir = path.resolve(__dirname, '..');
const entryPath = path.join(__dirname, 'openclaw-startup-state-migration.mjs');
const authStoreEntryPath = path.join(__dirname, 'openclaw-xai-auth-store.mjs');
const compatibilityEntryPath = path.join(__dirname, 'openclaw-startup-compat.mjs');

async function bundleOpenClawStartupMigration(runtimeDir, openclawSrc, selectedEntry = entryPath) {
  const expectedVersion = require(path.join(rootDir, 'package.json')).openclaw.version.replace(/^v/, '');
  for (const directory of [openclawSrc, runtimeDir]) {
    const version = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version;
    if (version !== expectedVersion) {
      throw new Error(`Startup migration must use OpenClaw ${expectedVersion}; found ${version} at ${directory}`);
    }
  }
  const authOwner = fs.readFileSync(path.join(openclawSrc, 'src/commands/doctor-auth-flat-profiles.ts'), 'utf8');
  if (!authOwner.includes('await params.persistConfig?.(params.cfg)')) {
    throw new Error('Startup auth migration requires openclaw-auth-migration-config-commit.patch; run openclaw:patch first.');
  }
  const workspaceOwner = fs.readFileSync(path.join(openclawSrc, 'src/infra/state-migrations.workspace-setup.ts'), 'utf8');
  if (!workspaceOwner.includes('await recoverReappearedWorkspaceSetup(')) {
    throw new Error('Startup workspace migration requires openclaw-workspace-setup-recovery.patch; run openclaw:patch first.');
  }
  const lockOwner = fs.readFileSync(path.join(openclawSrc, 'src/infra/gateway-lock.ts'), 'utf8');
  if (!lockOwner.includes('inspectOwner: opts.inspectOwner')) {
    throw new Error('Manual lock recovery requires zz-openclaw-lock-owner-recovery.patch; run openclaw:patch first.');
  }
  const outputPath = path.join(runtimeDir, path.basename(selectedEntry));
  // Rebuild even when the gateway cache is current: this entry is maintained by
  // LobsterAI and must match the pinned upstream migration/schema implementation.
  await esbuild.build({
    entryPoints: [selectedEntry],
    outfile: outputPath,
    alias: {
      '#openclaw-workspace-migration': path.join(openclawSrc, 'src/infra/state-migrations.workspace-setup.ts'),
      '#openclaw-device-auth-migration': path.join(openclawSrc, 'src/infra/state-migrations.device-auth.ts'),
      '#openclaw-device-identity-migration': path.join(openclawSrc, 'src/infra/state-migrations.device-identity.ts'),
      '#openclaw-device-identity': path.join(openclawSrc, 'src/infra/device-identity.ts'),
      '#openclaw-exec-approvals-migration': path.join(openclawSrc, 'src/infra/state-migrations.exec-approvals.ts'),
      '#openclaw-auth-profile-migration': path.join(openclawSrc, 'src/commands/doctor-auth-flat-profiles.ts'),
      '#openclaw-auth-sidecar-migration': path.join(openclawSrc, 'src/commands/doctor-auth-oauth-sidecar.ts'),
      '#openclaw-auth-migration-paths': path.join(openclawSrc, 'src/commands/doctor-auth-legacy-paths.ts'),
      '#openclaw-auth-migration-diagnostic': path.join(openclawSrc, 'src/agents/auth-profiles/legacy-source-diagnostic.ts'),
      '#openclaw-auth-profile-persisted': path.join(openclawSrc, 'src/agents/auth-profiles/persisted.ts'),
      '#openclaw-auth-profile-sqlite': path.join(openclawSrc, 'src/agents/auth-profiles/sqlite.ts'),
      '#openclaw-auth-profile-store': path.join(openclawSrc, 'src/agents/auth-profiles/store.ts'),
      '#openclaw-auth-profile-references': path.join(openclawSrc, 'src/agents/auth-profiles/runtime-external-profile-references.ts'),
      '#openclaw-auth-profile-paths': path.join(openclawSrc, 'src/agents/auth-profiles/path-resolve.ts'),
      '#openclaw-agent-database': path.join(openclawSrc, 'src/state/openclaw-agent-db.ts'),
      '#openclaw-state-database': path.join(openclawSrc, 'src/state/openclaw-state-db.ts'),
      '#openclaw-pid-alive': path.join(openclawSrc, 'src/shared/pid-alive.ts'),
      '#openclaw-config-io': path.join(openclawSrc, 'src/config/io.factory.ts'),
      '#openclaw-migration-lock': path.join(openclawSrc, 'src/infra/state-migrations.lock.ts'),
      '#openclaw-repair-lock': path.join(openclawSrc, 'src/commands/doctor-sqlite-maintenance-lock.ts'),
      '#openclaw-gateway-lock': path.join(openclawSrc, 'src/infra/gateway-lock.ts'),
      '#openclaw-repair-schema-check': path.join(openclawSrc, 'src/state/openclaw-database-preflight.ts'),
      '#openclaw-repair-state-check': path.join(openclawSrc, 'src/state/openclaw-state-db-maintenance.ts'),
      '#openclaw-repair-agent-targets': path.join(openclawSrc, 'src/config/sessions/targets.ts'),
      '#openclaw-repair-vectors': path.join(openclawSrc, 'packages/memory-host-sdk/src/host/sqlite-vec.ts'),
      '#openclaw-repair-plugin-records': path.join(openclawSrc, 'src/plugins/installed-plugin-index-records.ts'),
      '#openclaw-repair-plugin-payload': path.join(openclawSrc, 'src/cli/update-cli/plugin-payload-validation.ts'),
      '#openclaw-repair-plugin-consent': path.join(openclawSrc, 'src/plugins/capability-consent.ts'),
      '#openclaw-dreaming-workspaces': path.join(openclawSrc, 'src/memory-host-sdk/dreaming.ts'),
      '#openclaw-config-machine-state': path.join(openclawSrc, 'src/state/config-machine-state.ts'),
      '#openclaw-state-db': path.join(openclawSrc, 'src/state/openclaw-state-db.ts'),
      '#openclaw-state-db-contract': path.join(openclawSrc, 'src/state/openclaw-state-db-contract.ts'),
      '#openclaw-state-schema': path.join(openclawSrc, 'src/state/openclaw-state-schema.ts'),
      '#openclaw-state-schema-validation': path.join(openclawSrc, 'src/state/openclaw-state-db-fast-path.ts'),
      '#openclaw-state-schema-compatibility': path.join(openclawSrc, 'src/state/openclaw-state-schema-compatibility.ts'),
      '#openclaw-schema-contract': path.join(openclawSrc, 'src/infra/sqlite-schema-contract.ts'),
      '#openclaw-state-ownership': path.join(openclawSrc, 'src/state/openclaw-state-ownership.ts'),
      '#openclaw-state-coordinator': path.join(openclawSrc, 'src/infra/state-database-coordinator.ts'),
    },
    tsconfig: path.join(openclawSrc, 'tsconfig.json'),
    bundle: true,
    minify: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    plugins: [{
      name: 'inline-doctor-markdown-dependencies',
      setup(build) {
        // Doctor's note formatter imports these packages, which the desktop
        // runtime does not ship. Inline their complete pure-JS dependency trees.
        build.onResolve({ filter: /^(?:mdast-util-from-markdown|mdast-util-gfm-table|micromark-extension-gfm-table)$/ }, args => ({
          path: require.resolve(args.path, { paths: [args.resolveDir] }),
          namespace: 'doctor-markdown',
        }));
        build.onLoad({ filter: /.*/, namespace: 'doctor-markdown' }, async args => {
          const result = await esbuild.build({
            entryPoints: [args.path], bundle: true, platform: 'node',
            format: 'esm', write: false, logLevel: 'warning',
          });
          return { contents: result.outputFiles[0].text, loader: 'js' };
        });
      },
    }, {
      name: 'openclaw-sqlite-schema',
      setup(build) {
        // Match OpenClaw's production build: schema modules read adjacent SQL
        // only in source checkouts. Embed both schemas in this standalone entry.
        build.onLoad({ filter: /openclaw-(?:state|agent)-schema\.ts$/ }, args => {
          const schema = path.basename(args.path).includes('-agent-') ? 'AGENT' : 'STATE';
          const sql = fs.readFileSync(args.path.replace(/\.ts$/, '.sql'), 'utf8');
          return { contents: `export const OPENCLAW_${schema}_SCHEMA_SQL = ${JSON.stringify(sql)};`, loader: 'js' };
        });
      },
    }],
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    logLevel: 'warning',
  });
  console.log(`[OpenClaw] Built ${path.basename(outputPath)} (${fs.statSync(outputPath).size} bytes).`);
  if (selectedEntry === entryPath) {
    await bundleOpenClawStartupMigration(runtimeDir, openclawSrc, authStoreEntryPath);
    await bundleOpenClawStartupMigration(runtimeDir, openclawSrc, compatibilityEntryPath);
    await bundleOpenClawStartupMigration(runtimeDir, openclawSrc, path.join(__dirname, 'openclaw-gateway-repair.mjs'));
    const pinned = require(path.join(rootDir, 'package.json')).openclaw;
    fs.writeFileSync(path.join(runtimeDir, 'lobsterai-repair-plugins.json'), JSON.stringify({
      openclawVersion: expectedVersion,
      plugins: pinned.plugins.filter(plugin => plugin.version && plugin.npm).map(plugin => ({
        id: plugin.id, packageName: plugin.npm, version: plugin.version,
        relativePath: `${plugin.runtimeBundled ? 'dist/extensions' : 'third-party-extensions'}/${plugin.id}`,
      })),
    }, null, 2));
  }
  return outputPath;
}

if (require.main === module) {
  const runtimeDir = path.resolve(process.argv[2] || path.join(rootDir, 'vendor/openclaw-runtime/current'));
  const openclawSrc = path.resolve(process.argv[3] || process.env.OPENCLAW_SRC || path.join(rootDir, '../openclaw'));
  bundleOpenClawStartupMigration(runtimeDir, openclawSrc).catch(error => {
    console.error('[OpenClaw] Failed to build startup state migration helper:', error);
    process.exitCode = 1;
  });
}

module.exports = { bundleOpenClawStartupMigration };
