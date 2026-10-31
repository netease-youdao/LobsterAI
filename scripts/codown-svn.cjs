'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createHash } = require('crypto');
const { fileDigest, readManifest } = require('./codown-artifacts.cjs');

const SvnStatus = { Normal: 'normal', None: 'none', Added: 'added', Unversioned: 'unversioned' };
const decodeXml = value => value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attributes = value => Object.fromEntries([...value.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], decodeXml(match[2])]));

function statusEntries(xml) {
  return [...xml.matchAll(/<entry\s+([^>]+)>([\s\S]*?)<\/entry>/g)].map(match => ({
    path: attributes(match[1]).path,
    ...attributes(match[2].match(/<wc-status\s+([^>]+)>/)?.[1] || ''),
  }));
}

function dirtyEntries(xml) {
  return statusEntries(xml).filter(entry => ![SvnStatus.Normal, SvnStatus.None].includes(entry.item)
    || ![SvnStatus.Normal, SvnStatus.None].includes(entry.props) || entry['tree-conflicted'] === 'true');
}

function svnClient(config) {
  return (args, { digest = false } = {}) => new Promise((resolve, reject) => {
    const auth = ['--non-interactive', '--no-auth-cache', '--config-option', 'servers:global:http-timeout=60'];
    if (config.username) auth.push('--username', config.username);
    if (config.password) auth.push('--password-from-stdin');
    const child = spawn('svn', [...args, ...auth], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const hash = digest ? createHash('sha256') : undefined;
    let size = 0;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      if (hash) { hash.update(chunk); size += chunk.length; }
      else if (stdout.length < 8 * 1024 * 1024) stdout += chunk.toString();
      else child.kill();
    });
    child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk.toString(); });
    child.once('error', reject);
    child.stdin.on('error', () => {}); // Early auth failures can close stdin first.
    child.once('close', code => {
      if (code !== 0) {
        const safeError = config.password ? stderr.split(config.password).join('[redacted]') : stderr;
        reject(new Error(`svn ${args[0]} failed (${code}): ${safeError.trim()}`));
      } else resolve(hash ? { size, sha256: hash.digest('hex') } : stdout);
    });
    child.stdin.end(config.password ? `${config.password}\n` : undefined);
  });
}

async function inspectWorkingCopy(config, svn) {
  const xml = await svn(['info', '--xml', config.workingCopy]);
  const url = decodeXml(xml.match(/<url>([^<]+)<\/url>/)?.[1] || '').replace(/\/+$/, '');
  if (url !== config.svnUrl) throw new Error('CODOWN_WORKING_COPY does not point to CODOWN_SVN_URL.');
  const wcRoot = decodeXml(xml.match(/<wcroot-abspath>([^<]+)<\/wcroot-abspath>/)?.[1] || '');
  if (fs.realpathSync(wcRoot) !== fs.realpathSync(config.workingCopy)) throw new Error('CODOWN_WORKING_COPY must be a product working-copy root.');
  const dirty = dirtyEntries(await svn(['status', '--xml', '--ignore-externals', config.workingCopy]));
  if (dirty.length) throw new Error('Codown working copy has local changes. Resolve them before publishing; no files were added or committed.');
}

async function remoteRevision(config, svn) {
  const xml = await svn(['info', '--xml', config.svnUrl]);
  const revision = xml.match(/<entry\s[^>]*revision="(\d+)"/s)?.[1];
  if (!revision) throw new Error('Cannot determine SVN repository revision.');
  return revision;
}

async function preflightSvn(config) {
  const svn = svnClient(config);
  await inspectWorkingCopy(config, svn);
  return remoteRevision(config, svn);
}

async function remoteFiles(config, svn, manifest) {
  const revision = await remoteRevision(config, svn);
  const rootXml = await svn(['list', '--xml', '--depth', 'immediates', '-r', revision, config.svnUrl]);
  const entries = [...rootXml.matchAll(/<entry\s+kind="([^"]+)"[^>]*>([\s\S]*?)<\/entry>/g)];
  const channel = entries.find(entry => decodeXml(entry[2].match(/<name>([^<]+)<\/name>/)?.[1] || '') === manifest.keyfrom);
  if (channel && channel[1] !== 'dir') throw new Error('The channel path in SVN is not a directory.');
  if (!channel) return { revision, channelExists: false, existing: new Set() };
  const channelUrl = `${config.svnUrl}/${manifest.keyfrom}`;
  const xml = await svn(['list', '--xml', '--depth', 'immediates', '-r', revision, channelUrl]);
  const names = new Set([...xml.matchAll(/<name>([^<]+)<\/name>/g)].map(match => decodeXml(match[1])));
  const existing = new Set();
  for (const artifact of manifest.artifacts) {
    if (!names.has(artifact.name)) continue;
    const actual = await svn(['cat', '-r', revision, `${channelUrl}/${artifact.name}`], { digest: true });
    if (actual.size !== artifact.size || actual.sha256 !== artifact.sha256) {
      throw new Error(`Refusing to overwrite ${manifest.keyfrom}/${artifact.name}: different bytes already exist. Publish a new version.`);
    }
    existing.add(artifact.name);
  }
  return { revision, channelExists: true, existing };
}

