'use strict';

// Pack a built dsh runtime (vendor/dsh-runtime/<target>) into a distributable
// archive + manifest. The archive is what later uploads to the CDN for
// kit-triggered on-demand install; until then the local file stands in.
//
//   node scripts/pack-dsh-runtime.cjs <target-id> [out-dir]
//
// Produces in <out-dir> (default vendor/dsh-dist):
//   dsh-runtime-<version>-<target>.tar.gz
//   dsh-runtime-<version>-<target>.manifest.json   { version, target, sha256, size, archive }

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { resolveTarCommand } = require('./dsh-tar.cjs');

const LOG_TAG = '[pack-dsh-runtime]';

function log(message) {
  console.log(`${LOG_TAG} ${message}`);
}

function fail(message) {
  console.error(`${LOG_TAG} ${message}`);
  process.exit(1);
}

const targetId = (process.argv[2] || '').trim();
if (!targetId) {
  fail('Usage: node scripts/pack-dsh-runtime.cjs <target-id> [out-dir]');
}

const rootDir = path.resolve(__dirname, '..');
const runtimeDir = path.join(rootDir, 'vendor', 'dsh-runtime', targetId);
const buildInfoPath = path.join(runtimeDir, 'runtime-build-info.json');
if (!fs.existsSync(buildInfoPath)) {
  fail(`No built runtime at ${runtimeDir}. Run \`npm run dsh:runtime:${targetId}\` first.`);
}
const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
if (buildInfo.target !== targetId) {
  fail(`runtime-build-info.json target mismatch: expected ${targetId}, found ${buildInfo.target}`);
}

const outDir = path.resolve(rootDir, process.argv[3] || path.join('vendor', 'dsh-dist'));
fs.mkdirSync(outDir, { recursive: true });

const baseName = `dsh-runtime-${buildInfo.dshVersion}-${targetId}`;
const archivePath = path.join(outDir, `${baseName}.tar.gz`);
const manifestPath = path.join(outDir, `${baseName}.manifest.json`);

// -C into the runtime dir and archive its contents so extraction lands flat in
// the install destination. --no-xattrs keeps macOS metadata out of the archive.
log(`Archiving ${path.relative(rootDir, runtimeDir)} ...`);
fs.rmSync(archivePath, { force: true });
// No shell: these paths are absolute and may contain spaces.
const tarCommand = resolveTarCommand();
const result = spawnSync(tarCommand, ['-czf', archivePath, '-C', runtimeDir, '.'], { stdio: 'inherit' });
if (result.error) {
  fail(`tar could not start (${tarCommand}): ${result.error.message}`);
}
if (result.status !== 0) {
  fail(`tar exited with code ${result.status}`);
}

const archiveBytes = fs.readFileSync(archivePath);
const sha256 = crypto.createHash('sha256').update(archiveBytes).digest('hex');
const manifest = {
  version: buildInfo.dshVersion,
  target: targetId,
  patchHash: buildInfo.patchHash,
  archive: path.basename(archivePath),
  sha256,
  size: archiveBytes.length,
  createdAt: new Date().toISOString(),
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

log(`Archive:  ${path.relative(rootDir, archivePath)} (${Math.round(archiveBytes.length / 1024 / 1024)} MB)`);
log(`Manifest: ${path.relative(rootDir, manifestPath)} (sha256 ${sha256.slice(0, 16)}…)`);

// The app installs from package.json `dsh.runtimes[target]`, one absolute URL
// per target, so a CDN that mints an unrelated URL per file needs no directory
// layout. Upload the archive, then record where it landed.
log('');
log('Next: upload the archive, then record its URL for this target:');
log(`  npm run dsh:runtime:url ${targetId} <uploaded-url>`);
log('That writes this descriptor into package.json (digest and size come from the manifest):');
log(`  "${targetId}": { "url": "…", "sha256": "${sha256}", "size": ${archiveBytes.length} }`);
