'use strict';

// Repairs third-party packages that publish TypeScript-only OpenClaw runtime entries.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const esbuild = require('esbuild');
const tar = require('tar');

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function normalizePackageRelativePath(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function assertInsideDirectory(parentDir, childPath) {
  const parent = path.resolve(parentDir);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside package directory: ${childPath}`);
  }
}

function buildNpmPackEnv() {
  return {
    ...process.env,
    npm_config_prefer_offline: '',
    npm_config_prefer_online: '',
    NPM_CONFIG_PREFER_OFFLINE: '',
    NPM_CONFIG_PREFER_ONLINE: '',
  };
}

function npmPackDirectory(sourceDir, outputDir) {
  const isWin = process.platform === 'win32';
  const npmBin = isWin ? 'npm.cmd' : 'npm';
  const args = ['pack', sourceDir, '--pack-destination', outputDir];

  const result = spawnSync(npmBin, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: outputDir,
    env: buildNpmPackEnv(),
    shell: isWin,
    timeout: 3 * 60 * 1000,
    windowsVerbatimArguments: isWin,
  });

  if (result.error) {
    throw new Error(`npm pack ${sourceDir} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(
      `npm pack ${sourceDir} exited with code ${result.status}` +
        (stderr ? `\n${stderr}` : ''),
    );
  }

  const tgzName = (result.stdout || '').trim().split('\n').pop();
  return path.join(outputDir, tgzName);
}

function isTypescriptRuntimeEntry(entry) {
  return typeof entry === 'string' && /\.tsx?$/i.test(entry);
}

function toMjsRuntimeEntry(entry) {
  return `./${normalizePackageRelativePath(entry).replace(/\.tsx?$/i, '.mjs')}`;
}

function ensureFileIncluded(pkg, relativePath) {
  const normalized = normalizePackageRelativePath(relativePath);
  if (!Array.isArray(pkg.files)) {
    return;
  }
  if (!pkg.files.some(entry => normalizePackageRelativePath(entry) === normalized)) {
    pkg.files.push(normalized);
  }
}

function assertExpectedPackageName(pkg, expectedPackageNames) {
  if (!Array.isArray(expectedPackageNames) || expectedPackageNames.length === 0) {
    return;
  }
  if (!expectedPackageNames.includes(pkg.name)) {
    throw new Error(`Expected ${expectedPackageNames.join(' or ')}, got ${pkg.name || 'unnamed package'}`);
  }
}

function patchTypeScriptPluginPackageDirectory(packageDir, opts = {}) {
  const log = opts.log || (() => {});
  const packageJsonPath = path.join(packageDir, 'package.json');
  const pkg = readJsonFile(packageJsonPath);
  const packageLabel = opts.packageLabel || pkg.name || 'OpenClaw plugin';

  assertExpectedPackageName(pkg, opts.expectedPackageNames);

  const extensions = pkg.openclaw?.extensions;
  if (!Array.isArray(extensions)) {
    return { changed: false, compiledEntries: [] };
  }

  const compiledEntries = [];
  const nextExtensions = extensions.map(entry => {
    if (!isTypescriptRuntimeEntry(entry)) {
      return entry;
    }

    const entryRelativePath = normalizePackageRelativePath(entry);
    const outputEntry = toMjsRuntimeEntry(entry);
    const outputRelativePath = normalizePackageRelativePath(outputEntry);
    const entryPath = path.join(packageDir, entryRelativePath);
    const outputPath = path.join(packageDir, outputRelativePath);

    assertInsideDirectory(packageDir, entryPath);
    assertInsideDirectory(packageDir, outputPath);

    if (!fs.existsSync(entryPath)) {
      throw new Error(`${packageLabel} TypeScript runtime entry is missing: ${entry}`);
    }

    esbuild.buildSync({
      entryPoints: [entryPath],
      outfile: outputPath,
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      target: 'node20',
      sourcemap: false,
      logLevel: 'silent',
    });

    ensureFileIncluded(pkg, outputRelativePath);
    compiledEntries.push(outputEntry);
    return outputEntry;
  });

  if (compiledEntries.length === 0) {
    return { changed: false, compiledEntries: [] };
  }

  pkg.openclaw.extensions = nextExtensions;
  if (!pkg.main || isTypescriptRuntimeEntry(pkg.main)) {
    pkg.main = compiledEntries[0];
  }
  writeJsonFile(packageJsonPath, pkg);

  log(`  Prepared ${packageLabel} runtime entry: ${compiledEntries.join(', ')}`);
  return { changed: true, compiledEntries };
}

function prepareTypeScriptPluginPackage(inputTgzPath, outputDir, opts = {}) {
  const packageLabel = opts.packageLabel || 'OpenClaw plugin';
  if (!fs.existsSync(inputTgzPath)) {
    throw new Error(`${packageLabel} package tarball not found: ${inputTgzPath}`);
  }

  const sourceDir = fs.mkdtempSync(path.join(outputDir, 'openclaw-plugin-source-'));
  tar.x({
    file: inputTgzPath,
    cwd: sourceDir,
    strip: 1,
    sync: true,
  });

  const result = patchTypeScriptPluginPackageDirectory(sourceDir, opts);
  if (!result.changed) {
    return inputTgzPath;
  }

  const patchedPackDir = fs.mkdtempSync(path.join(outputDir, 'openclaw-plugin-patched-'));
  return npmPackDirectory(sourceDir, patchedPackDir);
}

module.exports = {
  patchTypeScriptPluginPackageDirectory,
  prepareTypeScriptPluginPackage,
};
