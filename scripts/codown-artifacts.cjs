'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { httpsUrl } = require('./codown-config.cjs');

const ReleaseTarget = {
  MacArm64: 'mac-arm64', MacX64: 'mac-x64', MacUniversal: 'mac-universal',
  WinChannel: 'win-channel', WinWeb: 'win-web', LinuxX64: 'linux-x64',
};
const ArtifactKind = { Installer: 'installer', WebInstaller: 'web-installer', Payload: 'payload' };
const MANIFEST_VERSION = 1;

function validateIdentity({ target, version, keyfrom, silent = false }) {
  if (!Object.values(ReleaseTarget).includes(target)) throw new Error(`Unsupported target: ${target}`);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid release version.');
  if (!/^[a-z0-9_-]{1,64}$/.test(keyfrom)) throw new Error('Invalid keyfrom: use 1-64 characters of a-z, 0-9, _ or -.');
  if (typeof silent !== 'boolean' || (silent && !isWindows(target))) throw new Error('--silent is only supported for Windows targets.');
}

function isWindows(target) {
  return target === ReleaseTarget.WinChannel || target === ReleaseTarget.WinWeb;
}

function payloadName(version, silent = false) {
  return `lobsterai-${version}${silent ? '-silent' : ''}.nsis.7z`;
}

function artifactUrl(base, keyfrom, name) {
  return `${httpsUrl(base, 'publicBaseUrl')}/${encodeURIComponent(keyfrom)}/${encodeURIComponent(name)}`;
}

function artifactPlan(identity) {
  validateIdentity(identity);
  const { target, version, keyfrom, silent = false } = identity;
  const suffix = silent ? '-silent' : '';
  if (isWindows(target)) {
    const artifacts = [{ kind: ArtifactKind.Installer, name: `lobsterai-${version}${suffix}.exe`, source: `LobsterAI-Setup-x64-${version}-${keyfrom}${suffix}.exe` }];
    if (target === ReleaseTarget.WinWeb) artifacts.push(
      { kind: ArtifactKind.WebInstaller, name: `lobsterai-${version}-web${suffix}.exe`, source: `nsis-web/LobsterAI-WebSetup-x64-${version}-${keyfrom}${suffix}.exe` },
      { kind: ArtifactKind.Payload, name: payloadName(version, silent), source: `nsis-web/lobsterai-${version}-x64.nsis.7z` },
    );
    return artifacts;
  }
  if (target === ReleaseTarget.LinuxX64) return [
    { kind: ArtifactKind.Installer, name: `lobsterai-${version}-x64.AppImage`, extension: '.AppImage' },
    { kind: ArtifactKind.Installer, name: `lobsterai-${version}-amd64.deb`, extension: '.deb' },
  ];
  const arch = target.slice('mac-'.length);
  return [{ kind: ArtifactKind.Installer, name: `lobsterai-${version}-${arch}.dmg`, source: `LobsterAI-darwin-${arch}-${version}-${keyfrom}.dmg` }];
}

async function fileDigest(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); size += chunk.length; }
  return { size, sha256: hash.digest('hex') };
}

function regularFile(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error(`Expected a regular file: ${file}`);
}

function sourceFiles(outputDir, identity) {
  return artifactPlan(identity).map(artifact => {
    let source = artifact.source;
    if (!source) {
      const matches = fs.readdirSync(outputDir).filter(name => name.endsWith(artifact.extension));
      if (matches.length !== 1) throw new Error(`Expected exactly one ${artifact.extension} artifact in the fresh build directory.`);
      [source] = matches;
    }
    const file = path.join(outputDir, source);
    regularFile(file);
    return { ...artifact, file };
  });
}

function manifestDirectory(root, identity) {
  validateIdentity(identity);
  return path.join(root, 'release', 'codown', identity.keyfrom, identity.version, `${identity.target}${identity.silent ? '-silent' : ''}`);
}

async function stageManifest(root, outputDir, identity, publicBaseUrl) {
  const destination = manifestDirectory(root, identity);
  if (fs.existsSync(destination)) throw new Error(`Release snapshot already exists: ${destination}. Use codown:publish to retry it, or archive it before rebuilding.`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(destination), '.staging-'));
  try {
    const artifacts = [];
    for (const artifact of sourceFiles(outputDir, identity)) {
      const file = path.join(staging, artifact.name);
      fs.copyFileSync(artifact.file, file, fs.constants.COPYFILE_EXCL);
      const digest = await fileDigest(file);
      if (!digest.size) throw new Error(`Empty artifact: ${artifact.name}`);
      artifacts.push({ kind: artifact.kind, name: artifact.name, ...digest });
    }
    const manifest = { schemaVersion: MANIFEST_VERSION, ...identity, publicBaseUrl: httpsUrl(publicBaseUrl, 'publicBaseUrl'), artifacts };
    fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(staging, destination);
    return path.join(destination, 'manifest.json');
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

async function readManifest(manifestPath) {
  const absolute = path.resolve(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  if (manifest.schemaVersion !== MANIFEST_VERSION) throw new Error('Unsupported manifest version.');
  validateIdentity(manifest);
  httpsUrl(manifest.publicBaseUrl, 'manifest.publicBaseUrl');
  const expected = artifactPlan(manifest);
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== expected.length) throw new Error('Incomplete artifact manifest.');
  for (const [index, artifact] of manifest.artifacts.entries()) {
    if (artifact.name !== expected[index].name || artifact.kind !== expected[index].kind) throw new Error('Manifest artifact names do not match the release identity.');
    const file = path.join(path.dirname(absolute), artifact.name);
    regularFile(file);
    const actual = await fileDigest(file);
    if (!actual.size || actual.size !== artifact.size || actual.sha256 !== artifact.sha256) throw new Error(`Artifact changed since build: ${artifact.name}`);
  }
  return manifest;
}

module.exports = { ReleaseTarget, ArtifactKind, validateIdentity, isWindows, payloadName, artifactUrl, artifactPlan, fileDigest, sourceFiles, manifestDirectory, stageManifest, readManifest };
