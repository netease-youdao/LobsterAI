#!/usr/bin/env node

/**
 * Windows 安装后资源 tar 解压脚本
 *
 * 由 NSIS installer.nsh 的 customInstall 宏调用。
 * 通过 LobsterAI.exe (ELECTRON_RUN_AS_NODE=1 模式) 执行。
 *
 * 用法: LobsterAI.exe <本脚本路径> <tarPath> <destDir>
 *
 * 效果:
 *   输入: $INSTDIR/resources/win-resources.tar
 *   输出: $INSTDIR/resources/cfmind/, SKILLs/, python-win/
 *   tar 文件由 NSIS 脚本在解压后删除
 *   全部目录校验通过后写入 <destDir>/.unpack-cfmind-ok 哨兵文件,
 *   供安装器在读不到本进程退出码的环境下兜底判定成功
 *
 * 依赖: 从 app.asar 内加载 tar npm 包 (Electron 内置 ASAR 透明读取支持)
 */

const fs = require('fs');
const path = require('path');

// Heartbeat: prove the script was actually invoked as Node.js (not Electron GUI)
try {
  const heartbeat = `${new Date().toISOString()} [unpack-cfmind] phase=script-started pid=${process.pid} node=${process.version} electron_run_as_node=${process.env.ELECTRON_RUN_AS_NODE || 'NOT_SET'}`;
  console.log(heartbeat);
  if (process.argv[4]) {
    fs.mkdirSync(path.dirname(process.argv[4]), { recursive: true });
    fs.appendFileSync(process.argv[4], heartbeat + '\n');
  }
} catch {}

// ============================================================
// 参数解析
// ============================================================

const tarPath = process.argv[2];
const destDir = process.argv[3];
const installLogPath = process.argv[4];

if (!tarPath || !destDir) {
  console.error('[unpack-cfmind] Usage: LobsterAI.exe unpack-cfmind.cjs <tarPath> <destDir>');
  process.exit(1);
}

if (!fs.existsSync(tarPath)) {
  console.error(`[unpack-cfmind] tar file not found: ${tarPath}`);
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
    console.error(`[unpack-cfmind] Failed to open install log: ${stringifyError(error)}`);
  }
}

function logLine(message) {
  const line = `${formatTimestamp()} ${message}`;
  console.log(line);
  if (logFd !== null) {
    try {
      fs.writeSync(logFd, `${line}\n`);
    } catch (error) {
      console.error(`${formatTimestamp()} [unpack-cfmind] Failed to write install log: ${stringifyError(error)}`);
      logFd = null;
    }
  }
}

function closeLogFile() {
  if (logFd === null) return;
  try {
    fs.closeSync(logFd);
  } catch {
    // Ignore cleanup errors.
  }
  logFd = null;
}

function formatMegabytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

// ============================================================
// 加载 tar 模块
// ============================================================

function loadTarModule() {
  // Strategy 1: Load from app.asar (Electron built-in ASAR read support)
  const resourcesDir = path.dirname(tarPath);
  const appAsar = path.join(resourcesDir, 'app.asar');
  const asarTarPath = path.join(appAsar, 'node_modules', 'tar');
  try {
    return require(asarTarPath);
  } catch (e) {
    logLine(`[unpack-cfmind] phase=load-tar-from-asar-failed error=${stringifyError(e)}`);
  }

  // Strategy 2: Direct require (may be in NODE_PATH)
  try {
    return require('tar');
  } catch {
    // Also failed
  }

  logLine('[unpack-cfmind] phase=load-tar-failed');
  logLine(`[unpack-cfmind] phase=load-tar-tried path=${asarTarPath}`);
  process.exit(1);
}

// ============================================================
// 执行解压
// ============================================================

process.on('uncaughtException', (err) => {
  logLine(`[unpack-cfmind] phase=uncaught-exception error=${stringifyError(err)}`);
  closeLogFile();
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logLine(`[unpack-cfmind] phase=unhandled-rejection error=${stringifyError(reason)}`);
  closeLogFile();
  process.exit(1);
});

