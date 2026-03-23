import { app, BrowserWindow, ipcMain, session, nativeTheme, dialog, shell, nativeImage, systemPreferences, Menu, protocol, net, powerMonitor } from 'electron';
import type { WebContents } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { SqliteStore } from './sqliteStore';
import { CoworkStore } from './coworkStore';
import { CoworkRunner } from './libs/coworkRunner';
import {
  ClaudeRuntimeAdapter,
  CoworkEngineRouter,
  OpenClawRuntimeAdapter,
  type CoworkAgentEngine,
} from './libs/agentEngine';
import { SkillManager } from './skillManager';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { getCurrentApiConfig, resolveCurrentApiConfig, setStoreGetter } from './libs/claudeSettings';
import { saveCoworkApiConfig } from './libs/coworkConfigStore';
import { generateSessionTitle, probeCoworkModelReadiness } from './libs/coworkUtil';
import { startCoworkOpenAICompatProxy, stopCoworkOpenAICompatProxy } from './libs/coworkOpenAICompatProxy';
import { OpenClawEngineManager, type OpenClawEngineStatus } from './libs/openclawEngineManager';
import {
  listPairingRequests,
  approvePairingCode,
  rejectPairingRequest,
  readAllowFromStore,
} from './im/imPairingStore';
import { OpenClawConfigSync } from './libs/openclawConfigSync';
import {
  resolveMemoryFilePath,
  readMemoryEntries,
  addMemoryEntry,
  updateMemoryEntry,
  deleteMemoryEntry,
  searchMemoryEntries,
  migrateSqliteToMemoryMd,
  syncMemoryFileOnWorkspaceChange,
  readBootstrapFile,
  writeBootstrapFile,
  ensureDefaultIdentity,
} from './libs/openclawMemoryFile';
import {
  OpenClawChannelSessionSync,
  buildManagedSessionKey,
  DEFAULT_MANAGED_AGENT_ID,
} from './libs/openclawChannelSessionSync';
import { IMGatewayManager, IMPlatform, IMGatewayConfig } from './im';
import { APP_NAME } from './appConstants';
import { getSkillServiceManager } from './skillServices';
import { createTray, destroyTray, updateTrayMenu } from './trayManager';
import {
  registerStoreAndAppIpcHandlers,
  restorePreventSleep,
  registerCoworkIpcHandlers,
  registerSkillsIpcHandlers,
  registerMcpIpcHandlers,
  registerOpenClawIpcHandlers,
  registerScheduledTaskIpcHandlers,
  registerImIpcHandlers,
} from './ipcHandlers';
import {
  truncateIpcString,
  sanitizeCoworkMessageForIpc,
  sanitizePermissionRequestForIpc,
  IPC_UPDATE_CONTENT_MAX_CHARS,
} from './ipcHandlers/ipcUtils';
import { setLanguage } from './i18n';
import { isAutoLaunched, getAutoLaunchEnabled, setAutoLaunchEnabled } from './autoLaunchManager';
import { McpStore } from './mcpStore';
import { CronJobService } from './libs/cronJobService';
import { migrateScheduledTasksToOpenclaw, migrateScheduledTaskRunsToOpenclaw } from './libs/migrateScheduledTasks';
import { buildScheduledTaskEnginePrompt } from './libs/scheduledTaskEnginePrompt';
import { McpServerManager } from './libs/mcpServerManager';
import { McpBridgeServer } from './libs/mcpBridgeServer';
import type { McpBridgeConfig } from './libs/openclawConfigSync';
import { downloadUpdate, installUpdate, cancelActiveDownload } from './libs/appUpdateInstaller';
import { initLogger, getLogFilePath, getRecentMainLogEntries } from './logger';
import { getCoworkLogPath } from './libs/coworkLogger';
import { exportLogsZip } from './libs/logExport';
import { ensurePythonRuntimeReady } from './libs/pythonRuntime';
import {
  applySystemProxyEnv,
  resolveSystemProxyUrl,
  restoreOriginalProxyEnv,
  setSystemProxyEnabled,
} from './libs/systemProxy';

// 设置应用程序名称
app.name = APP_NAME;
app.setName(APP_NAME);

const SCHEDULED_TASK_CHANNEL_OPTIONS = [
  { value: 'last', label: 'Last conversation' },
  { value: 'dingtalk-connector', label: 'DingTalk' },
  { value: 'feishu', label: 'Feishu' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'discord', label: 'Discord' },
  { value: 'qqbot', label: 'QQ' },
  { value: 'wecom', label: 'WeCom' },
  { value: 'popo', label: 'POPO' },
] as const;

const configureUserDataPath = (): void => {
  const appDataPath = app.getPath('appData');
  const preferredUserDataPath = path.join(appDataPath, APP_NAME);
  const currentUserDataPath = app.getPath('userData');

  if (currentUserDataPath !== preferredUserDataPath) {
    app.setPath('userData', preferredUserDataPath);
    console.log(`[Main] userData path updated: ${currentUserDataPath} -> ${preferredUserDataPath}`);
  }
};

configureUserDataPath();
initLogger();

const isDev = process.env.NODE_ENV === 'development';
const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const DEV_SERVER_URL = process.env.ELECTRON_START_URL || 'http://localhost:5175';
const enableVerboseLogging =
  process.env.ELECTRON_ENABLE_LOGGING === '1' ||
  process.env.ELECTRON_ENABLE_LOGGING === 'true';
const disableGpu =
  process.env.LOBSTERAI_DISABLE_GPU === '1' ||
  process.env.LOBSTERAI_DISABLE_GPU === 'true' ||
  process.env.ELECTRON_DISABLE_GPU === '1' ||
  process.env.ELECTRON_DISABLE_GPU === 'true';
const reloadOnChildProcessGone =
  process.env.ELECTRON_RELOAD_ON_CHILD_PROCESS_GONE === '1' ||
  process.env.ELECTRON_RELOAD_ON_CHILD_PROCESS_GONE === 'true';
const TITLEBAR_HEIGHT = 48;
const TITLEBAR_COLORS = {
  dark: { color: '#0F1117', symbolColor: '#E4E5E9' },
  // Align light title bar with app light surface-muted tone to reduce visual contrast.
  light: { color: '#F3F4F6', symbolColor: '#1A1D23' },
} as const;


// ==================== macOS Permissions ====================

/**
 * Check calendar permission on macOS by attempting to access Calendar app
 * Returns: 'authorized' | 'denied' | 'restricted' | 'not-determined'
 * On Windows, checks if Outlook is available
 * On Linux, returns 'not-supported'
 */
const checkCalendarPermission = async (): Promise<string> => {
  if (process.platform === 'darwin') {
    try {
      // Try to access Calendar to check permission
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);

      // Quick test to see if we can access Calendar
      await execAsync('osascript -l JavaScript -e \'Application("Calendar").name()\'', { timeout: 5000 });
      console.log('[Permissions] macOS Calendar access: authorized');
      return 'authorized';
    } catch (error: any) {
      // Check if it's a permission error
      if (error.stderr?.includes('不能获取对象') ||
          error.stderr?.includes('not authorized') ||
          error.stderr?.includes('Permission denied')) {
        console.log('[Permissions] macOS Calendar access: not-determined (needs permission)');
        return 'not-determined';
      }
      console.warn('[Permissions] Failed to check macOS calendar permission:', error);
      return 'not-determined';
    }
  }

  if (process.platform === 'win32') {
    // Windows doesn't have a system-level calendar permission like macOS
    // Instead, we check if Outlook is available
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);

      // Check if Outlook COM object is accessible
      const checkScript = `
        try {
          $Outlook = New-Object -ComObject Outlook.Application
          $Outlook.Version
        } catch { exit 1 }
      `;
      await execAsync('powershell -Command "' + checkScript + '"', { timeout: 10000 });
      console.log('[Permissions] Windows Outlook is available');
      return 'authorized';
    } catch (error) {
      console.log('[Permissions] Windows Outlook not available or not accessible');
      return 'not-determined';
    }
  }

  return 'not-supported';
};

