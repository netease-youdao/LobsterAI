'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

function resolveHostTargetId() {
  const platformMap = {
    darwin: 'mac',
    win32: 'win',
    linux: 'linux',
  };
  const archMap = {
    x64: 'x64',
    arm64: 'arm64',
    ia32: 'ia32',
  };

  const platform = platformMap[process.platform];
  const arch = archMap[process.arch];
  if (!platform || !arch) {
    throw new Error(`Unsupported host platform/arch: ${process.platform}/${process.arch}`);
  }

  return `${platform}-${arch}`;
}

const targetId = resolveHostTargetId();
const rootDir = path.resolve(__dirname, '..');
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// Ensure the current Node's directory is first in PATH for the whole build chain
const env = { ...process.env };
if (process.platform === 'win32') {
  const nodeDir = path.dirname(process.execPath);
  const pathEntries = Object.entries(env).filter(([k]) => k.toUpperCase() === 'PATH');
  const pathValue = pathEntries.map(([, v]) => v).join(path.delimiter);
  for (const [k] of pathEntries) delete env[k];
  env.PATH = `${nodeDir}${path.delimiter}${pathValue}`;
}

const result = spawnSync(npmBin, ['run', `openclaw:runtime:${targetId}`], {
  cwd: rootDir,
  env,
  stdio: 'inherit',
  shell: true,
});

if (typeof result.status === 'number') {
  process.exit(result.status);
}

process.exit(1);
