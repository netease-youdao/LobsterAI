'use strict';

// Channel web-installer build entry. Wraps the dist:win chain so that every
// web-installer variable is scoped to the spawned build only — nothing is
// read from or written to the caller's shell environment, which makes builds
// reproducible from any terminal state (see LOBSTERAI_WEB_* handling below).

const { spawnSync } = require('child_process');
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');

const { BuildEnv, CHANNEL_SCOPED_ENV_VARS } = require('./build-env.cjs');
const { normalizeKeyfrom } = require('./build-keyfrom.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const RELEASE_DIR = path.join(REPO_ROOT, 'release');
const WEB_OUTPUT_DIR = path.join(RELEASE_DIR, 'nsis-web');
const PREPACKAGED_APP_DIR = path.join(RELEASE_DIR, 'win-unpacked');
const PLACEHOLDER_BASE_URL = 'https://placeholder.invalid/web-package';

function webPackageFileName(version) {
  return `lobsterai-${version}-x64.nsis.7z`;
}

function webSetupFileName(version, keyfrom, silentOnDoubleClick) {
  return `LobsterAI-WebSetup-x64-${version}-${keyfrom}${silentOnDoubleClick ? '-silent' : ''}.exe`;
}

function sha256File(filePath) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  const fd = fs.openSync(filePath, 'r');
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

const USAGE = `Usage:
  npm run dist:win:web -- --keyfrom <channel> [--silent] [--pkg-base-url <cdn-dir> | --pkg-url <package-url>]

Modes:
  --silent        make direct launches enter NSIS silent mode without requiring /S
  --pkg-base-url  one-pass build; the installer downloads <dir>/<keyfrom>/lobsterai-<version>-x64.nsis.7z
  --pkg-url       stub-only rebuild with the exact package URL (upload-first flow, e.g. NOS)
  (no URL flag)   full build with a placeholder URL, to produce the .nsis.7z for upload;
                  the unusable WebSetup exe from this pass is deleted afterwards
  --dry-run       print the resolved build plan without building`;

function fail(message) {
  console.error(`[WebBuild] ${message}`);
  console.error(USAGE);
  process.exit(1);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      keyfrom: { type: 'string' },
      silent: { type: 'boolean', default: false },
      'pkg-url': { type: 'string' },
      'pkg-base-url': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  }));
} catch (error) {
  fail(`invalid arguments: ${error.message}`);
}

const keyfrom = (values.keyfrom || '').trim().toLowerCase();
if (!keyfrom) {
  fail('--keyfrom is required so the channel is always explicit.');
}
if (normalizeKeyfrom(keyfrom) !== keyfrom) {
  fail(`invalid keyfrom "${values.keyfrom}": use 1-64 characters of a-z 0-9 _ -`);
}

const pkgUrl = (values['pkg-url'] || '').trim();
const pkgBaseUrl = (values['pkg-base-url'] || '').trim();
const silentOnDoubleClick = values.silent === true;
if (pkgUrl && pkgBaseUrl) {
  fail('--pkg-url and --pkg-base-url are mutually exclusive.');
}

// Leftover shell variables (e.g. from a previous $env: assignment) must never
// leak into a build; everything relevant is set explicitly below.
const env = { ...process.env };
for (const name of CHANNEL_SCOPED_ENV_VARS) {
  if (env[name] !== undefined) {
    console.warn(`[WebBuild] ignoring inherited ${name}=${env[name]} from the shell`);
    delete env[name];
  }
}
env[BuildEnv.ChannelBuild] = '1';
env[BuildEnv.Keyfrom] = keyfrom;
env[BuildEnv.SilentOnDoubleClick] = silentOnDoubleClick ? '1' : '0';
env[BuildEnv.WebInstaller] = '1';

