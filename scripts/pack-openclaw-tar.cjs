'use strict';

/**
 * pack-openclaw-tar.cjs
 *
 * Packs directories into a single .tar file for Windows distribution.
 * NSIS installs thousands of small files very slowly on NTFS; shipping one
 * tar archive and extracting it post-install is dramatically faster.
 *
 * Used by electron-builder-hooks beforePack to pack:
 *   - OpenClaw runtime (vendor/openclaw-runtime/current -> cfmind/)
 *   - SKILLs directory (SKILLs -> SKILLs/)
 *   - Python runtime (resources/python-win -> python-win/)
 *
 * Usage:
 *   Single dir:      node scripts/pack-openclaw-tar.cjs [sourceDir] [outputTar]
 *   Windows combined: node scripts/pack-openclaw-tar.cjs --win-combined
 *
 * Uses npm `tar` package for reliable handling of long paths, Unicode, etc.
 */

const fs = require('fs');
const path = require('path');
const tar = require('tar');

// ── File/dir exclusion rules (same as electron-builder.json filters) ─────────

const EXCLUDED_FILE_PATTERNS = [
  /\.map$/i,
  /\.d\.ts$/i,
  /\.d\.cts$/i,
  /\.d\.mts$/i,
  /^readme(\.(md|txt|rst))?$/i,
  /^changelog(\.(md|txt|rst))?$/i,
  /^history(\.(md|txt|rst))?$/i,
  /^license(\.(md|txt))?$/i,
  /^licence(\.(md|txt))?$/i,
  /^authors(\.(md|txt))?$/i,
  /^contributors(\.(md|txt))?$/i,
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
]);

const EXCLUDED_ENVFILE = /^\.env(\..+)?$/i;

function shouldExclude(entryPath) {
  const basename = path.basename(entryPath);

  // Check dir exclusion
  const segments = entryPath.split(/[/\\]/);
  for (const seg of segments) {
    if (EXCLUDED_DIRS.has(seg.toLowerCase())) return true;
  }

  // Check file exclusion
  if (EXCLUDED_ENVFILE.test(basename)) return true;
  if (EXCLUDED_FILE_PATTERNS.some((p) => p.test(basename))) return true;

  return false;
}

// ── Pack functions ───────────────────────────────────────────────────────────

/**
 * Pack a single source directory into a tar file.
 * The directory contents are stored under `prefix/` in the tar.
 */
function packSingleSource(sourceDir, outputTar, prefix) {
  const entries = [];
  let skipped = 0;

  // Collect entries, applying exclusion filter
  function walk(dir, relPrefix) {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    items.sort((a, b) => a.name.localeCompare(b.name));

    for (const item of items) {
      if (item.isSymbolicLink()) continue;
      const fullPath = path.join(dir, item.name);
      const relPath = relPrefix ? `${relPrefix}/${item.name}` : item.name;

      if (item.isDirectory()) {
        if (EXCLUDED_DIRS.has(item.name.toLowerCase())) {
          skipped++;
          continue;
        }
        walk(fullPath, relPath);
      } else if (item.isFile()) {
        if (shouldExclude(item.name)) {
          skipped++;
          continue;
        }
        entries.push(relPath);
      }
    }
  }

  walk(sourceDir, '');

  // Use npm tar to create the archive
  tar.create(
    {
      file: outputTar,
      cwd: sourceDir,
      prefix: prefix || '',
      sync: true,
      // Follow symlinks instead of storing them (avoids Windows issues)
      follow: true,
      filter: (filePath) => !shouldExclude(filePath),
    },
    // Pack all top-level entries (tar will recurse)
    fs.readdirSync(sourceDir).filter((name) => {
      if (EXCLUDED_DIRS.has(name.toLowerCase())) return false;
      return true;
    })
  );

  return { totalFiles: entries.length, skipped };
}

/**
 * Pack multiple source directories into a single tar file.
 * Each source gets its own prefix (root directory name) in the tar.
 */