/**
 * Request calendar permission on macOS
 * On Windows, attempts to initialize Outlook COM object
 */
const requestCalendarPermission = async (): Promise<boolean> => {
  if (process.platform === 'darwin') {
    try {
      // On macOS, we trigger permission by trying to access Calendar
      // The system will show permission dialog if needed
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);

      await execAsync('osascript -l JavaScript -e \'Application("Calendar").calendars()[0].name()\'', { timeout: 10000 });
      return true;
    } catch (error) {
      console.warn('[Permissions] Failed to request macOS calendar permission:', error);
      return false;
    }
  }

  if (process.platform === 'win32') {
    // Windows doesn't have a permission dialog for COM objects
    // We just check if Outlook is available
    const status = await checkCalendarPermission();
    return status === 'authorized';
  }

  return false;
};



// 配置应用
// Linux/Windows 禁用 Chromium 沙箱：桌面应用渲染自有代码，风险可控；
// Windows 下以管理员运行时沙箱无法降权会导致 GPU 进程启动失败 (error_code=18)
if (isLinux || isWindows) {
  app.commandLine.appendSwitch('no-sandbox');
}
if (isLinux) {
  app.commandLine.appendSwitch('disable-dev-shm-usage');
}
if (disableGpu) {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  // 禁用硬件加速
  app.disableHardwareAcceleration();
}
if (enableVerboseLogging) {
  app.commandLine.appendSwitch('enable-logging');
  app.commandLine.appendSwitch('v', '1');
}

// 配置网络服务
app.on('ready', () => {
  // 配置网络服务重启策略
  app.configureHostResolver({
    enableBuiltInResolver: true,
    secureDnsMode: 'off'
  });
});

// 添加错误处理
app.on('render-process-gone', (_event, webContents, details) => {
  console.error('Render process gone:', details);
  const shouldReload =
    details.reason === 'crashed' ||
    details.reason === 'killed' ||
    details.reason === 'oom' ||
    details.reason === 'launch-failed' ||
    details.reason === 'integrity-failure';
  if (shouldReload) {
    scheduleReload(`render-process-gone (${details.reason})`, webContents);
  }
});

app.on('child-process-gone', (_event, details) => {
  console.error('Child process gone:', details);
  if (reloadOnChildProcessGone && (details.type === 'GPU' || details.type === 'Utility')) {
    scheduleReload(`child-process-gone (${details.type}/${details.reason})`);
  }
});

// 处理未捕获的异常
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});

process.on('exit', (code) => {
  console.log(`[Main] Process exiting with code: ${code}`);
});

let store: SqliteStore | null = null;
let coworkStore: CoworkStore | null = null;
let coworkRunner: CoworkRunner | null = null;
let claudeRuntimeAdapter: ClaudeRuntimeAdapter | null = null;
let openClawRuntimeAdapter: OpenClawRuntimeAdapter | null = null;
let coworkEngineRouter: CoworkEngineRouter | null = null;
let skillManager: SkillManager | null = null;
let mcpStore: McpStore | null = null;
let mcpServerManager: McpServerManager | null = null;
let mcpBridgeServer: McpBridgeServer | null = null;
let mcpBridgeSecret: string | null = null;
let mcpBridgeStartPromise: Promise<McpBridgeConfig | null> | null = null;
let imGatewayManager: IMGatewayManager | null = null;
let cronJobService: CronJobService | null = null;
let storeInitPromise: Promise<SqliteStore> | null = null;
let openClawEngineManager: OpenClawEngineManager | null = null;
let openClawConfigSync: OpenClawConfigSync | null = null;
let openClawBootstrapPromise: Promise<OpenClawEngineStatus> | null = null;
let openClawStatusForwarderBound = false;
let coworkRuntimeForwarderBound = false;
const memoryMigrationDone = false;

const initStore = async (): Promise<SqliteStore> => {
  if (!storeInitPromise) {
    if (!app.isReady()) {
      throw new Error('Store accessed before app is ready.');
    }
    storeInitPromise = Promise.race([
      SqliteStore.create(app.getPath('userData')),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Store initialization timed out after 15s')), 15_000)
      ),
    ]);
  }
  return storeInitPromise;
};

const getStore = (): SqliteStore => {
  if (!store) {
    throw new Error('Store not initialized. Call initStore() first.');
  }
  return store;
};

const getOpenClawEngineManager = (): OpenClawEngineManager => {
  if (!openClawEngineManager) {
    openClawEngineManager = new OpenClawEngineManager();
  }
  return openClawEngineManager;
};

const forwardOpenClawStatus = (status: OpenClawEngineStatus): void => {
  const windows = BrowserWindow.getAllWindows();
  windows.forEach((win) => {
    if (win.isDestroyed()) return;
    try {
      win.webContents.send('openclaw:engine:onProgress', status);
    } catch (error) {
      console.error('Failed to forward OpenClaw engine status:', error);
    }
  });
};

const bindOpenClawStatusForwarder = (): void => {
  if (openClawStatusForwarderBound) return;
  const manager = getOpenClawEngineManager();
  manager.on('status', (status) => {
    forwardOpenClawStatus(status);
  });
  openClawStatusForwarderBound = true;
  forwardOpenClawStatus(manager.getStatus());
};


const bootstrapOpenClawEngine = async (options: { forceReinstall?: boolean; reason?: string } = {}) => {
  if (openClawBootstrapPromise) {
    return openClawBootstrapPromise;
  }

  const manager = getOpenClawEngineManager();
  bindOpenClawStatusForwarder();

  const task = async (): Promise<OpenClawEngineStatus> => {
    const reason = options.reason || 'unknown';
    const t0 = Date.now();
    const elapsed = () => `${Date.now() - t0}ms`;
    try {
      console.log(`[OpenClaw] bootstrap starting (reason=${reason})`);

      // Start MCP Bridge before config sync so mcpBridge tools are included in openclaw.json
      const bridgeResult = await startMcpBridge().catch((err: unknown) => {
        console.error(`[OpenClaw] bootstrap: MCP bridge startup failed (non-fatal):`, err);
        return null as McpBridgeConfig | null;
      });
      console.log(`[OpenClaw] bootstrap: MCP bridge setup done (${elapsed()}), result=${bridgeResult ? `${bridgeResult.tools.length} tools` : 'null'}`);
      console.log(`[OpenClaw] bootstrap: mcpBridgeServer=${mcpBridgeServer?.callbackUrl || 'null'}, mcpServerManager.tools=${mcpServerManager?.toolManifest?.length ?? 'null'}, secret=${mcpBridgeSecret ? 'set' : 'null'}`);

      // Ensure IDENTITY.md has default content in the current workspace
      try {
        ensureDefaultIdentity(getCoworkStore().getConfig().workingDirectory);
      } catch (err) {
        console.warn('[OpenClaw] bootstrap: ensureDefaultIdentity failed (non-fatal):', err);
      }

      const syncResult = await syncOpenClawConfig({
        reason: `bootstrap:${reason}`,
        restartGatewayIfRunning: false,
      });
      console.log(`[OpenClaw] bootstrap: syncOpenClawConfig done (${elapsed()}), success=${syncResult.success}`);
      if (!syncResult.success) {
        return syncResult.status || manager.getStatus();
      }
      if (options.forceReinstall) {
        await manager.stopGateway();
        console.log(`[OpenClaw] bootstrap: stopGateway done (${elapsed()})`);
      }
      const ensuredStatus = await manager.ensureReady();
      console.log(`[OpenClaw] bootstrap: ensureReady done (${elapsed()}), phase=${ensuredStatus.phase}`);
      if (ensuredStatus.phase !== 'ready' && ensuredStatus.phase !== 'running') {
        return ensuredStatus;
      }
      const result = await manager.startGateway();
      console.log(`[OpenClaw] bootstrap completed (${elapsed()}), phase=${result.phase}`);
      return result;
    } catch (error) {
      console.error(`[OpenClaw] bootstrap failed (${reason}, ${elapsed()}):`, error);
      return manager.getStatus();
    }
  };

  const promise = task().finally(() => {
    if (openClawBootstrapPromise === promise) {
      openClawBootstrapPromise = null;
    }
  });
  openClawBootstrapPromise = promise;
  return promise;
};

