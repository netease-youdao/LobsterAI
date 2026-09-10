'use strict';

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const rootDir = path.resolve(__dirname, '..');
const entryPath = path.join(__dirname, 'openclaw-startup-state-migration.mjs');

async function bundleOpenClawStartupMigration(runtimeDir, openclawSrc) {
  const expectedVersion = require(path.join(rootDir, 'package.json')).openclaw.version.replace(/^v/, '');
  for (const directory of [openclawSrc, runtimeDir]) {
    const version = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version;
    if (version !== expectedVersion) {
      throw new Error(`Startup migration must use OpenClaw ${expectedVersion}; found ${version} at ${directory}`);
    }
  }
  const outputPath = path.join(runtimeDir, path.basename(entryPath));
  // Rebuild even when the gateway cache is current: this entry is maintained by
  // LobsterAI and must match the pinned upstream migration/schema implementation.
  await esbuild.build({
    entryPoints: [entryPath],
    outfile: outputPath,
    alias: {
      '#openclaw-workspace-migration': path.join(openclawSrc, 'src/infra/state-migrations.workspace-setup.ts'),
      '#openclaw-device-auth-migration': path.join(openclawSrc, 'src/infra/state-migrations.device-auth.ts'),
      '#openclaw-device-identity-migration': path.join(openclawSrc, 'src/infra/state-migrations.device-identity.ts'),
      '#openclaw-device-identity': path.join(openclawSrc, 'src/infra/device-identity.ts'),
      '#openclaw-exec-approvals-migration': path.join(openclawSrc, 'src/infra/state-migrations.exec-approvals.ts'),
    },
    tsconfig: path.join(openclawSrc, 'tsconfig.json'),
    bundle: true,
    minify: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    plugins: [{
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
  console.log(`[OpenClaw] Built startup state migration helper (${fs.statSync(outputPath).size} bytes).`);
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
