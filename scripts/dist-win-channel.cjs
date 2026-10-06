'use strict';

// Channel full-package build for Windows. The keyfrom is passed as an explicit
// flag and scoped to the spawned build only, so PowerShell sessions never leak
// a previous channel (or a leftover web-installer switch) into this build.

const { spawnSync } = require('child_process');
const path = require('path');
const { parseArgs } = require('util');

const { BuildEnv, CHANNEL_SCOPED_ENV_VARS } = require('./build-env.cjs');
const { normalizeKeyfrom } = require('./build-keyfrom.cjs');

const REPO_ROOT = path.join(__dirname, '..');

const USAGE = `Usage:
  npm run dist:win:channel -- --keyfrom <channel> [--silent] [--dry-run]

Builds the regular full installer (npm run dist:win) for the given channel.
Use --silent when the generated installer should enter NSIS silent mode even
when the user double-clicks it without passing /S.
For the web-installer variants, including --silent builds, use: npm run dist:win:web`;

function fail(message) {
  console.error(`[ChannelBuild] ${message}`);
  console.error(USAGE);
  process.exit(1);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      keyfrom: { type: 'string' },
      silent: { type: 'boolean', default: false },
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

const env = { ...process.env };
for (const name of CHANNEL_SCOPED_ENV_VARS) {
  if (env[name] !== undefined) {
    console.warn(`[ChannelBuild] ignoring inherited ${name}=${env[name]} from the shell`);
    delete env[name];
  }
}
const silentOnDoubleClick = values.silent === true;
env[BuildEnv.ChannelBuild] = '1';
env[BuildEnv.Keyfrom] = keyfrom;
env[BuildEnv.SilentOnDoubleClick] = silentOnDoubleClick ? '1' : '0';

console.log(
  `[ChannelBuild] keyfrom=${keyfrom} mode=full-installer ` +
    `silentOnDoubleClick=${silentOnDoubleClick} source=${silentOnDoubleClick ? 'cli' : 'default'}`,
);

if (values['dry-run']) {
  console.log('[ChannelBuild] dry-run: would execute `npm run dist:win`');
  process.exit(0);
}

const result = spawnSync('npm', ['run', 'dist:win'], {
  cwd: REPO_ROOT,
  env,
  stdio: 'inherit',
  shell: true,
});
process.exit(result.status ?? 1);
