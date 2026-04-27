'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function commandExists(command) {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checker, [command], { stdio: 'ignore' });
  return result.status === 0;
}

function resolveBashExecutable(rootDir) {
  if (process.platform !== 'win32') {
    return commandExists('bash') ? 'bash' : null;
  }

  // On Windows, we must use Git Bash (MSYS2), NOT WSL's bash.
  // WSL bash (WindowsApps\bash.exe) runs in a separate Linux environment and
  // cannot access Windows-installed node, npm, pnpm, etc.


  // 1. Derive bash path from git installation.
  try {
    const gitResult = spawnSync('where', ['git'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (gitResult.status === 0 && gitResult.stdout) {
      const gitPath = gitResult.stdout.trim().split(/\r?\n/)[0].trim();
      const gitRoot = path.resolve(path.dirname(gitPath), '..');
      const gitBashCandidates = [
        path.join(gitRoot, 'bin', 'bash.exe'),
        path.join(gitRoot, 'usr', 'bin', 'bash.exe'),
      ];
      for (const candidate of gitBashCandidates) {
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch {}

  // 2. Bundled mingit bash.
  const candidates = [
    path.join(rootDir, 'resources', 'mingit', 'bin', 'bash.exe'),
    path.join(rootDir, 'resources', 'mingit', 'usr', 'bin', 'bash.exe'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

const targetId = (process.argv[2] || '').trim();
if (!targetId) {
  console.error('[run-build-openclaw-runtime] Missing target id (example: mac-arm64, win-x64, linux-x64).');
  process.exit(1);
}

const rootDir = path.resolve(__dirname, '..');
const bashExecutable = resolveBashExecutable(rootDir);
if (!bashExecutable) {
  console.error('[run-build-openclaw-runtime] bash is required but not found.');
  if (process.platform === 'win32') {
    console.error('[run-build-openclaw-runtime] Install Git Bash or run `npm run setup:mingit` first.');
  }
  process.exit(1);
}

// On Windows, normalise the environment for bash:
// 1. Bash expects "PATH" (uppercase) but Windows may use "Path" — merge all
//    case-variants into a single uppercase "PATH".
// 2. Prepend the directory containing the current node binary so that node,
//    npm, pnpm, etc. are findable inside the bash script even when spawned
//    through deeply-nested npm/cmd.exe process chains.
const env = { ...process.env };
if (process.platform === 'win32') {
  const nodeDir = path.dirname(process.execPath);
  const pathEntries = Object.entries(env).filter(([k]) => k.toUpperCase() === 'PATH');
  const pathValue = pathEntries.map(([, v]) => v).join(path.delimiter);
  for (const [k] of pathEntries) delete env[k];
  env.PATH = `${nodeDir}${path.delimiter}${pathValue}`;
}

// Use a relative path so bash never sees Windows drive-letter paths like
// "D:/..." which can fail when invoked through nested npm/cmd.exe chains.
const scriptPath = 'scripts/build-openclaw-runtime.sh';
const result = spawnSync(bashExecutable, [scriptPath, targetId], {
  cwd: rootDir,
  env,
  stdio: 'inherit',
});

if (typeof result.status === 'number') {
  process.exit(result.status);
}

process.exit(1);
