'use strict';

/**
 * Prepare declared TypeScript plugin entries before packaging. Published JS
 * outputs keep their layout; source declarations remain available for rebuilds.
 * Usage: node scripts/precompile-openclaw-extensions.cjs [runtime-dir]
 */
const fs = require('node:fs');
const path = require('node:path');
const {
  ENTRY_KIND,
  collectPluginPackages,
  collectPluginRuntimeEntries,
  resolvePluginFile,
} = require('./openclaw-plugin-entries.cjs');

const rootDir = path.resolve(__dirname, '..');
const PRECOMPILE_INFO = 'openclaw-precompile-info.json';
const PRECOMPILE_VERSION = 1;
const SDK_EXTERNALS = ['openclaw/plugin-sdk', 'openclaw/plugin-sdk/*', 'clawdbot/plugin-sdk', 'clawdbot/plugin-sdk/*'];
const FORMAT = { Esm: 'esm', CommonJs: 'cjs' };
const PACKAGE_TYPE = { Esm: 'module', CommonJs: 'commonjs' };
const isTypeScript = entry => /\.(?:[cm]?ts|tsx)$/i.test(entry);
const relativeEntry = (pluginDir, source) => `./${path.relative(pluginDir, source).replace(/\\/g, '/')}`;

function writeIfChanged(file, content) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function sourceFormat(source) {
  if (/\.mts$/i.test(source)) return FORMAT.Esm;
  if (/\.cts$/i.test(source)) return FORMAT.CommonJs;
  let directory = path.dirname(source);
  while (true) {
    const packagePath = path.join(directory, 'package.json');
    if (fs.existsSync(packagePath)) {
      return JSON.parse(fs.readFileSync(packagePath, 'utf8')).type === PACKAGE_TYPE.Esm ? FORMAT.Esm : FORMAT.CommonJs;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return FORMAT.CommonJs;
    directory = parent;
  }
}

function readProvenance(pluginDir) {
  const file = path.join(pluginDir, PRECOMPILE_INFO);
  if (!fs.existsSync(file)) return [];
  const info = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (info.version !== PRECOMPILE_VERSION || !Array.isArray(info.entries)) {
    throw new Error(`Unsupported plugin precompile metadata: ${file}; resync this plugin before rebuilding`);
  }
  return info.entries;
}

function ownedLocalPluginNames() {
  const directory = path.join(rootDir, 'openclaw-extensions');
  return new Set(fs.existsSync(directory)
    ? fs.readdirSync(directory, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name)
    : []);
}

async function precompileOpenClawExtensions(runtimeRoot, { log = console.log } = {}) {
  const started = Date.now();
  const plugins = collectPluginPackages(path.resolve(runtimeRoot));
  const localPlugins = ownedLocalPluginNames();
  let compiled = 0;
  let preserved = 0;
  let esbuild;
  for (const plugin of plugins) {
    const previous = readProvenance(plugin.pluginDir);
    const ownedLocal = plugin.origin === 'config' && localPlugins.has(path.basename(plugin.pluginDir));
    const plans = [];
    for (const entry of plugin.entries) {
      const prior = previous.find(item => item.kind === entry.kind && item.index === entry.index
        && item.entry === entry.entry && item.output === entry.runtimeEntry);
      let source = entry.source;
      if (ownedLocal && isTypeScript(entry.entry)) {
        source = resolvePluginFile(plugin.pluginDir, entry.entry);
      } else if (prior) {
        source = resolvePluginFile(plugin.pluginDir, prior.source);
      }
      if (!isTypeScript(source)) {
        preserved++;
        continue;
      }
      const format = sourceFormat(source);
      // Development startup recopies each local source package.json, removing
      // runtime overrides. Keep .ts output at the adjacent .js path preferred
      // by upstream inference, replacing the old precompiler's stale artifact.
      // The copied package type supplies its ESM/CJS mode; explicit .mts/.cts
      // entries and publisher layouts retain their format-specific outputs.
      const outputExtension = ownedLocal && /\.ts$/i.test(source)
        ? '.js' : format === FORMAT.Esm ? '.mjs' : '.cjs';
      const output = source.replace(/\.(?:[cm]?ts|tsx)$/i, outputExtension);
      const outputRel = relativeEntry(plugin.pluginDir, output);
      resolvePluginFile(plugin.pluginDir, outputRel, { required: false });
      plans.push({ ...entry, source, output, outputRel, format });
    }
    if (plans.length === 0) continue;
    esbuild ??= require('esbuild');
    // Build every entry before changing metadata or outputs for this package.
    const generated = new Map();
    try {
      for (const plan of plans) {
        if (generated.has(plan.output)) {
          const existing = generated.get(plan.output);
          if (existing.source !== plan.source) throw new Error(`Compiled plugin entries collide at ${plan.outputRel}`);
          continue;
        }
        const result = await esbuild.build({
          entryPoints: [plan.source],
          outfile: plan.output,
          bundle: true,
          platform: 'node',
          format: plan.format,
          target: 'node24',
          write: false,
          // Local extensions use LobsterAI's build dependencies even when an
          // isolated runtime is prepared outside the repository's vendor tree.
          ...(ownedLocal ? { nodePaths: [path.join(rootDir, 'node_modules')] } : {}),
          ...(fs.existsSync(path.join(plugin.pluginDir, 'node_modules')) ? { packages: 'external' } : {}),
          external: SDK_EXTERNALS,
          plugins: [{
            name: 'externalize-openclaw-internals',
            setup(build) {
              build.onResolve({ filter: /^\.\.\/.*\/src\// }, args => ({ path: args.path, external: true }));
            },
          }],
          logLevel: 'silent',
          // Dropping import.meta in a CommonJS output would change file lookup.
          logOverride: { 'empty-import-meta': 'error' },
        });
        generated.set(plan.output, { source: plan.source, text: result.outputFiles[0].text });
      }
    } catch (error) {
      throw new Error(`Failed to precompile plugin ${plugin.id}: ${error.message}`);
    }

    // A generated package boundary must retain the previously inherited module
    // mode, otherwise the next build would reinterpret a package-less .ts file.
    const pkg = plugin.pkg ?? { private: true, type: plans[0].format === FORMAT.Esm ? PACKAGE_TYPE.Esm : PACKAGE_TYPE.CommonJs };
    pkg.openclaw = { ...pkg.openclaw };
    const runtimeEntries = plugin.entries.filter(entry => entry.kind === ENTRY_KIND.Runtime);
    pkg.openclaw.extensions ??= runtimeEntries.map(entry => entry.entry);
    const runtimePlans = plans.filter(plan => plan.kind === ENTRY_KIND.Runtime);
    if (runtimePlans.length) {
      pkg.openclaw.runtimeExtensions = runtimeEntries.map(entry => {
        const plan = runtimePlans.find(item => item.index === entry.index);
        return plan ? plan.outputRel : relativeEntry(plugin.pluginDir, entry.source);
      });
    }
    const setupPlan = plans.find(plan => plan.kind === ENTRY_KIND.Setup);
    if (setupPlan) pkg.openclaw.runtimeSetupEntry = setupPlan.outputRel;

    for (const [output, result] of generated) writeIfChanged(output, result.text);
    writeIfChanged(plugin.packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    writeIfChanged(path.join(plugin.pluginDir, PRECOMPILE_INFO), `${JSON.stringify({
      version: PRECOMPILE_VERSION,
      entries: plans.map(plan => ({
        kind: plan.kind, index: plan.index, entry: plan.entry,
        source: relativeEntry(plugin.pluginDir, plan.source), output: plan.outputRel,
      })),
    }, null, 2)}\n`);
    compiled += generated.size;
  }
  const entries = collectPluginRuntimeEntries(runtimeRoot);
  const remaining = entries.filter(entry => isTypeScript(entry.source));
  if (remaining.length) throw new Error(`Uncompiled plugin runtime entries: ${remaining.map(entry => entry.source).join(', ')}`);
  log(`[precompile-extensions] Done in ${Date.now() - started}ms: ${compiled} compiled, ${preserved} preserved, ${entries.length} runtime/setup entries validated`);
  return { compiled, preserved, entries };
}

if (require.main === module) {
  const runtimeRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.join(rootDir, 'vendor/openclaw-runtime/current');
  precompileOpenClawExtensions(runtimeRoot).catch(error => {
    console.error(`[precompile-extensions] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { precompileOpenClawExtensions };
