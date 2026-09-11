'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOTS = [
  { relative: 'dist/extensions', origin: 'bundled' },
  { relative: 'third-party-extensions', origin: 'config' },
];
const ENTRY_KIND = { Runtime: 'runtime', Setup: 'setup' };
const INDEX_ENTRIES = ['index.ts', 'index.js', 'index.mjs', 'index.cjs'];

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
    return value;
  } catch (error) {
    throw new Error(`Invalid plugin metadata ${file}: ${error.message}`);
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

// Validate source declarations as well as selected output, including missing
// paths whose existing parent is a symlink. Packaged manifests stay relocatable.
function resolvePluginFile(pluginDir, entry, { required = true } = {}) {
  if (typeof entry !== 'string' || !entry.trim() || entry.includes('\0')
    || path.posix.isAbsolute(entry) || path.win32.isAbsolute(entry) || /^[a-z][a-z\d+.-]*:/i.test(entry)) {
    throw new Error(`Invalid relative plugin entry in ${pluginDir}: ${String(entry)}`);
  }
  const absolute = path.resolve(pluginDir, entry.replace(/\\/g, '/'));
  const root = fs.realpathSync(pluginDir);
  if (!isInside(pluginDir, absolute)) throw new Error(`Plugin entry escapes plugin directory: ${entry} (${pluginDir})`);
  let existingParent = absolute;
  while (!fs.existsSync(existingParent) && existingParent !== path.dirname(existingParent)) {
    existingParent = path.dirname(existingParent);
  }
  if (!isInside(root, fs.realpathSync(existingParent))) {
    throw new Error(`Plugin entry escapes plugin directory: ${entry} (${pluginDir})`);
  }
  if (!fs.existsSync(absolute)) {
    if (required) throw new Error(`Plugin entry not found: ${entry} (${pluginDir})`);
    return null;
  }
  if (!fs.statSync(absolute).isFile()) throw new Error(`Plugin entry is not a file: ${entry} (${pluginDir})`);
  fs.accessSync(absolute, fs.constants.R_OK);
  return absolute;
}

// Keep this ordering aligned with OpenClaw v2026.8.1 package-entrypoints.ts.
function listBuiltRuntimeEntryCandidates(entry) {
  if (!/\.(?:ts|mts|cts)$/i.test(entry)) return [];
  const normalized = entry.replace(/\\/g, '/').replace(/^\.\//, '');
  const stem = normalized.replace(/\.[^.]+$/, '');
  const dist = `./dist/${stem.startsWith('src/') ? stem.slice(4) : stem}`;
  return [...new Set([dist, `./${stem}`].flatMap(base => ['.js', '.mjs', '.cjs'].map(ext => `${base}${ext}`)))];
}

function stringList(value, field, pluginDir) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`package.json openclaw.${field} must be an array (${pluginDir})`);
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`package.json openclaw.${field}[${index}] must be a non-empty string (${pluginDir})`);
    }
    return entry.trim();
  });
}

function optionalEntry(value, field, pluginDir) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`package.json openclaw.${field} must be a non-empty string (${pluginDir})`);
  }
  return value.trim();
}

function resolveEntry(plugin, entry, runtimeEntry) {
  const original = resolvePluginFile(plugin.pluginDir, entry, { required: false });
  if (runtimeEntry) return resolvePluginFile(plugin.pluginDir, runtimeEntry);
  // Bundled sources do not infer dist/ output; config-origin packages do.
  if (plugin.origin === 'config') {
    for (const candidate of listBuiltRuntimeEntryCandidates(entry)) {
      const built = resolvePluginFile(plugin.pluginDir, candidate, { required: false });
      if (built) return built;
    }
  }
  if (original) return original;
  // Trusted bundled trees may have their source replaced by adjacent built JS.
  if (plugin.origin === 'bundled' && /\.(?:ts|mts|cts)$/i.test(entry)) {
    const adjacent = resolvePluginFile(plugin.pluginDir, entry.replace(/\.[^.]+$/, '.js'), { required: false });
    if (adjacent) return adjacent;
  }
  throw new Error(`Plugin entry not found: ${entry} (${plugin.pluginDir})`);
}

