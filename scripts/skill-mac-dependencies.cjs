'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { spawnSync } = require('child_process');
const { Arch } = require('builder-util');

const MAC_PLATFORM = 'darwin';
const MAC_ARCHES = ['arm64', 'x64'];
const CACHE_VERSION = '2';
const STAMP = '.lobster-skill-dependencies.json';
const UNIVERSAL_NATIVE_FILES = 'Contents/Resources/SKILLs/**/node_modules/@img/sharp-*darwin-*/**/*';

function targetArchitectures(context) {
  const universal = context.arch === Arch.universal
    || context.packager.info?.options?.targets?.get(context.packager.platform)?.has(Arch.universal);
  if (universal) return MAC_ARCHES;
  const arch = Arch[context.arch];
  if (!MAC_ARCHES.includes(arch)) throw new Error(`[skill-dependencies] Unsupported Mac architecture: ${arch}`);
  return [arch];
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function skillNames(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'package.json')))
    .map(entry => entry.name);
}

function matchesTarget(values, value) {
  return !values || (!values.includes(`!${value}`)
    && (!values.some(item => !item.startsWith('!')) || values.includes(value) || values.includes('any')));
}

function verifyMacBinary(file, arch) {
  const data = Buffer.alloc(32);
  const fd = fs.openSync(file, 'r');
  let bytesRead;
  try {
    bytesRead = fs.readSync(fd, data, 0, data.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const cpu = arch === 'arm64' ? 0x0100000c : 0x01000007;
  // Official Sharp macOS prebuilds are thin, little-endian 64-bit Mach-O files.
  if (bytesRead < data.length || data.readUInt32LE(0) !== 0xfeedfacf || data.readUInt32LE(4) !== cpu) {
    throw new Error(`[skill-dependencies] Expected ${arch} Mach-O binary: ${file}`);
  }
}

function verifySkill(root, lock, arches) {
  for (const [relative, entry] of Object.entries(lock.packages || {})) {
    if (!relative || entry.dev || entry.optional) continue;
    if (!matchesTarget(entry.os, 'darwin') || !arches.some(arch => matchesTarget(entry.cpu, arch))) continue;
    const installed = readJson(path.join(root, relative, 'package.json'));
    if (installed.version !== entry.version) throw new Error(`[skill-dependencies] Version mismatch: ${relative}`);
  }
  if (!lock.packages?.['node_modules/sharp']) return;
  for (const relative of ['lib/index.js', 'lib/sharp.js', 'lib/libvips.js']) {
    const file = path.join(root, 'node_modules/sharp', relative);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) {
      throw new Error(`[skill-dependencies] Missing Sharp runtime file: ${file}`);
    }
  }
  for (const arch of arches) {
    for (const name of [`sharp-darwin-${arch}`, `sharp-libvips-darwin-${arch}`]) {
      const relative = `node_modules/@img/${name}`;
      const expected = lock.packages[relative];
      if (!expected) throw new Error(`[skill-dependencies] Lockfile is missing ${relative}`);
      const installed = readJson(path.join(root, relative, 'package.json'));
      if (installed.version !== expected.version) throw new Error(`[skill-dependencies] Version mismatch: ${relative}`);
      const lib = path.join(root, relative, 'lib');
      const files = name.startsWith('sharp-libvips-')
        ? fs.readdirSync(lib).filter(file => /^libvips-cpp\..+\.dylib$/.test(file))
        : [`sharp-darwin-${arch}.node`];
      if (files.length === 0) throw new Error(`[skill-dependencies] Missing native payload: ${relative}`);
      for (const file of files) verifyMacBinary(path.join(lib, file), arch);
    }
  }
}

function installDependencies(root, arch) {
  const result = spawnSync('npm', ['ci', '--omit=dev', '--include=optional', '--os=darwin', `--cpu=${arch}`, '--no-audit', '--no-fund'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    env: {
      ...process.env,
      npm_config_platform: 'darwin',
      npm_config_arch: arch,
      SHARP_IGNORE_GLOBAL_LIBVIPS: '1',
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    },
  });
  if (result.status !== 0) {
    throw new Error(`[skill-dependencies] npm ci failed for ${path.basename(root)} (darwin-${arch}): ${result.error?.message || result.stderr?.slice(-2000) || result.stdout?.slice(-2000)}`);
  }
}

function prepareDependencyCache(source, cache, arch, install) {
  const manifest = fs.readFileSync(path.join(source, 'package.json'));
  const lockBytes = fs.readFileSync(path.join(source, 'package-lock.json'));
  const lock = JSON.parse(lockBytes.toString());
  if (!lock.packages) throw new Error(`[skill-dependencies] A modern lockfile is required: ${source}`);
  const fingerprint = createHash('sha256').update(CACHE_VERSION).update('darwin').update(arch)
    .update(process.versions.node).update(manifest).update(lockBytes).digest('hex');
  try {
    if (readJson(path.join(cache, STAMP)).fingerprint === fingerprint) {
      verifySkill(cache, lock, [arch]);
      console.log(`[skill-dependencies] Reusing validated darwin-${arch} dependencies for ${path.basename(source)}`);
      return cache;
    }
  } catch (error) {
    if (fs.existsSync(path.join(cache, STAMP))) {
      console.warn(`[skill-dependencies] Invalid cache for ${path.basename(source)} (darwin-${arch}); rebuilding:`, error);
    }
  }
  const started = Date.now();
  console.log(`[skill-dependencies] Installing ${path.basename(source)} for darwin-${arch}`);
  fs.rmSync(cache, { recursive: true, force: true });
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'package.json'), manifest);
  fs.writeFileSync(path.join(cache, 'package-lock.json'), lockBytes);
  try {
    install(cache, arch);
    verifySkill(cache, lock, [arch]);
  } catch (error) {
    throw new Error(`[skill-dependencies] Failed to prepare ${path.basename(source)} for darwin-${arch}: ${error.message}`, { cause: error });
  }
  fs.writeFileSync(path.join(cache, STAMP), JSON.stringify({ fingerprint }));
  console.log(`[skill-dependencies] Installed and verified ${path.basename(source)} for darwin-${arch} in ${Date.now() - started}ms`);
  return cache;
}