const ensureOpenClawRunningForCowork = async () => {
  const manager = getOpenClawEngineManager();
  const status = manager.getStatus();
  if (status.phase === 'running') {
    return status;
  }
  if (status.phase === 'starting') {
    return status;
  }

  // Ensure MCP bridge is started and config is synced before launching the gateway,
  // so that mcpBridge tools are available in openclaw.json when the gateway loads.
  await startMcpBridge().catch((err: unknown) => {
    console.error('[OpenClaw] ensureRunning: MCP bridge startup failed (non-fatal):', err);
  });
  const syncResult = await syncOpenClawConfig({
    reason: 'ensureRunning:mcpBridge',
    restartGatewayIfRunning: false,
  });
  if (!syncResult.success) {
    console.error('[OpenClaw] ensureRunning: config sync failed:', syncResult.error);
  }

  return await manager.startGateway();
};

const getCoworkStore = () => {
  if (!coworkStore) {
    const sqliteStore = getStore();
    coworkStore = new CoworkStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
    const cleaned = coworkStore.autoDeleteNonPersonalMemories();
    if (cleaned > 0) {
      console.info(`[cowork-memory] Auto-deleted ${cleaned} non-personal/procedural memories`);
    }
  }
  return coworkStore;
};

const resolveCoworkAgentEngine = (): CoworkAgentEngine => {
  const configured = getCoworkStore().getConfig().agentEngine;
  return configured === 'openclaw' ? 'openclaw' : 'yd_cowork';
};

const getOpenClawConfigSync = (): OpenClawConfigSync => {
  if (!openClawConfigSync) {
    openClawConfigSync = new OpenClawConfigSync({
      engineManager: getOpenClawEngineManager(),
      getCoworkConfig: () => getCoworkStore().getConfig(),
      getSkillsList: () => getSkillManager().listSkills().map(s => ({ id: s.id, enabled: s.enabled })),
      getTelegramOpenClawConfig: () => {
        try {
          return getIMGatewayManager()?.getConfig()?.telegram ?? null;
        } catch {
          return null;
        }
      },
      getDingTalkConfig: () => {
        try {
          return getIMGatewayManager().getConfig().dingtalk;
        } catch {
          return null;
        }
      },
      getFeishuConfig: () => {
        try {
          return getIMGatewayManager().getConfig().feishu;
        } catch {
          return null;
        }
      },
      getQQConfig: () => {
        try {
          return getIMGatewayManager().getConfig().qq;
        } catch {
          return null;
        }
      },
      getWecomConfig: () => {
        try {
          return getIMGatewayManager().getConfig().wecom;
        } catch {
          return null;
        }
      },
      getPopoConfig: () => {
        try {
          return getIMGatewayManager().getConfig().popo;
          } catch {
          return null;
        }
      },
      getNimConfig: () => {
        try {
          return getIMGatewayManager().getConfig().nim;
        } catch {
          return null;
        }
      },
      getWeixinConfig: () => {
        try {
          return getIMGatewayManager().getConfig().weixin;
        } catch {
          return null;
        }
      },
      getDiscordOpenClawConfig: () => {
        try {
          return getIMGatewayManager()?.getConfig()?.discord ?? null;
        } catch {
          return null;
        }
      },
      getMcpBridgeConfig: (): McpBridgeConfig | null => {
        if (!mcpBridgeServer?.callbackUrl || !mcpServerManager?.toolManifest?.length || !mcpBridgeSecret) {
          return null;
        }
        return {
          callbackUrl: mcpBridgeServer.callbackUrl,
          secret: mcpBridgeSecret,
          tools: mcpServerManager.toolManifest,
        };
      },
    });
  }
  return openClawConfigSync;
};

// Deferred gateway restart: when a config change requires a gateway restart
// but active cowork sessions exist, we defer the restart until all sessions
// complete.  A polling interval checks periodically; a hard timeout ensures
// the restart eventually happens even if a session hangs.
let deferredRestartTimer: ReturnType<typeof setInterval> | null = null;
let deferredRestartTimeout: ReturnType<typeof setTimeout> | null = null;
const DEFERRED_RESTART_POLL_MS = 3_000;
const DEFERRED_RESTART_MAX_WAIT_MS = 5 * 60_000; // 5 minutes hard cap

const clearDeferredRestart = () => {
  if (deferredRestartTimer) { clearInterval(deferredRestartTimer); deferredRestartTimer = null; }
  if (deferredRestartTimeout) { clearTimeout(deferredRestartTimeout); deferredRestartTimeout = null; }
};

const executeDeferredGatewayRestart = async (reason: string) => {
  clearDeferredRestart();
  console.log(`[OpenClaw] executeDeferredGatewayRestart: performing deferred restart (reason: ${reason})`);
  await syncOpenClawConfig({ reason: `deferred:${reason}`, restartGatewayIfRunning: true });
};

const scheduleDeferredGatewayRestart = (reason: string) => {
  // If already scheduled, the latest config is already on disk — just let
  // the existing timer handle the restart.
  if (deferredRestartTimer) {
    console.log(`[OpenClaw] scheduleDeferredGatewayRestart: already scheduled, skipping (reason: ${reason})`);
    return;
  }

  deferredRestartTimer = setInterval(() => {
    if (!openClawRuntimeAdapter?.hasActiveSessions()) {
      void executeDeferredGatewayRestart(reason);
    }
  }, DEFERRED_RESTART_POLL_MS);

  // Hard timeout: restart anyway after max wait to avoid config drift.
  deferredRestartTimeout = setTimeout(() => {
    console.warn(`[OpenClaw] scheduleDeferredGatewayRestart: max wait exceeded, forcing restart (reason: ${reason})`);
    void executeDeferredGatewayRestart(reason);
  }, DEFERRED_RESTART_MAX_WAIT_MS);
};

const syncOpenClawConfig = async (
  options: { reason: string; restartGatewayIfRunning?: boolean } = { reason: 'unknown' },
): Promise<{ success: boolean; changed: boolean; status?: OpenClawEngineStatus; error?: string }> => {
  // When a restart would be needed and there are active sessions, defer the
  // entire sync (including the config file write) to avoid triggering
  // OpenClaw's built-in file-watcher reload (SIGUSR1) which would kill
  // in-flight conversations even without our explicit gateway restart.
  if (options.restartGatewayIfRunning && openClawRuntimeAdapter?.hasActiveSessions()) {
    const manager = getOpenClawEngineManager();
    const status = manager.getStatus();
    if (status.phase === 'running') {
      console.log(`[OpenClaw] syncOpenClawConfig: deferring entire config sync because active sessions exist (reason: ${options.reason})`);
      scheduleDeferredGatewayRestart(options.reason);
      return {
        success: true,
        changed: false,
        status,
      };
    }
  }

  const syncResult = getOpenClawConfigSync().sync(options.reason);
  if (!syncResult.ok) {
    const status = getOpenClawEngineManager().setExternalError(
      `OpenClaw config sync failed: ${syncResult.error || 'unknown error'}`,
    );
    return {
      success: false,
      changed: false,
      status,
      error: syncResult.error,
    };
  }

  // Update secret env vars so the gateway process receives the latest
  // plaintext credentials via environment variables (openclaw.json only
  // contains ${VAR} placeholders, never plaintext secrets).
  const nextSecretEnvVars = getOpenClawConfigSync().collectSecretEnvVars();
  const prevSecretEnvVars = getOpenClawEngineManager().getSecretEnvVars();
  const secretEnvVarsChanged = JSON.stringify(nextSecretEnvVars) !== JSON.stringify(prevSecretEnvVars);
  getOpenClawEngineManager().setSecretEnvVars(nextSecretEnvVars);

  // When secret env vars change, the running gateway must be restarted even if
  // the caller didn't request it — the ${VAR} placeholders in openclaw.json
  // resolve from the process environment which is fixed at spawn time.
  const needsRestart = syncResult.changed || secretEnvVarsChanged;

  if (!needsRestart || (!options.restartGatewayIfRunning && !secretEnvVarsChanged)) {
    return {
      success: true,
      changed: syncResult.changed,
    };
  }

  const manager = getOpenClawEngineManager();
  const status = manager.getStatus();
  if (status.phase !== 'running') {
    return {
      success: true,
      changed: true,
      status,
    };
  }

  // Tear down the runtime adapter's WebSocket client BEFORE killing the gateway process.
  // This prevents a race where the old client's async `onClose` fires after a new client
  // has already been created, destroying the new connection.
  if (openClawRuntimeAdapter) {
    console.log(`[OpenClaw] syncOpenClawConfig: pre-emptively disconnecting runtime adapter before gateway restart (reason: ${options.reason})`);
    openClawRuntimeAdapter.disconnectGatewayClient();
  }

  await manager.stopGateway();
  const restarted = await manager.startGateway();
  if (restarted.phase !== 'running') {
    return {
      success: false,
      changed: true,
      status: restarted,
      error: restarted.message || 'Failed to restart OpenClaw gateway after config sync.',
    };
  }
  return {
    success: true,
    changed: true,
    status: restarted,
  };
};

