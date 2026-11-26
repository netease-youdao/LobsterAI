'use strict';

/**
 * pack-dsh-win-resources.cjs
 *
 * Packs large resource directories into a single .tar archive for Windows NSIS
 * distribution. NSIS extracts thousands of small files slowly on NTFS; shipping
 * one tar archive and unpacking it post-install (via bsdtar or Electron Node)
 * is substantially faster.
 *
 * Used by scripts/electron-builder-hooks.cjs (beforePack) to pack:
 *   - DSH runtime   (vendor/dsh-runtime/current -> dsh-runtime/)
 *   - DSH bundles   (dsh-bundles -> dsh-bundles/)
 *   - SKILLs        (SKILLs -> SKILLs/)
 *   - Python runtime (resources/python-win -> python-win/)
 *
 * Usage:
 *   Single dir:       node scripts/pack-dsh-win-resources.cjs [sourceDir] [outputTar]
 *   Windows combined: node scripts/pack-dsh-win-resources.cjs --win-combined
 */

const fs = require('fs');
const path = require('path');
const tar = require('tar');
const { createSkillsPayloadFilter } = require('./skill-payload.cjs');

const EXCLUDED_FILE_PATTERNS = [
  /\.map$/i,
  /\.d\.ts$/i,
  /\.d\.cts$/i,
  /\.d\.mts$/i,
  /^readme(\.(md|txt|rst))?$/i,
  /^changelog(\.(md|txt|rst))?$/i,
  /^history(\.(md|txt|rst))?$/i,
  /^license(\.(md|txt|rst))?$/i,
  /^licence(\.(md|txt|rst))?$/i,
  /^authors(\.(md|txt|rst))?$/i,
  /^contributors(\.(md|txt|rst))?$/i,
  /^\.eslintrc/i,
  /^\.prettierrc/i,
  /^\.editorconfig$/i,
  /^\.npmignore$/i,
  /^\.gitignore$/i,
  /^\.gitattributes$/i,
  /^tsconfig(\..+)?\.json$/i,
  /^jest\.config/i,
  /^vitest\.config/i,
  /^\.babelrc/i,
  /^babel\.config/i,
  /\.test\.\w+$/i,
  /\.spec\.\w+$/i,
];

const EXCLUDED_DIRS = new Set([
  'test',
  'tests',
  '__tests__',
  '__mocks__',
  '.github',
  'example',
  'examples',
  'coverage',
  '.venv',
  '.bin', // node_modules/.bin contains symlinks that break tar on cross-platform builds
]);

const EXCLUDED_ENVFILE = /^\.env(\..+)?$/i;

function shouldExclude(entryPath) {
  const basename = path.basename(entryPath);

  const segments = entryPath.split(/[/\\]/);
  for (const seg of segments) {
    if (EXCLUDED_DIRS.has(seg.toLowerCase())) return true;
  }

  if (EXCLUDED_ENVFILE.test(basename)) return true;
  if (EXCLUDED_FILE_PATTERNS.some((p) => p.test(basename))) return true;

  return false;
}

function createPackFilter(filter, counts, overrides = {}) {
  return (filePath, stat) => {
    const relative = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (shouldExclude(filePath) || Object.hasOwn(overrides, relative) || (filter && !filter(filePath))) {
      counts.skipped++;
      return false;
    }
    if (stat.isFile()) counts.totalFiles++;
    return true;
  };
}