function packMultipleSources(sources, outputTar) {
  let totalFiles = 0;
  let totalSkipped = 0;

  // Pack first source (creates the tar)
  let first = true;
  for (const { dir, prefix } of sources) {
    if (!fs.existsSync(dir)) {
      console.log(`[pack-openclaw-tar]   Skipping ${prefix}: ${dir} not found`);
      continue;
    }

    console.log(`[pack-openclaw-tar]   Adding ${prefix} ← ${dir}`);

    const entries = [];
    function countFiles(d) {
      for (const item of fs.readdirSync(d, { withFileTypes: true })) {
        if (item.isSymbolicLink()) continue;
        const fullPath = path.join(d, item.name);
        if (item.isDirectory()) {
          if (!EXCLUDED_DIRS.has(item.name.toLowerCase())) countFiles(fullPath);
        } else if (item.isFile()) {
          if (!shouldExclude(item.name)) entries.push(item.name);
          else totalSkipped++;
        }
      }
    }
    countFiles(dir);
    totalFiles += entries.length;

    const opts = {
      file: outputTar,
      cwd: dir,
      prefix,
      sync: true,
      follow: true,
      filter: (filePath) => !shouldExclude(filePath),
    };

    if (first) {
      // Create new tar
      tar.create(
        opts,
        fs.readdirSync(dir).filter((n) => !EXCLUDED_DIRS.has(n.toLowerCase()))
      );
      first = false;
    } else {
      // Append to existing tar (replace creates new, we need to use a different approach)
      // npm tar doesn't support append directly, so we use replace with gzip:false
      tar.replace(
        opts,
        fs.readdirSync(dir).filter((n) => !EXCLUDED_DIRS.has(n.toLowerCase()))
      );
    }
  }

  return { totalFiles, skipped: totalSkipped };
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const projectRoot = path.join(__dirname, '..');
  const isWinCombined = process.argv.includes('--win-combined');

  if (isWinCombined) {
    const outputTar = path.join(projectRoot, 'build-tar', 'win-resources.tar');
    fs.mkdirSync(path.dirname(outputTar), { recursive: true });

    // Remove old tar if exists
    if (fs.existsSync(outputTar)) fs.unlinkSync(outputTar);

    const sources = [
      { dir: path.join(projectRoot, 'vendor', 'openclaw-runtime', 'current'), prefix: 'cfmind' },
      { dir: path.join(projectRoot, 'SKILLs'), prefix: 'SKILLs' },
      { dir: path.join(projectRoot, 'resources', 'python-win'), prefix: 'python-win' },
    ];

    console.log(`[pack-openclaw-tar] Packing combined Windows tar: ${outputTar}`);
    const t0 = Date.now();
    const { totalFiles, skipped } = packMultipleSources(sources, outputTar);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const sizeMB = (fs.statSync(outputTar).size / (1024 * 1024)).toFixed(1);
    console.log(
      `[pack-openclaw-tar] Done in ${elapsed}s: ${totalFiles} files, ${skipped} skipped, ${sizeMB} MB`
    );
    return;
  }

  // Single directory mode
  const sourceDir = process.argv[2]
    || path.join(projectRoot, 'vendor', 'openclaw-runtime', 'current');
  const outputTar = process.argv[3]
    || path.join(projectRoot, 'vendor', 'openclaw-runtime', 'cfmind.tar');

  if (!fs.existsSync(sourceDir)) {
    console.error(`[pack-openclaw-tar] Source directory not found: ${sourceDir}`);
    process.exit(1);
  }

  // Remove old tar if exists
  if (fs.existsSync(outputTar)) fs.unlinkSync(outputTar);

  console.log(`[pack-openclaw-tar] Packing: ${sourceDir}`);
  console.log(`[pack-openclaw-tar] Output:  ${outputTar}`);

  const t0 = Date.now();
  const basename = path.basename(outputTar, '.tar');
  const { totalFiles, skipped } = packSingleSource(sourceDir, outputTar, basename);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const sizeMB = (fs.statSync(outputTar).size / (1024 * 1024)).toFixed(1);
  console.log(
    `[pack-openclaw-tar] Done in ${elapsed}s: ${totalFiles} files, ${skipped} skipped, ${sizeMB} MB`
  );
}

if (require.main === module) {
  main();
}

module.exports = { packSingleSource, packMultipleSources };