try {
  logLine(`[unpack-cfmind] phase=extract-open tar=${tarPath}`);
  logLine(`[unpack-cfmind] phase=extract-destination dir=${destDir}`);

  const tar = loadTarModule();
  const t0 = Date.now();
  let extractedEntries = 0;
  let extractedBytes = 0;
  let currentRoot = '';
  let nextGlobalProgressBytes = 25 * 1024 * 1024;
  let nextRootProgressBytes = 25 * 1024 * 1024;
  const rootStats = new Map();

  // Ensure destination directory exists
  fs.mkdirSync(destDir, { recursive: true });

  // Extract tar using npm tar package (handles long paths, symlinks, etc.)
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
        logLine(`[unpack-cfmind] phase=root-start root=${root} entry=${entryPath}`);
      }

      if (extractedEntries <= 20 || extractedBytes >= nextGlobalProgressBytes) {
        const elapsedMs = Date.now() - t0;
        logLine(
          `[unpack-cfmind] phase=extract-progress entries=${extractedEntries} bytes=${extractedBytes} mb=${formatMegabytes(extractedBytes)} elapsed_ms=${elapsedMs} current=${entryPath}`,
        );
        while (extractedBytes >= nextGlobalProgressBytes) {
          nextGlobalProgressBytes += 25 * 1024 * 1024;
        }
      }

      if (stats.bytes >= nextRootProgressBytes) {
        const elapsedMs = Date.now() - stats.startedAtMs;
        logLine(
          `[unpack-cfmind] phase=root-progress root=${root} entries=${stats.entries} bytes=${stats.bytes} mb=${formatMegabytes(stats.bytes)} elapsed_ms=${elapsedMs} current=${entryPath}`,
        );
        while (stats.bytes >= nextRootProgressBytes) {
          nextRootProgressBytes += 25 * 1024 * 1024;
        }
      }
    },
  });

  const elapsedMs = Date.now() - t0;
  logLine(`[unpack-cfmind] phase=extract-complete entries=${extractedEntries} bytes=${extractedBytes} elapsed_ms=${elapsedMs}`);

  for (const [root, stats] of rootStats.entries()) {
    const elapsedMs = Date.now() - stats.startedAtMs;
    logLine(
      `[unpack-cfmind] phase=root-summary root=${root} entries=${stats.entries} bytes=${stats.bytes} mb=${formatMegabytes(stats.bytes)} elapsed_ms=${elapsedMs}`,
    );
  }

  // Verify key directories exist
  const expectedDirs = ['cfmind', 'SKILLs', 'python-win'];
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
      logLine(`[unpack-cfmind] phase=verify-ok dir=${dir}`);
    } else {
      missingDirs += 1;
      logLine(`[unpack-cfmind] phase=verify-missing dir=${dir}`);
    }
  }

  const gatewayBundlePath = path.join(destDir, 'cfmind', 'gateway-bundle.mjs');
  const requiredResourceChecks = [
    {
      name: 'cfmind-entry',
      ok: ['gateway-bundle.mjs', 'openclaw.mjs']
        .some(fileName => fs.existsSync(path.join(destDir, 'cfmind', fileName))),
    },
    {
      name: 'cfmind-bundle-assets',
      ok: !fs.existsSync(gatewayBundlePath)
        || fs.existsSync(path.join(destDir, 'cfmind', 'web-tree-sitter.wasm')),
    },
    {
      name: 'skills-content',
      ok: fs.existsSync(path.join(destDir, 'SKILLs'))
        && fs.readdirSync(path.join(destDir, 'SKILLs')).length > 0,
    },
    {
      name: 'python-entry',
      ok: ['python.exe', 'python3.exe']
        .some(fileName => fs.existsSync(path.join(destDir, 'python-win', fileName))),
    },
  ];
  const missingResources = requiredResourceChecks
    .filter(check => !check.ok)
    .map(check => check.name);
  for (const check of requiredResourceChecks) {
    logLine(
      `[unpack-cfmind] phase=${check.ok ? 'verify-ok' : 'verify-missing'} resource=${check.name}`,
    );
  }

  if (missingDirs > 0 || missingResources.length > 0) {
    throw new Error(
      `required resources missing after extraction: directories=${missingDirs}, resources=${missingResources.join(',') || 'none'}`,
    );
  }

  // Success sentinel for exit-code-blind environments: some security tooling
  // permanently breaks the exit-code query in the installer's PowerShell
  // watchdog ($p.ExitCode stays null after a successful wait), so the
  // verified result is also published as a file the installer can consult.
  // Best-effort: exit code 0 remains the primary success signal.
  if (missingDirs === 0 && missingResources.length === 0) {
    const sentinelPath = path.join(destDir, '.unpack-cfmind-ok');
    try {
      fs.writeFileSync(
        sentinelPath,
        `${formatTimestamp()} pid=${process.pid} entries=${extractedEntries} bytes=${extractedBytes}\n`,
      );
      logLine(`[unpack-cfmind] phase=sentinel-written path=${sentinelPath}`);
    } catch (error) {
      logLine(`[unpack-cfmind] phase=sentinel-write-failed error=${stringifyError(error)}`);
    }
  }

  logLine('[unpack-cfmind] phase=extract-ok');
  closeLogFile();
  process.exit(0);
} catch (err) {
  logLine(`[unpack-cfmind] phase=extract-failed error=${stringifyError(err)}`);
  closeLogFile();
  process.exit(1);
}
