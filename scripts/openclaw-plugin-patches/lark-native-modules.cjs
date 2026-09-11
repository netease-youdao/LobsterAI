'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readJsonFile } = require('./common.cjs');

const REVIEWED_LARK_VERSION = '2026.7.16';

// This published version mixes CommonJS exports with import.meta syntax. Keep
// both files in place so version/resource lookup and token storage stay intact.
function patchLarkNativeModules(pluginDir, log) {
  const pkg = readJsonFile(path.join(pluginDir, 'package.json'));
  if (pkg?.version !== REVIEWED_LARK_VERSION) return;
  const replacements = [
    {
      file: 'version.js',
      before: 'const __filename = (0, node_url_1.fileURLToPath)(import.meta.url);\n        const __dirname = (0, node_path_1.dirname)(__filename);',
      after: '// LobsterAI: use the installed CommonJS module directory.',
    },
    {
      file: 'token-store.js',
      before: '(0, node_module_1.createRequire)(typeof __filename !== \'undefined\' ? __filename : import.meta.url)',
      after: '(0, node_module_1.createRequire)(__filename)',
    },
  ];
  const edits = replacements.map(({ file, before, after }) => {
    const target = path.join(pluginDir, 'src', 'core', file);
    const source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
    if (source.includes(after) && !source.includes(before)) return null;
    if (source.split(before).length !== 2) {
      throw new Error(`[openclaw-lark] Unrecognized ${file} in ${REVIEWED_LARK_VERSION}; review native module compatibility.`);
    }
    return { target, source: source.replace(before, after), file };
  });
  for (const edit of edits.filter(Boolean)) {
    fs.writeFileSync(edit.target, edit.source);
    log(`Patched openclaw-lark/${edit.file}: native CommonJS loading`);
  }
}

module.exports = { patchLarkNativeModules };
