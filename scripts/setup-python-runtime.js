#!/usr/bin/env node
/**
 * Prepare bundled Windows Python runtime under resources/python-win.
 *
 * This script mirrors setup-mingit.js behavior:
 * - Supports local offline archive via LOBSTERAI_PORTABLE_PYTHON_ARCHIVE
 * - Supports optional mirror URL via LOBSTERAI_PORTABLE_PYTHON_URL
 * - Can run cross-platform for Windows packaging
 * - Bundles interpreter runtime only (no preinstalled skill dependencies)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { spawnSync } = require('child_process');
const extractZip = require('extract-zip');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'resources', 'python-win');
const DEFAULT_ARCHIVE_PATH = path.join(PROJECT_ROOT, 'resources', 'python-win-runtime.zip');
const DEFAULT_WINDOWS_EMBED_PYTHON_VERSION = process.env.LOBSTERAI_WINDOWS_EMBED_PYTHON_VERSION || '3.11.9';
const DEFAULT_WINDOWS_EMBED_PYTHON_ZIP = `python-${DEFAULT_WINDOWS_EMBED_PYTHON_VERSION}-embed-amd64.zip`;
const DEFAULT_WINDOWS_EMBED_PYTHON_URL = process.env.LOBSTERAI_WINDOWS_EMBED_PYTHON_URL
  || `https://www.python.org/ftp/python/${DEFAULT_WINDOWS_EMBED_PYTHON_VERSION}/${DEFAULT_WINDOWS_EMBED_PYTHON_ZIP}`;
const DEFAULT_GET_PIP_URL = process.env.LOBSTERAI_WINDOWS_GET_PIP_URL || 'https://bootstrap.pypa.io/get-pip.py';
const DEFAULT_PIP_PYZ_URL = process.env.LOBSTERAI_WINDOWS_PIP_PYZ_URL || 'https://bootstrap.pypa.io/pip/pip.pyz';
const DEFAULT_RUNTIME_URL = DEFAULT_WINDOWS_EMBED_PYTHON_URL;

const REQUIRED_FILES = [
  'python.exe',
  'python3.exe',
];
const PIP_EXECUTABLE_CANDIDATES = [
  path.join('Scripts', 'pip.exe'),
  path.join('Scripts', 'pip3.exe'),
  path.join('Scripts', 'pip.cmd'),
  path.join('Scripts', 'pip3.cmd'),
  path.join('Scripts', 'pip'),
  path.join('Scripts', 'pip3'),
];
const PIP_RUNTIME_ARCHIVE_REL_PATH = path.join('tools', 'pip.pyz');
const PIP_MODULE_MAIN_REL_PATH = path.join('Lib', 'site-packages', 'pip', '__main__.py');
const PIP_MODULE_INIT_REL_PATH = path.join('Lib', 'site-packages', 'pip', '__init__.py');

function hasPipCommand(rootDir) {
  return PIP_EXECUTABLE_CANDIDATES.some((relPath) => fs.existsSync(path.join(rootDir, relPath)));
}

function hasPipModule(rootDir) {
  return fs.existsSync(path.join(rootDir, PIP_MODULE_MAIN_REL_PATH))
    || fs.existsSync(path.join(rootDir, PIP_MODULE_INIT_REL_PATH));
}

function parseArgs(argv) {
  return {
    required: argv.includes('--required'),
  };
}

function resolveInputPath(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
}

function isNonEmptyFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function getDirSize(dir) {
  let size = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      size += getDirSize(full);
    } else {
      size += fs.statSync(full).size;
    }
  }
  return size;
}

function checkRuntimeHealth(rootDir, options = {}) {
  const requirePython3Alias = options.requirePython3Alias !== false;
  const requirePip = options.requirePip !== false;
  const missing = [];
  for (const relPath of REQUIRED_FILES) {
    if (!requirePython3Alias && relPath === 'python3.exe') {
      continue;
    }
    const fullPath = path.join(rootDir, relPath);
    if (!fs.existsSync(fullPath)) {
      missing.push(relPath);
    }
  }

  if (requirePip) {
    if (!hasPipCommand(rootDir)) {
      missing.push('Scripts/pip.exe (or Scripts/pip3.exe/pip.cmd/pip3.cmd)');
    }
    if (!hasPipModule(rootDir)) {
      missing.push(PIP_MODULE_MAIN_REL_PATH.replace(/\\/g, '/'));
    }
  }

  return {
    ok: missing.length === 0,
    missing,
  };
}

function writeFileIfChanged(filePath, content) {
  try {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === content) {
      return;
    }
  } catch {
    // ignore stale read errors and rewrite below
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function createPipWrappers(rootDir) {
  const scriptsDir = path.join(rootDir, 'Scripts');
  const pipCmd = [
    '@echo off',
    'setlocal',
    'set "PYROOT=%~dp0.."',
    '"%PYROOT%\\python.exe" -m pip %*',
    '',
  ].join('\r\n');
  const pipSh = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'PYROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"',
    'exec "${PYROOT}/python.exe" -m pip "$@"',
    '',
  ].join('\n');

  writeFileIfChanged(path.join(scriptsDir, 'pip.cmd'), pipCmd);
  writeFileIfChanged(path.join(scriptsDir, 'pip3.cmd'), pipCmd);
  writeFileIfChanged(path.join(scriptsDir, 'pip'), pipSh);
  writeFileIfChanged(path.join(scriptsDir, 'pip3'), pipSh);
  try {
    fs.chmodSync(path.join(scriptsDir, 'pip'), 0o755);
    fs.chmodSync(path.join(scriptsDir, 'pip3'), 0o755);
  } catch {
    // Ignore chmod failures on filesystems without POSIX modes.
  }
}

function tryCopyPipFromHostPython(rootDir) {
  const pythonCandidates = ['python3', 'python'];
  for (const candidate of pythonCandidates) {
    const probe = spawnSync(candidate, [
      '-c',
      [
        'import importlib.util, json, pathlib',
        "spec = importlib.util.find_spec('pip')",
        'if spec is None or not spec.origin:',
        "  raise SystemExit(2)",
        'pip_dir = pathlib.Path(spec.origin).resolve().parent',
        'site_dir = pip_dir.parent',
        "dist_info = [str(p) for p in site_dir.glob('pip-*.dist-info')]",
        "print(json.dumps({'pip_dir': str(pip_dir), 'dist_info': dist_info}))",
      ].join('\n'),
    ], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 20_000,
    });

    if (probe.status !== 0 || !probe.stdout) {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(probe.stdout.trim());
    } catch {
      continue;
    }

    if (!parsed || typeof parsed.pip_dir !== 'string' || !parsed.pip_dir) {
      continue;
    }

    const pipDir = parsed.pip_dir;
    if (!fs.existsSync(pipDir)) {
      continue;
    }

    const targetSitePackages = path.join(rootDir, 'Lib', 'site-packages');
    const targetPipDir = path.join(targetSitePackages, 'pip');
    fs.mkdirSync(targetSitePackages, { recursive: true });
    fs.cpSync(pipDir, targetPipDir, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: true,
    });

    if (Array.isArray(parsed.dist_info)) {
      for (const entry of parsed.dist_info) {
        if (typeof entry !== 'string' || !entry) continue;
        if (!fs.existsSync(entry)) continue;
        const targetEntry = path.join(targetSitePackages, path.basename(entry));
        fs.cpSync(entry, targetEntry, {
          recursive: true,
          force: true,
          errorOnExist: false,
          dereference: true,
        });
      }
    }

    return { ok: true, source: candidate };
  }

  return { ok: false };
}

async function ensurePipPayload(rootDir, options = {}) {
  const required = options.required !== false;
  const existingPipHealth = checkRuntimeHealth(rootDir, { requirePip: true });
  if (existingPipHealth.ok) {
    return;
  }

  const copyResult = tryCopyPipFromHostPython(rootDir);
  if (copyResult.ok) {
    console.log(`[setup-python-runtime] Copied pip package from host ${copyResult.source}`);
    createPipWrappers(rootDir);
    const copiedHealth = checkRuntimeHealth(rootDir, { requirePip: true });
    if (copiedHealth.ok) {
      return;
    }
  }

  const pipPyzPath = path.join(rootDir, PIP_RUNTIME_ARCHIVE_REL_PATH);
  if (!isNonEmptyFile(pipPyzPath)) {
    try {
      console.log(`[setup-python-runtime] Downloading pip runtime from: ${DEFAULT_PIP_PYZ_URL}`);
      await downloadArchive(DEFAULT_PIP_PYZ_URL, pipPyzPath);
      const fileSizeKB = (fs.statSync(pipPyzPath).size / 1024).toFixed(0);
      console.log(`[setup-python-runtime] Downloaded pip runtime (${fileSizeKB} KB): ${pipPyzPath}`);
    } catch (error) {
      if (required) {
        throw new Error(
          'Unable to obtain pip runtime archive (pip.pyz). '
          + 'Set LOBSTERAI_WINDOWS_PIP_PYZ_URL to a reachable mirror if needed. '
          + `Original error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      console.warn(
        '[setup-python-runtime] pip runtime archive is not available; continuing without pip. '
        + `Reason: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
  }

  const pipModuleDir = path.join(rootDir, 'Lib', 'site-packages', 'pip');
  const pipInitPath = path.join(pipModuleDir, '__init__.py');
  const pipMainPath = path.join(pipModuleDir, '__main__.py');
  const pipMain = [
    'import pathlib',
    'import runpy',
    'import sys',
    '',
    'root = pathlib.Path(__file__).resolve().parents[3]',
    "pip_pyz = root / 'tools' / 'pip.pyz'",
    'if not pip_pyz.exists():',
    "    raise SystemExit(f'pip runtime archive missing: {pip_pyz}')",
    "sys.argv[0] = 'pip'",
    "runpy.run_path(str(pip_pyz), run_name='__main__')",
    '',
  ].join('\n');

  writeFileIfChanged(pipInitPath, '');
  writeFileIfChanged(pipMainPath, pipMain);
  createPipWrappers(rootDir);

  const finalHealth = checkRuntimeHealth(rootDir, { requirePip: true });
  if (!finalHealth.ok && required) {
    throw new Error(`Failed to prepare pip payload. Missing: ${finalHealth.missing.join(', ')}`);
  }
}

function ensurePython3Alias(rootDir) {
  const pythonExe = path.join(rootDir, 'python.exe');
  const python3Exe = path.join(rootDir, 'python3.exe');
  if (fs.existsSync(python3Exe) || !fs.existsSync(pythonExe)) {
    return;
  }
  fs.copyFileSync(pythonExe, python3Exe);
}

function findRuntimeRoot(baseDir) {
  const directHealth = checkRuntimeHealth(baseDir, { requirePython3Alias: false, requirePip: false });
  if (directHealth.ok) {
    return baseDir;
  }

  const queue = [baseDir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    const health = checkRuntimeHealth(current, { requirePython3Alias: false, requirePip: false });
    if (health.ok) {
      return current;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      queue.push(path.join(current, entry.name));
    }
  }

  return null;
}

async function downloadArchive(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status} ${response.statusText}) for ${url}`);
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tmpFile = `${destination}.download`;
  try {
    const stream = fs.createWriteStream(tmpFile);
    await pipeline(Readable.fromWeb(response.body), stream);

    if (!isNonEmptyFile(tmpFile)) {
      throw new Error('Downloaded archive is empty.');
    }
    fs.renameSync(tmpFile, destination);
  } catch (error) {
    try {
      fs.rmSync(tmpFile, { force: true });
    } catch {
      // Ignore cleanup error.
    }
    throw error;
  }
}

async function resolveArchive(required) {
  const envArchive = resolveInputPath(process.env.LOBSTERAI_PORTABLE_PYTHON_ARCHIVE);
  if (envArchive) {
    if (!isNonEmptyFile(envArchive)) {
      throw new Error(`LOBSTERAI_PORTABLE_PYTHON_ARCHIVE points to an invalid file: ${envArchive}`);
    }
    console.log(`[setup-python-runtime] Using local archive from LOBSTERAI_PORTABLE_PYTHON_ARCHIVE: ${envArchive}`);
    return { archivePath: envArchive, source: 'env-archive' };
  }

  if (isNonEmptyFile(DEFAULT_ARCHIVE_PATH)) {
    console.log(`[setup-python-runtime] Using cached archive: ${DEFAULT_ARCHIVE_PATH}`);
    return { archivePath: DEFAULT_ARCHIVE_PATH, source: 'cache' };
  }

  const urlFromEnv = typeof process.env.LOBSTERAI_PORTABLE_PYTHON_URL === 'string'
    ? process.env.LOBSTERAI_PORTABLE_PYTHON_URL.trim()
    : '';
  const downloadUrl = urlFromEnv || DEFAULT_RUNTIME_URL;

  if (!downloadUrl) {
    if (required) {
      throw new Error(
        'Portable Python archive is not available. '
        + 'Set LOBSTERAI_PORTABLE_PYTHON_ARCHIVE to a local package or '
        + 'LOBSTERAI_PORTABLE_PYTHON_URL to a downloadable runtime archive URL.'
      );
    }
    console.warn('[setup-python-runtime] Archive URL is not configured; skipping because --required is not set.');
    return null;
  }

  try {
    console.log(`[setup-python-runtime] Downloading runtime from: ${downloadUrl}`);
    await downloadArchive(downloadUrl, DEFAULT_ARCHIVE_PATH);
    const fileSizeMB = (fs.statSync(DEFAULT_ARCHIVE_PATH).size / 1024 / 1024).toFixed(1);
    console.log(`[setup-python-runtime] Downloaded archive (${fileSizeMB} MB): ${DEFAULT_ARCHIVE_PATH}`);
    return { archivePath: DEFAULT_ARCHIVE_PATH, source: 'download' };
  } catch (error) {
    if (required) {
      throw new Error(
        'Unable to obtain portable Python runtime archive. '
        + 'Set LOBSTERAI_PORTABLE_PYTHON_ARCHIVE to a local offline package or '
        + 'set LOBSTERAI_PORTABLE_PYTHON_URL to a reachable mirror. '
        + `Original error: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    console.warn(
      '[setup-python-runtime] Runtime archive is not available; skip because --required is not set. '
      + `Reason: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

function copyRuntimeTree(sourceRoot, destRoot) {
  if (fs.existsSync(destRoot)) {
    fs.rmSync(destRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(destRoot, { recursive: true });
  fs.cpSync(sourceRoot, destRoot, {
    recursive: true,
    dereference: true,
    force: true,
    errorOnExist: false,
  });
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: options.timeout || 5 * 60 * 1000,
    env: options.env || process.env,
  });

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`Command failed: ${command} ${args.join(' ')}${detail ? `\n${detail}` : ''}`);
  }
}

function enableSitePackages(rootDir) {
  const pthCandidates = fs.readdirSync(rootDir).filter((name) => name.endsWith('._pth'));
  if (pthCandidates.length === 0) {
    throw new Error('Could not find python _pth file in runtime directory.');
  }

  const pthPath = path.join(rootDir, pthCandidates[0]);
  const raw = fs.readFileSync(pthPath, 'utf-8');
  const lines = raw.split(/\r?\n/);
  const updated = [];
  let hasSitePackages = false;
  let hasImportSite = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'import site' || trimmed === '#import site') {
      updated.push('import site');
      hasImportSite = true;
      continue;
    }
    if (trimmed.toLowerCase() === 'lib\\site-packages' || trimmed.toLowerCase() === 'lib/site-packages') {
      updated.push('Lib\\site-packages');
      hasSitePackages = true;
      continue;
    }
    updated.push(line);
  }

  if (!hasSitePackages) {
    updated.push('Lib\\site-packages');
  }
  if (!hasImportSite) {
    updated.push('import site');
  }

  fs.writeFileSync(pthPath, `${updated.join('\n').replace(/\n+$/g, '')}\n`, 'utf8');
}

async function bootstrapRuntimeOnWindows() {
  if (process.platform !== 'win32') {
    throw new Error('Windows bootstrap is only supported on Windows hosts.');
  }

  console.log('[setup-python-runtime] No prebuilt archive provided, bootstrapping runtime from python.org on Windows host...');
  const tempRoot = fs.mkdtempSync(path.join(PROJECT_ROOT, 'tmp-python-bootstrap-'));
  try {
    const embedZipPath = path.join(tempRoot, DEFAULT_WINDOWS_EMBED_PYTHON_ZIP);
    await downloadArchive(DEFAULT_WINDOWS_EMBED_PYTHON_URL, embedZipPath);
    await extractArchiveToRuntime(embedZipPath);

    enableSitePackages(OUTPUT_DIR);
    ensurePython3Alias(OUTPUT_DIR);

    const pythonExe = path.join(OUTPUT_DIR, 'python.exe');
    if (!fs.existsSync(pythonExe)) {
      throw new Error('python.exe not found after extraction.');
    }

    const pipExe = path.join(OUTPUT_DIR, 'Scripts', 'pip.exe');
    if (!fs.existsSync(pipExe)) {
      try {
        const getPipPath = path.join(tempRoot, 'get-pip.py');
        await downloadArchive(DEFAULT_GET_PIP_URL, getPipPath);
        runCommand(pythonExe, [getPipPath], { timeout: 3 * 60 * 1000 });
      } catch (error) {
        console.warn(
          '[setup-python-runtime] Failed to bootstrap pip during Windows-host preparation. '
          + `Python runtime remains usable. Reason: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    await ensurePipPayload(OUTPUT_DIR, { required: true });
    const health = checkRuntimeHealth(OUTPUT_DIR, { requirePip: true });
    if (!health.ok) {
      throw new Error(`Bootstrapped runtime health check failed; missing: ${health.missing.join(', ')}`);
    }

    console.log('[setup-python-runtime] Windows bootstrap completed successfully');
  } finally {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  }
}

async function extractArchiveToRuntime(archivePath) {
  const tempRoot = fs.mkdtempSync(path.join(PROJECT_ROOT, 'tmp-python-runtime-'));
  try {
    await extractZip(archivePath, { dir: tempRoot });
    const runtimeRoot = findRuntimeRoot(tempRoot);
    if (!runtimeRoot) {
      throw new Error('Could not locate python runtime root after extraction.');
    }

    copyRuntimeTree(runtimeRoot, OUTPUT_DIR);
    enableSitePackages(OUTPUT_DIR);
    ensurePython3Alias(OUTPUT_DIR);
    await ensurePipPayload(OUTPUT_DIR, { required: true });

    const health = checkRuntimeHealth(OUTPUT_DIR, { requirePip: true });
    if (!health.ok) {
      throw new Error(
        `Runtime health check failed; missing: ${health.missing.join(', ')}. `
        + 'Please provide a valid Python runtime archive.'
      );
    }
  } finally {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  }
}

function findPortablePythonExecutable(baseDir = OUTPUT_DIR) {
  const candidates = [
    path.join(baseDir, 'python.exe'),
    path.join(baseDir, 'python3.exe'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function ensurePortablePythonRuntime(options = {}) {
  const required = Boolean(options.required);
  const shouldRun = process.platform === 'win32'
    || required
    || process.env.LOBSTERAI_SETUP_PYTHON_RUNTIME_FORCE === '1';

  if (!shouldRun) {
    console.log('[setup-python-runtime] Skip on non-Windows host (pass --required to force cross-platform preparation).');
    return { ok: true, skipped: true, pythonPath: null };
  }

  const existingBaseHealth = checkRuntimeHealth(OUTPUT_DIR, { requirePip: false });
  if (existingBaseHealth.ok) {
    await ensurePipPayload(OUTPUT_DIR, { required: true });
    const existingFullHealth = checkRuntimeHealth(OUTPUT_DIR, { requirePip: true });
    if (existingFullHealth.ok) {
      const pythonPath = findPortablePythonExecutable(OUTPUT_DIR);
      console.log(`[setup-python-runtime] Runtime already prepared: ${pythonPath || OUTPUT_DIR}`);
      return { ok: true, skipped: false, pythonPath };
    }
    console.warn(
      '[setup-python-runtime] Existing runtime found but pip support is incomplete; '
      + `missing: ${existingFullHealth.missing.join(', ')}. Re-extracting runtime...`
    );
  }

  const archive = await resolveArchive(required && process.platform !== 'win32');
  if (archive) {
    console.log(`[setup-python-runtime] Extracting runtime archive (${archive.source})...`);
    try {
      await extractArchiveToRuntime(archive.archivePath);
    } catch (error) {
      if (process.platform !== 'win32') {
        throw error;
      }
      console.warn(
        '[setup-python-runtime] Archive extraction or pip payload setup failed; '
        + `falling back to Windows bootstrap. Reason: ${error instanceof Error ? error.message : String(error)}`
      );
      await bootstrapRuntimeOnWindows();
    }
  } else if (process.platform === 'win32') {
    await bootstrapRuntimeOnWindows();
  } else if (required) {
    throw new Error(
      'Portable Python archive is not available for non-Windows host. '
      + 'Set LOBSTERAI_PORTABLE_PYTHON_ARCHIVE to a local package or '
      + 'LOBSTERAI_PORTABLE_PYTHON_URL to a downloadable runtime archive URL.'
    );
  } else {
    return { ok: true, skipped: true, pythonPath: null };
  }

  const pythonPath = findPortablePythonExecutable(OUTPUT_DIR);
  const finalHealth = checkRuntimeHealth(OUTPUT_DIR, { requirePip: true });
  if (!finalHealth.ok) {
    throw new Error(
      'Portable Python runtime is missing required pip components after preparation: '
      + finalHealth.missing.join(', ')
    );
  }
  const finalSize = getDirSize(OUTPUT_DIR);
  console.log(`[setup-python-runtime] Portable Python runtime ready: ${pythonPath || OUTPUT_DIR}`);
  console.log(`[setup-python-runtime] Total size: ~${(finalSize / 1024 / 1024).toFixed(1)} MB`);

  return { ok: true, skipped: false, pythonPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensurePortablePythonRuntime({ required: args.required });
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[setup-python-runtime] ERROR:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  ensurePortablePythonRuntime,
  findPortablePythonExecutable,
  checkRuntimeHealth,
};
