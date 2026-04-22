import { app, session } from 'electron';
import { exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

import { type AppUpdateSource } from '../../shared/appUpdate/constants';

export interface AppUpdateDownloadProgress {
  received: number;
  total: number | undefined;
  percent: number | undefined;
  speed: number | undefined;
}

let activeDownloadController: AbortController | null = null;

export function cancelActiveDownload(): boolean {
  if (activeDownloadController) {
    console.log('[AppUpdate] Download cancelled by user');
    activeDownloadController.abort('cancelled');
    activeDownloadController = null;
    return true;
  }
  return false;
}

/** Escape a string for safe use as a single-quoted POSIX shell argument. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function execAsync(command: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\nstderr: ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/** Minimum interval between progress IPC events (ms). */
const PROGRESS_THROTTLE_MS = 200;

/** Abort download if no data received for this duration (ms). */
const DOWNLOAD_INACTIVITY_TIMEOUT_MS = 60_000;

export async function downloadUpdate(
  url: string,
  source: AppUpdateSource,
  onProgress: (progress: AppUpdateDownloadProgress) => void,
): Promise<string> {
  if (activeDownloadController) {
    throw new Error('A download is already in progress');
  }

  console.log(`[AppUpdate] Starting download: ${url}`);

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid download URL: ${url}`);
  }

  const ext = path.extname(parsedUrl.pathname) || (process.platform === 'darwin' ? '.dmg' : '.exe');
  const updateDir = path.join(app.getPath('userData'), 'updates');
  const ts = Date.now();
  const downloadPath = path.join(updateDir, `lobsterai-update-${source}-${ts}${ext}.download`);
  const finalPath = path.join(updateDir, `lobsterai-update-${source}-${ts}${ext}`);

  console.log(`[AppUpdate] Temp path: ${downloadPath}`);
  console.log(`[AppUpdate] Final path: ${finalPath}`);

  const controller = new AbortController();
  activeDownloadController = controller;

  let writeStream: fs.WriteStream | null = null;
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;

  const clearInactivityTimer = () => {
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
  };

  const resetInactivityTimer = () => {
    clearInactivityTimer();
    inactivityTimer = setTimeout(() => {
      console.error('[AppUpdate] Download inactivity timeout (60s), aborting');
      controller.abort('timeout');
    }, DOWNLOAD_INACTIVITY_TIMEOUT_MS);
  };

  try {
    const response = await session.defaultSession.fetch(url, {
      signal: controller.signal,
    });

    console.log(`[AppUpdate] HTTP response: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      throw new Error(`Download failed (HTTP ${response.status})`);
    }

    if (!response.body) {
      throw new Error('Response has no body');
    }

    const totalHeader = response.headers.get('content-length');
    const total = totalHeader ? Number(totalHeader) : undefined;
    console.log(`[AppUpdate] Content-Length: ${totalHeader ?? 'unknown'}`);

    let received = 0;
    let lastSpeedTime = Date.now();
    let lastSpeedBytes = 0;
    let currentSpeed: number | undefined = undefined;
    let lastProgressTime = 0;

    const emitProgress = () => {
      onProgress({
        received,
        total: total && Number.isFinite(total) ? total : undefined,
        percent: total && Number.isFinite(total) ? received / total : undefined,
        speed: currentSpeed,
      });
    };

    // Emit initial progress
    emitProgress();

    await fs.promises.mkdir(updateDir, { recursive: true });
    writeStream = fs.createWriteStream(downloadPath);

    const nodeStream = Readable.fromWeb(response.body as any);

    // Start inactivity timer
    resetInactivityTimer();

    nodeStream.on('data', (chunk: Buffer) => {
      received += chunk.length;

      // Reset inactivity timer on each chunk
      resetInactivityTimer();

      // Calculate speed with 1-second window
      const now = Date.now();
      const elapsed = now - lastSpeedTime;
      if (elapsed >= 1000) {
        currentSpeed = ((received - lastSpeedBytes) / elapsed) * 1000;
        lastSpeedTime = now;
        lastSpeedBytes = received;
      }

      // Throttle progress events to avoid flooding IPC channel
      if (now - lastProgressTime >= PROGRESS_THROTTLE_MS) {
        lastProgressTime = now;
        emitProgress();
      }
    });

    await pipeline(nodeStream, writeStream);
    writeStream = null;
    clearInactivityTimer();

    // Validate downloaded file
    const stat = await fs.promises.stat(downloadPath);
    console.log(`[AppUpdate] Download complete: ${stat.size} bytes`);

    if (stat.size === 0) {
      throw new Error('Downloaded file is empty');
    }
    if (total && Number.isFinite(total) && stat.size !== total) {
      throw new Error(`Download incomplete: expected ${total} bytes but got ${stat.size}`);
    }

    // Rename to final path (atomic on same filesystem)
    await fs.promises.rename(downloadPath, finalPath);
    console.log(`[AppUpdate] File saved to: ${finalPath}`);

    // Emit final 100% progress
    onProgress({
      received,
      total: total && Number.isFinite(total) ? total : received,
      percent: 1,
      speed: currentSpeed,
    });

    return finalPath;
  } catch (error) {
    clearInactivityTimer();
    console.error('[AppUpdate] Download error:', error);

    // Clean up partial download
    try {
      if (writeStream) {
        writeStream.destroy();
      }
      await fs.promises.unlink(downloadPath).catch(() => {});
    } catch {
      // Ignore cleanup errors
    }

    if (controller.signal.aborted) {
      if (controller.signal.reason === 'timeout') {
        throw new Error('Download timed out: no data received for 60 seconds');
      }
      throw new Error('Download cancelled');
    }
    throw error;
  } finally {
    activeDownloadController = null;
  }
}

