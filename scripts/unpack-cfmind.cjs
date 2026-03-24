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
 *
 * 依赖: 从 app.asar 内加载 tar npm 包 (Electron 内置 ASAR 透明读取支持)
 */

const fs = require('fs');
const path = require('path');

// ============================================================
// 参数解析
// ============================================================

const tarPath = process.argv[2];
const destDir = process.argv[3];

if (!tarPath || !destDir) {
  console.error('[unpack-cfmind] Usage: LobsterAI.exe unpack-cfmind.cjs <tarPath> <destDir>');
  process.exit(1);
}

if (!fs.existsSync(tarPath)) {
  console.error(`[unpack-cfmind] tar file not found: ${tarPath}`);
  process.exit(1);
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
    console.error(`[unpack-cfmind] Failed to load tar from asar: ${e.message}`);
  }

  // Strategy 2: Direct require (may be in NODE_PATH)
  try {
    return require('tar');
  } catch {
    // Also failed
  }

  console.error('[unpack-cfmind] Error: cannot load tar module');
  console.error(`[unpack-cfmind] Tried: ${asarTarPath}`);
  process.exit(1);
}

// ============================================================
// 执行解压
// ============================================================

try {
  console.log(`[unpack-cfmind] Extracting: ${tarPath}`);
  console.log(`[unpack-cfmind] Destination: ${destDir}`);

  const tar = loadTarModule();
  const t0 = Date.now();

  // Ensure destination directory exists
  fs.mkdirSync(destDir, { recursive: true });

  // Extract tar using npm tar package (handles long paths, symlinks, etc.)
  tar.extract({
    file: tarPath,
    cwd: destDir,
    sync: true,
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[unpack-cfmind] Done in ${elapsed}s`);

  // Verify key directories exist
  const expectedDirs = ['cfmind'];
  for (const dir of expectedDirs) {
    const dirPath = path.join(destDir, dir);
    if (fs.existsSync(dirPath)) {
      console.log(`[unpack-cfmind] Verified: ${dir}/`);
    } else {
      console.error(`[unpack-cfmind] Warning: expected directory missing: ${dir}/`);
    }
  }

  console.log('[unpack-cfmind] OK');
  process.exit(0);
} catch (err) {
  console.error(`[unpack-cfmind] Extraction failed: ${err.message}`);
  process.exit(1);
}
