'use strict';

/**
 * Ensure the local OpenClaw source directory is checked out at the version
 * declared in package.json ("openclaw.version").
 *
 * - If OPENCLAW_SRC does not exist, clones the repo at the pinned tag.
 * - If it exists but is on a different version, fetches and checks out the tag.
 * - If already on the correct tag, does nothing.
 *
 * Environment variables:
 *   OPENCLAW_SRC          – Override the OpenClaw source path (default: ../openclaw)
 *   OPENCLAW_SKIP_ENSURE  – Set to "1" to skip this script entirely
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const rootDir = path.resolve(__dirname, '..');

function log(msg) {
  console.log(`[openclaw-ensure] ${msg}`);
}

function warn(msg) {
  console.warn(`[openclaw-ensure] WARNING: ${msg}`);
}

function die(msg) {
  console.error(`[openclaw-ensure] ERROR: ${msg}`);
  process.exit(1);
}

function commandExists(command) {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checker, [command], { stdio: 'ignore' });
  return result.status === 0;
}

function resolveGitExecutable() {
  if (commandExists('git')) return 'git';

  // Windows fallback: project-bundled mingit
  if (process.platform === 'win32') {
    const candidates = [
      path.join(rootDir, 'resources', 'mingit', 'cmd', 'git.exe'),
      path.join(rootDir, 'resources', 'mingit', 'bin', 'git.exe'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return null;
}

function git(args, opts = {}) {
  const result = execFileSync(gitBin, args, {
    encoding: 'utf-8',
    stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd,
  });
  return typeof result === 'string' ? result.trim() : '';
}

function gitExitCode(args, opts = {}) {
  const result = spawnSync(gitBin, args, {
    encoding: 'utf-8',
    stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd,
  });
  return result.status;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Skip if explicitly requested
if (process.env.OPENCLAW_SKIP_ENSURE === '1') {
  log('Skipped (OPENCLAW_SKIP_ENSURE=1).');
  process.exit(0);
}

// Read config from package.json
const pkg = require(path.join(rootDir, 'package.json'));
const openclawConfig = pkg.openclaw;
if (!openclawConfig || !openclawConfig.version) {
  die('Missing "openclaw.version" in package.json.');
}

const desiredVersion = openclawConfig.version;
const repoUrl = openclawConfig.repo || 'https://github.com/openclaw/openclaw.git';
const openclawSrc = process.env.OPENCLAW_SRC || path.resolve(rootDir, '..', 'openclaw');

log(`Desired OpenClaw version: ${desiredVersion}`);
log(`OpenClaw source path: ${openclawSrc}`);

// Resolve git binary
const gitBin = resolveGitExecutable();
if (!gitBin) {
  die(
    'git is required but not found.' +
    (process.platform === 'win32'
      ? ' Install Git for Windows or run `npm run setup:mingit` first.'
      : '')
  );
}

// Case 1: source directory does not exist → clone
if (!fs.existsSync(openclawSrc)) {
  log(`Cloning ${repoUrl} at tag ${desiredVersion} ...`);
  try {
    git(
      ['clone', '--branch', desiredVersion, '--depth', '1', repoUrl, openclawSrc],
      { stdio: 'inherit' }
    );
  } catch (e) {
    die(`Failed to clone OpenClaw: ${e.message}`);
  }
  log(`Cloned successfully at ${desiredVersion}.`);
  process.exit(0);
}

// Case 2: source directory exists → check current version
if (!fs.existsSync(path.join(openclawSrc, '.git'))) {
  die(`${openclawSrc} exists but is not a git repository.`);
}

// Check if already on the desired tag
let currentTag = '';
try {
  currentTag = git(['describe', '--tags', '--exact-match', 'HEAD'], { cwd: openclawSrc });
} catch {
  // HEAD is not on an exact tag — that's fine, we'll need to checkout
}

if (currentTag === desiredVersion) {
  log(`Already at ${desiredVersion}, nothing to do.`);
  process.exit(0);
}

log(`Current: ${currentTag || '(not on a tag)'}. Switching to ${desiredVersion} ...`);

// Fetch tags (unshallow if needed)
try {
  const isShallow = fs.existsSync(path.join(openclawSrc, '.git', 'shallow'));
  if (isShallow) {
    log('Repository is shallow, fetching full history for tags ...');
    git(['fetch', '--unshallow', '--tags', 'origin'], { cwd: openclawSrc, stdio: 'inherit' });
  } else {
    git(['fetch', '--tags', 'origin'], { cwd: openclawSrc, stdio: 'inherit' });
  }
} catch (e) {
  die(`Failed to fetch tags: ${e.message}`);
}

// Verify the desired tag exists
const tagCheck = gitExitCode(['rev-parse', '--verify', `refs/tags/${desiredVersion}`], {
  cwd: openclawSrc,
});
if (tagCheck !== 0) {
  die(`Tag ${desiredVersion} not found in the OpenClaw repository. Check openclaw.version in package.json.`);
}

// Discard any local modifications and untracked files (typically build artifacts
// and files created by patches from a different LobsterAI branch) before checking
// out the desired tag. Developers working on OpenClaw itself should use
// OPENCLAW_SKIP_ENSURE=1 to prevent this.
const hasLocalChanges = gitExitCode(['diff', '--quiet', 'HEAD'], { cwd: openclawSrc }) !== 0;
const hasUntrackedFiles =
  git(['ls-files', '--others', '--exclude-standard'], { cwd: openclawSrc }).length > 0;
if (hasLocalChanges || hasUntrackedFiles) {
  warn('Discarding local modifications and untracked files in OpenClaw source.');
  warn('Use OPENCLAW_SKIP_ENSURE=1 if you are developing OpenClaw locally.');
  if (hasLocalChanges) {
    git(['checkout', '.'], { cwd: openclawSrc });
  }
  if (hasUntrackedFiles) {
    git(['clean', '-fd'], { cwd: openclawSrc });
  }
}

// Checkout the desired tag (force to handle any remaining conflicts)
try {
  git(['checkout', desiredVersion], { cwd: openclawSrc, stdio: 'inherit' });
} catch (e) {
  die(`Failed to checkout ${desiredVersion}: ${e.message}`);
}

log(`Switched to ${desiredVersion} successfully.`);