export async function installUpdate(filePath: string): Promise<void> {
  console.log(`[AppUpdate] Installing update from: ${filePath}`);
  console.log(`[AppUpdate] Platform: ${process.platform}, Arch: ${process.arch}`);

  // Verify the file exists before attempting install
  try {
    const stat = await fs.promises.stat(filePath);
    console.log(`[AppUpdate] Installer file size: ${stat.size} bytes`);
    if (stat.size === 0) {
      throw new Error('Update file is empty');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Update file not found');
    }
    throw error;
  }

  if (process.platform === 'darwin') {
    return installMacDmg(filePath);
  }
  if (process.platform === 'win32') {
    return installWindowsNsis(filePath);
  }
  throw new Error('Unsupported platform');
}

async function installMacDmg(dmgPath: string): Promise<void> {
  // Strategy: we must NOT rm+cp the running .app in-process, because
  // deleting/overwriting the executable that is currently loaded causes
  // SIGBUS / page-fault freezes on macOS.
  //
  // Instead — like the Windows NSIS path — we:
  //   1. Mount the DMG now (validates it before we quit).
  //   2. Determine source .app and target path.
  //   3. Write a detached shell script that waits for our PID to exit,
  //      then performs the rm+cp, detaches the DMG, and relaunches.
  //   4. Call app.quit() so the process exits cleanly.

  let mountPoint: string | null = null;

  try {
    // Mount the DMG (timeout 60s) — validates the DMG before we commit to quitting
    console.log('[AppUpdate] Mounting DMG...');
    const mountOutput = await execAsync(
      `hdiutil attach ${shellEscape(dmgPath)} -nobrowse -noautoopen -noverify`,
      60_000,
    );

    // Parse mount point from output (last line, last column)
    const lines = mountOutput.split('\n').filter((l) => l.trim());
    const lastLine = lines[lines.length - 1];
    const mountMatch = lastLine?.match(/\t(\/Volumes\/.+)$/);
    if (!mountMatch) {
      throw new Error('Failed to determine mount point from hdiutil output');
    }
    mountPoint = mountMatch[1];
    console.log(`[AppUpdate] Mounted at: ${mountPoint}`);

    // Find .app bundle in mount point
    const entries = await fs.promises.readdir(mountPoint);
    const appBundle = entries.find((e) => e.endsWith('.app'));
    if (!appBundle) {
      throw new Error('No .app bundle found in DMG');
    }

    const sourceApp = path.join(mountPoint, appBundle);
    console.log(`[AppUpdate] Source app: ${sourceApp}`);

    // Determine target path: current running app location
    // process.resourcesPath is .app/Contents/Resources, go up 3 levels
    const currentAppPath = path.resolve(process.resourcesPath, '..', '..', '..');
    let targetApp: string;

    if (currentAppPath.endsWith('.app')) {
      targetApp = currentAppPath;
    } else {
      // Fallback to /Applications
      targetApp = `/Applications/${appBundle}`;
    }
    console.log(`[AppUpdate] Target app: ${targetApp}`);

    // Build the deferred-install shell script
    // Note: we use `open -a "$TARGET"` to relaunch, which is the standard
    // macOS way to open a .app bundle — no need to resolve the inner executable.
    const ts = Date.now();
    const tempDir = app.getPath('temp');
    const logPath = path.join(tempDir, `lobsterai-update-${ts}.log`);
    const scriptPath = path.join(tempDir, `lobsterai-update-${ts}.sh`);
    const appPid = process.pid;

    console.log(`[AppUpdate] Script log: ${logPath}`);

    const script = [
      '#!/bin/bash',
      '# LobsterAI macOS deferred-install script',
      `LOG=${shellEscape(logPath)}`,
      `APP_PID=${appPid}`,
      `SOURCE=${shellEscape(sourceApp)}`,
      `TARGET=${shellEscape(targetApp)}`,
      `MOUNT=${shellEscape(mountPoint)}`,
      `DMG=${shellEscape(dmgPath)}`,
      '',
      'log() { echo "[$(date "+%Y-%m-%d %H:%M:%S")] $*" >> "$LOG"; }',
      '',
      'log "Update script started (appPid=$APP_PID)"',
      '',
      '# Wait for the app to fully exit (max 120s)',
      'waited=0',
      'while [ $waited -lt 120 ]; do',
      '  if ! kill -0 "$APP_PID" 2>/dev/null; then',
      '    break',
      '  fi',
      '  sleep 1',
      '  waited=$((waited + 1))',
      'done',
      'log "App exited after ${waited}s"',
      '',
      '# Perform the copy (try normal first, fall back to admin privileges)',
      'log "Removing old app and copying new version..."',
      'if rm -rf "$TARGET" 2>>"$LOG" && cp -R "$SOURCE" "$TARGET" 2>>"$LOG"; then',
      '  log "Copy succeeded (normal permissions)"',
      'else',
      '  log "Normal copy failed, requesting admin privileges via osascript..."',
      // For the admin fallback, we bake the full osascript command as a literal
      // at script-generation time, avoiding bash variable expansion + quoting issues.
      // The inner shell command uses escaped double quotes for paths.
      `  if osascript -e ${shellEscape(`do shell script "rm -rf \\"${targetApp}\\" && cp -R \\"${sourceApp}\\" \\"${targetApp}\\"" with administrator privileges`)} 2>>"$LOG"; then`,
      '    log "Copy succeeded (admin privileges)"',
      '  else',
      '    log "Admin copy also failed (exit $?), giving up"',
      '    hdiutil detach "$MOUNT" -force >>/dev/null 2>&1',
      '    exit 1',
      '  fi',
      'fi',
      '',
      '# Detach DMG',
      'log "Detaching DMG: $MOUNT"',
      'hdiutil detach "$MOUNT" -force >>/dev/null 2>&1',
      'log "DMG detached"',
      '',
      '# Clean up downloaded DMG file',
      'rm -f "$DMG" 2>/dev/null',
      '',
      '# Relaunch the new version',
      'log "Relaunching: $TARGET"',
      'open -a "$TARGET"',
      'log "Done"',
    ].join('\n');

    await fs.promises.writeFile(scriptPath, script, { mode: 0o755 });
    console.log(`[AppUpdate] Install script written to: ${scriptPath}`);

    // Launch the script detached from this process
    const child = spawn('/bin/bash', [scriptPath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    console.log(`[AppUpdate] Script launched (PID ${child.pid}), calling app.quit()`);

    // Safety net: if before-quit cleanup takes too long (e.g. cowork session
    // teardown hangs), force-exit so the deferred install script can proceed.
    setTimeout(() => {
      console.warn('[AppUpdate] app.quit() did not exit within 10s, forcing exit');
      app.exit(0);
    }, 10_000).unref();

    app.quit();
  } catch (error) {
    console.error('[AppUpdate] macOS install error:', error);
    // Clean up mount point on error
    if (mountPoint) {
      try {
        await execAsync(`hdiutil detach ${shellEscape(mountPoint)} -force`, 30_000);
      } catch {
        // Best effort
      }
    }
    throw error;
  }
}

async function installWindowsNsis(exePath: string): Promise<void> {
  console.log(`[AppUpdate] Windows NSIS install (interactive mode)`);
  console.log(`[AppUpdate]   installer: ${exePath}`);
  console.log(`[AppUpdate]   appPid: ${process.pid}`);

  // We must NOT spawn the installer directly as a child of the app, because
  // the NSIS customInit macro runs `taskkill /IM "LobsterAI.exe" /F /T`
  // which kills the entire process tree — including child processes.
  //
  // Strategy: use a tiny PowerShell script (launched via hidden VBS) that
  // waits for the app to fully exit, then opens the installer with its
  // normal UI (no /S silent flag). This lets NSIS handle everything:
  // desktop shortcuts, start menu entries, "Run after finish", etc.
  const ts = Date.now();
  const tempDir = app.getPath('temp');
  const logPath = path.join(tempDir, `lobsterai-update-${ts}.log`);
  const scriptPath = path.join(tempDir, `lobsterai-update-${ts}.ps1`);
  const vbsPath = path.join(tempDir, `lobsterai-update-${ts}.vbs`);

  console.log(`[AppUpdate] Script log: ${logPath}`);

  const psEscape = (s: string) => s.replace(/'/g, "''");

  const psScript = [
    `$logPath = '${psEscape(logPath)}'`,
    `$appPid = ${process.pid}`,
    `$installerPath = '${psEscape(exePath)}'`,
    '',
    'function Log($msg) {',
    "    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'",
    '    Add-Content -Path $logPath -Value "[$ts] $msg" -Encoding UTF8',
    '}',
    '',
    'try {',
    '    Log "Update script started (appPid=$appPid)"',
    '',
    '    # Wait for the app to fully exit (by PID, max 120s)',
    '    $waited = 0',
    '    while ($waited -lt 120) {',
    '        try {',
    '            Get-Process -Id $appPid -ErrorAction Stop | Out-Null',
    '            Start-Sleep -Seconds 1',
    '            $waited++',
    '        } catch {',
    '            break',
    '        }',
    '    }',
    '    Log "App exited after $waited seconds"',
    '',
    '    # Launch installer with normal UI (NSIS handles shortcuts & relaunch)',
    '    Log "Launching installer: $installerPath"',
    '    Start-Process -FilePath $installerPath',
    '    Log "Done"',
    '} catch {',
    '    Log "ERROR: $($_.Exception.Message)"',
    '}',
  ].join('\r\n');

  await fs.promises.writeFile(scriptPath, '\ufeff' + psScript, 'utf-8');

  const vbsScript = `CreateObject("WScript.Shell").Run "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${scriptPath}""", 0, False`;
  await fs.promises.writeFile(vbsPath, vbsScript, 'utf-8');

  console.log('[AppUpdate] Launching installer via wscript.exe...');

  const launcher = spawn('wscript.exe', [vbsPath], {
    detached: true,
    stdio: 'ignore',
  });
  launcher.unref();

  console.log(`[AppUpdate] Launcher PID: ${launcher.pid}, calling app.quit()`);
  app.quit();
}