const getCoworkRunner = () => {
  if (!coworkRunner) {
    coworkRunner = new CoworkRunner(getCoworkStore());

    // Provide MCP server configuration to the runner
    coworkRunner.setMcpServerProvider(() => {
      return getMcpStore().getEnabledServers();
    });
  }
  return coworkRunner;
};

const bindCoworkRuntimeForwarder = (): void => {
  if (coworkRuntimeForwarderBound) return;
  const runtime = getCoworkEngineRouter();

  runtime.on('message', (sessionId: string, message: any) => {
    const safeMessage = sanitizeCoworkMessageForIpc(message);
    const windows = BrowserWindow.getAllWindows();
    console.log('[CoworkForwarder] forwarding message: sessionId=', sessionId, 'type=', message?.type, 'windowCount=', windows.length);
    windows.forEach((win) => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send('cowork:stream:message', { sessionId, message: safeMessage });
      } catch (error) {
        console.error('Failed to forward cowork message:', error);
      }
    });
  });

  runtime.on('messageUpdate', (sessionId: string, messageId: string, content: string) => {
    const safeContent = truncateIpcString(content, IPC_UPDATE_CONTENT_MAX_CHARS);
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((win) => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send('cowork:stream:messageUpdate', { sessionId, messageId, content: safeContent });
      } catch (error) {
        console.error('Failed to forward cowork message update:', error);
      }
    });
  });

  runtime.on('permissionRequest', (sessionId: string, request: any) => {
    if (runtime.getSessionConfirmationMode(sessionId) === 'text') {
      return;
    }
    const safeRequest = sanitizePermissionRequestForIpc(request);
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((win) => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send('cowork:stream:permission', { sessionId, request: safeRequest });
      } catch (error) {
        console.error('Failed to forward cowork permission request:', error);
      }
    });
  });

  runtime.on('complete', (sessionId: string, claudeSessionId: string | null) => {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((win) => {
      if (win.isDestroyed()) return;
      win.webContents.send('cowork:stream:complete', { sessionId, claudeSessionId });
    });
  });

  runtime.on('error', (sessionId: string, error: string) => {
    // Mark session as error in store so the .catch() fallback can detect duplicates.
    try { getCoworkStore().updateSession(sessionId, { status: 'error' }); } catch { /* ignore */ }
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((win) => {
      if (win.isDestroyed()) return;
      win.webContents.send('cowork:stream:error', { sessionId, error });
    });
  });

  coworkRuntimeForwarderBound = true;
};

const getCoworkEngineRouter = () => {
  if (!coworkEngineRouter) {
    if (!claudeRuntimeAdapter) {
      claudeRuntimeAdapter = new ClaudeRuntimeAdapter(getCoworkRunner());
    }
    if (!openClawRuntimeAdapter) {
      openClawRuntimeAdapter = new OpenClawRuntimeAdapter(getCoworkStore(), getOpenClawEngineManager());
      // Wire up channel session sync for IM conversations via OpenClaw
      try {
        const imManager = getIMGatewayManager();
        const imStore = imManager.getIMStore();
        if (imStore) {
          const channelSessionSync = new OpenClawChannelSessionSync({
            coworkStore: getCoworkStore(),
            imStore,
            getDefaultCwd: () => getCoworkStore().getConfig().workingDirectory || os.homedir(),
            resolveJobName: (jobId) => getCronJobService().getJobNameSync(jobId),
          });
          openClawRuntimeAdapter.setChannelSessionSync(channelSessionSync);
        }
      } catch (error) {
        console.warn('[Main] Failed to set up channel session sync:', error);
      }
    }
    coworkEngineRouter = new CoworkEngineRouter({
      getCurrentEngine: resolveCoworkAgentEngine,
      openclawRuntime: openClawRuntimeAdapter,
      claudeRuntime: claudeRuntimeAdapter,
    });
  }
  return coworkEngineRouter;
};

const getSkillManager = () => {
  if (!skillManager) {
    skillManager = new SkillManager(getStore);
  }
  return skillManager;
};

const getMcpStore = () => {
  if (!mcpStore) {
    const sqliteStore = getStore();
    mcpStore = new McpStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  }
  return mcpStore;
};

/**
 * Start the MCP Bridge: server manager + HTTP callback.
 * Called during OpenClaw bootstrap before config sync.
 * Returns the bridge config to be written into openclaw.json.
 */
const startMcpBridge = (): Promise<McpBridgeConfig | null> => {
  // Deduplicate concurrent calls — only one initialization at a time
  if (mcpBridgeStartPromise) {
    return mcpBridgeStartPromise;
  }
  mcpBridgeStartPromise = (async (): Promise<McpBridgeConfig | null> => {
  try {
    console.log('[McpBridge] startMcpBridge called');
    const enabledServers = getMcpStore().getEnabledServers();
    console.log(`[McpBridge] enabledServers: ${enabledServers.length} (${enabledServers.map(s => s.name).join(', ')})`);
    if (enabledServers.length === 0) {
      console.log('[McpBridge] no enabled MCP servers, skipping bridge startup');
      return null;
    }

    // Generate a per-session secret for bridge auth
    if (!mcpBridgeSecret) {
      const crypto = await import('crypto');
      mcpBridgeSecret = crypto.randomUUID();
    }
    console.log('[McpBridge] secret generated');

    // Start server manager and discover tools
    if (!mcpServerManager) {
      mcpServerManager = new McpServerManager();
    }
    console.log('[McpBridge] starting MCP servers...');
    const tools = await mcpServerManager.startServers(enabledServers);
    console.log(`[McpBridge] tools discovered: ${tools.length}`);
    if (tools.length === 0) {
      console.log('[McpBridge] no tools discovered from MCP servers');
      return null;
    }

    // Start HTTP callback server
    if (!mcpBridgeServer) {
      mcpBridgeServer = new McpBridgeServer(mcpServerManager, mcpBridgeSecret);
    }
    if (!mcpBridgeServer.port) {
      console.log('[McpBridge] starting HTTP callback server...');
      await mcpBridgeServer.start();
    }

    const callbackUrl = mcpBridgeServer.callbackUrl;
    if (!callbackUrl) {
      console.error('[McpBridge] failed to get callback URL');
      return null;
    }

    console.log(`[McpBridge] started: ${tools.length} tools, callback=${callbackUrl}`);
    return { callbackUrl, secret: mcpBridgeSecret, tools };
  } catch (error) {
    console.error('[McpBridge] startup error:', error instanceof Error ? error.stack || error.message : String(error));
    return null;
  }
  })().finally(() => {
    mcpBridgeStartPromise = null;
  });
  return mcpBridgeStartPromise;
};

