'use strict';

const fs = require('fs');
const path = require('path');

const PLUGIN_IDS = ['openclaw-nim-channel', 'openclaw-netease-bee'];

function patchNimAndBee({ runtimeExtensionsDir, log }) {
  // Both pinned plugins only use emptyPluginConfigSchema from the removed
  // SDK root at runtime. plugin-entry also exports their OpenClawPluginApi type.
  // Patch after the cache copy so existing precompiled index.mjs files are
  // repaired as well as freshly prepared TypeScript packages.
  for (const pluginId of PLUGIN_IDS) {
    for (const entry of ['index.ts', 'index.mjs']) {
      const file = path.join(runtimeExtensionsDir, pluginId, entry);
      if (!fs.existsSync(file)) continue;
      const source = fs.readFileSync(file, 'utf8');
      const patched = source.replaceAll(
        'from "openclaw/plugin-sdk"',
        'from "openclaw/plugin-sdk/plugin-entry"',
      );
      if (patched !== source) {
        fs.writeFileSync(file, patched);
        log(`Patched ${pluginId}/${entry}: use public OpenClaw plugin-entry SDK`);
      }
    }
  }
}

module.exports = { patchNimAndBee };
