'use strict';

// Guards the dsh home teardown against the Windows junction trap.
//
// dsh materialises its profile as links into the runtime install, and on
// Windows those are directory junctions. `fs.rmSync(home, {recursive:true})`
// under Electron's Node walks through them and deletes the runtime's own files,
// leaving a runtime that still boots with pieces missing — which is how the
// directory picker lost its dialog worker and started failing with "win32
// folder dialog worker exited before reporting a result".
//
// The behaviour has differed between plain Node and Electron runtimes, so this
// check is only meaningful when it runs under the same runtime the app uses:
//
//   ELECTRON_RUN_AS_NODE=1 <electron> scripts/verify-dsh-remove-tree.cjs
//
// Exits non-zero if removeTree ever deletes through a link.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { removeTree } = require('./dsh-remove-tree.cjs');

const LOG_TAG = '[verify-dsh-remove-tree]';
const runtimeLabel = process.versions.electron
  ? `electron ${process.versions.electron} (node ${process.versions.node})`
  : `node ${process.versions.node}`;

// A dsh home in miniature: profiles/**/pkg is a link into the runtime tree.
function buildFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remove-tree-'));
  const runtimePackage = path.join(base, 'runtime', 'node_modules', 'pkg');
  const profileModules = path.join(base, 'home', 'profiles', 'node_modules');
  fs.mkdirSync(runtimePackage, { recursive: true });
  fs.mkdirSync(profileModules, { recursive: true });
  fs.writeFileSync(path.join(runtimePackage, 'worker.cjs'), '// a file only the runtime owns\n');
  fs.symlinkSync(runtimePackage, path.join(profileModules, 'pkg'), process.platform === 'win32' ? 'junction' : 'dir');
  return { base, home: path.join(base, 'home'), guarded: path.join(runtimePackage, 'worker.cjs') };
}

// What the naive teardown does here, reported so the log says which side of the
// trap this runtime falls on rather than asserting a behaviour we do not own.
const naive = buildFixture();
fs.rmSync(naive.home, { recursive: true, force: true });
const naiveFollowed = !fs.existsSync(naive.guarded);
fs.rmSync(naive.base, { recursive: true, force: true });
console.log(`${LOG_TAG} ${runtimeLabel}: fs.rmSync(recursive) ${naiveFollowed ? 'FOLLOWS links' : 'does not follow links'}`);

const guarded = buildFixture();
removeTree(guarded.home);
const survived = fs.existsSync(guarded.guarded);
const homeGone = !fs.existsSync(guarded.home);
fs.rmSync(guarded.base, { recursive: true, force: true });

if (!survived) {
  console.error(`${LOG_TAG} removeTree deleted through the profile link — the runtime would be corrupted`);
  process.exit(1);
}
if (!homeGone) {
  console.error(`${LOG_TAG} removeTree left the home behind`);
  process.exit(1);
}
console.log(`${LOG_TAG} removeTree removed the home and left the link target intact`);