/** Keep developer node_modules out of packaging, even for a single x64 build. */
function prepareMacSkills(context, { projectDir = context.packager?.projectDir ?? path.join(__dirname, '..'), install = installDependencies } = {}) {
  if (context.electronPlatformName !== MAC_PLATFORM) return;
  const arches = targetArchitectures(context);
  console.log(`[skill-dependencies] Preparing Mac skills: host=${process.platform}-${process.arch}, target=darwin-${arches.join('+')}`);
  const source = path.join(projectDir, 'SKILLs');
  const cacheRoot = path.join(projectDir, 'node_modules', '.cache', 'lobsterai-skills');
  const payload = path.join(cacheRoot, `darwin-${arches.join('-')}`, 'SKILLs');
  fs.rmSync(payload, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(payload), { recursive: true });
  fs.cpSync(source, payload, {
    recursive: true,
    verbatimSymlinks: true,
    filter: file => !['node_modules', '.venv', '.git'].includes(path.basename(file)),
  });
  for (const name of skillNames(source)) {
    const skillSource = path.join(source, name);
    const destination = path.join(payload, name);
    for (const [index, arch] of arches.entries()) {
      const cache = prepareDependencyCache(skillSource, path.join(cacheRoot, 'dependencies', `darwin-${arch}`, name), arch, install);
      if (index === 0) {
        fs.cpSync(path.join(cache, 'node_modules'), path.join(destination, 'node_modules'), { recursive: true, verbatimSymlinks: true });
      } else if (fs.existsSync(path.join(cache, 'node_modules', '@img'))) {
        // Universal app inputs must have identical paths and bytes for these
        // platform-named prebuilds. Sharp selects the correct one at runtime.
        fs.cpSync(path.join(cache, 'node_modules', '@img'), path.join(destination, 'node_modules', '@img'), { recursive: true, verbatimSymlinks: true });
      }
    }
    // npm's hidden lockfile describes one architecture and is not a runtime resource.
    fs.rmSync(path.join(destination, 'node_modules', '.package-lock.json'), { force: true });
    verifySkill(destination, readJson(path.join(skillSource, 'package-lock.json')), arches);
  }
  const options = context.packager.platformSpecificBuildOptions;
  let replaced = false;
  options.extraResources = (options.extraResources || []).map(resource => {
    if (typeof resource !== 'string' && resource.to === 'SKILLs') {
      replaced = true;
      return { ...resource, from: payload };
    }
    return resource;
  });
  if (!replaced) throw new Error('[skill-dependencies] Missing SKILLs extraResources mapping');
  if (arches.length === 2 && !options.x64ArchFiles?.includes(UNIVERSAL_NATIVE_FILES)) {
    options.x64ArchFiles = options.x64ArchFiles
      ? `{${options.x64ArchFiles},${UNIVERSAL_NATIVE_FILES}}` : UNIVERSAL_NATIVE_FILES;
  }
  console.log(`[skill-dependencies] Mac skills payload ready: ${payload}`);
  return payload;
}

function verifyPackagedMacSkills(context, projectDir = context.packager?.projectDir ?? path.join(__dirname, '..')) {
  if (context.electronPlatformName !== MAC_PLATFORM) return;
  const source = path.join(projectDir, 'SKILLs');
  const resources = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'SKILLs');
  const arches = targetArchitectures(context);
  for (const name of skillNames(source)) {
    try {
      verifySkill(path.join(resources, name), readJson(path.join(source, name, 'package-lock.json')), arches);
    } catch (error) {
      throw new Error(`[skill-dependencies] Packaged ${name} failed validation for darwin-${arches.join('+')}: ${error.message}`, { cause: error });
    }
  }
  console.log(`[skill-dependencies] Verified packaged Mac skills for darwin-${arches.join('+')}: ${resources}`);
}

module.exports = { prepareMacSkills, verifyPackagedMacSkills, verifySkill, verifyMacBinary, targetArchitectures };
