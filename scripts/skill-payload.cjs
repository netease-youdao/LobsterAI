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
 * `npm ci --omit=dev`; Windows filters dev-only packages out of `win.extraResources`.
 * Returns paths relative to the SKILLs root, e.g. web-search/node_modules/typescript.
 */
function listSkillDevOnlyPackages(skillsRoot) {
  if (!fs.existsSync(skillsRoot)) return [];
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

/** Glob exclusions relative to SKILLs/ for electron-builder extraResources filters. */
function createSkillsExtraResourceExclusions(skillsRoot) {
  return listSkillDevOnlyPackages(skillsRoot).flatMap(pkg => [`!${pkg}`, `!${pkg}/**`]);
}

/**
 * Append dev-only package exclusions to the Windows `SKILLs` extraResources
 * entry so `electron-builder` copies skill runtime code without developer
 * dependencies like `typescript` or `@types/*`.
 */
function configureWindowsSkillsPayload(context, skillsRoot) {
  const options = context?.packager?.platformSpecificBuildOptions;
  if (!options || !Array.isArray(options.extraResources)) return;
  const exclusions = createSkillsExtraResourceExclusions(skillsRoot);
  if (exclusions.length === 0) return;

  let updated = false;
  options.extraResources = options.extraResources.map(resource => {
    if (!resource || typeof resource !== 'object' || resource.to !== 'SKILLs') {
      return resource;
    }
    updated = true;
    const baseFilter = Array.isArray(resource.filter)
      ? [...resource.filter]
      : resource.filter
        ? [resource.filter]
        : ['**/*'];
    for (const pattern of exclusions) {
      if (!baseFilter.includes(pattern)) baseFilter.push(pattern);
    }
    return { ...resource, filter: baseFilter };
  });
  if (!updated) {
    throw new Error('[skill-payload] Missing Windows SKILLs extraResources mapping');
  }
}

/** Filter predicate for paths relative to the SKILLs root. */
function createSkillsPayloadFilter(skillsRoot) {
  const excluded = listSkillDevOnlyPackages(skillsRoot);
  return filePath => {
    const relative = filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    return !excluded.some(prefix => relative === prefix || relative.startsWith(`${prefix}/`));
  };
}

module.exports = {
  configureWindowsSkillsPayload,
  createSkillsExtraResourceExclusions,
  createSkillsPayloadFilter,
  listSkillDevOnlyPackages,
};
