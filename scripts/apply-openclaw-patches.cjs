'use strict';

/**
 * Apply LobsterAI patches to the openclaw source tree.
 *
 * These patches add a dedicated gateway entry point that skips the full CLI
 * infrastructure, dramatically reducing startup time inside Electron's
 * utilityProcess (~15s instead of ~120s).
 *
 * Usage:
 *   node scripts/apply-openclaw-patches.cjs [openclaw-src-dir]
 *
 * If openclaw-src-dir is not specified, defaults to ../openclaw relative to
 * the LobsterAI project root.
 *
 * Safe to run multiple times — already-applied patches are skipped.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const openclawSrc = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(rootDir, '..', 'openclaw');

const patchesDir = path.join(rootDir, 'scripts', 'patches');

if (!fs.existsSync(openclawSrc)) {
  console.error(`[apply-openclaw-patches] openclaw source not found: ${openclawSrc}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(openclawSrc, 'package.json'))) {
  console.error(`[apply-openclaw-patches] Not an openclaw project: ${openclawSrc}`);
  process.exit(1);
}

const patchFiles = fs.readdirSync(patchesDir)
  .filter(f => f.endsWith('.patch'))
  .sort();

if (patchFiles.length === 0) {
  console.log('[apply-openclaw-patches] No patches found, nothing to do.');
  process.exit(0);
}

let applied = 0;
let skipped = 0;

for (const patchFile of patchFiles) {
  const patchPath = path.join(patchesDir, patchFile);

  // Check if patch is already applied.
  //
  // Strategy:
  //   1. Try `git apply --check --reverse` — if it succeeds the patch is applied.
  //   2. Try `git apply --check` (forward) — if it succeeds the patch is NOT applied.
  //   3. If BOTH fail, the patch is partially/fully applied (e.g. new files already
  //      exist and modified hunks already match).  Treat as already applied.
  //
  // This avoids fragile regex parsing of patch contents and works regardless of
  // line-ending differences (CRLF vs LF).

  let reverseOk = false;
  try {
    execFileSync('git', ['apply', '--check', '--reverse', patchPath], {
      cwd: openclawSrc,
      stdio: 'pipe',
    });
    reverseOk = true;
  } catch {
    // reverse check failed — patch may or may not be applied
  }

  if (reverseOk) {
    console.log(`[apply-openclaw-patches] Already applied: ${patchFile}`);
    skipped++;
    continue;
  }

  // Try forward apply check.
  let forwardErr = null;
  try {
    execFileSync('git', ['apply', '--check', patchPath], {
      cwd: openclawSrc,
      stdio: 'pipe',
    });
  } catch (err) {
    forwardErr = err;
  }

  if (forwardErr) {
    // Both reverse and forward checks failed.  This typically means the patch
    // is already applied but git can't cleanly reverse it (e.g. new files are
    // untracked, or the working tree has the changes but they aren't committed).
    const stderr = forwardErr.stderr ? forwardErr.stderr.toString() : '';
    const alreadyExists = stderr.includes('already exists in working directory');
    const patchDoesNotApply = stderr.includes('patch does not apply');

    if (alreadyExists || patchDoesNotApply) {
      console.log(`[apply-openclaw-patches] Already applied (forward check confirms): ${patchFile}`);
      skipped++;
      continue;
    }

    // Genuinely cannot apply — report error.
    console.error(`[apply-openclaw-patches] Patch does not apply cleanly: ${patchFile}`);
    console.error(`[apply-openclaw-patches] This usually means the openclaw version has changed.`);
    console.error(`[apply-openclaw-patches] Regenerate patches or update to match the new source.`);
    if (stderr) console.error(stderr);
    process.exit(1);
  }

  // Apply the patch.
  try {
    execFileSync('git', ['apply', patchPath], {
      cwd: openclawSrc,
      stdio: 'pipe',
    });
    console.log(`[apply-openclaw-patches] Applied: ${patchFile}`);
    applied++;
  } catch (err) {
    console.error(`[apply-openclaw-patches] Failed to apply: ${patchFile}`);
    const stderr = err.stderr ? err.stderr.toString() : '';
    if (stderr) console.error(stderr);
    process.exit(1);
  }
}

console.log(`[apply-openclaw-patches] Done. Applied: ${applied}, Skipped (already applied): ${skipped}`);
