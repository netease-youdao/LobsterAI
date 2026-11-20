#!/usr/bin/env node

/**
 * Windows post-install resource tar extractor.
 *
 * Invoked by NSIS scripts/nsis-installer.nsh customInstall via LobsterAI.exe
 * with ELECTRON_RUN_AS_NODE=1 when system bsdtar is unavailable or fails.
 *
 * Usage: LobsterAI.exe unpack-dsh-resources.cjs <tarPath> <destDir> [installLogPath]
 *
 * Extracts:
 *   - dsh-runtime/  (DeepSeek Harness bundled runtime)
 *   - dsh-bundles/  (@lobsterai/dsh-host + @lobsterai/dsh-channels)
 *   - SKILLs/       (bundled skills)
 *   - python-win/   (portable Python runtime)
 *
 * Writes <destDir>/.unpack-dsh-ok sentinel only after all required directories
 * and runtime entry files are verified present on disk.
 */

const fs = require('fs');
const path = require('path');

try {
  const heartbeat = `${new Date().toISOString()} [unpack-dsh-resources] phase=script-started pid=${process.pid} node=${process.version} electron_run_as_node=${process.env.ELECTRON_RUN_AS_NODE || 'NOT_SET'}`;
  console.log(heartbeat);
  if (process.argv[4]) {
    fs.mkdirSync(path.dirname(process.argv[4]), { recursive: true });
    fs.appendFileSync(process.argv[4], heartbeat + '\n');
  }
} catch {}

const tarPath = process.argv[2];
const destDir = process.argv[3];
const installLogPath = process.argv[4];

if (!tarPath || !destDir) {
  console.error('[unpack-dsh-resources] Usage: LobsterAI.exe unpack-dsh-resources.cjs <tarPath> <destDir>');
  process.exit(1);
}

if (!fs.existsSync(tarPath)) {
  console.error(`[unpack-dsh-resources] tar file not found: ${tarPath}`);
  process.exit(1);
}

function formatTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const milliseconds = String(date.getMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function stringifyError(error) {
  if (!error) return 'unknown error';
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

let logFd = null;
if (installLogPath) {
  try {
    fs.mkdirSync(path.dirname(installLogPath), { recursive: true });
    logFd = fs.openSync(installLogPath, 'a');
  } catch (error) {
    console.error(`[unpack-dsh-resources] Failed to open install log: ${stringifyError(error)}`);
  }
}

function logLine(message) {
  const line = `${formatTimestamp()} ${message}`;
  console.log(line);
  if (logFd !== null) {
    try {
      fs.writeSync(logFd, `${line}\n`);
    } catch (error) {
      console.error(`${formatTimestamp()} [unpack-dsh-resources] Failed to write install log: ${stringifyError(error)}`);
      logFd = null;
    }
  }
}

function closeLogFile() {
  if (logFd === null) return;
  try {
    fs.closeSync(logFd);
  } catch {}
  logFd = null;
}

function formatMegabytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function loadTarModule() {
  const resourcesDir = path.dirname(tarPath);
  const appAsar = path.join(resourcesDir, 'app.asar');
  const asarTarPath = path.join(appAsar, 'node_modules', 'tar');
  try {
    return require(asarTarPath);
  } catch (e) {
    logLine(`[unpack-dsh-resources] phase=load-tar-from-asar-failed error=${stringifyError(e)}`);
  }

  try {
    return require('tar');
  } catch {}

  logLine('[unpack-dsh-resources] phase=load-tar-failed');
  logLine(`[unpack-dsh-resources] phase=load-tar-tried path=${asarTarPath}`);
  process.exit(1);
}

process.on('uncaughtException', (err) => {
  logLine(`[unpack-dsh-resources] phase=uncaught-exception error=${stringifyError(err)}`);
  closeLogFile();
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logLine(`[unpack-dsh-resources] phase=unhandled-rejection error=${stringifyError(reason)}`);
  closeLogFile();
  process.exit(1);
});

try {
  logLine(`[unpack-dsh-resources] phase=extract-open tar=${tarPath}`);
  logLine(`[unpack-dsh-resources] phase=extract-destination dir=${destDir}`);

  const tar = loadTarModule();
  const t0 = Date.now();
  let extractedEntries = 0;
  let extractedBytes = 0;
  let currentRoot = '';
  let nextGlobalProgressBytes = 25 * 1024 * 1024;
  let nextRootProgressBytes = 25 * 1024 * 1024;
  const rootStats = new Map();

  fs.mkdirSync(destDir, { recursive: true });

  tar.extract({
    file: tarPath,
    cwd: destDir,
    sync: true,
    onentry: (entry) => {
      const entryPath = String(entry?.path || '');
      const root = entryPath.split(/[\\/]/)[0] || '(root)';
      const size = Number(entry?.size || 0);
      extractedEntries += 1;
      extractedBytes += size;

      const stats = rootStats.get(root) || {
        entries: 0,
        bytes: 0,
        startedAtMs: Date.now(),
      };
      stats.entries += 1;
      stats.bytes += size;
      rootStats.set(root, stats);

      if (root !== currentRoot) {
        currentRoot = root;
        nextRootProgressBytes = stats.bytes + (25 * 1024 * 1024);
        logLine(`[unpack-dsh-resources] phase=root-start root=${root} entry=${entryPath}`);
      }

      if (extractedEntries <= 20 || extractedBytes >= nextGlobalProgressBytes) {
        const elapsedMs = Date.now() - t0;
        logLine(
          `[unpack-dsh-resources] phase=extract-progress entries=${extractedEntries} bytes=${extractedBytes} mb=${formatMegabytes(extractedBytes)} elapsed_ms=${elapsedMs} current=${entryPath}`,
        );
        while (extractedBytes >= nextGlobalProgressBytes) {
          nextGlobalProgressBytes += 25 * 1024 * 1024;
        }
      }

      if (stats.bytes >= nextRootProgressBytes) {
        const elapsedMs = Date.now() - stats.startedAtMs;
        logLine(
          `[unpack-dsh-resources] phase=root-progress root=${root} entries=${stats.entries} bytes=${stats.bytes} mb=${formatMegabytes(stats.bytes)} elapsed_ms=${elapsedMs} current=${entryPath}`,
        );
        while (stats.bytes >= nextRootProgressBytes) {
          nextRootProgressBytes += 25 * 1024 * 1024;
        }
      }
    },
  });

  const elapsedMs = Date.now() - t0;
  logLine(`[unpack-dsh-resources] phase=extract-complete entries=${extractedEntries} bytes=${extractedBytes} elapsed_ms=${elapsedMs}`);

  for (const [root, stats] of rootStats.entries()) {
    const rootElapsedMs = Date.now() - stats.startedAtMs;
    logLine(
      `[unpack-dsh-resources] phase=root-summary root=${root} entries=${stats.entries} bytes=${stats.bytes} mb=${formatMegabytes(stats.bytes)} elapsed_ms=${rootElapsedMs}`,
    );
  }

  const expectedDirs = ['dsh-runtime', 'dsh-bundles', 'SKILLs', 'python-win'];
  let missingDirs = 0;
  for (const dir of expectedDirs) {
    const dirPath = path.join(destDir, dir);
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(dirPath).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (isDirectory) {
      logLine(`[unpack-dsh-resources] phase=verify-ok dir=${dir}`);
    } else {
      missingDirs += 1;
      logLine(`[unpack-dsh-resources] phase=verify-missing dir=${dir}`);
    }
  }

  const requiredResourceChecks = [
    {
      name: 'dsh-runtime-entry',
      ok: fs.existsSync(path.join(destDir, 'dsh-runtime', 'lib', 'bin.js'))
        && fs.existsSync(path.join(destDir, 'dsh-runtime', 'package.json')),
    },
    {
      name: 'dsh-host-bundle',
      ok: fs.existsSync(path.join(destDir, 'dsh-bundles', 'lobsterai-host', 'package.json')),
    },
    {
      name: 'dsh-channels-bundle',
      ok: fs.existsSync(path.join(destDir, 'dsh-bundles', 'lobsterai-channels', 'package.json')),
    },
    {
      name: 'skills-content',
      ok: fs.existsSync(path.join(destDir, 'SKILLs'))
        && fs.readdirSync(path.join(destDir, 'SKILLs')).length > 0,
    },
    {
      name: 'python-entry',
      ok: ['python.exe', 'python3.exe']
        .some((fileName) => fs.existsSync(path.join(destDir, 'python-win', fileName))),
    },
  ];
  const missingResources = requiredResourceChecks
    .filter((check) => !check.ok)
    .map((check) => check.name);
  for (const check of requiredResourceChecks) {
    logLine(
      `[unpack-dsh-resources] phase=${check.ok ? 'verify-ok' : 'verify-missing'} resource=${check.name}`,
    );
  }

  if (missingDirs > 0 || missingResources.length > 0) {
    throw new Error(
      `required resources missing after extraction: directories=${missingDirs}, resources=${missingResources.join(',') || 'none'}`,
    );
  }

  // Success sentinel for exit-code-blind environments where security tooling
  // breaks PowerShell's $p.ExitCode query even when extraction completed cleanly.
  if (missingDirs === 0 && missingResources.length === 0) {
    const sentinelPath = path.join(destDir, '.unpack-dsh-ok');
    try {
      fs.writeFileSync(
        sentinelPath,
        `${formatTimestamp()} pid=${process.pid} entries=${extractedEntries} bytes=${extractedBytes}\n`,
      );
      logLine(`[unpack-dsh-resources] phase=sentinel-written path=${sentinelPath}`);
    } catch (error) {
      logLine(`[unpack-dsh-resources] phase=sentinel-write-failed error=${stringifyError(error)}`);
    }
  }

  logLine('[unpack-dsh-resources] phase=extract-ok');
  closeLogFile();
  process.exit(0);
} catch (err) {
  logLine(`[unpack-dsh-resources] phase=extract-failed error=${stringifyError(err)}`);
  closeLogFile();
  process.exit(1);
}