const stubOnly = pkgUrl !== '';
const usesPlaceholder = !stubOnly && pkgBaseUrl === '';
let command;
let args;
let stubSourcePackageHash;
let stubSourcePackagePath;
if (stubOnly) {
  if (!values['dry-run']) {
    const version = require('../package.json').version;
    const packagePath = path.join(WEB_OUTPUT_DIR, webPackageFileName(version));
    for (const [label, requiredPath] of [
      ['prepackaged app directory', PREPACKAGED_APP_DIR],
      ['web package', packagePath],
    ]) {
      if (!fs.existsSync(requiredPath)) {
        fail(
          `${label} not found at ${path.relative(REPO_ROOT, requiredPath)} — ` +
            `run the first pass (npm run dist:win:web -- --keyfrom ${keyfrom}) before the stub-only pass.`,
        );
      }
    }

    // The stub-only pass skips prebuild, so .keyfrom-build still holds the first
    // pass's channel; a mismatch would name the stub after one channel while the
    // uploaded package carries another.
    const keyfromBuildPath = path.join(REPO_ROOT, '.keyfrom-build', 'keyfrom.json');
    if (fs.existsSync(keyfromBuildPath)) {
      let firstPassKeyfrom;
      try {
        firstPassKeyfrom = JSON.parse(fs.readFileSync(keyfromBuildPath, 'utf8'))?.keyfrom;
      } catch {
        firstPassKeyfrom = undefined; // unreadable file: fall through to the build
      }
      if (firstPassKeyfrom && firstPassKeyfrom !== keyfrom) {
        fail(
          `--keyfrom ${keyfrom} does not match the first pass (${firstPassKeyfrom}). ` +
            `Rerun the first pass with --keyfrom ${keyfrom}, or pass --keyfrom ${firstPassKeyfrom}.`,
        );
      }
    }

    stubSourcePackageHash = sha256File(packagePath);
    stubSourcePackagePath = packagePath;
  }
  env[BuildEnv.ReuseWebPackage] = '1';
  env[BuildEnv.WebPkgUrl] = pkgUrl;
  command = 'npx';
  args = [
    'electron-builder',
    '--win',
    'nsis-web',
    '--x64',
    '--prepackaged',
    path.relative(REPO_ROOT, PREPACKAGED_APP_DIR),
    '--config',
    'scripts/electron-builder-config.cjs',
  ];
} else {
  env[BuildEnv.WebPkgBaseUrl] = pkgBaseUrl || PLACEHOLDER_BASE_URL;
  command = 'npm';
  args = ['run', 'dist:win'];
}

const mode = stubOnly ? 'stub-only' : usesPlaceholder ? 'full-build-with-placeholder-url' : 'full-build-with-base-url';
console.log(`[WebBuild] keyfrom=${keyfrom} mode=${mode}`);
console.log(
  `[WebBuild] silentOnDoubleClick=${silentOnDoubleClick} source=${silentOnDoubleClick ? 'cli' : 'default'}`,
);
console.log(`[WebBuild] package ${stubOnly ? 'url' : 'base url'}: ${stubOnly ? pkgUrl : env[BuildEnv.WebPkgBaseUrl]}`);
if (usesPlaceholder) {
  console.log('[WebBuild] no URL flag given: building with a placeholder so the .nsis.7z can be uploaded first.');
}

const logUploadFollowUp = () => {
  const version = require('../package.json').version;
  const packagePath = path.relative(REPO_ROOT, path.join(WEB_OUTPUT_DIR, webPackageFileName(version)));
  console.log(`[WebBuild] next: upload ${packagePath}, then run`);
  console.log(
    `[WebBuild]   npm run dist:win:web -- --keyfrom ${keyfrom}${silentOnDoubleClick ? ' --silent' : ''} --pkg-url <uploaded-url>`,
  );
};

if (values['dry-run']) {
  console.log(`[WebBuild] dry-run: would execute \`${command} ${args.join(' ')}\``);
  if (usesPlaceholder) {
    logUploadFollowUp();
  }
  process.exit(0);
}

if (stubOnly) {
  // The stub-only pass calls electron-builder directly (bypassing dist:win),
  // so run the same installer gate dist:win runs: apply patches, verify the
  // NSIS template contracts against node_modules, abort on any mismatch.
  const gate = spawnSync(process.execPath, [path.join(__dirname, 'verify-installer-patches.cjs')], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
  });
  if (gate.status !== 0) {
    process.exit(gate.status ?? 1);
  }
}

const result = spawnSync(command, args, {
  cwd: REPO_ROOT,
  env,
  stdio: 'inherit',
  shell: true,
});
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (stubOnly) {
  const packageHashAfterBuild = sha256File(stubSourcePackagePath);
  if (packageHashAfterBuild !== stubSourcePackageHash) {
    fail(
      `stub-only build changed ${path.relative(REPO_ROOT, stubSourcePackagePath)}; ` +
        'the uploaded payload would fail the WebSetup integrity check.',
    );
  }
  console.log(`[WebBuild] verified uploaded payload unchanged: sha256=${packageHashAfterBuild}`);
}

if (usesPlaceholder) {
  // The stub from this pass points at the placeholder URL and must never be
  // shipped; remove it so only the real second-pass stub can reach a landing page.
  const version = require('../package.json').version;
  const throwawayStub = path.join(
    WEB_OUTPUT_DIR,
    webSetupFileName(version, keyfrom, silentOnDoubleClick),
  );
  if (!fs.existsSync(throwawayStub)) {
    fail(`throwaway WebSetup artifact not found at ${path.relative(REPO_ROOT, throwawayStub)}.`);
  }
  fs.rmSync(throwawayStub, { force: true });
  console.log(`[WebBuild] deleted throwaway ${path.relative(REPO_ROOT, throwawayStub)}`);

  const packagePath = path.join(WEB_OUTPUT_DIR, webPackageFileName(version));
  if (!fs.existsSync(packagePath)) {
    fail(`web package not found at ${path.relative(REPO_ROOT, packagePath)}.`);
  }
  logUploadFollowUp();
}
