'use strict';

// Junction-safe recursive removal, for tearing down a DSH_HOME.
//
// dsh materialises its profile as links into the runtime install
// (`<DSH_HOME>/profiles/**` -> `<runtime>/node_modules/<pkg>`, `<runtime>/config`),
// and on Windows those links are directory *junctions*. Electron's Node
// Electron's embedded Node runtime walks straight through a junction in
// `fs.rmSync(dir, { recursive: true })` and deletes the runtime's own files —
// which leaves a runtime that still boots but has lost, say, the directory
// picker's dialog worker. Plain Node 24.19 does not follow them, so the same
// script is destructive or harmless depending on which binary runs it.
//
// Removing a link means removing the link, never what it points at, so walk the
// tree ourselves and stop at every reparse point.

const fs = require('fs');
const path = require('path');

/**
 * Delete `target` recursively without ever descending into a symlink or
 * junction. Missing paths are ignored, mirroring `{ force: true }`.
 */
function removeTree(target) {
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const isLink = stats.isSymbolicLink();
  if (isLink || !stats.isDirectory()) {
    try {
      // Electron's rmSync rejects read-only Git objects on Windows. Unlinking
      // just this entry preserves the permissions of any other hard links.
      fs.unlinkSync(target);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      if (!isLink || process.platform !== 'win32') throw error;
      fs.rmdirSync(target); // Some Windows junctions require rmdir.
    }
    return;
  }
  for (const entry of fs.readdirSync(target)) {
    removeTree(path.join(target, entry));
  }
  fs.rmdirSync(target);
}

module.exports = { removeTree };