function appendOverrides(outputTar, prefix, overrides, counts) {
  const files = Object.entries(overrides || {});
  if (!files.length) return;
  const parent = path.dirname(path.resolve(outputTar));
  const stage = fs.mkdtempSync(path.join(parent, '.payload-overrides-'));
  try {
    for (const [relative, content] of files) {
      const target = path.resolve(stage, relative);
      const inside = path.relative(stage, target);
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
        throw new Error(`[pack-dsh-win-resources] Invalid payload override path: ${relative}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    tar.replace(
      { file: outputTar, cwd: stage, prefix, sync: true, filter: createPackFilter(null, counts) },
      files.map(([relative]) => relative),
    );
  } finally {
    if (path.dirname(stage) !== parent) {
      throw new Error('Payload staging directory escaped its output directory.');
    }
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Pack a single source directory into a tar file under `prefix/`.
 */
function packSingleSource(sourceDir, outputTar, prefix, { filter, overrides } = {}) {
  const counts = { totalFiles: 0, skipped: 0 };

  tar.create(
    {
      file: outputTar,
      cwd: sourceDir,
      prefix: prefix || '',
      sync: true,
      follow: true,
      filter: createPackFilter(filter, counts, overrides),
    },
    fs.readdirSync(sourceDir).filter((name) => !EXCLUDED_DIRS.has(name.toLowerCase())),
  );
  appendOverrides(outputTar, prefix, overrides, counts);

  return counts;
}

/**
 * Pack multiple source directories into a single tar file, each under its own prefix.
 */
function packMultipleSources(sources, outputTar) {
  const counts = { totalFiles: 0, skipped: 0 };

  let first = true;
  for (const { dir, prefix, filter, overrides } of sources) {
    if (!fs.existsSync(dir)) {
      console.log(`[pack-dsh-win-resources]   Skipping ${prefix}: ${dir} not found`);
      continue;
    }

    console.log(`[pack-dsh-win-resources]   Adding ${prefix} <- ${dir}`);

    const opts = {
      file: outputTar,
      cwd: dir,
      prefix,
      sync: true,
      follow: true,
      filter: createPackFilter(filter, counts, overrides),
    };

    const topEntries = fs.readdirSync(dir).filter((n) => !EXCLUDED_DIRS.has(n.toLowerCase()));
    if (first) {
      tar.create(opts, topEntries);
      first = false;
    } else {
      tar.replace(opts, topEntries);
    }
    appendOverrides(outputTar, prefix, overrides, counts);
  }

  return counts;
}

function main() {
  const projectRoot = path.join(__dirname, '..');
  const isWinCombined = process.argv.includes('--win-combined');

  if (isWinCombined) {
    const outputTar = path.join(projectRoot, 'build-tar', 'win-resources.tar');
    fs.mkdirSync(path.dirname(outputTar), { recursive: true });
    if (fs.existsSync(outputTar)) fs.unlinkSync(outputTar);

    const runtimeRoot = path.join(projectRoot, 'vendor', 'dsh-runtime', 'current');
    const buildInfoPath = path.join(runtimeRoot, 'runtime-build-info.json');
    const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
    if (!buildInfo?.target?.startsWith('win-')) {
      throw new Error(`Expected a Windows DSH runtime, found ${buildInfo?.target || 'unknown'}.`);
    }

    const sources = [
      { dir: runtimeRoot, prefix: 'dsh-runtime' },
      { dir: path.join(projectRoot, 'dsh-bundles'), prefix: 'dsh-bundles' },
      {
        dir: path.join(projectRoot, 'SKILLs'),
        prefix: 'SKILLs',
        filter: createSkillsPayloadFilter(path.join(projectRoot, 'SKILLs')),
      },
      { dir: path.join(projectRoot, 'resources', 'python-win'), prefix: 'python-win' },
    ];

    console.log(`[pack-dsh-win-resources] Packing combined Windows tar: ${outputTar}`);
    const t0 = Date.now();
    const { totalFiles, skipped } = packMultipleSources(sources, outputTar);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const sizeMB = (fs.statSync(outputTar).size / (1024 * 1024)).toFixed(1);
    console.log(
      `[pack-dsh-win-resources] Done in ${elapsed}s: ${totalFiles} files, ${skipped} skipped, ${sizeMB} MB`,
    );
    return;
  }

  const sourceDir = process.argv[2] || path.join(projectRoot, 'vendor', 'dsh-runtime', 'current');
  const outputTar = process.argv[3] || path.join(projectRoot, 'build-tar', 'dsh-runtime.tar');

  if (!fs.existsSync(sourceDir)) {
    console.error(`[pack-dsh-win-resources] Source directory not found: ${sourceDir}`);
    process.exit(1);
  }
  if (fs.existsSync(outputTar)) fs.unlinkSync(outputTar);

  const t0 = Date.now();
  const basename = path.basename(outputTar, '.tar');
  const { totalFiles, skipped } = packSingleSource(sourceDir, outputTar, basename);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const sizeMB = (fs.statSync(outputTar).size / (1024 * 1024)).toFixed(1);
  console.log(
    `[pack-dsh-win-resources] Done in ${elapsed}s: ${totalFiles} files, ${skipped} skipped, ${sizeMB} MB`,
  );
}

if (require.main === module) {
  main();
}

module.exports = { packSingleSource, packMultipleSources };
