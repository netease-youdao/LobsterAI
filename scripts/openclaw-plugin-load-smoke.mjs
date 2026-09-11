// Executed only by the build verifier, in an isolated Electron Node process.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, flushCompileCache } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ENTRY_KIND } from './openclaw-plugin-entries.cjs';

const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { runtimeRoot, entries, resultPath, stateDir } = request;
process.argv[1] = path.join(runtimeRoot, 'openclaw.mjs');
const requirePlugin = createRequire(path.join(runtimeRoot, 'package.json'));
const started = performance.now();
const results = [];
// Exercise configuration-required local plugins without using real accounts or
// relaxing their schema. No model request is made by discovery registration.
const pluginConfigFixtures = {
  'lobsterai-model-compat': { modelProfiles: { 'native-load-probe/kimi-k3': 'moonshot-kimi-k3' } },
};
let failure;
try {
  // This is an upstream stable build-smoke facade, not a hashed chunk name or
  // a second loader bundled from source. Exercise the actual shipped loader.
  console.debug('[openclaw-plugin-load] Importing the shipped registry facade');
  const { loadPluginRegistryHandle, getPluginModuleLoaderStats } = await import(
    pathToFileURL(path.join(runtimeRoot, 'dist/plugins/build-smoke-entry.js')).href
  );
  const before = getPluginModuleLoaderStats();
  for (const entry of entries) {
    console.debug(`[openclaw-plugin-load] Importing ${entry.id} (${entry.kind})`);
    const start = performance.now();
    const loaded = requirePlugin(entry.source);
    const plugin = loaded.default ?? loaded.plugin ?? loaded;
    if (entry.kind === ENTRY_KIND.Runtime && typeof plugin.loadChannelPlugin === 'function') {
      // Import success alone misses bundled channels' deferred entry/asset paths.
      await plugin.loadChannelPlugin();
    }
    if (entry.kind === ENTRY_KIND.Setup && typeof plugin.loadSetupPlugin === 'function') {
      await plugin.loadSetupPlugin();
    }
    results.push({ id: entry.id, kind: entry.kind,
      source: path.relative(runtimeRoot, entry.source).split(path.sep).join('/'),
      importMs: performance.now() - start });
  }
  const ids = [...new Set(entries.filter(entry => entry.kind === ENTRY_KIND.Runtime).map(entry => entry.id))];
  const config = { plugins: { enabled: true, allow: ids,
    entries: Object.fromEntries(ids.map(id => [id, { enabled: true,
      ...(pluginConfigFixtures[id] ? { config: pluginConfigFixtures[id] } : {}),
    }])),
    load: { paths: [...new Set(entries.filter(entry => entry.origin === 'config').map(entry => entry.pluginDir))] },
  } };
  fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
  console.debug('[openclaw-plugin-load] Loading the discovery registry');
  const registry = loadPluginRegistryHandle({ config, cache: false,
    workspaceDir: path.join(stateDir, 'workspace'), env: process.env,
    channelPluginLoadIntent: 'full', preferBuiltPluginArtifacts: true,
    onlyPluginIds: ids, logger: { info() {}, warn() {}, debug() {}, error: message => console.error(message) },
  });
  const bad = registry.plugins.filter(plugin => plugin.status === 'error');
  const missing = ids.filter(id => !registry.plugins.some(plugin => plugin.id === id));
  if (bad.length || missing.length) {
    throw new Error(`Plugin registry failed: ${bad.map(plugin => `${plugin.id}: ${plugin.error}`).concat(missing.map(id => `${id}: missing`)).join('; ')}`);
  }
  const after = getPluginModuleLoaderStats();
  const counters = Object.fromEntries(['calls', 'nativeHits', 'nativeMisses', 'sourceTransformForced', 'sourceTransformFallbacks']
    .map(key => [key, after[key] - before[key]]));
  if (counters.nativeMisses || counters.sourceTransformForced || counters.sourceTransformFallbacks
    || (ids.length > 0 && counters.nativeHits === 0)) {
    throw new Error(`Packaged plugin loader did not stay native: ${JSON.stringify(counters)}`);
  }
  fs.writeFileSync(resultPath, JSON.stringify({ versions: { node: process.versions.node, electron: process.versions.electron },
    registrationMode: 'discovery', channelPluginLoadIntent: 'full',
    totalMs: performance.now() - started, entries: results, counters,
    registry: registry.plugins.map(plugin => ({ id: plugin.id, status: plugin.status })),
  }, null, 2));
} catch (error) {
  failure = error;
} finally {
  flushCompileCache();
}
if (failure) console.error('[openclaw-plugin-load] FAILED:', failure);
process.exit(failure ? 1 : 0);