/**
 * Stop the MCP Bridge: server manager + HTTP callback.
 */
const stopMcpBridge = async (): Promise<void> => {
  try {
    if (mcpServerManager) {
      await mcpServerManager.stopServers();
    }
    if (mcpBridgeServer) {
      await mcpBridgeServer.stop();
    }
  } catch (error) {
    console.error('[McpBridge] shutdown error:', error instanceof Error ? error.message : String(error));
  }
};

/**
 * Refresh the MCP Bridge after server config changes:
 * stop existing MCP servers → restart with new config → sync openclaw.json → restart gateway.
 * Returns a summary for the renderer to display.
 */
let mcpBridgeRefreshPromise: Promise<{ tools: number; error?: string }> | null = null;

const refreshMcpBridge = (): Promise<{ tools: number; error?: string }> => {
  if (mcpBridgeRefreshPromise) {
    return mcpBridgeRefreshPromise;
  }
  mcpBridgeRefreshPromise = (async () => {
    try {
      console.log('[McpBridge] refreshing after config change...');

      // 1. Stop existing MCP servers (but keep HTTP callback server alive — port stays the same)
      if (mcpServerManager) {
        await mcpServerManager.stopServers();
      }

      // 2. Re-discover tools from the new set of enabled servers
      const bridgeConfig = await startMcpBridge();
      const toolCount = bridgeConfig?.tools.length ?? 0;
      console.log(`[McpBridge] refresh: ${toolCount} tools discovered`);

      // 3. Sync openclaw.json and restart gateway if running
      const syncResult = await syncOpenClawConfig({
        reason: 'mcp-server-changed',
        restartGatewayIfRunning: true,
      });
      if (!syncResult.success) {
        console.error('[McpBridge] refresh: config sync failed:', syncResult.error);
        return { tools: toolCount, error: syncResult.error };
      }

      console.log(`[McpBridge] refresh complete: ${toolCount} tools, gateway restarted=${syncResult.changed}`);
      return { tools: toolCount };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[McpBridge] refresh error:', msg);
      return { tools: 0, error: msg };
    }
  })().finally(() => {
    mcpBridgeRefreshPromise = null;
  });
  return mcpBridgeRefreshPromise;
};

const getIMGatewayManager = () => {
  if (!imGatewayManager) {
    const sqliteStore = getStore();

    // Get Cowork dependencies for IM Cowork mode
    const runtime = getCoworkEngineRouter();
    const store = getCoworkStore();

    imGatewayManager = new IMGatewayManager(
      sqliteStore.getDatabase(),
      sqliteStore.getSaveFunction(),
      {
        coworkRuntime: runtime,
        coworkStore: store,
        ensureCoworkReady: async () => {
          if (resolveCoworkAgentEngine() !== 'openclaw') {
            return;
          }
          const status = await ensureOpenClawRunningForCowork();
          if (status.phase !== 'running') {
            throw new Error(status.message || 'AI engine is initializing. Please try again in a moment.');
          }
        },
        isOpenClawEngine: () => resolveCoworkAgentEngine() === 'openclaw',
        syncOpenClawConfig: async () => {
          await syncOpenClawConfig({
            reason: 'im-gateway-start',
            restartGatewayIfRunning: true,
          });
        },
        ensureOpenClawGatewayConnected: async () => {
          if (openClawRuntimeAdapter) {
            await openClawRuntimeAdapter.connectGatewayIfNeeded();
          }
        },
        getOpenClawGatewayClient: () => openClawRuntimeAdapter?.getGatewayClient() ?? null,
        ensureOpenClawGatewayReady: async () => {
          if (!openClawRuntimeAdapter) {
            throw new Error('OpenClaw runtime adapter not initialized.');
          }
          await openClawRuntimeAdapter.ensureReady();
          await openClawRuntimeAdapter.connectGatewayIfNeeded();
        },
        getOpenClawSessionKeysForCoworkSession: (sessionId: string) => {
          return openClawRuntimeAdapter?.getSessionKeysForSession(sessionId) ?? [];
        },
        createScheduledTask: async ({ sessionId, message, request }) => {
          if (message.platform === 'dingtalk') {
            await getIMGatewayManager().primeConversationReplyRoute(
              message.platform,
              message.conversationId,
              sessionId,
            );
          }
          const task = await getCronJobService().addJob({
            name: request.taskName,
            description: '',
            enabled: true,
            schedule: {
              kind: 'at',
              at: request.scheduleAt,
            },
            sessionTarget: 'main',
            wakeMode: 'now',
            payload: {
              kind: 'systemEvent',
              text: request.payloadText,
            },
            delivery: { mode: 'none' },
            agentId: DEFAULT_MANAGED_AGENT_ID,
            sessionKey: buildManagedSessionKey(sessionId, DEFAULT_MANAGED_AGENT_ID),
          });
          return {
            id: task.id,
            name: task.name,
            agentId: task.agentId,
            sessionKey: task.sessionKey,
            payloadText: task.payload.kind === 'systemEvent' ? task.payload.text : '',
            scheduleAt: task.schedule.kind === 'at' ? task.schedule.at : request.scheduleAt,
          };
        },
      }
    );

    // Initialize with LLM config provider
    imGatewayManager.initialize({
      getLLMConfig: async () => {
        const appConfig = sqliteStore.get<any>('app_config');
        if (!appConfig) return null;

        // Find first enabled provider
        const providers = appConfig.providers || {};
        for (const [providerName, providerConfig] of Object.entries(providers) as [string, any][]) {
          if (providerConfig.enabled && providerConfig.apiKey) {
            const model = providerConfig.models?.[0]?.id;
            return {
              apiKey: providerConfig.apiKey,
              baseUrl: providerConfig.baseUrl,
              model: model,
              provider: providerName,
            };
          }
        }

        // Fallback to legacy api config
        if (appConfig.api?.key) {
          return {
            apiKey: appConfig.api.key,
            baseUrl: appConfig.api.baseUrl,
            model: appConfig.model?.defaultModel,
          };
        }

        return null;
      },
      getSkillsPrompt: async () => {
        return getSkillManager().buildAutoRoutingPrompt();
      },
    });

    // Forward IM events to renderer
    imGatewayManager.on('statusChange', (status) => {
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('im:status:change', status);
        }
      });
    });

    imGatewayManager.on('message', (message) => {
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('im:message:received', message);
        }
      });
    });

    imGatewayManager.on('error', ({ platform, error }) => {
      console.error(`[IM Gateway] ${platform} error:`, error);
    });
  }
  return imGatewayManager;
};

const getCronJobService = (): CronJobService => {
  if (!cronJobService) {
    if (!openClawRuntimeAdapter) {
      throw new Error('OpenClaw runtime adapter not initialized. CronJobService requires OpenClaw.');
    }
    const adapter = openClawRuntimeAdapter;
    cronJobService = new CronJobService({
      getGatewayClient: () => adapter.getGatewayClient(),
      ensureGatewayReady: () => adapter.ensureReady(),
    });
  }
  return cronJobService;
};

function listScheduledTaskChannels(): Array<{ value: string; label: string }> {
  const manager = getIMGatewayManager();
  const config = manager?.getConfig();
  if (!config) {
    return [...SCHEDULED_TASK_CHANNEL_OPTIONS];
  }

  const enabledConfigKeys = new Set<string>();
  const configEntries: Array<[string, unknown]> = Object.entries(
    config as unknown as Record<string, unknown>,
  );
  for (const [key, value] of configEntries) {
    if (value && typeof value === 'object' && (value as { enabled?: boolean }).enabled) {
      enabledConfigKeys.add(key);
    }
  }

  return SCHEDULED_TASK_CHANNEL_OPTIONS.filter((option) => {
    if (option.value === 'last') {
      return true;
    }
    if (option.value === 'dingtalk-connector') {
      return enabledConfigKeys.has('dingtalk');
    }
    if (option.value === 'qqbot') {
      return enabledConfigKeys.has('qq');
    }
    return enabledConfigKeys.has(option.value);
  });
}

