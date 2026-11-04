'use strict';

const fs = require('fs');
const path = require('path');

// npm writes the hidden lockfile on every install, so it covers skills whose
// package-lock.json was never generated. Both record the same `dev` flags.
const LOCKFILES = ['package-lock.json', path.join('node_modules', '.package-lock.json')];

function readLockPackages(skillDir) {
  for (const relative of LOCKFILES) {
    const file = path.join(skillDir, relative);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).packages || {};
  }
  return {};
}

/**
 * Bundled skills ship prebuilt code (skillServices never runs `tsc` in a
 * packaged app), so packages that a skill's lockfile marks dev-only, such as
 * typescript and @types/*, are never loaded. macOS installs skills with
 * `npm ci --omit=dev`; the Windows tar packs the developer node_modules.
 * Returns paths relative to the SKILLs root, e.g. web-search/node_modules/typescript.
 */
function listSkillDevOnlyPackages(skillsRoot) {
  const result = [];
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const [relative, info] of Object.entries(readLockPackages(path.join(skillsRoot, entry.name)))) {
      // devOptional packages are also reachable from production dependencies.
      if (relative && info.dev === true) result.push(`${entry.name}/${relative}`);
    }
  }
  return result.sort();
}

/** Windows tar filter for paths relative to the SKILLs root. */
function createSkillsPayloadFilter(skillsRoot) {
  const excluded = listSkillDevOnlyPackages(skillsRoot);
  return filePath => {
    const relative = filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    return !excluded.some(prefix => relative === prefix || relative.startsWith(`${prefix}/`));
  };
}

module.exports = { createSkillsPayloadFilter, listSkillDevOnlyPackages };
