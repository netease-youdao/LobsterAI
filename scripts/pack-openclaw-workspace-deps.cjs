'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const WORKSPACE_PROTOCOL = 'workspace:';
const ARCHIVE_DIR = 'workspace-packages';
const RUNTIME_DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies'];

function readPackage(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
}

function packOpenClawWorkspaceDependencies(sourceRoot, runtimeRoot) {
  const sourcePackage = readPackage(sourceRoot);
  const runtimePackage = readPackage(runtimeRoot);
  const npmCli = path.join(path.dirname(require.resolve('npm/package.json')), 'bin', 'npm-cli.js');
  const archiveRoot = path.join(runtimeRoot, ARCHIVE_DIR);
  const archives = new Map();

  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(sourcePackage[field] || {})) {
      if (!spec.startsWith(WORKSPACE_PROTOCOL)) continue;

      if (!archives.has(name)) {
        // pnpm has already installed the source workspace. Follow its link so
        // package names do not have to match directory names under packages/.
        const packageRoot = fs.realpathSync(path.join(sourceRoot, 'node_modules', name));
        const localPackage = readPackage(packageRoot);
        if (localPackage.name !== name) {
          throw new Error(`Workspace dependency ${name} resolves to ${localPackage.name}`);
        }
        if (!localPackage.main || !fs.existsSync(path.join(packageRoot, localPackage.main))) {
          throw new Error(`Workspace dependency ${name} is not built; run the OpenClaw build first`);
        }
        // npm pack preserves workspace: specs. Dev dependencies are harmless
        // with --omit=dev, but a new runtime workspace edge needs its own
        // archive resolution before we can ship it.
        for (const dependencyField of RUNTIME_DEPENDENCY_FIELDS) {
          for (const [dependency, version] of Object.entries(localPackage[dependencyField] || {})) {
            if (version.startsWith(WORKSPACE_PROTOCOL)) {
              throw new Error(`Workspace dependency ${name} has an unresolved runtime dependency: ${dependency}`);
            }
          }
        }

        fs.mkdirSync(archiveRoot, { recursive: true });
        // Use npm's JS entry directly to preserve paths with spaces on Windows.
        // Only publishable files are packed; source node_modules and links are
        // excluded. Lifecycle scripts must not rebuild or modify the checkout.
        const output = execFileSync(process.execPath, [
          npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', archiveRoot,
        ], {
          cwd: packageRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
        });
        const [packed] = JSON.parse(output);
        if (!packed?.filename || !fs.existsSync(path.join(archiveRoot, packed.filename))) {
          throw new Error(`No archive produced for workspace dependency ${name}`);
        }
        archives.set(name, `file:${ARCHIVE_DIR}/${packed.filename}`);
      }

      runtimePackage[field] = { ...runtimePackage[field], [name]: archives.get(name) };
    }
  }

  if (archives.size > 0) {
    // Keep the tarballs and relative specs in the runtime. Later npm installs
    // (including channel dependencies) must preserve these patched packages.
    fs.writeFileSync(path.join(runtimeRoot, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`);
  }
  return [...archives.keys()];
}

if (require.main === module) {
  const [sourceRoot, runtimeRoot] = process.argv.slice(2);
  if (!sourceRoot || !runtimeRoot) {
    console.error('Usage: node scripts/pack-openclaw-workspace-deps.cjs <openclaw-source> <runtime-root>');
    process.exitCode = 1;
  } else {
    try {
      const names = packOpenClawWorkspaceDependencies(path.resolve(sourceRoot), path.resolve(runtimeRoot));
      console.log(`[openclaw-runtime] Packed ${names.length} local workspace dependency package(s): ${names.join(', ')}`);
    } catch (error) {
      console.error('[openclaw-runtime] Failed to pack local workspace dependencies:', error);
      process.exitCode = 1;
    }
  }
}

module.exports = { packOpenClawWorkspaceDependencies };