function mergeCoworkSystemPrompt(
  engine: CoworkAgentEngine,
  systemPrompt?: string,
): string | undefined {
  const sections = [
    buildScheduledTaskEnginePrompt(engine),
    systemPrompt?.trim() || '',
  ].filter(Boolean);
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

// 获取正确的预加载脚本路径
const PRELOAD_PATH = app.isPackaged 
  ? path.join(__dirname, 'preload.js')
  : path.join(__dirname, '../dist-electron/preload.js');

// 获取应用图标路径（Windows 使用 .ico，其他平台使用 .png）
const getAppIconPath = (): string | undefined => {
  if (process.platform !== 'win32' && process.platform !== 'linux') return undefined;
  const basePath = app.isPackaged
    ? path.join(process.resourcesPath, 'tray')
    : path.join(__dirname, '..', 'resources', 'tray');
  return process.platform === 'win32'
    ? path.join(basePath, 'tray-icon.ico')
    : path.join(basePath, 'tray-icon.png');
};

// 保存对主窗口的引用
let mainWindow: BrowserWindow | null = null;

let isQuitting = false;

// 存储活跃的流式请求控制器
const activeStreamControllers = new Map<string, AbortController>();
let lastReloadAt = 0;
const MIN_RELOAD_INTERVAL_MS = 5000;
type AppConfigSettings = {
  theme?: string;
  language?: string;
  useSystemProxy?: boolean;
};

const getUseSystemProxyFromConfig = (config?: { useSystemProxy?: boolean }): boolean => {
  return config?.useSystemProxy === true;
};

const resolveThemeFromConfig = (config?: AppConfigSettings): 'light' | 'dark' => {
  if (config?.theme === 'dark') {
    return 'dark';
  }
  if (config?.theme === 'light') {
    return 'light';
  }
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
};

const getInitialTheme = (): 'light' | 'dark' => {
  const config = getStore().get<AppConfigSettings>('app_config');
  return resolveThemeFromConfig(config);
};

const getTitleBarOverlayOptions = () => {
  const config = getStore().get<AppConfigSettings>('app_config');
  const theme = resolveThemeFromConfig(config);
  return {
    color: TITLEBAR_COLORS[theme].color,
    symbolColor: TITLEBAR_COLORS[theme].symbolColor,
    height: TITLEBAR_HEIGHT,
  };
};

const updateTitleBarOverlay = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!isMac && !isWindows) {
    mainWindow.setTitleBarOverlay(getTitleBarOverlayOptions());
  }
  // Also update the window background color to match the theme
  const config = getStore().get<AppConfigSettings>('app_config');
  const theme = resolveThemeFromConfig(config);
  mainWindow.setBackgroundColor(theme === 'dark' ? '#0F1117' : '#F8F9FB');
};

const applyProxyPreference = async (useSystemProxy: boolean): Promise<void> => {
  try {
    await session.defaultSession.setProxy({ mode: useSystemProxy ? 'system' : 'direct' });
  } catch (error) {
    console.error('[Main] Failed to apply session proxy mode:', error);
  }

  setSystemProxyEnabled(useSystemProxy);

  if (!useSystemProxy) {
    restoreOriginalProxyEnv();
    console.log('[Main] System proxy disabled (direct mode).');
    return;
  }

  const proxyUrl = await resolveSystemProxyUrl('https://openrouter.ai');
  applySystemProxyEnv(proxyUrl);

  if (proxyUrl) {
    console.log('[Main] System proxy enabled for process env:', proxyUrl);
  } else {
    console.warn('[Main] System proxy mode enabled, but no proxy endpoint was resolved (DIRECT).');
  }
};

const emitWindowState = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('window:state-changed', {
    isMaximized: mainWindow.isMaximized(),
    isFullscreen: mainWindow.isFullScreen(),
    isFocused: mainWindow.isFocused(),
  });
};

const showSystemMenu = (position?: { x?: number; y?: number }) => {
  if (!isWindows) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const isMaximized = mainWindow.isMaximized();
  const menu = Menu.buildFromTemplate([
    { label: 'Restore', enabled: isMaximized, click: () => mainWindow.restore() },
    { role: 'minimize' },
    { label: 'Maximize', enabled: !isMaximized, click: () => mainWindow.maximize() },
    { type: 'separator' },
    { role: 'close' },
  ]);

  menu.popup({
    window: mainWindow,
    x: Math.max(0, Math.round(position?.x ?? 0)),
    y: Math.max(0, Math.round(position?.y ?? 0)),
  });
};

const scheduleReload = (reason: string, webContents?: WebContents) => {
  const target = webContents ?? mainWindow?.webContents;
  if (!target || target.isDestroyed()) {
    return;
  }
  const now = Date.now();
  if (now - lastReloadAt < MIN_RELOAD_INTERVAL_MS) {
    console.warn(`Skipping reload (${reason}); last reload was ${now - lastReloadAt}ms ago.`);
    return;
  }
  lastReloadAt = now;
  console.warn(`Reloading window due to ${reason}`);
  target.reloadIgnoringCache();
};


