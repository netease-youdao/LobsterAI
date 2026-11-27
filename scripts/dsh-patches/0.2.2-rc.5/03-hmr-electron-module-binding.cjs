'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILE = 'node_modules/@deepseek-ai/dsh-hmr/lib/index.js';
const ORIGINAL = 'const realm = requireInternal("internal/bootstrap/realm");';
const FALLBACK = 'const realm = requireInternal("internal/bootstrap/realm")\n'
  + '\t\t?? (process.versions.electron && requireInternal("internal/test/binding"));';

module.exports = {
  description: 'dsh-hmr: resolve the module binding exposed by Electron',
  apply(runtimeRoot) {
    const file = path.join(runtimeRoot, FILE);
    const source = fs.readFileSync(file, 'utf8');
    if (source.includes(FALLBACK)) return 'already patched';
    if (source.split(ORIGINAL).length !== 2) {
      throw new Error(`Expected one HMR bootstrap realm lookup in ${FILE}`);
    }
    // Electron hides the bootstrap realm even with --expose-internals.
    // Its exposed binding module supplies the same internalBinding function.
    fs.writeFileSync(file, source.replace(ORIGINAL, FALLBACK));
    return 'patched HMR package-manifest invalidation';
  },
};