// Roll back only files this invocation created and which still match the
// snapshot. A lost commit response can leave either added or normal nodes;
// normal nodes have already been committed and must be left alone.
async function rollbackCreated(svn, createdFiles, createdDirectory) {
  for (const { file, sha256 } of createdFiles) {
    if (!fs.existsSync(file) || (await fileDigest(file)).sha256 !== sha256) continue;
    const status = statusEntries(await svn(['status', '--xml', file]))[0]?.item;
    if (status === SvnStatus.Added) await svn(['revert', '--depth', 'empty', file]);
    if ([SvnStatus.Added, SvnStatus.Unversioned].includes(status)) fs.unlinkSync(file);
  }
  if (createdDirectory && fs.existsSync(createdDirectory) && fs.readdirSync(createdDirectory).length === 0) {
    const status = statusEntries(await svn(['status', '--xml', '--depth', 'empty', createdDirectory]))[0]?.item;
    if (status === SvnStatus.Added) await svn(['revert', '--depth', 'empty', createdDirectory]);
    if ([SvnStatus.Added, SvnStatus.Unversioned].includes(status)) fs.rmdirSync(createdDirectory);
  }
}

async function publishManifest(manifestPath, config, { dryRun = false } = {}) {
  const manifest = await readManifest(manifestPath);
  if (manifest.publicBaseUrl !== config.publicBaseUrl) throw new Error('Manifest download base differs from CODOWN_PUBLIC_BASE_URL; rebuilding is required for web installers.');
  const svn = svnClient(config);
  await inspectWorkingCopy(config, svn);
  const lock = path.join(config.workingCopy, '.svn', 'codown-publish.lock');
  if (!dryRun) {
    try { fs.mkdirSync(lock); } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`Another codown publisher holds ${lock}. If it was interrupted, confirm it stopped before removing that lock.`);
      throw error;
    }
  }
  const createdFiles = [];
  let createdDirectory;
  try {
    // Recheck after acquiring the lock, including changes from a previous run.
    await inspectWorkingCopy(config, svn);
    const remote = await remoteFiles(config, svn, manifest);
    const missing = manifest.artifacts.filter(artifact => !remote.existing.has(artifact.name));
    if (dryRun || !missing.length) return { revision: dryRun ? null : remote.revision, uploaded: [], reused: [...remote.existing], pending: missing.map(artifact => artifact.name), dryRun };
    const channelDir = path.join(config.workingCopy, manifest.keyfrom);
    if (fs.existsSync(channelDir) && !fs.lstatSync(channelDir).isDirectory()) throw new Error('The local channel path must be a regular directory.');
    await svn(['update', '--depth', 'empty', '--ignore-externals', config.workingCopy]);
    if (remote.channelExists) {
      await svn(['update', '--depth', 'empty', '--ignore-externals', channelDir]);
    } else {
      fs.mkdirSync(channelDir);
      createdDirectory = channelDir;
      await svn(['add', '--depth', 'empty', '--no-auto-props', channelDir]);
    }
    for (const artifact of missing) {
      const file = path.join(channelDir, artifact.name);
      fs.copyFileSync(path.join(path.dirname(path.resolve(manifestPath)), artifact.name), file, fs.constants.COPYFILE_EXCL);
      createdFiles.push({ file, sha256: artifact.sha256 });
      const copied = await fileDigest(file);
      if (copied.sha256 !== artifact.sha256 || copied.size !== artifact.size) throw new Error(`Copy verification failed: ${artifact.name}`);
      await svn(['add', '--depth', 'empty', '--no-auto-props', file]);
    }
    const targets = [...(createdDirectory ? [createdDirectory] : []), ...createdFiles.map(entry => entry.file)];
    const allowed = new Set(targets.map(file => path.resolve(file)));
    const pending = dirtyEntries(await svn(['status', '--xml', '--ignore-externals', config.workingCopy]));
    if (pending.some(entry => !allowed.has(path.resolve(entry.path)) || entry.item !== SvnStatus.Added)) {
      throw new Error('Working copy changed during publication; refusing to commit.');
    }
    await svn(['commit', '--depth', 'empty', '-m', `Publish LobsterAI ${manifest.version} ${manifest.keyfrom} ${manifest.target}${manifest.silent ? ' silent' : ''}`, ...targets]);
    // Read machine-readable committed metadata instead of localized CLI text.
    const info = await svn(['info', '--xml', createdFiles[0].file]);
    const revision = info.match(/<commit\s+revision="(\d+)"/)?.[1];
    if (!revision) throw new Error('Commit completed but its revision could not be read. Retry the saved manifest to verify the remote files.');
    return { revision, uploaded: missing.map(artifact => artifact.name), reused: [...remote.existing], dryRun: false };
  } catch (error) {
    try { await rollbackCreated(svn, createdFiles, createdDirectory); }
    catch (cleanupError) { error.message += ` Local cleanup needs attention: ${cleanupError.message}`; }
    throw error;
  } finally {
    if (!dryRun) fs.rmdirSync(lock);
  }
}

module.exports = { preflightSvn, publishManifest };
