'use strict';

// Windows acceptance check: install a Git-sourced plugin through the generated
// dsh launcher with no system Git, Node, or pnpm on PATH. A local repository
// exercises pnpm's Git fetch without a network dependency or credentials.
// Run after compile:electron, setup:mingit, and dsh:runtime:host:
//   node scripts/verify-dsh-git-install.cjs [runtime-dir]

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { removeTree } = require('./dsh-remove-tree.cjs');

const LOG_TAG = '[verify-dsh-git-install]';
if (process.platform !== 'win32') {
  console.log(`${LOG_TAG} Skipped: Windows-only bundled Git check`);
  process.exit(0);
}

const rootDir = path.resolve(__dirname, '..');
const runtimeDir = fs.realpathSync(process.argv[2] || path.join(rootDir, 'vendor', 'dsh-runtime', 'current'));
const {
  buildDshLauncherSource,
  buildDshPackageManager,
  DSH_NODE_EXEC_ARGV,
  DSH_PNPM_PACKAGE_RELPATH,
  DSH_RUNTIME_ENTRY_RELPATH,
  parseDshPnpmBinRelPath,
  resolveDshBundledGitBinDir,
} = require(path.join(rootDir, 'dist-electron', 'main', 'libs', 'dshRuntime.js'));
const electronPath = require('electron');
const bundledGitDir = resolveDshBundledGitBinDir(path.join(rootDir, 'resources'), process.platform, fs.existsSync, path.join);
assert.ok(bundledGitDir, 'Bundled Git is missing; run npm run setup:mingit -- --required');

const tempBase = path.resolve(os.tmpdir());
const workDir = fs.mkdtempSync(path.join(tempBase, 'dsh-git-install-'));
assert.equal(path.dirname(workDir), tempBase);

function run(command, args, env, cwd = workDir) {
  const result = spawnSync(command, args, { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 60_000 });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

try {
  // Exercise an installed-app path with spaces and keep teardown link-safe.
  const resourcesDir = path.join(workDir, 'app resources');
  fs.mkdirSync(resourcesDir);
  fs.symlinkSync(path.dirname(bundledGitDir), path.join(resourcesDir, 'mingit'), 'junction');
  const gitBinDir = resolveDshBundledGitBinDir(resourcesDir, process.platform, fs.existsSync, path.join);
  assert.ok(gitBinDir);
  const gitPath = path.join(gitBinDir, 'git.exe');
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const gitConfig = path.join(workDir, 'gitconfig');
  fs.writeFileSync(gitConfig, '');
  const bareEnv = {
    SystemRoot: systemRoot,
    windir: systemRoot,
    COMSPEC: path.join(systemRoot, 'System32', 'cmd.exe'),
    Path: path.join(systemRoot, 'System32'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    HOME: workDir,
    USERPROFILE: workDir,
    LOCALAPPDATA: workDir,
    APPDATA: workDir,
    TEMP: workDir,
    TMP: workDir,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_TELEMETRY_DISABLED: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_TERMINAL_PROMPT: '0',
  };
  assert.equal(spawnSync('git', ['--version'], { env: bareEnv, cwd: workDir, windowsHide: true }).error?.code, 'ENOENT');

  const pluginName = 'dsh-git-install-probe';
  const repoDir = path.join(workDir, 'repo');
  fs.mkdirSync(repoDir);
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
    name: pluginName, version: '1.0.0', type: 'module', exports: './index.js',
  }));
  const pluginSource = 'export function apply() {}\n';
  fs.writeFileSync(path.join(repoDir, 'index.js'), pluginSource);
  for (const args of [
    ['init'],
    ['add', '.'],
    ['-c', 'user.name=DSH Git Test', '-c', 'user.email=dsh-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'test fixture'],
  ]) {
    const result = run(gitPath, args, bareEnv, repoDir);
    assert.equal(result.status, 0, result.output);
  }

  const pnpmRoot = path.join(runtimeDir, ...DSH_PNPM_PACKAGE_RELPATH.split('/'));
  const pnpmBin = parseDshPnpmBinRelPath(fs.readFileSync(path.join(pnpmRoot, 'package.json'), 'utf8'));
  assert.ok(pnpmBin, 'Runtime must bundle pnpm');
  const entryUrl = pathToFileURL(path.join(runtimeDir, DSH_RUNTIME_ENTRY_RELPATH)).href;
  const spec = `git+${pathToFileURL(repoDir).href}`;

  for (const withGit of [false, true]) {
    const dshHome = path.join(workDir, withGit ? 'with-git' : 'without-git');
    const profileDir = path.join(dshHome, 'profiles', 'git-probe');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-git-probe', private: true, dsh: { profile: { bundles: [] } },
    }));
    const manager = buildDshPackageManager({
      electronPath,
      pnpmEntry: path.join(pnpmRoot, pnpmBin),
      nodeShimDir: null,
      npmBinDir: null,
      gitBinDir: withGit ? gitBinDir : null,
      baseEnv: bareEnv,
      delimiter: path.delimiter,
    });
    const launcherPath = path.join(dshHome, 'launch.mjs');
    fs.writeFileSync(launcherPath, buildDshLauncherSource(entryUrl, manager));
    const result = run(electronPath, [
      ...DSH_NODE_EXEC_ARGV, launcherPath, 'plugin', '--profile', 'git-probe', 'add', spec,
      '--ignore-scripts', '--store-dir', path.join(dshHome, 'pnpm-store'),
    ], { ...bareEnv, DSH_HOME: dshHome });
    if (!withGit) {
      assert.notEqual(result.status, 0, 'Negative control unexpectedly installed without Git');
      // cmd.exe's missing-command text is localized; pnpm's code is stable.
      assert.match(result.output, /ERR_PNPM_GIT_RESOLVE_FAILED/);
      console.log(`${LOG_TAG} Without bundled Git, the install fails because Git is missing`);
    } else {
      assert.equal(result.status, 0, result.output);
      assert.equal(fs.readFileSync(path.join(profileDir, 'node_modules', pluginName, 'index.js'), 'utf8'), pluginSource);
      const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
      assert.ok(manifest.dependencies[pluginName].startsWith('git+file:'));
      console.log(`${LOG_TAG} Git-sourced plugin installed through dsh using bundled Git, with no system Git on PATH`);
    }
  }
} finally {
  removeTree(workDir);
}
