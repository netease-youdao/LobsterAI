'use strict';

// Let dsh-app-boot reach Node internals through --expose-internals.
//
// dsh 0.2.x added runtime resolution interception to dsh-app-boot. Its
// internalModules() helper (in the main thread and in the profile-resolution
// worker bootstrap) loads Node internals only through the
// node-addon-require-builtin native addon. That addon matches an exact
// Electron/V8 fingerprint and rejects ours ("unsupported Electron runtime
// fingerprint"), so dsh exits during boot.
//
// The Cordis loader and dsh-hmr already try `--expose-internals` first and fall
// back to the addon; LobsterAI always launches dsh with that flag (see
// DSH_NODE_EXEC_ARGV). This patch gives internalModules() the same lookup
// order. Drop it once upstream does the same or the addon supports the pinned
// Electron; the build fails here when the target text changes.
//
// Written as a transform rather than a diff: `git apply` silently skips paths
// under a gitignored vendor directory.

const fs = require('fs');
const path = require('path');

const PACKAGE_LIB = ['node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib'];
const TARGETS = [
  [...PACKAGE_LIB, 'index.js'],
  [...PACKAGE_LIB, 'worker', 'profile-resolution-bootstrap.js'],
];
const FROM = '\tconst addon = createRequire(import.meta.url)("node-addon-require-builtin");';
const TO =
  '\tconst require = createRequire(import.meta.url);\n' +
  '\tconst exposed = process.execArgv.includes("--expose-internals");\n' +
  '\tconst addon = { requireBuiltin(id) {\n' +
  '\t\tif (exposed) try {\n' +
  '\t\t\treturn require(id);\n' +
  '\t\t} catch {}\n' +
  '\t\treturn require("node-addon-require-builtin").requireBuiltin(id);\n' +
  '\t} };';

module.exports = {
  description: 'dsh-app-boot: prefer --expose-internals over the require-builtin addon',
  apply(runtimeRoot) {
    const patched = [];
    for (const target of TARGETS) {
      const filePath = path.join(runtimeRoot, ...target);
      if (!fs.existsSync(filePath)) {
        throw new Error(`dsh-app-boot file is not installed at ${filePath}`);
      }
      const contents = fs.readFileSync(filePath, 'utf8');
      const sites = contents.split(FROM).length - 1;
      if (sites !== 1) {
        throw new Error(`${target.slice(PACKAGE_LIB.length).join('/')}: expected 1 internalModules() site, found ${sites}`);
      }
      fs.writeFileSync(filePath, contents.replace(FROM, TO));
      patched.push(target.slice(PACKAGE_LIB.length).join('/'));
    }
    return patched.join(', ');
  },
};
