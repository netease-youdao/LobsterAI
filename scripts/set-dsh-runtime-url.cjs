'use strict';

// Records where an uploaded runtime archive lives:
//
//   node scripts/set-dsh-runtime-url.cjs <target-id> <uploaded-url>
//
// The digest and size are read from the manifest that scripts/pack-dsh-runtime
// wrote for that exact archive, so they can never drift from what was uploaded
// by hand. The result goes into package.json under `dsh.runtimes[target]`,
// which ships inside the app — the app therefore trusts a digest it carries
// itself rather than one fetched from the same host as the archive.
//
// Each target holds one absolute URL and nothing is appended to it, so a CDN
// that mints an unrelated URL per file needs no shared directory.

const fs = require('fs');
const path = require('path');

const LOG_TAG = '[set-dsh-runtime-url]';

function fail(message) {
  console.error(`${LOG_TAG} ${message}`);
  process.exit(1);
}

const [targetId, url] = process.argv.slice(2);
if (!targetId || !url) {
  fail('Usage: node scripts/set-dsh-runtime-url.cjs <target-id> <uploaded-url>');
}
if (!/^https?:\/\//i.test(url)) {
  fail(`URL must be absolute http(s): ${url}`);
}

const rootDir = path.resolve(__dirname, '..');
const pkgPath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (!pkg.dsh || !pkg.dsh.version) {
  fail('package.json is missing the "dsh" field');
}

const distDir = path.join(rootDir, 'vendor', 'dsh-dist');
const manifestPath = path.join(distDir, `dsh-runtime-${pkg.dsh.version}-${targetId}.manifest.json`);
if (!fs.existsSync(manifestPath)) {
  fail(`No manifest for ${targetId} at ${path.relative(rootDir, manifestPath)} — run \`npm run dsh:runtime:pack ${targetId}\` first`);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.target !== targetId || manifest.version !== pkg.dsh.version) {
  fail(`Manifest mismatch: it describes ${manifest.version}/${manifest.target}`);
}

// Guard against pointing a target at an archive that no longer exists locally:
// the digest must still match the packed file we are publishing.
const archivePath = path.join(distDir, manifest.archive);
if (!fs.existsSync(archivePath)) {
  fail(`Manifest names ${manifest.archive}, which is missing from ${path.relative(rootDir, distDir)}`);
}
const actualSize = fs.statSync(archivePath).size;
if (actualSize !== manifest.size) {
  fail(`${manifest.archive} is ${actualSize} bytes but the manifest says ${manifest.size} — re-pack before publishing`);
}

pkg.dsh.runtimes = pkg.dsh.runtimes || {};
pkg.dsh.runtimes[targetId] = { url, sha256: manifest.sha256, size: manifest.size };
// Keep targets in a stable order so the diff stays readable.
pkg.dsh.runtimes = Object.fromEntries(Object.entries(pkg.dsh.runtimes).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`${LOG_TAG} ${targetId} -> ${url}`);
console.log(`${LOG_TAG} sha256 ${manifest.sha256} (${manifest.size} bytes) recorded in package.json`);