function packageId(pkg, manifest, fallback) {
  const declared = manifest?.id ?? pkg?.openclaw?.plugin?.id;
  if (typeof declared === 'string' && declared.trim()) return declared.trim();
  const unscoped = typeof pkg?.name === 'string' ? pkg.name.split('/').pop() : '';
  return unscoped ? unscoped.replace(/-(?:provider|plugin)$/, '') : fallback;
}

function collectPluginPackages(runtimeRoot) {
  const plugins = [];
  for (const { relative, origin } of PLUGIN_ROOTS) {
    const directory = path.resolve(runtimeRoot, relative);
    if (!fs.existsSync(directory)) continue;
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!item.isDirectory()) continue;
      const pluginDir = path.join(directory, item.name);
      const packagePath = path.join(pluginDir, 'package.json');
      const manifestPath = path.join(pluginDir, 'openclaw.plugin.json');
      const pkg = fs.existsSync(packagePath) ? readJson(packagePath) : null;
      const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : null;
      // Ignore helper packages such as image-generation-core and dependency trees.
      if (!manifest && !pkg?.openclaw) continue;
      const metadata = pkg?.openclaw ?? {};
      if (typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error(`package.json openclaw must be an object (${pluginDir})`);
      }
      let extensions = stringList(metadata.extensions, 'extensions', pluginDir);
      if (Array.isArray(metadata.extensions) && extensions.length === 0) {
        throw new Error(`package.json openclaw.extensions is empty (${pluginDir})`);
      }
      const hasPackageExtensions = extensions.length > 0;
      if (extensions.length === 0) {
        const conventional = INDEX_ENTRIES.find(entry => fs.existsSync(path.join(pluginDir, entry)));
        if (!conventional) throw new Error(`Plugin entry not found in ${pluginDir}`);
        extensions = [`./${conventional}`];
      }
      const runtimeExtensions = stringList(metadata.runtimeExtensions, 'runtimeExtensions', pluginDir);
      if (runtimeExtensions.length && runtimeExtensions.length !== extensions.length) {
        throw new Error(`package.json openclaw.runtimeExtensions length (${runtimeExtensions.length}) must match openclaw.extensions length (${extensions.length}) (${pluginDir})`);
      }
      const setup = optionalEntry(metadata.setupEntry, 'setupEntry', pluginDir);
      const runtimeSetup = optionalEntry(metadata.runtimeSetupEntry, 'runtimeSetupEntry', pluginDir);
      if (runtimeSetup && !setup) throw new Error(`package.json openclaw.runtimeSetupEntry requires openclaw.setupEntry (${pluginDir})`);
      const plugin = { id: packageId(pkg, manifest, item.name), pluginDir, origin, pkg, packagePath, entries: [] };
      const ids = new Set();
      for (const [index, entry] of extensions.entries()) {
        const runtimeEntry = runtimeExtensions[index];
        // Discovery's convention path picks the first index candidate directly;
        // config-origin build inference only applies to package declarations.
        const source = hasPackageExtensions
          ? resolveEntry(plugin, entry, runtimeEntry)
          : resolvePluginFile(pluginDir, entry);
        const id = extensions.length > 1 ? `${plugin.id}/${path.basename(source, path.extname(source))}` : plugin.id;
        if (ids.has(id)) throw new Error(`Plugin package entries collide on derived id "${id}" (${pluginDir})`);
        ids.add(id);
        plugin.entries.push({ id, kind: ENTRY_KIND.Runtime, index, entry, runtimeEntry, source });
      }
      if (setup) {
        plugin.entries.push({ id: plugin.id, kind: ENTRY_KIND.Setup, index: 0, entry: setup, runtimeEntry: runtimeSetup, source: resolveEntry(plugin, setup, runtimeSetup) });
      }
      plugins.push(plugin);
    }
  }
  return plugins;
}

/** Read-only entry inventory for the packaged runtime's native-load smoke gate. */
function collectPluginRuntimeEntries(runtimeRoot) {
  return collectPluginPackages(runtimeRoot).flatMap(plugin => plugin.entries.map(entry => ({
    id: entry.id,
    pluginDir: plugin.pluginDir,
    source: entry.source,
    kind: entry.kind,
    origin: plugin.origin,
  })));
}

module.exports = {
  ENTRY_KIND,
  collectPluginPackages,
  collectPluginRuntimeEntries,
  listBuiltRuntimeEntryCandidates,
  resolvePluginFile,
};