// 确保应用程序只有一个实例
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine, workingDirectory) => {
    console.log('[Main] second-instance event', { commandLine, workingDirectory });
    // 如果尝试启动第二个实例，则聚焦到主窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      if (!mainWindow.isFocused()) mainWindow.focus();
    }
  });

  // IPC 处理程序 — delegated to handler modules
  const ipcContext: import('./ipcHandlers/ipcContext').IpcContext = {
    getStore,
    getCoworkStore,
    getCoworkRunner,
    getCoworkEngineRouter,
    getSkillManager,
    getMcpStore,
    getOpenClawEngineManager,
    getOpenClawRuntimeAdapter: () => openClawRuntimeAdapter,
    getIMGatewayManager,
    getCronJobService,
    getMainWindow: () => mainWindow,

    resolveCoworkAgentEngine,
    ensureOpenClawRunningForCowork,
    bootstrapOpenClawEngine,
    syncOpenClawConfig,
    refreshMcpBridge,
    mergeCoworkSystemPrompt,
    listScheduledTaskChannels,

    activeStreamControllers,
    isDev,
  };

  registerStoreAndAppIpcHandlers(ipcContext, {
    mainWindow: () => mainWindow,
    showSystemMenu,
  });
  registerCoworkIpcHandlers(ipcContext);
  registerSkillsIpcHandlers(ipcContext);
  registerMcpIpcHandlers(ipcContext);
  registerOpenClawIpcHandlers(ipcContext);
  registerScheduledTaskIpcHandlers(ipcContext);
  registerImIpcHandlers(ipcContext);

  const WECOM_AUTH_HOSTNAMES = new Set([
    'work.weixin.qq.com',
    'open.work.weixin.qq.com',
    'wwcdn.weixin.qq.com',
  ]);

  const isWecomAuthUrl = (url: string): boolean => {
    try {
      const hostname = new URL(url).hostname;
      return WECOM_AUTH_HOSTNAMES.has(hostname);
    } catch {
      return false;
    }
  };

  // 设置 Content Security Policy
  const setContentSecurityPolicy = () => {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      // 跳过企微授权页面，让其使用自身的 CSP（否则外部脚本被阻止导致空白页）
      if (isWecomAuthUrl(details.url)) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }

      const devPort = process.env.ELECTRON_START_URL?.match(/:(\d+)/)?.[1] || '5175';
      const cspDirectives = [
        "default-src 'self'",
        isDev ? `script-src 'self' 'unsafe-inline' http://localhost:${devPort} ws://localhost:${devPort}` : "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https: http: localfile:",
        // 允许连接到所有域名，不做限制
        "connect-src *",
        "font-src 'self' data:",
        "media-src 'self'",
        "worker-src 'self' blob:",
        "frame-src 'self'"
      ];

      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': cspDirectives.join('; ')
        }
      });
    });
  };

  // 创建主窗口
  const createWindow = () => {
    // 如果窗口已经存在，就不再创建新窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      if (!mainWindow.isFocused()) mainWindow.focus();
      return;
    }

    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      title: APP_NAME,
      icon: getAppIconPath(),
      ...(isMac
        ? {
            titleBarStyle: 'hiddenInset' as const,
            trafficLightPosition: { x: 12, y: 20 },
          }
        : isWindows
          ? {
              frame: false,
              titleBarStyle: 'hidden' as const,
            }
          : {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: getTitleBarOverlayOptions(),
          }),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        preload: PRELOAD_PATH,
        backgroundThrottling: false,
        devTools: isDev,
        spellcheck: false,
        enableWebSQL: false,
        autoplayPolicy: 'document-user-activation-required',
        disableDialogs: true,
        navigateOnDragDrop: false
      },
      backgroundColor: getInitialTheme() === 'dark' ? '#0F1117' : '#F8F9FB',
      show: false,
      autoHideMenuBar: true,
      enableLargerThanScreen: false
    });

    // 设置 macOS Dock 图标（开发模式下 Electron 默认图标不是应用 Logo）
    if (isMac && isDev) {
      const iconPath = path.join(__dirname, '../build/icons/png/512x512.png');
      if (fs.existsSync(iconPath)) {
        app.dock.setIcon(nativeImage.createFromPath(iconPath));
      }
    }

    // 禁用窗口菜单
    mainWindow.setMenu(null);

    // 处理 window.open 请求（企微 SDK 授权弹窗等）
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (isWecomAuthUrl(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 950,
            height: 640,
            title: '企业微信授权',
            autoHideMenuBar: true,
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
            },
          },
        };
      }
      shell.openExternal(url);
      return { action: 'deny' };
    });

    // 监听子窗口创建事件（企微授权弹窗安全限制）
    mainWindow.webContents.on('did-create-window', (childWindow) => {
      // 限制子窗口只能导航到企微域名，防止被劫持到其他站点
      childWindow.webContents.on('will-navigate', (event, navUrl) => {
        if (!isWecomAuthUrl(navUrl)) {
          event.preventDefault();
        }
      });
    });

    // 设置窗口的最小尺寸
    mainWindow.setMinimumSize(800, 600);

    // 设置窗口加载超时
    const loadTimeout = setTimeout(() => {
      if (mainWindow && mainWindow.webContents.isLoadingMainFrame()) {
        console.log('Window load timed out, attempting to reload...');
        scheduleReload('load-timeout');
      }
    }, 30000);

    // 清除超时
    mainWindow.webContents.once('did-finish-load', () => {
      clearTimeout(loadTimeout);
    });
    mainWindow.webContents.on('did-finish-load', () => {
      emitWindowState();
      if (openClawEngineManager && !mainWindow?.isDestroyed()) {
        mainWindow.webContents.send('openclaw:engine:onProgress', openClawEngineManager.getStatus());
      }
    });

    // 处理窗口关闭
    mainWindow.on('close', (e) => {
      // In development, close should actually quit so `npm run electron:dev`
      // restarts from a clean process. In production we keep tray behavior.
      if (mainWindow && !isQuitting && !isDev) {
        e.preventDefault();
        mainWindow.hide();
      }
    });

    // 处理渲染进程崩溃或退出
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.error('Window render process gone:', details);
      scheduleReload('webContents-crashed');
    });

    if (isDev) {
      // 开发环境
      const maxRetries = 3;
      let retryCount = 0;

      const tryLoadURL = () => {
        mainWindow?.loadURL(DEV_SERVER_URL).catch((err) => {
          console.error('Failed to load URL:', err);
          retryCount++;
          
          if (retryCount < maxRetries) {
            console.log(`Retrying to load URL (${retryCount}/${maxRetries})...`);
            setTimeout(tryLoadURL, 3000);
          } else {
            console.error('Failed to load URL after maximum retries');
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.loadFile(path.join(__dirname, '../resources/error.html'));
            }
          }
        });
      };

      tryLoadURL();
      
      // 打开开发者工具
      mainWindow.webContents.openDevTools();
    } else {
      // 生产环境
      mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    // 添加错误处理
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      console.error('Page failed to load:', errorCode, errorDescription);
      // 如果加载失败，尝试重新加载
      if (isDev) {
        setTimeout(() => {
          scheduleReload('did-fail-load');
        }, 3000);
      }
    });

    // 当窗口关闭时，清除引用
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    const forwardWindowState = () => emitWindowState();
    mainWindow.on('maximize', forwardWindowState);
    mainWindow.on('unmaximize', forwardWindowState);
    mainWindow.on('enter-full-screen', forwardWindowState);
    mainWindow.on('leave-full-screen', forwardWindowState);
    mainWindow.on('focus', forwardWindowState);
    mainWindow.on('blur', forwardWindowState);

    // 等待内容加载完成后再显示窗口
    mainWindow.once('ready-to-show', () => {
      emitWindowState();
      // 开机自启时不显示窗口，仅显示托盘图标
      if (!isAutoLaunched()) {
        mainWindow?.show();
      }
      // Initialize main-process i18n from stored language before creating UI elements.
      const initLang = getStore().get<{ language?: string }>('app_config')?.language;
      setLanguage(initLang === 'en' ? 'en' : 'zh');
      // 窗口就绪后创建系统托盘
      createTray(() => mainWindow);

      // Start cron polling after the window is ready.
      (async () => {
        try {
          getCronJobService().startPolling();
        } catch (err) {
          console.warn('[Main] CronJobService not available yet, will start polling when OpenClaw is ready:', err);
        }

        // One-time migration: move tasks from legacy SQLite tables to OpenClaw gateway.
        migrateScheduledTasksToOpenclaw({
          db: getStore().getDatabase(),
          getKv: (key) => getStore().get(key),
          setKv: (key, value) => getStore().set(key, value),
          cronJobService: getCronJobService(),
        }).catch((err) => {
          console.warn('[Main] Scheduled tasks migration failed:', err);
        });

        // One-time migration: copy legacy run history to OpenClaw cron/runs/ JSONL files.
        migrateScheduledTaskRunsToOpenclaw({
          db: getStore().getDatabase(),
          getKv: (key) => getStore().get(key),
          setKv: (key, value) => getStore().set(key, value),
          openclawStateDir: getOpenClawEngineManager().getStateDir(),
        }).catch((err) => {
          console.warn('[Main] Scheduled task run history migration failed:', err);
        });
      })();
    });
  };

  let isCleanupFinished = false;
  let isCleanupInProgress = false;

  const runAppCleanup = async (): Promise<void> => {
    console.log('[Main] App is quitting, starting cleanup...');
    destroyTray();
    skillManager?.stopWatching();

    // Stop Cowork sessions without blocking shutdown.
    if (coworkEngineRouter) {
      console.log('[Main] Stopping cowork sessions...');
      coworkEngineRouter.stopAllSessions();
    }

    await stopCoworkOpenAICompatProxy().catch((error) => {
      console.error('Failed to stop OpenAI compatibility proxy:', error);
    });

    // Stop skill services.
    const skillServices = getSkillServiceManager();
    await skillServices.stopAll();

    // Stop all IM gateways gracefully.
    if (imGatewayManager) {
      await imGatewayManager.stopAll().catch(err => {
        console.error('[IM Gateway] Error stopping gateways on quit:', err);
      });
    }

    if (openClawEngineManager) {
      await openClawEngineManager.stopGateway().catch((error) => {
        console.error('[OpenClaw] Failed to stop gateway on quit:', error);
      });
    }

    // Stop the cron job polling
    if (cronJobService) {
      cronJobService.stopPolling();
    }
  };

  app.on('before-quit', (e) => {
    if (isCleanupFinished) return;

    e.preventDefault();
    if (isCleanupInProgress) {
      return;
    }

    isCleanupInProgress = true;
    isQuitting = true;

    void runAppCleanup()
      .catch((error) => {
        console.error('[Main] Cleanup error:', error);
      })
      .finally(() => {
        isCleanupFinished = true;
        isCleanupInProgress = false;
        app.exit(0);
      });
  });

  const handleTerminationSignal = (signal: NodeJS.Signals) => {
    if (isCleanupFinished || isCleanupInProgress) {
      return;
    }
    console.log(`[Main] Received ${signal}, running cleanup before exit...`);
    isCleanupInProgress = true;
    isQuitting = true;
    void runAppCleanup()
      .catch((error) => {
        console.error(`[Main] Cleanup error during ${signal}:`, error);
      })
      .finally(() => {
        isCleanupFinished = true;
        isCleanupInProgress = false;
        app.exit(0);
      });
  };

  process.once('SIGINT', () => handleTerminationSignal('SIGINT'));
  process.once('SIGTERM', () => handleTerminationSignal('SIGTERM'));

  // 初始化应用
  const initApp = async () => {
    console.log('[Main] initApp: waiting for app.whenReady()');
    await app.whenReady();
    console.log('[Main] initApp: app is ready');

    // Note: Calendar permission is checked on-demand when calendar operations are requested
    // We don't trigger permission dialogs at startup to avoid annoying users

    // Ensure default working directory exists
    const defaultProjectDir = path.join(os.homedir(), 'lobsterai', 'project');
    if (!fs.existsSync(defaultProjectDir)) {
      fs.mkdirSync(defaultProjectDir, { recursive: true });
      console.log('Created default project directory:', defaultProjectDir);
    }
    console.log('[Main] initApp: default project dir ensured');

    // 注册 localfile:// 自定义协议，用于安全加载本地文件（图片等）
    protocol.handle('localfile', (request) => {
      const url = new URL(request.url);
      const filePath = decodeURIComponent(url.pathname);
      return net.fetch(`file://${filePath}`);
    });

    console.log('[Main] initApp: starting initStore()');
    store = await initStore();
    console.log('[Main] initApp: store initialized');

    // Defensive recovery: app may be force-closed during execution and leave
    // stale running flags in DB. Normalize them on startup.
    const resetCount = getCoworkStore().resetRunningSessions();
    console.log('[Main] initApp: resetRunningSessions done, count:', resetCount);
    if (resetCount > 0) {
      console.log(`[Main] Reset ${resetCount} stuck cowork session(s) from running -> idle`);
    }
    // Inject store getter into claudeSettings
    setStoreGetter(() => store);

    bindCoworkRuntimeForwarder();
    bindOpenClawStatusForwarder();

    const startupSync = await syncOpenClawConfig({
      reason: 'startup',
      restartGatewayIfRunning: false,
    });
    if (!startupSync.success) {
      console.error('[OpenClaw] Startup config sync failed:', startupSync.error);
    }
    if (resolveCoworkAgentEngine() === 'openclaw') {
      void ensureOpenClawRunningForCowork().then(() => {
        // Start cron polling once the gateway is confirmed running.
        try {
          getCronJobService().startPolling();
        } catch (err) {
          console.warn('[Main] CronJobService not available after OpenClaw startup:', err);
        }
      }).catch((error) => {
        console.error('[OpenClaw] Failed to auto-start gateway on app startup:', error);
      });
    }

    console.log('[Main] initApp: setStoreGetter done');
    const manager = getSkillManager();
    console.log('[Main] initApp: getSkillManager done');

    // When skills change (install/enable/disable/delete), re-sync AGENTS.md
    // so OpenClaw's IM channel agents pick up the latest skill list.
    manager.onSkillsChanged(() => {
      syncOpenClawConfig({ reason: 'skills-changed' }).catch((error) => {
        console.warn('[Main] Failed to sync OpenClaw config after skills change:', error);
      });
    });

    // Non-critical: sync bundled skills to user data.
    // Wrapped in try-catch so a failure here does not block window creation.
    try {
      manager.syncBundledSkillsToUserData();
      console.log('[Main] initApp: syncBundledSkillsToUserData done');
    } catch (error) {
      console.error('[Main] initApp: syncBundledSkillsToUserData failed:', error);
    }

    try {
      const runtimeResult = await ensurePythonRuntimeReady();
      if (!runtimeResult.success) {
        console.error('[Main] initApp: ensurePythonRuntimeReady failed:', runtimeResult.error);
      } else {
        console.log('[Main] initApp: ensurePythonRuntimeReady done');
      }
    } catch (error) {
      console.error('[Main] initApp: ensurePythonRuntimeReady threw:', error);
    }

    try {
      manager.startWatching();
      console.log('[Main] initApp: startWatching done');
    } catch (error) {
      console.error('[Main] initApp: startWatching failed:', error);
    }

    // Start skill services (non-critical)
    try {
      const skillServices = getSkillServiceManager();
      console.log('[Main] initApp: getSkillServiceManager done');
      await skillServices.startAll();
      console.log('[Main] initApp: skill services started');
    } catch (error) {
      console.error('[Main] initApp: skill services failed:', error);
    }

    const appConfig = getStore().get<AppConfigSettings>('app_config');
    await applyProxyPreference(getUseSystemProxyFromConfig(appConfig));

    await startCoworkOpenAICompatProxy().catch((error) => {
      console.error('Failed to start OpenAI compatibility proxy:', error);
    });

    // 设置安全策略
    setContentSecurityPolicy();

    // 创建窗口
    console.log('[Main] initApp: creating window');
    createWindow();
    console.log('[Main] initApp: window created');

    // Auto-reconnect IM bots that were enabled before restart
    getIMGatewayManager().startAllEnabled().catch((error) => {
      console.error('[IM] Failed to auto-start enabled gateways:', error);
    });

    // Reconnect OpenClaw gateway WS after system wake from sleep/suspend
    powerMonitor.on('resume', () => {
      if (openClawRuntimeAdapter) {
        openClawRuntimeAdapter.onSystemResume();
      }
    });

    // 首次启动时默认开启开机自启动（先写标记再设置，避免崩溃后重复设置）
    if (!getStore().get('auto_launch_initialized')) {
      getStore().set('auto_launch_initialized', true);
      getStore().set('auto_launch_enabled', true);
      setAutoLaunchEnabled(true);
    }

    // Restore prevent-sleep setting
    restorePreventSleep(getStore());

    let lastLanguage = getStore().get<AppConfigSettings>('app_config')?.language;
    let lastUseSystemProxy = getUseSystemProxyFromConfig(getStore().get<AppConfigSettings>('app_config'));
    getStore().onDidChange<AppConfigSettings>('app_config', (newConfig, oldConfig) => {
      updateTitleBarOverlay();
      // 仅在语言变更时刷新托盘菜单文本
      const currentLanguage = newConfig?.language;
      if (currentLanguage !== lastLanguage) {
        lastLanguage = currentLanguage;
        setLanguage(currentLanguage === 'en' ? 'en' : 'zh');
        updateTrayMenu(() => mainWindow);
      }

      const previousUseSystemProxy = oldConfig
        ? getUseSystemProxyFromConfig(oldConfig)
        : lastUseSystemProxy;
      const currentUseSystemProxy = getUseSystemProxyFromConfig(newConfig);
      if (currentUseSystemProxy !== previousUseSystemProxy) {
        void applyProxyPreference(currentUseSystemProxy).then(() => {
          if (getOpenClawEngineManager().getStatus().phase === 'running') {
            void getOpenClawEngineManager().restartGateway();
          }
        });
      }
      lastUseSystemProxy = currentUseSystemProxy;
    });

    // 在 macOS 上，当点击 dock 图标时显示已有窗口或重新创建
    app.on('activate', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (!mainWindow.isVisible()) mainWindow.show();
        if (!mainWindow.isFocused()) mainWindow.focus();
        return;
      }
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  };

  // 启动应用
  initApp().catch(console.error);

  // 当所有窗口关闭时退出应用
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
} 
