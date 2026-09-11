'use strict';

const fs = require('fs');
const path = require('path');
const { createOpenClawRuntimePayload, OpenClawPayloadTarget } = require('./openclaw-runtime-payload.cjs');

/** Trim only electron-builder's copied runtime, before codesigning the app. */
function pruneOpenClawMacPayload(appPath, targetId) {
  if (![OpenClawPayloadTarget.MacArm64, OpenClawPayloadTarget.MacX64].includes(targetId)) {
    throw new Error(`[openclaw-mac-payload] Unsupported macOS packaging target: ${targetId}.`);
  }
  const root = path.join(fs.realpathSync(appPath), 'Contents', 'Resources', 'cfmind');
  if (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== root) {
    throw new Error('[openclaw-mac-payload] Packaged runtime must be a directory inside the app, not a link to the build cache.');
  }

  // Validate the entire payload and manifest before removing anything. Checking
  // the app copy also catches files omitted by extraResources filters.
  const { filter, overrides = {} } = createOpenClawRuntimePayload(root, targetId);
  const removals = [];
  const stats = { filesRemoved: 0, bytesFreed: 0 };
  function walk(dir, excluded = false) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const remove = excluded || !filter(path.relative(root, file));
      if (remove && !excluded) removals.push(file);
      // Do not follow dependency links back into a runtime cache.
      if (entry.isDirectory()) walk(file, remove);
      else if (remove) {
        stats.filesRemoved++;
        stats.bytesFreed += fs.lstatSync(file).size;
      }
    }
  }
  walk(root);

  const replacements = Object.entries(overrides).map(([relative, content]) => {
    const file = path.join(root, relative);
    if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file) {
      throw new Error(`[openclaw-mac-payload] Payload override must be a regular file inside the app: ${relative}.`);
    }
    return { file, content };
  });
  for (const file of removals) fs.rmSync(file, { recursive: true, force: true });
  for (const { file, content } of replacements) {
    const original = fs.statSync(file);
    // electron-builder can hard-link extraResources on CI. Replacing the inode
    // keeps the build cache's manifest intact even in that mode.
    const stage = fs.mkdtempSync(path.join(path.dirname(file), '.lobsterai-payload-'));
    try {
      const replacement = path.join(stage, path.basename(file));
      fs.writeFileSync(replacement, content, { mode: original.mode & 0o777 });
      fs.renameSync(replacement, file);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
    stats.bytesFreed += original.size - Buffer.byteLength(content);
  }
  console.log(`[openclaw-mac-payload] ${targetId}: removed ${stats.filesRemoved} files, saved ${stats.bytesFreed} bytes (${(stats.bytesFreed / 1024 / 1024).toFixed(1)} MiB) from the packaged runtime.`);
  return stats;
}

module.exports = { pruneOpenClawMacPayload };
