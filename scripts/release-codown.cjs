'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs } = require('util');
const { BuildEnv, CHANNEL_SCOPED_ENV_VARS, PackagingEnv } = require('./build-env.cjs');
const { CodownEnv, packagingEnv, readCodownConfig, withoutSvnCredentials } = require('./codown-config.cjs');
const { ReleaseTarget, ArtifactKind, isWindows, artifactPlan, artifactUrl, sourceFiles, manifestDirectory, stageManifest } = require('./codown-artifacts.cjs');
const { preflightSvn } = require('./codown-svn.cjs');
const { publishAndReport } = require('./codown-publish.cjs');

const TARGET_BUILDS = {
  [ReleaseTarget.MacArm64]: { platform: 'darwin', script: 'dist:mac:arm64' },
  [ReleaseTarget.MacX64]: { platform: 'darwin', script: 'dist:mac:x64' },
  [ReleaseTarget.MacUniversal]: { platform: 'darwin', script: 'dist:mac:universal' },
  [ReleaseTarget.WinChannel]: { platform: 'win32', script: 'dist:win:channel' },
  [ReleaseTarget.WinWeb]: { platform: 'win32', script: 'dist:win:web' },
  [ReleaseTarget.LinuxX64]: { platform: 'linux', script: 'dist:linux' },
};

function releasePlan(values, version) {
  const identity = { target: values.target, version, keyfrom: (values.keyfrom || 'official').trim().toLowerCase(), silent: values.silent === true };
  const artifacts = artifactPlan(identity);
  const build = TARGET_BUILDS[identity.target];
  const args = ['run', build.script];
  if (isWindows(identity.target)) {
    args.push('--', '--keyfrom', identity.keyfrom);
    if (identity.silent) args.push('--silent');
    if (identity.target === ReleaseTarget.WinWeb) args.push('--codown');
  }
  return { identity, artifacts, args, platform: build.platform };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status ?? result.signal}).`);
}

function assertReleaseCredentials(plan, env) {
  const required = isWindows(plan.identity.target)
    ? ['YD_SIGN_SERVICE_URL', 'YD_SIGN_APP_KEY', 'YD_SIGN_APP_SECRET', 'YD_SIGN_USERNAME']
    : plan.platform === 'darwin' ? ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'] : [];
  const missing = required.filter(name => !env[name]?.trim());
  if (missing.length) throw new Error(`Release signing credentials are missing: ${missing.join(', ')}. Configure env or .env before publishing.`);
}

function verifySignatures(outputDir, identity) {
  if (isWindows(identity.target)) {
    const files = sourceFiles(outputDir, identity).filter(artifact => artifact.kind !== ArtifactKind.Payload).map(artifact => artifact.file);
    files.push(path.join(outputDir, 'win-unpacked', 'LobsterAI.exe'));
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference = "Stop"; foreach ($file in (ConvertFrom-Json $env:LOBSTERAI_SIGNATURE_FILES)) { if ((Get-AuthenticodeSignature -LiteralPath $file).Status -ne "Valid") { throw "Invalid Authenticode signature: $file" } }'],
    { env: { ...withoutSvnCredentials(process.env), LOBSTERAI_SIGNATURE_FILES: JSON.stringify(files) } });
  } else if (identity.target !== ReleaseTarget.LinuxX64) {
    const apps = fs.readdirSync(outputDir).map(name => path.join(outputDir, name, 'LobsterAI.app')).filter(file => fs.existsSync(file));
    if (apps.length !== 1) throw new Error('Expected one packaged macOS app for signature verification.');
    run('codesign', ['--verify', '--deep', '--strict', apps[0]]);
    run('xcrun', ['stapler', 'validate', apps[0]]);
  }
}

async function release(root, plan, config, env, dependencies = {}) {
  const checkSvn = dependencies.preflight || preflightSvn;
  const build = dependencies.build || ((args, outputDir) => {
    const npmCli = process.env.npm_execpath || path.join(path.dirname(require.resolve('npm/package.json')), 'bin', 'npm-cli.js');
    const childEnv = withoutSvnCredentials(env);
    for (const name of CHANNEL_SCOPED_ENV_VARS) delete childEnv[name];
    if (!isWindows(plan.identity.target)) childEnv[BuildEnv.Keyfrom] = plan.identity.keyfrom;
    childEnv[PackagingEnv.OutputDir] = outputDir;
    // This public download base is the only codown setting needed by a build.
    childEnv[CodownEnv.PublicBaseUrl] = config.publicBaseUrl;
    run(process.execPath, [npmCli, ...args], { cwd: root, env: childEnv });
  });
  const snapshotDir = manifestDirectory(root, plan.identity);
  if (fs.existsSync(snapshotDir)) throw new Error(`Release snapshot already exists: ${snapshotDir}. Retry with codown:publish using its manifest.json.`);
  await checkSvn(config);
  const work = path.join(root, '.work');
  fs.mkdirSync(work, { recursive: true });
  const lock = path.join(work, 'codown-build.lock');
  try { fs.mkdirSync(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another release holds ${lock}. Wait for it, or remove this lock only after confirming the old process stopped.`);
    throw error;
  }
  let outputDir;
  let manifestPath;
  try {
    outputDir = fs.mkdtempSync(path.join(work, 'codown-build-'));
    await build(plan.args, outputDir);
    await (dependencies.verifySignatures || verifySignatures)(outputDir, plan.identity);
    manifestPath = await stageManifest(root, outputDir, plan.identity, config.publicBaseUrl);
    console.log(`[Codown] Release snapshot: ${manifestPath}`);
  } finally {
    if (outputDir) fs.rmSync(outputDir, { recursive: true, force: true });
    fs.rmdirSync(lock);
  }
  try {
    return await (dependencies.publish || publishAndReport)(manifestPath, config);
  } catch (error) {
    console.error(`[Codown] Build snapshot preserved. Retry without rebuilding: npm run codown:publish -- --manifest "${manifestPath}"`);
    throw error;
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    target: { type: 'string' }, keyfrom: { type: 'string' }, silent: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
  } });
  const root = path.join(__dirname, '..');
  const plan = releasePlan(values, require('../package.json').version);
  const env = packagingEnv(root);
  const config = readCodownConfig(env, root);
  console.log(`[Codown] Build: npm ${plan.args.join(' ')}`);
  for (const artifact of plan.artifacts) console.log(`[Codown] ${artifact.kind}: ${artifactUrl(config.publicBaseUrl, plan.identity.keyfrom, artifact.name)}`);
  console.log(`[Codown] Manual deployment hint: ${config.ticketUrl}`);
  if (values['dry-run']) {
    console.log('[Codown] Dry run only; no build, SVN mutation or browser operation.');
    return;
  }
  if (process.platform !== plan.platform || (plan.identity.target === ReleaseTarget.LinuxX64 && process.arch !== 'x64')) {
    throw new Error(`Build ${plan.identity.target} on its native ${plan.platform} host. You can publish an existing snapshot from another host.`);
  }
  assertReleaseCredentials(plan, env);
  return release(root, plan, config, env);
}

if (require.main === module) main().catch(error => { console.error(`[Codown] ${error.message}`); process.exitCode = 1; });
module.exports = { releasePlan, release, assertReleaseCredentials };
