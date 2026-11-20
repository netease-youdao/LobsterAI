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
// If a newer upstream release already probes `--expose-internals` natively,
// this patch leaves the file untouched; otherwise it patches both sites.

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
    const upstreamSupported = [];
    for (const target of TARGETS) {
      const filePath = path.join(runtimeRoot, ...target);
      if (!fs.existsSync(filePath)) {
        throw new Error(`dsh-app-boot file is not installed at ${filePath}`);
      }
      const contents = fs.readFileSync(filePath, 'utf8');
      const rel = target.slice(PACKAGE_LIB.length).join('/');
      if (contents.includes('--expose-internals')) {
        upstreamSupported.push(rel);
        continue;
      }
      const sites = contents.split(FROM).length - 1;
      if (sites !== 1) {
        throw new Error(`${rel}: expected 1 internalModules() site, found ${sites}`);
      }
      fs.writeFileSync(filePath, contents.replace(FROM, TO));
      patched.push(rel);
    }
    const parts = [];
    if (patched.length > 0) parts.push(`patched ${patched.join(', ')}`);
    if (upstreamSupported.length > 0) parts.push(`upstream already supports --expose-internals in ${upstreamSupported.join(', ')}`);
    return parts.join('; ');
  },
};
