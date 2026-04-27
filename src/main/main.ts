import type { WebContents } from 'electron';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, powerMonitor, powerSaveBlocker, protocol, session, shell } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { OpenClawSessionPatch } from '../common/openclawSession';
import { buildScheduledTaskEnginePrompt } from '../scheduledTask/enginePrompt';
import { migrateScheduledTaskRunsToOpenclaw, migrateScheduledTasksToOpenclaw } from '../scheduledTask/migrate';
import { AppUpdateIpc } from '../shared/appUpdate/constants';
import { PlatformRegistry } from '../shared/platform';
import { AgentManager } from './agentManager';
import { APP_NAME } from './appConstants';
import { getAutoLaunchEnabled, isAutoLaunched, setAutoLaunchEnabled } from './autoLaunchManager';
import { CoworkStore } from './coworkStore';
import { setLanguage, t } from './i18n';
import { IMGatewayConfig, IMGatewayManager } from './im';
import {
  approvePairingCode,
  listPairingRequests,
  readAllowFromStore,
  rejectPairingRequest,
} from './im/imPairingStore';
import { pollNimQrLogin, startNimQrLogin } from './im/nimQrLoginService';
import type { DingTalkInstanceConfig, DiscordInstanceConfig, EmailMultiInstanceConfig, FeishuInstanceConfig, NimInstanceConfig, Platform, QQInstanceConfig, TelegramInstanceConfig, WecomInstanceConfig } from './im/types';
import { registerNimQrLoginHandlers } from './ipcHandlers/nimQrLogin';
import {
  getCronJobService,
  initCronJobServiceManager,
  initScheduledTaskHelpers,
  registerScheduledTaskHandlers,
} from './ipcHandlers/scheduledTask';
import {
  type CoworkAgentEngine,
  CoworkEngineRouter,
  OpenClawRuntimeAdapter,
  type PermissionResult,
} from './libs/agentEngine';
import { AppUpdateCoordinator } from './libs/appUpdateCoordinator';
import { clearServerModelMetadata, getCurrentApiConfig, resolveAllEnabledProviderConfigs, resolveCurrentApiConfig, resolveRawApiConfig, setAuthTokensGetter, setServerBaseUrlGetter, setStoreGetter, updateServerModelMetadata } from './libs/claudeSettings';
import {
  clearCopilotTokenState,
  initCopilotTokenManager,
  refreshCopilotTokenNow,
  setCopilotTokenState,
} from './libs/copilotTokenManager';
import { saveCoworkApiConfig } from './libs/coworkConfigStore';
import { getCoworkLogPath } from './libs/coworkLogger';
import { registerProxyTokenRefresher, startCoworkOpenAICompatProxy, stopCoworkOpenAICompatProxy } from './libs/coworkOpenAICompatProxy';
import { generateSessionTitle, probeCoworkModelReadiness } from './libs/coworkUtil';
import { getServerApiBaseUrl, getSkillStoreUrl, refreshEndpointsTestMode } from './libs/endpoints';
import { mergeEnterpriseOpenclawConfig, resolveEnterpriseConfigPath, syncEnterpriseConfig } from './libs/enterpriseConfigSync';
import { exportLogsZip } from './libs/logExport';
import { McpBridgeServer } from './libs/mcpBridgeServer';
import { McpServerManager } from './libs/mcpServerManager';
import { resolveQualifiedAgentModelRef } from './libs/openclawAgentModels';
import {
  buildManagedSessionKey,
  DEFAULT_MANAGED_AGENT_ID,
  OpenClawChannelSessionSync,
} from './libs/openclawChannelSessionSync';
import type { McpBridgeConfig } from './libs/openclawConfigSync';
import { buildProviderSelection, OpenClawConfigSync } from './libs/openclawConfigSync';
import { OpenClawEngineManager, type OpenClawEngineStatus } from './libs/openclawEngineManager';
import {
  addMemoryEntry,
  deleteMemoryEntry,
  ensureDefaultIdentity,
  migrateSqliteToMemoryMd,
  readBootstrapFile,
  readMemoryEntries,
  resolveMemoryFilePath,
  searchMemoryEntries,
  syncMemoryFileOnWorkspaceChange,
  updateMemoryEntry,
  writeBootstrapFile,
} from './libs/openclawMemoryFile';
import { startOpenClawTokenProxy, stopOpenClawTokenProxy } from './libs/openclawTokenProxy';
import { ensurePythonRuntimeReady } from './libs/pythonRuntime';
import { SqliteBackupManager } from './libs/sqliteBackup/sqliteBackupManager';
import {
  applySystemProxyEnv,
  resolveSystemProxyUrlForTargets,
  restoreOriginalProxyEnv,
  setSystemProxyEnabled,
} from './libs/systemProxy';
import { getLogFilePath, getRecentMainLogEntries, initLogger } from './logger';
import type { McpServerFormData } from './mcpStore';
import { McpStore } from './mcpStore';
import { OpenClawSessionIpc } from './openclawSession/constants';
import { OpenClawSessionPolicyIpc } from './openclawSessionPolicy/constants';
import { loadOpenClawSessionPolicyConfig, saveOpenClawSessionPolicyConfig } from './openclawSessionPolicy/store';
import { SkillManager } from './skillManager';
import { getSkillServiceManager } from './skillServices';
import { SqliteStore } from './sqliteStore';
import { StartupProfiler } from './startupProfiler';
import { createTray, destroyTray, updateTrayMenu } from './trayManager';

// 设置应用程序名称
app.name = APP_NAME;
app.setName(APP_NAME);

const INVALID_FILE_NAME_PATTERN = /[<>:"/\\|?*\u0000-\u001F]/g;
const MIN_MEMORY_USER_MEMORIES_MAX_ITEMS = 1;
const MAX_MEMORY_USER_MEMORIES_MAX_ITEMS = 60;
const IPC_MESSAGE_CONTENT_MAX_CHARS = 120_000;
const IPC_UPDATE_CONTENT_MAX_CHARS = 120_000;
const IPC_STRING_MAX_CHARS = 4_000;
const IPC_MAX_DEPTH = 5;
const IPC_MAX_KEYS = 80;
const IPC_MAX_ITEMS = 40;
const MAX_INLINE_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const ENGINE_NOT_READY_CODE = 'ENGINE_NOT_READY';
const PowerSaveBlockerType = {
  PreventAppSuspension: 'prevent-app-suspension',
} as const;
const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'text/csv': '.csv',
};

function sanitizeOptionalPatchValue(
  value: unknown,
  maxChars = IPC_STRING_MAX_CHARS,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error('Session patch value must be a string or null.');
  }
  const trimmed = value.trim();
  if (trimmed.length > maxChars) {
    throw new Error('Session patch value is too long.');
  }
  return trimmed;
}

function sanitizeOpenClawSessionPatch(input: unknown): OpenClawSessionPatch {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid session patch payload.');
  }

  const source = input as Record<string, unknown>;
  const patch: OpenClawSessionPatch = {};

  const model = sanitizeOptionalPatchValue(source.model);
  if (model !== undefined) patch.model = model;

  const thinkingLevel = sanitizeOptionalPatchValue(source.thinkingLevel);
  if (thinkingLevel !== undefined) patch.thinkingLevel = thinkingLevel;

  const reasoningLevel = sanitizeOptionalPatchValue(source.reasoningLevel);
  if (reasoningLevel !== undefined) patch.reasoningLevel = reasoningLevel;

  const elevatedLevel = sanitizeOptionalPatchValue(source.elevatedLevel);
  if (elevatedLevel !== undefined) patch.elevatedLevel = elevatedLevel;

  const responseUsage = sanitizeOptionalPatchValue(source.responseUsage);
  if (responseUsage !== undefined) patch.responseUsage = responseUsage as OpenClawSessionPatch['responseUsage'];

  const sendPolicy = sanitizeOptionalPatchValue(source.sendPolicy);
  if (sendPolicy !== undefined) patch.sendPolicy = sendPolicy as OpenClawSessionPatch['sendPolicy'];

  if (Object.keys(patch).length === 0) {
    throw new Error('Session patch is empty.');
  }

  return patch;
}

const sanitizeExportFileName = (value: string): string => {
  const sanitized = value.replace(INVALID_FILE_NAME_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  return sanitized || 'cowork-session';
};

const resolveDefaultAgentModelRef = (): string => {
  const apiResolution = resolveRawApiConfig();
  const config = apiResolution.config;
  if (!config?.model?.trim()) {
    return '';
  }

  return buildProviderSelection({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    modelId: config.model.trim(),
    apiType: config.apiType,
    providerName: apiResolution.providerMetadata?.providerName,
    authType: apiResolution.providerMetadata?.authType,
    codingPlanEnabled: apiResolution.providerMetadata?.codingPlanEnabled,
    supportsImage: apiResolution.providerMetadata?.supportsImage,
    modelName: apiResolution.providerMetadata?.modelName,
  }).primaryModel;
};

const buildAvailableOpenClawProviders = (): Record<string, { models: Array<{ id: string }> }> => {
  const providerMap: Record<string, { models: Array<{ id: string }> }> = {};

  for (const provider of resolveAllEnabledProviderConfigs()) {
    for (const model of provider.models) {
      const selection = buildProviderSelection({
        apiKey: provider.apiKey,
        baseURL: provider.baseURL,
        modelId: model.id,
        apiType: provider.apiType,
        providerName: provider.providerName,
        authType: provider.authType,
        codingPlanEnabled: provider.codingPlanEnabled,
        supportsImage: model.supportsImage,
        modelName: model.name,
      });

      if (!providerMap[selection.providerId]) {
        providerMap[selection.providerId] = { models: [] };
      }
      if (!providerMap[selection.providerId].models.some((entry) => entry.id === selection.sessionModelId)) {
        providerMap[selection.providerId].models.push({ id: selection.sessionModelId });
      }
    }
  }

  return providerMap;
};

// Provider IDs that were renamed in past refactors. Any stored agent model ref
// using an old ID is rewritten to the current ID on startup.
const RENAMED_PROVIDER_IDS: Record<string, string> = {
  'github-copilot': 'lobsterai-copilot',
};

const migrateAgentModelRefs = (): number => {
  const defaultModelRef = resolveDefaultAgentModelRef();
  if (!defaultModelRef) return 0;

  const availableProviders = buildAvailableOpenClawProviders();
  const agents = getAgentManager().listAgents();
  let changed = 0;

  for (const agent of agents) {
    let normalizedModel = agent.model.trim();
    if (!normalizedModel) continue;

    // Apply explicit provider rename map before qualification so that renamed
    // provider IDs (e.g. 'github-copilot' → 'lobsterai-copilot') are corrected
    // even though resolveQualifiedAgentModelRef treats any slash-ref as valid.
    const slashIdx = normalizedModel.indexOf('/');
    if (slashIdx > 0) {
      const storedProviderId = normalizedModel.slice(0, slashIdx);
      const renamedId = RENAMED_PROVIDER_IDS[storedProviderId];
      if (renamedId) {
        normalizedModel = `${renamedId}${normalizedModel.slice(slashIdx)}`;
      }
    }

    const qualification = resolveQualifiedAgentModelRef({
      agentModel: normalizedModel,
      availableProviders,
    });

    if (qualification.status === 'ambiguous') {
      console.warn(
        `[Main] Skipped ambiguous agent model migration for "${agent.id}" because "${qualification.modelId}" matches multiple providers: ${qualification.providerIds.join(', ')}`,
      );
      continue;
    }

    if (qualification.status !== 'qualified' || qualification.primaryModel === agent.model.trim()) {
      continue;
    }

    getCoworkStore().updateAgent(agent.id, { model: qualification.primaryModel });
    changed += 1;
  }

  return changed;
};

const sanitizeAttachmentFileName = (value?: string): string => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return 'attachment';
  const fileName = path.basename(raw);
  const sanitized = fileName.replace(INVALID_FILE_NAME_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  return sanitized || 'attachment';
};

const inferAttachmentExtension = (fileName: string, mimeType?: string): string => {
  const fromName = path.extname(fileName).toLowerCase();
  if (fromName) {
    return fromName;
  }
  if (typeof mimeType === 'string') {
    const normalized = mimeType.toLowerCase().split(';')[0].trim();
    return MIME_EXTENSION_MAP[normalized] ?? '';
  }
  return '';
};

const resolveInlineAttachmentDir = (cwd?: string): string => {
  const trimmed = typeof cwd === 'string' ? cwd.trim() : '';
  if (trimmed) {
    const resolved = path.resolve(trimmed);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return path.join(resolved, '.cowork-temp', 'attachments', 'manual');
    }
  }
  return path.join(app.getPath('temp'), 'lobsterai', 'attachments');
};

const ensurePngFileName = (value: string): string => {
  return value.toLowerCase().endsWith('.png') ? value : `${value}.png`;
};

const ensureZipFileName = (value: string): string => {
  return value.toLowerCase().endsWith('.zip') ? value : `${value}.zip`;
};

const padTwoDigits = (value: number): string => value.toString().padStart(2, '0');

const buildLogExportFileName = (): string => {
  const now = new Date();
  const datePart = `${now.getFullYear()}${padTwoDigits(now.getMonth() + 1)}${padTwoDigits(now.getDate())}`;
  const timePart = `${padTwoDigits(now.getHours())}${padTwoDigits(now.getMinutes())}${padTwoDigits(now.getSeconds())}`;
  return `lobsterai-logs-${datePart}-${timePart}.zip`;
};

const OPENCLAW_DAILY_LOG_RETENTION_DAYS = 7;
const OPENCLAW_DAILY_LOG_RE = /^openclaw-\d{4}-\d{2}-\d{2}\.log$/;

function getRecentOpenClawDailyLogEntries(
  logDir: string | null,
): Array<{ archiveName: string; filePath: string }> {
  if (!logDir || !fs.existsSync(logDir)) return [];

  const cutoffMs = Date.now() - OPENCLAW_DAILY_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  return fs.readdirSync(logDir)
    .filter((f) => OPENCLAW_DAILY_LOG_RE.test(f))
    .map((f) => ({ archiveName: f, filePath: path.join(logDir, f) }))
    .filter(({ filePath }) => {
      try {
        return fs.statSync(filePath).mtimeMs >= cutoffMs;
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.archiveName.localeCompare(b.archiveName));
}

const truncateIpcString = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated in main IPC forwarding]`;
};

const sanitizeIpcPayload = (value: unknown, depth = 0, seen?: WeakSet<object>): unknown => {
  const localSeen = seen ?? new WeakSet<object>();
  if (
    value === null
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'undefined'
  ) {
    return value;
  }
  if (typeof value === 'string') {
    return truncateIpcString(value, IPC_STRING_MAX_CHARS);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'function') {
    return '[function]';
  }
  if (depth >= IPC_MAX_DEPTH) {
    return '[truncated-depth]';
  }
  if (Array.isArray(value)) {
    const result = value.slice(0, IPC_MAX_ITEMS).map((entry) => sanitizeIpcPayload(entry, depth + 1, localSeen));
    if (value.length > IPC_MAX_ITEMS) {
      result.push(`[truncated-items:${value.length - IPC_MAX_ITEMS}]`);
    }
    return result;
  }
  if (typeof value === 'object') {
    if (localSeen.has(value as object)) {
      return '[circular]';
    }
    localSeen.add(value as object);
    const entries = Object.entries(value as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    for (const [key, entry] of entries.slice(0, IPC_MAX_KEYS)) {
      result[key] = sanitizeIpcPayload(entry, depth + 1, localSeen);
    }
    if (entries.length > IPC_MAX_KEYS) {
      result.__truncated_keys__ = entries.length - IPC_MAX_KEYS;
    }
    return result;
  }
  return String(value);
};

const sanitizeCoworkMessageForIpc = (message: unknown): unknown => {
  if (!message || typeof message !== 'object') {
    return message;
  }
  const messageRecord = message as { metadata?: unknown; content?: unknown };

  // Preserve imageAttachments in metadata as-is (base64 data can be very large
  // and must not be truncated by the generic sanitizer).
  let sanitizedMetadata: unknown;
  if (messageRecord.metadata && typeof messageRecord.metadata === 'object') {
    const { imageAttachments, ...rest } = messageRecord.metadata as Record<string, unknown>;
    const sanitizedRest = sanitizeIpcPayload(rest) as Record<string, unknown> | undefined;
    sanitizedMetadata = {
      ...(sanitizedRest && typeof sanitizedRest === 'object' ? sanitizedRest : {}),
      ...(Array.isArray(imageAttachments) && imageAttachments.length > 0
        ? { imageAttachments }
        : {}),
    };
  } else {
    sanitizedMetadata = undefined;
  }

  return {
    ...message,
    content: typeof messageRecord.content === 'string'
      ? truncateIpcString(messageRecord.content, IPC_MESSAGE_CONTENT_MAX_CHARS)
      : '',
    metadata: sanitizedMetadata,
  };
};

const sanitizePermissionRequestForIpc = (request: unknown): unknown => {
  if (!request || typeof request !== 'object') {
    return request;
  }
  const requestRecord = request as { toolInput?: unknown };
  return {
    ...request,
    toolInput: sanitizeIpcPayload(requestRecord.toolInput ?? {}),
  };
};

type CaptureRect = { x: number; y: number; width: number; height: number };

const normalizeCaptureRect = (rect?: Partial<CaptureRect> | null): CaptureRect | null => {
  if (!rect) return null;
  const normalized = {
    x: Math.max(0, Math.round(typeof rect.x === 'number' ? rect.x : 0)),
    y: Math.max(0, Math.round(typeof rect.y === 'number' ? rect.y : 0)),
    width: Math.max(0, Math.round(typeof rect.width === 'number' ? rect.width : 0)),
    height: Math.max(0, Math.round(typeof rect.height === 'number' ? rect.height : 0)),
  };
  return normalized.width > 0 && normalized.height > 0 ? normalized : null;
};

const resolveTaskWorkingDirectory = (workspaceRoot: string): string => {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  // Reject bare Windows drive roots (e.g. "D:\") — mkdir on drive roots causes EPERM,
  // and some agent engines (OpenClaw) also fail when given a drive root as workspace.
  if (process.platform === 'win32' && /^[a-zA-Z]:\\?$/.test(resolvedWorkspaceRoot)) {
    throw new Error(`Cannot use a drive root as the working directory (${resolvedWorkspaceRoot}). Please select a subfolder instead, for example: ${resolvedWorkspaceRoot}Projects`);
  }
  if (!fs.existsSync(resolvedWorkspaceRoot)) {
    fs.mkdirSync(resolvedWorkspaceRoot, { recursive: true });
  }
  if (!fs.statSync(resolvedWorkspaceRoot).isDirectory()) {
    throw new Error(`Selected workspace is not a directory: ${resolvedWorkspaceRoot}`);
  }
  return resolvedWorkspaceRoot;
};

const getDefaultExportImageName = (defaultFileName?: string): string => {
  const normalized = typeof defaultFileName === 'string' && defaultFileName.trim()
    ? defaultFileName.trim()
    : `cowork-session-${Date.now()}`;
  return ensurePngFileName(sanitizeExportFileName(normalized));
};

const savePngWithDialog = async (
  webContents: WebContents,
  pngData: Buffer,
  defaultFileName?: string,
): Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }> => {
  const defaultName = getDefaultExportImageName(defaultFileName);
  const ownerWindow = BrowserWindow.fromWebContents(webContents);
  const saveOptions = {
    title: 'Export Session Image',
    defaultPath: path.join(app.getPath('downloads'), defaultName),
    filters: [{ name: 'PNG Image', extensions: ['png'] }],
  };
  const saveResult = ownerWindow
    ? await dialog.showSaveDialog(ownerWindow, saveOptions)
    : await dialog.showSaveDialog(saveOptions);

  if (saveResult.canceled || !saveResult.filePath) {
    return { success: true, canceled: true };
  }

  const outputPath = ensurePngFileName(saveResult.filePath);
  await fs.promises.writeFile(outputPath, pngData);
  return { success: true, canceled: false, path: outputPath };
};

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

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeWindowsShellPath = (inputPath: string): string => {
  if (!isWindows) return inputPath;

  const trimmed = inputPath.trim();
  if (!trimmed) return inputPath;

  let normalized = trimmed;
  if (/^file:\/\//i.test(normalized)) {
    normalized = safeDecodeURIComponent(normalized.replace(/^file:\/\//i, ''));
  }

  if (/^\/[A-Za-z]:/.test(normalized)) {
    normalized = normalized.slice(1);
  }

  const unixDriveMatch = normalized.match(/^[/\\]([A-Za-z])[/\\](.+)$/);
  if (unixDriveMatch) {
    const drive = unixDriveMatch[1].toUpperCase();
    const rest = unixDriveMatch[2].replace(/[/\\]+/g, '\\');
    return `${drive}:\\${rest}`;
  }

  if (/^[A-Za-z]:[/\\]/.test(normalized)) {
    const drive = normalized[0].toUpperCase();
    const rest = normalized.slice(1).replace(/\//g, '\\');
    return `${drive}${rest}`;
  }

  return normalized;
};

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
    } catch (error: unknown) {
      const stderr = typeof error === 'object' && error && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr ?? '')
        : '';
      // Check if it's a permission error
      if (stderr.includes('不能获取对象') ||
          stderr.includes('not authorized') ||
          stderr.includes('Permission denied')) {
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
    } catch {
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
let openClawRuntimeAdapter: OpenClawRuntimeAdapter | null = null;
let coworkEngineRouter: CoworkEngineRouter | null = null;
let skillManager: SkillManager | null = null;
let mcpStore: McpStore | null = null;
let mcpServerManager: McpServerManager | null = null;
let mcpBridgeServer: McpBridgeServer | null = null;
// Generated eagerly so the secret is available before the first syncOpenClawConfig
// call — the gateway process inherits it via LOBSTER_MCP_BRIDGE_SECRET env var at
// spawn time, avoiding a restart just to pick up the correct secret.
let mcpBridgeSecret: string = require('crypto').randomUUID();
let mcpBridgeStartPromise: Promise<McpBridgeConfig | null> | null = null;
let imGatewayManager: IMGatewayManager | null = null;
let storeInitPromise: Promise<SqliteStore> | null = null;
let sqliteBackupManager: SqliteBackupManager | null = null;
let openClawEngineManager: OpenClawEngineManager | null = null;
let openClawConfigSync: OpenClawConfigSync | null = null;
let openClawBootstrapPromise: Promise<OpenClawEngineStatus> | null = null;
let openClawStatusForwarderBound = false;
let coworkRuntimeForwarderBound = false;
let memoryMigrationDone = false;
let preventSleepBlockerId: number | null = null;
let appUpdateCoordinator: AppUpdateCoordinator | null = null;

function setPreventSleepBlockerEnabled(enabled: boolean): void {
  if (enabled) {
    if (preventSleepBlockerId === null || !powerSaveBlocker.isStarted(preventSleepBlockerId)) {
      preventSleepBlockerId = powerSaveBlocker.start(PowerSaveBlockerType.PreventAppSuspension);
    }
    return;
  }

  if (preventSleepBlockerId !== null && powerSaveBlocker.isStarted(preventSleepBlockerId)) {
    powerSaveBlocker.stop(preventSleepBlockerId);
  }
  preventSleepBlockerId = null;
}

const initStore = async (): Promise<SqliteStore> => {
  if (!storeInitPromise) {
    if (!app.isReady()) {
      throw new Error('Store accessed before app is ready.');
    }
    // better-sqlite3 opens the database synchronously, so Promise.resolve() resolves
    // immediately. The timeout acts as a safety net for unexpected OS-level
    // blocking during store initialization and recovery.
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

const getAppUpdateCoordinator = (): AppUpdateCoordinator => {
  if (!appUpdateCoordinator) {
    appUpdateCoordinator = new AppUpdateCoordinator(getStore());
  }
  return appUpdateCoordinator;
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

const getEngineNotReadyResponse = (status: OpenClawEngineStatus) => {
  const fallbackMessage = 'AI engine is initializing. Please try again in a moment.';
  return {
    success: false,
    code: ENGINE_NOT_READY_CODE,
    error: status.message || fallbackMessage,
    engineStatus: status,
  };
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

// Module-level handle so ensureOpenClawRunningForCowork can await any in-flight
// proactive token refresh before syncing config to the gateway.
let pendingTokenRefresh: Promise<string | null> | null = null;

const ensureOpenClawRunningForCowork = async () => {
  const manager = getOpenClawEngineManager();
  const status = manager.getStatus();
  if (status.phase === 'running') {
    // Token proxy handles dynamic token injection — no need to restart
    // the gateway for token changes. Just wait for any in-flight refresh.
    if (pendingTokenRefresh) {
      console.log('[OpenClaw] ensureRunning: awaiting pending token refresh before proceeding');
      await pendingTokenRefresh.catch(() => {});
    }
    return manager.getStatus();
  }
  if (status.phase === 'starting') {
    return status;
  }

  // Wait for any in-flight token refresh so that the gateway starts with
  // a fresh token rather than the stale one that triggered the refresh.
  if (pendingTokenRefresh) {
    console.log('[OpenClaw] ensureRunning: awaiting pending token refresh before gateway start');
    await pendingTokenRefresh.catch(() => {});
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
    coworkStore = new CoworkStore(sqliteStore.getDatabase());
    const cleaned = coworkStore.autoDeleteNonPersonalMemories();
    if (cleaned > 0) {
      console.info(`[cowork-memory] Auto-deleted ${cleaned} non-personal/procedural memories`);
    }
  }
  return coworkStore;
};

let agentManager: AgentManager | null = null;
const getAgentManager = () => {
  if (!agentManager) {
    agentManager = new AgentManager(getCoworkStore());
  }
  return agentManager;
};

const resolveCoworkAgentEngine = (): CoworkAgentEngine => {
  return getCoworkStore().getConfig().agentEngine;
};

const getOpenClawConfigSync = (): OpenClawConfigSync => {
  if (!openClawConfigSync) {
    openClawConfigSync = new OpenClawConfigSync({
      engineManager: getOpenClawEngineManager(),
      getCoworkConfig: () => getCoworkStore().getConfig(),
      isEnterprise: () => !!getStore().get('enterprise_config'),
      getOpenClawSessionPolicy: () => loadOpenClawSessionPolicyConfig(getStore()),
      getSkillsList: () => getSkillManager().listSkills().map(s => ({ id: s.id, enabled: s.enabled })),
      getTelegramInstances: () => {
        try {
          return getIMGatewayManager().getIMStore().getTelegramInstances();
        } catch {
          return [];
        }
      },
      getDingTalkInstances: () => {
        try {
          return getIMGatewayManager().getIMStore().getDingTalkInstances();
        } catch {
          return [];
        }
      },
      getFeishuInstances: () => {
        try {
          return getIMGatewayManager().getIMStore().getFeishuInstances();
        } catch {
          return [];
        }
      },
      getQQInstances: () => {
        try {
          return getIMGatewayManager().getIMStore().getQQInstances();
        } catch {
          return [];
        }
      },
      getWecomInstances: () => {
        try {
          return getIMGatewayManager().getIMStore().getWecomInstances();
        } catch {
          return [];
        }
      },
      getPopoConfig: () => {
        try {
          return getIMGatewayManager().getConfig().popo;
          } catch {
          return null;
        }
      },
      getEmailOpenClawConfig: () => {
        try {
          return getIMGatewayManager().getIMStore().getEmailConfig();
        } catch {
          return { instances: [] };
        }
      },
      getNimInstances: () => {
        try {
          return getIMGatewayManager().getIMStore().getNimInstances();
        } catch {
          return [];
        }
      },
      getNeteaseBeeChanConfig: () => {
        try {
          return getIMGatewayManager().getConfig()['netease-bee'];
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
      getIMSettings: () => {
        try {
          return getIMGatewayManager().getConfig().settings;
        } catch {
          return null;
        }
      },
      getDiscordInstances: () => {
        try {
          return getIMGatewayManager()?.getIMStore()?.getDiscordInstances() ?? [];
        } catch {
          return [];
        }
      },
      getMcpBridgeConfig: (): McpBridgeConfig | null => {
        if (!mcpBridgeServer?.callbackUrl || !mcpBridgeServer?.askUserCallbackUrl || !mcpBridgeSecret) {
          return null;
        }
        return {
          callbackUrl: mcpBridgeServer.callbackUrl,
          askUserCallbackUrl: mcpBridgeServer.askUserCallbackUrl,
          secret: mcpBridgeSecret,
          tools: mcpServerManager?.toolManifest ?? [],
        };
      },
      getMcpBridgeSecret: () => mcpBridgeSecret,
      getAgents: () => getCoworkStore().listAgents(),
    });
  }
  return openClawConfigSync;
};

// Deferred gateway restart: when a config change requires a gateway restart
// but active cowork sessions or cron jobs exist, we defer the restart until
// all workloads complete.  A polling interval checks periodically; a hard
// timeout ensures the restart eventually happens even if a session hangs.
let deferredRestartTimer: ReturnType<typeof setInterval> | null = null;
let deferredRestartTimeout: ReturnType<typeof setTimeout> | null = null;
const DEFERRED_RESTART_POLL_MS = 3_000;
const DEFERRED_RESTART_MAX_WAIT_MS = 5 * 60_000; // 5 minutes hard cap

const hasActiveGatewayWorkloads = (): boolean => {
  if (openClawRuntimeAdapter?.hasActiveSessions()) return true;
  try {
    if (getCronJobService()?.hasRunningJobs()) return true;
  } catch {
    // CronJobService may not be initialized yet.
  }
  return false;
};

const clearDeferredRestart = () => {
  if (deferredRestartTimer) { clearInterval(deferredRestartTimer); deferredRestartTimer = null; }
  if (deferredRestartTimeout) { clearTimeout(deferredRestartTimeout); deferredRestartTimeout = null; }
};

const executeDeferredGatewayRestart = async (reason: string) => {
  clearDeferredRestart();
  console.log(`[OpenClaw] executeDeferredGatewayRestart: performing deferred restart (reason: ${reason})`);
  await syncOpenClawConfig({ reason: `deferred:${reason}` });
};

const scheduleDeferredGatewayRestart = (reason: string) => {
  // If already scheduled, the latest config is already on disk — just let
  // the existing timer handle the restart.
  if (deferredRestartTimer) {
    console.log(`[OpenClaw] scheduleDeferredGatewayRestart: already scheduled, skipping (reason: ${reason})`);
    return;
  }

  deferredRestartTimer = setInterval(() => {
    if (!hasActiveGatewayWorkloads()) {
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
): Promise<{ success: boolean; changed: boolean; mcpBridgeConfigChanged?: boolean; status?: OpenClawEngineStatus; error?: string }> => {
  const D = '[GW-RESTART-DIAG]';
  console.log(`${D} ──── syncOpenClawConfig START reason=${options.reason} restartIfRunning=${!!options.restartGatewayIfRunning}`);

  const syncResult = getOpenClawConfigSync().sync(options.reason);
  console.log(`${D} sync() ok=${syncResult.ok} changed=${syncResult.changed} bindingsChanged=${!!syncResult.bindingsChanged}`);
  if (!syncResult.ok) {
    console.log(`${D} sync FAILED: ${syncResult.error}`);
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

  try {
    mergeEnterpriseOpenclawConfig(getOpenClawEngineManager().getConfigPath());
  } catch { /* non-critical */ }

  const nextSecretEnvVars = getOpenClawConfigSync().collectSecretEnvVars();
  const prevSecretEnvVars = getOpenClawEngineManager().getSecretEnvVars();
  const secretEnvVarsChanged = JSON.stringify(nextSecretEnvVars) !== JSON.stringify(prevSecretEnvVars);
  getOpenClawEngineManager().setSecretEnvVars(nextSecretEnvVars);

  // Diagnostic: print which env vars changed
  if (secretEnvVarsChanged) {
    const allKeys = new Set([...Object.keys(prevSecretEnvVars), ...Object.keys(nextSecretEnvVars)]);
    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];
    for (const k of allKeys) {
      const prev = prevSecretEnvVars[k];
      const next = nextSecretEnvVars[k];
      if (prev === next) continue;
      if (prev === undefined) { added.push(k); }
      else if (next === undefined) { removed.push(k); }
      else { modified.push(k); }
    }
    console.log(`${D} SECRET ENV VARS CHANGED!`);
    if (added.length) console.log(`${D}   added: ${added.join(', ')}`);
    if (removed.length) console.log(`${D}   removed: ${removed.join(', ')}`);
    for (const k of modified) {
      const p = (prevSecretEnvVars[k] || '').slice(0, 12);
      const n = (nextSecretEnvVars[k] || '').slice(0, 12);
      console.log(`${D}   modified: ${k} prev=${p}… next=${n}…`);
    }
  } else {
    console.log(`${D} secretEnvVars unchanged (${Object.keys(nextSecretEnvVars).length} keys)`);
  }

  // Force a hard restart when the mcp-bridge callbackUrl or tools changed,
  // regardless of the restartGatewayIfRunning flag.  The OpenClaw gateway
  // pins its config snapshot at startup, so a hot-reload alone won't pick
  // up a new callbackUrl — the gateway must be fully restarted.
  const mcpBridgeForceRestart = !!syncResult.mcpBridgeConfigChanged;
  const needsHardRestart = secretEnvVarsChanged || syncResult.bindingsChanged || mcpBridgeForceRestart || (syncResult.changed && options.restartGatewayIfRunning);

  console.log(`${D} needsHardRestart=${needsHardRestart} (envChanged=${secretEnvVarsChanged} bindingsChanged=${!!syncResult.bindingsChanged} mcpBridgeChanged=${mcpBridgeForceRestart} configChanged=${syncResult.changed} restartFlag=${!!options.restartGatewayIfRunning})`);

  if (!needsHardRestart) {
    console.log(`${D} ──── NO RESTART, hot-reload only. reason=${options.reason}`);
    return {
      success: true,
      changed: syncResult.changed,
      mcpBridgeConfigChanged: syncResult.mcpBridgeConfigChanged,
    };
  }

  const manager = getOpenClawEngineManager();
  const status = manager.getStatus();
  if (status.phase !== 'running') {
    console.log(`${D} ──── RESTART NEEDED but gateway not running (phase=${status.phase}), skipping. reason=${options.reason}`);
    return {
      success: true,
      changed: true,
      status,
    };
  }

  if (hasActiveGatewayWorkloads()) {
    console.log(`${D} ──── RESTART DEFERRED (active workloads). reason=${options.reason}`);
    scheduleDeferredGatewayRestart(options.reason);
    return {
      success: true,
      changed: true,
      status,
    };
  }

  console.log(`${D} ──── HARD RESTART EXECUTING. reason=${options.reason}`);
  if (openClawRuntimeAdapter) {
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

const bindCoworkRuntimeForwarder = (): void => {
  if (coworkRuntimeForwarderBound) return;
  const runtime = getCoworkEngineRouter();

  runtime.on('message', (sessionId: string, message: unknown) => {
    const safeMessage = sanitizeCoworkMessageForIpc(message);
    const windows = BrowserWindow.getAllWindows();
    const messageType = typeof message === 'object' && message && 'type' in message
      ? (message as { type?: unknown }).type
      : undefined;
    console.log('[CoworkForwarder] forwarding message: sessionId=', sessionId, 'type=', messageType, 'windowCount=', windows.length);
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

  runtime.on('permissionRequest', (sessionId: string, request: unknown) => {
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
    // If session used a server model, notify renderer to refresh quota
    try {
      const apiConfig = resolveCurrentApiConfig();
      if (apiConfig.providerMetadata?.providerName === 'lobsterai-server') {
        const windows = BrowserWindow.getAllWindows();
        windows.forEach((win) => {
          if (win.isDestroyed()) return;
          win.webContents.send('auth:quotaChanged');
        });
      }
    } catch {
      // ignore
    }
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
    mcpStore = new McpStore(sqliteStore.getDatabase());
  }
  return mcpStore;
};

/**
 * Start the MCP Bridge: server manager + HTTP callback.
 * Called during OpenClaw bootstrap before config sync.
 * Returns the bridge config to be written into openclaw.json.
 *
 * The HTTP callback server is always started (even without MCP servers)
 * because the AskUserQuestion plugin also uses it for user confirmation dialogs.
 */
const startMcpBridge = (): Promise<McpBridgeConfig | null> => {
  // Deduplicate concurrent calls — only one initialization at a time
  if (mcpBridgeStartPromise) {
    return mcpBridgeStartPromise;
  }
  mcpBridgeStartPromise = (async (): Promise<McpBridgeConfig | null> => {
  try {
    console.log('[McpBridge] startMcpBridge called');

    // Discover MCP tools (may be empty if no servers configured)
    const enabledServers = getMcpStore().getEnabledServers();
    console.log(`[McpBridge] enabledServers: ${enabledServers.length} (${enabledServers.map(s => s.name).join(', ')})`);

    let tools: Awaited<ReturnType<McpServerManager['startServers']>> = [];
    if (enabledServers.length > 0) {
      if (!mcpServerManager) {
        mcpServerManager = new McpServerManager();
      }
      console.log('[McpBridge] starting MCP servers...');
      tools = await mcpServerManager.startServers(enabledServers);
      console.log(`[McpBridge] tools discovered: ${tools.length}`);
    }

    // Always start HTTP callback server (serves both MCP Bridge and AskUserQuestion)
    if (!mcpServerManager) {
      mcpServerManager = new McpServerManager();
    }
    if (!mcpBridgeServer) {
      mcpBridgeServer = new McpBridgeServer(mcpServerManager, mcpBridgeSecret);
    }
    if (!mcpBridgeServer.port) {
      console.log('[McpBridge] starting HTTP callback server...');
      await mcpBridgeServer.start();
    }

    // Register AskUserQuestion callback — shows a permission modal when the
    // ask-user-question OpenClaw plugin sends a request via HTTP.
    mcpBridgeServer.onAskUser((request) => {
      const windows = BrowserWindow.getAllWindows();
      windows.forEach((win) => {
        if (win.isDestroyed()) return;
        try {
          win.webContents.send('cowork:stream:permission', {
            sessionId: '__askuser__',
            request: {
              requestId: request.requestId,
              toolName: 'AskUserQuestion',
              toolInput: { questions: request.questions },
            },
          });
        } catch (error) {
          console.error('[AskUser] failed to send permission request to window:', error);
        }
      });
    });

    // Dismiss the AskUser modal when timeout or resolved from server side.
    // Simulate a deny response to remove it from the renderer's pending queue.
    mcpBridgeServer.onAskUserDismiss((requestId) => {
      const windows = BrowserWindow.getAllWindows();
      windows.forEach((win) => {
        if (win.isDestroyed()) return;
        try {
          win.webContents.send('cowork:stream:permissionDismiss', { requestId });
        } catch {
          // ignore
        }
      });
    });

    const callbackUrl = mcpBridgeServer.callbackUrl;
    const askUserCallbackUrl = mcpBridgeServer.askUserCallbackUrl;
    if (!callbackUrl || !askUserCallbackUrl) {
      console.error('[McpBridge] failed to get callback URL');
      return null;
    }

    console.log(`[McpBridge] started: ${tools.length} MCP tools, callback=${callbackUrl}`);
    return { callbackUrl, askUserCallbackUrl, secret: mcpBridgeSecret, tools };
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
const _stopMcpBridge = async (): Promise<void> => {
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

const broadcastMcpBridgeSync = (channel: string, data?: Record<string, unknown>): void => {
  const windows = BrowserWindow.getAllWindows();
  windows.forEach((win) => {
    if (win.isDestroyed()) return;
    try {
      win.webContents.send(channel, data ?? {});
    } catch (error) {
      console.error(`[McpBridge] Failed to broadcast ${channel}:`, error);
    }
  });
};

const refreshMcpBridge = (): Promise<{ tools: number; error?: string }> => {
  if (mcpBridgeRefreshPromise) {
    return mcpBridgeRefreshPromise;
  }
  mcpBridgeRefreshPromise = (async () => {
    try {
      console.log('[McpBridge] refreshing after config change...');
      broadcastMcpBridgeSync('mcp:bridge:syncStart');

      // 1. Stop existing MCP servers (but keep HTTP callback server alive — port stays the same)
      if (mcpServerManager) {
        await mcpServerManager.stopServers();
      }

      // 2. Re-discover tools from the new set of enabled servers
      const bridgeConfig = await startMcpBridge();
      const toolCount = bridgeConfig?.tools.length ?? 0;
      console.log(`[McpBridge] refresh: ${toolCount} tools discovered`);

      // 3. Sync openclaw.json — the gateway will hard-restart when the
      // mcp-bridge callbackUrl or tools change, ensuring the gateway picks
      // up the new config (it pins a snapshot at startup).
      const syncResult = await syncOpenClawConfig({
        reason: 'mcp-server-changed',
      });
      if (!syncResult.success) {
        console.error('[McpBridge] refresh: config sync failed:', syncResult.error);
        return { tools: toolCount, error: syncResult.error };
      }

      console.log(`[McpBridge] refresh complete: ${toolCount} tools, configChanged=${syncResult.changed}, mcpBridgeChanged=${!!syncResult.mcpBridgeConfigChanged}`);
      return { tools: toolCount };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[McpBridge] refresh error:', msg);
      return { tools: 0, error: msg };
    }
  })().then((result) => {
    broadcastMcpBridgeSync('mcp:bridge:syncDone', { tools: result.tools, error: result.error });
    return result;
  }).catch((err) => {
    const error = err instanceof Error ? err.message : String(err);
    broadcastMcpBridgeSync('mcp:bridge:syncDone', { tools: 0, error });
    return { tools: 0, error };
  }).finally(() => {
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
          // if (message.platform === 'dingtalk') {
          //   await getIMGatewayManager().primeConversationReplyRoute(
          //     message.platform,
          //     message.conversationId,
          //     sessionId,
          //   );
          // }
          const channelName = PlatformRegistry.channelOf(message.platform);
          const hasChannel = !!(channelName && message.conversationId);
          // Strip IM subtype prefix (e.g. "direct:ou_xxx" -> "ou_xxx")
          let deliveryTo = message.conversationId;
          if (hasChannel && deliveryTo) {
            const colonIdx = deliveryTo.indexOf(':');
            if (colonIdx > 0) {
              deliveryTo = deliveryTo.slice(colonIdx + 1);
            }
          }
          const task = await getCronJobService().addJob({
            name: request.taskName,
            description: '',
            enabled: true,
            schedule: {
              kind: 'at',
              at: request.scheduleAt,
            },
            sessionTarget: hasChannel ? 'isolated' : 'main',
            wakeMode: 'now',
            payload: hasChannel
              ? { kind: 'agentTurn', message: request.payloadText }
              : { kind: 'systemEvent', text: request.payloadText },
            delivery: {
              mode: hasChannel ? 'announce' : 'none',
              ...(channelName ? { channel: channelName } : {}),
              ...(hasChannel ? { to: deliveryTo } : message.conversationId ? { to: message.conversationId } : {}),
            },
            agentId: DEFAULT_MANAGED_AGENT_ID,
            ...(hasChannel ? {} : { sessionKey: buildManagedSessionKey(sessionId, DEFAULT_MANAGED_AGENT_ID) }),
          });
          return {
            id: task.id,
            name: task.name,
            agentId: task.agentId,
            sessionKey: task.sessionKey,
            payloadText: task.payload.kind === 'systemEvent'
              ? task.payload.text
              : task.payload.kind === 'agentTurn'
                ? task.payload.message
                : '',
            scheduleAt: task.schedule.kind === 'at' ? task.schedule.at : request.scheduleAt,
          };
        },
      }
    );

    // Initialize with LLM config provider
    imGatewayManager.initialize({
      getLLMConfig: async () => {
        type LlmProviderConfig = {
          enabled?: boolean;
          apiKey?: string;
          baseUrl?: string;
          models?: Array<{ id: string }>;
        };
        type LlmAppConfig = {
          providers?: Record<string, LlmProviderConfig>;
          api?: { key?: string; baseUrl?: string };
          model?: { defaultModel?: string };
        };
        const appConfig = sqliteStore.get<LlmAppConfig>('app_config');
        if (!appConfig) return null;

        // Find first enabled provider
        const providers = appConfig.providers || {};
        for (const [providerName, providerConfig] of Object.entries(providers)) {
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
  sqliteAutoBackupEnabled?: boolean;
};

const getUseSystemProxyFromConfig = (config?: { useSystemProxy?: boolean }): boolean => {
  return config?.useSystemProxy === true;
};

const getSqliteAutoBackupEnabledFromConfig = (
  config?: { sqliteAutoBackupEnabled?: boolean },
): boolean => {
  return config?.sqliteAutoBackupEnabled === true;
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
  setSystemProxyEnabled(useSystemProxy);

  try {
    await session.defaultSession.setProxy({ mode: useSystemProxy ? 'system' : 'direct' });
  } catch (error) {
    console.error('[Main] Failed to apply session proxy mode:', error);
  }

  if (!useSystemProxy) {
    restoreOriginalProxyEnv();
    console.log('[Main] System proxy disabled (direct mode).');
    return;
  }

  const { proxyUrl, targetUrl } = await resolveSystemProxyUrlForTargets();
  applySystemProxyEnv(proxyUrl);

  if (proxyUrl) {
    console.log(`[Main] System proxy enabled for process env via ${targetUrl}:`, proxyUrl);
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
  // Register custom protocol for OAuth callback
  app.setAsDefaultProtocolClient('lobsterai');

  // Buffer for deep link auth code received before renderer is ready
  let pendingAuthCode: string | null = null;

  /**
   * Parse a lobsterai:// deep link and send (or buffer) the auth code.
   */
  const handleDeepLink = (url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'auth' && parsed.pathname === '/callback') {
        const code = parsed.searchParams.get('code');
        if (code) {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('auth:callback', { code });
          } else {
            pendingAuthCode = code;
          }
        }
      }
    } catch (e) {
      console.error('[Main] Failed to parse deep link:', e);
    }
  };

  // Allow renderer to retrieve a buffered auth code on init
  ipcMain.handle('auth:getPendingCallback', () => {
    const code = pendingAuthCode;
    pendingAuthCode = null;
    return code;
  });

  // macOS: handle open-url event for deep links
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.on('second-instance', (_event, commandLine, workingDirectory) => {
    console.debug('[Main] second-instance event', { commandLine, workingDirectory });

    // Check for deep link in command line args (Windows/Linux)
    const deepLink = commandLine.find(arg => arg.startsWith('lobsterai://'));
    if (deepLink) {
      handleDeepLink(deepLink);
    }

    // Focus main window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      if (!mainWindow.isFocused()) mainWindow.focus();
    }
  });

  // IPC 处理程序
  ipcMain.handle('store:get', (_event, key) => {
    return getStore().get(key);
  });

  ipcMain.handle('store:set', async (_event, key, value) => {
    getStore().set(key, value);
    if (key === 'app_config') {
      refreshEndpointsTestMode(getStore());
      const syncResult = await syncOpenClawConfig({
        reason: 'app-config-change',
        restartGatewayIfRunning: true,
      });
      if (!syncResult.success) {
        console.error('[OpenClaw] Failed to sync config after app_config update:', syncResult.error);
      }
    }
  });

  ipcMain.handle('store:remove', (_event, key) => {
    getStore().delete(key);
  });

  ipcMain.handle('enterprise:getConfig', async () => {
    try {
      return getStore().get('enterprise_config') ?? null;
    } catch {
      return null;
    }
  });

  // Network status change handler
  // Remove any existing listener first to avoid duplicate registrations
  ipcMain.removeAllListeners('network:status-change');
  ipcMain.on('network:status-change', (_event, status: 'online' | 'offline') => {
    console.log(`[Main] Network status changed: ${status}`);

    if (status === 'online' && imGatewayManager) {
      console.log('[Main] Network restored, reconnecting IM gateways...');
      imGatewayManager.reconnectAllDisconnected();
    }
  });

  // Log IPC handlers
  ipcMain.handle('log:getPath', () => {
    return getLogFilePath();
  });

  ipcMain.handle('log:openFolder', () => {
    const logPath = getLogFilePath();
    if (logPath) {
      shell.showItemInFolder(logPath);
    }
  });

  ipcMain.handle('log:exportZip', async (event) => {
    try {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      if (!ownerWindow || ownerWindow.isDestroyed()) {
        return { success: false, error: 'Window is not available' };
      }

      const saveOptions = {
        title: 'Export Logs',
        defaultPath: path.join(app.getPath('downloads'), buildLogExportFileName()),
        filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
      };

      const saveResult = await dialog.showSaveDialog(ownerWindow, saveOptions);

      if (saveResult.canceled || !saveResult.filePath) {
        return { success: true, canceled: true };
      }

      const outputPath = ensureZipFileName(saveResult.filePath);
      const manager = getOpenClawEngineManager();
      const archiveResult = await exportLogsZip({
        outputPath,
        entries: [
          ...getRecentMainLogEntries(),
          { archiveName: 'cowork.log', filePath: getCoworkLogPath() },
          { archiveName: 'gateway.log', filePath: manager.getGatewayLogPath() },
          ...getRecentOpenClawDailyLogEntries(manager.getOpenClawDailyLogDir()),
          ...(process.platform === 'win32'
            ? [{ archiveName: 'install-timing.log', filePath: path.join(app.getPath('appData'), 'LobsterAI', 'install-timing.log') }]
            : []),
        ],
      });

      return {
        success: true,
        canceled: false,
        path: outputPath,
        missingEntries: archiveResult.missingEntries,
      };
    } catch (error) {
      console.error('[LogExport] export failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to export logs',
      };
    }
  });

  // Auto-launch IPC handlers
  // Use SQLite store as the source of truth for UI state, because
  // app.getLoginItemSettings() returns unreliable values on macOS and
  // requires matching args on Windows.
  ipcMain.handle('app:getAutoLaunch', () => {
    const stored = getStore().get<boolean>('auto_launch_enabled');
    // Fall back to OS API if SQLite has no record yet (e.g. upgraded from older version)
    const enabled = stored ?? getAutoLaunchEnabled();
    return { enabled };
  });

  ipcMain.handle('app:setAutoLaunch', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      return { success: false, error: 'Invalid parameter: enabled must be boolean' };
    }
    try {
      setAutoLaunchEnabled(enabled);
      getStore().set('auto_launch_enabled', enabled);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set auto-launch',
      };
    }
  });

  ipcMain.handle('app:getPreventSleep', () => {
    const enabled = getStore().get<boolean>('prevent_sleep_enabled') ?? false;
    return { enabled };
  });

  ipcMain.handle('app:setPreventSleep', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      return { success: false, error: 'Invalid parameter: enabled must be boolean' };
    }
    try {
      setPreventSleepBlockerEnabled(enabled);
      getStore().set('prevent_sleep_enabled', enabled);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set prevent-sleep',
      };
    }
  });

  // Window control IPC handlers
  ipcMain.on('window-minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.on('window-close', () => {
    mainWindow?.close();
  });

  ipcMain.handle('window:isMaximized', () => {
    return mainWindow?.isMaximized() ?? false;
  });

  ipcMain.on('window:showSystemMenu', (_event, position: { x?: number; y?: number } | undefined) => {
    showSystemMenu(position);
  });

  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:getSystemLocale', () => app.getLocale());

  // ── Auth IPC handlers ──

  /**
   * Helper: Persist auth tokens into the kv store.
   */
  const saveAuthTokens = (accessToken: string, refreshToken: string) => {
    getStore().set('auth_tokens', { accessToken, refreshToken });
  };

  const getAuthTokens = (): { accessToken: string; refreshToken: string } | null => {
    return getStore().get<{ accessToken: string; refreshToken: string }>('auth_tokens') || null;
  };

  const clearAuthTokens = () => {
    getStore().delete('auth_tokens');
  };

  /**
   * Helper: Fetch with Bearer token, auto-refresh on 401 and retry once.
   */
  const fetchWithAuth = async (url: string, options?: RequestInit): Promise<Response> => {
    const tokens = getAuthTokens();
    if (!tokens) throw new Error('No auth tokens');

    const doFetch = (accessToken: string) =>
      net.fetch(url, {
        ...options,
        headers: { ...(options?.headers as Record<string, string>), Authorization: `Bearer ${accessToken}` },
      });

    let resp = await doFetch(tokens.accessToken);

    if (resp.status === 401 && tokens.refreshToken) {
      const serverBaseUrl = getServerApiBaseUrl();
      const refreshResp = await net.fetch(`${serverBaseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      });
      if (refreshResp.ok) {
        const refreshBody = await refreshResp.json() as { code: number; data: { accessToken: string; refreshToken?: string } };
        if (refreshBody.code === 0 && refreshBody.data) {
          saveAuthTokens(refreshBody.data.accessToken, refreshBody.data.refreshToken || tokens.refreshToken);
          resp = await doFetch(refreshBody.data.accessToken);
        }
      }
    }

    return resp;
  };

  /**
   * Normalize quota data from various server response formats into a unified shape.
   */
  const normalizeQuota = (raw: Record<string, unknown>) => {
    let creditsLimit = 0;
    let creditsUsed = 0;
    let planName = t('authPlanFree');
    let subscriptionStatus = 'free';

    if (typeof raw.freeCreditsTotal === 'number') {
      // Free user format from /api/user/quota
      creditsLimit = raw.freeCreditsTotal as number;
      creditsUsed = (raw.freeCreditsUsed as number) || 0;
      planName = (raw.planName as string) || t('authPlanFree');
      subscriptionStatus = (raw.subscriptionStatus as string) || 'free';
    } else if (typeof raw.monthlyCreditsLimit === 'number') {
      // Paid user format from /api/user/quota
      creditsLimit = raw.monthlyCreditsLimit as number;
      creditsUsed = (raw.monthlyCreditsUsed as number) || 0;
      planName = (raw.planName as string) || t('authPlanStandard');
      subscriptionStatus = (raw.subscriptionStatus as string) || 'active';
    } else if (typeof raw.dailyCreditsLimit === 'number') {
      // Legacy exchange format
      creditsLimit = raw.dailyCreditsLimit as number;
      creditsUsed = (raw.dailyCreditsUsed as number) || 0;
      planName = (raw.planName as string) || t('authPlanFree');
      subscriptionStatus = (raw.subscriptionStatus as string) || 'free';
    } else if (typeof raw.creditsLimit === 'number') {
      // Already normalized
      return raw;
    }

    return {
      planName,
      subscriptionStatus,
      creditsLimit,
      creditsUsed,
      creditsRemaining: Math.max(0, creditsLimit - creditsUsed),
    };
  };

  ipcMain.handle('auth:login', async (_event, { loginUrl }: { loginUrl?: string } = {}) => {
    try {
      const baseUrl = loginUrl || `${getServerApiBaseUrl()}/login`;
      const finalUrl = `${baseUrl}?source=electron`;
      await shell.openExternal(finalUrl);
      return { success: true };
    } catch (error) {
      console.error('[Auth] login failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open login' };
    }
  });

  ipcMain.handle('auth:exchange', async (_event, { code }: { code: string }) => {
    try {
      const serverBaseUrl = getServerApiBaseUrl();
      const resp = await net.fetch(`${serverBaseUrl}/api/auth/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authCode: code }),
      });
      if (!resp.ok) {
        return { success: false, error: `Exchange failed: ${resp.status}` };
      }
      const body = await resp.json() as {
        code: number;
        message?: string;
        data: {
          accessToken: string;
          refreshToken: string;
          user: Record<string, unknown>;
          quota: Record<string, unknown>;
        };
      };
      if (body.code !== 0 || !body.data) {
        return { success: false, error: body.message || 'Exchange failed' };
      }
      saveAuthTokens(body.data.accessToken, body.data.refreshToken);
      console.log('[Auth] exchange user data:', JSON.stringify(body.data.user));
      return { success: true, user: body.data.user, quota: normalizeQuota(body.data.quota) };
    } catch (error) {
      console.error('[Auth] exchange failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Exchange failed' };
    }
  });

  ipcMain.handle('auth:getUser', async () => {
    try {
      const tokens = getAuthTokens();
      if (!tokens) return { success: false };
      const serverBaseUrl = getServerApiBaseUrl();
      // Fetch user profile
      const profileResp = await fetchWithAuth(`${serverBaseUrl}/api/user/profile`);
      if (!profileResp.ok) return { success: false };
      const profileBody = await profileResp.json() as { code: number; data: Record<string, unknown> };
      if (profileBody.code !== 0 || !profileBody.data) return { success: false };
      // Fetch quota separately
      const quotaResp = await fetchWithAuth(`${serverBaseUrl}/api/user/quota`);
      let quota = null;
      if (quotaResp.ok) {
        const quotaBody = await quotaResp.json() as { code: number; data: Record<string, unknown> };
        if (quotaBody.code === 0 && quotaBody.data) {
          quota = normalizeQuota(quotaBody.data);
        }
      }
      console.log('[Auth] getUser profile data:', JSON.stringify(profileBody.data));
      return { success: true, user: profileBody.data, quota };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle('auth:getQuota', async () => {
    try {
      const tokens = getAuthTokens();
      if (!tokens) return { success: false };
      const serverBaseUrl = getServerApiBaseUrl();
      const resp = await fetchWithAuth(`${serverBaseUrl}/api/user/quota`);
      if (!resp.ok) return { success: false };
      const body = await resp.json() as { code: number; data: Record<string, unknown> };
      if (body.code !== 0 || !body.data) return { success: false };
      return { success: true, quota: normalizeQuota(body.data) };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle('auth:getProfileSummary', async () => {
    try {
      const tokens = getAuthTokens();
      if (!tokens) return { success: false };
      const serverBaseUrl = getServerApiBaseUrl();
      const resp = await fetchWithAuth(`${serverBaseUrl}/api/user/profile-summary`);
      if (!resp.ok) return { success: false };
      const body = await resp.json() as { code: number; data: Record<string, unknown> };
      if (body.code !== 0 || !body.data) return { success: false };
      return { success: true, data: body.data };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle('auth:logout', async () => {
    try {
      const tokens = getAuthTokens();
      if (tokens) {
        const serverBaseUrl = getServerApiBaseUrl();
        await net.fetch(`${serverBaseUrl}/api/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        }).catch(() => { /* best-effort */ });
      }
      clearAuthTokens();
      clearServerModelMetadata();
      return { success: true };
    } catch {
      clearAuthTokens();
      clearServerModelMetadata();
      return { success: true };
    }
  });

  ipcMain.handle('auth:refreshToken', async () => {
    try {
      const tokens = getAuthTokens();
      if (!tokens?.refreshToken) return { success: false };
      const serverBaseUrl = getServerApiBaseUrl();
      const resp = await net.fetch(`${serverBaseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      });
      if (!resp.ok) return { success: false };
      const body = await resp.json() as { code: number; data: { accessToken: string; refreshToken?: string } };
      if (body.code !== 0 || !body.data) return { success: false };
      saveAuthTokens(body.data.accessToken, body.data.refreshToken || tokens.refreshToken);
      return { success: true, accessToken: body.data.accessToken };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle('auth:getAccessToken', async () => {
    const tokens = getAuthTokens();
    return tokens?.accessToken || null;
  });

  ipcMain.handle('auth:getModels', async () => {
    try {
      const tokens = getAuthTokens();
      if (!tokens) {
        console.log('[Auth:getModels] No auth tokens available');
        return { success: false };
      }
      const serverBaseUrl = getServerApiBaseUrl();
      const url = `${serverBaseUrl}/api/models/available`;
      console.log('[Auth:getModels] Fetching:', url);
      const resp = await fetchWithAuth(url);
      console.log('[Auth:getModels] Response status:', resp.status);
      if (!resp.ok) {
        console.log('[Auth:getModels] Response not ok:', resp.status, resp.statusText);
        return { success: false };
      }
      const data = await resp.json() as { code: number; data: Array<{ modelId: string; modelName: string; provider: string; apiFormat: string; supportsImage?: boolean }> };
      console.log('[Auth:getModels] Response data:', JSON.stringify(data).slice(0, 500));
      if (data.code !== 0) return { success: false };
      // Cache server model metadata for use in OpenClaw config sync (supportsImage, etc.)
      updateServerModelMetadata(data.data);
      // Re-sync so the gateway picks up the correct supportsImage values for server models.
      // The startup sync runs before this IPC call, so the cache was empty then.
      // restartGatewayIfRunning:true ensures the gateway restarts only when the config
      // actually changed; the deferred-restart mechanism keeps active sessions safe.
      syncOpenClawConfig({ reason: 'server-models-updated', restartGatewayIfRunning: false }).catch(() => {});
      return { success: true, models: data.data };
    } catch (e) {
      console.error('[Auth:getModels] Error:', e);
      return { success: false };
    }
  });

  // Skills IPC handlers
  ipcMain.handle('skills:list', () => {
    try {
      const skills = getSkillManager().listSkills();
      return { success: true, skills };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to load skills' };
    }
  });

  ipcMain.handle('skills:setEnabled', (_event, options: { id: string; enabled: boolean }) => {
    try {
      const skills = getSkillManager().setSkillEnabled(options.id, options.enabled);
      return { success: true, skills };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update skill' };
    }
  });

  ipcMain.handle('skills:delete', (_event, id: string) => {
    try {
      const skills = getSkillManager().deleteSkill(id);
      return { success: true, skills };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete skill' };
    }
  });

  ipcMain.handle('skills:download', async (_event, source: string) => {
    return getSkillManager().downloadSkill(source);
  });

  ipcMain.handle('skills:upgrade', async (_event, skillId: string, downloadUrl: string) => {
    return getSkillManager().upgradeSkill(skillId, downloadUrl);
  });

  ipcMain.handle('skills:confirmInstall', async (_event, pendingId: string, action: string) => {
    const validActions = ['install', 'installDisabled', 'cancel'];
    if (!validActions.includes(action)) {
      return { success: false, error: 'Invalid action' };
    }
    return getSkillManager().confirmPendingInstall(
      pendingId,
      action as 'install' | 'installDisabled' | 'cancel'
    );
  });

  ipcMain.handle('skills:getRoot', () => {
    try {
      const root = getSkillManager().getSkillsRoot();
      return { success: true, path: root };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to resolve skills root' };
    }
  });

  ipcMain.handle('skills:autoRoutingPrompt', () => {
    try {
      const prompt = getSkillManager().buildAutoRoutingPrompt();
      return { success: true, prompt };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to build auto-routing prompt' };
    }
  });

  ipcMain.handle('skills:getConfig', (_event, skillId: string) => {
    return getSkillManager().getSkillConfig(skillId);
  });

  ipcMain.handle('skills:setConfig', (_event, skillId: string, config: Record<string, string>) => {
    return getSkillManager().setSkillConfig(skillId, config);
  });

  ipcMain.handle('skills:testEmailConnectivity', async (
    _event,
    skillId: string,
    config: Record<string, string>
  ) => {
    return getSkillManager().testEmailConnectivity(skillId, config);
  });

  ipcMain.handle('skills:fetchMarketplace', async () => {
    const url = getSkillStoreUrl();
    console.log(`[SkillMarketplace] fetching from: ${url}`);
    try {
      const https = await import('https');
      const data = await new Promise<string>((resolve, reject) => {
        const req = https.get(url, { timeout: 10000 }, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            res.resume();
            return;
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => { body += chunk; });
          res.on('end', () => resolve(body));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      });
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch skill marketplace' };
    }
  });

  ipcMain.handle('openclaw:engine:getStatus', async () => {
    try {
      const manager = getOpenClawEngineManager();
      return {
        success: true,
        status: manager.getStatus(),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get OpenClaw engine status',
      };
    }
  });

  ipcMain.handle('openclaw:engine:install', async () => {
    try {
      const status = await bootstrapOpenClawEngine({
        forceReinstall: false,
        reason: 'manual-install',
      });
      return {
        success: status.phase === 'running' || status.phase === 'ready',
        status,
      };
    } catch (error) {
      const manager = getOpenClawEngineManager();
      return {
        success: false,
        status: manager.getStatus(),
        error: error instanceof Error ? error.message : 'Failed to install OpenClaw engine',
      };
    }
  });

  ipcMain.handle('openclaw:engine:retryInstall', async () => {
    try {
      const status = await bootstrapOpenClawEngine({
        forceReinstall: true,
        reason: 'manual-retry',
      });
      return {
        success: status.phase === 'running' || status.phase === 'ready',
        status,
      };
    } catch (error) {
      const manager = getOpenClawEngineManager();
      return {
        success: false,
        status: manager.getStatus(),
        error: error instanceof Error ? error.message : 'Failed to retry OpenClaw engine install',
      };
    }
  });

  let restartGatewayPromise: Promise<OpenClawEngineStatus> | null = null;
  ipcMain.handle('openclaw:engine:restartGateway', async () => {
    if (restartGatewayPromise) {
      const status = await restartGatewayPromise;
      return { success: status.phase === 'running' || status.phase === 'ready', status };
    }
    try {
      const manager = getOpenClawEngineManager();
      restartGatewayPromise = manager.restartGateway();
      const status = await restartGatewayPromise;
      return {
        success: status.phase === 'running' || status.phase === 'ready',
        status,
      };
    } catch (error) {
      const manager = getOpenClawEngineManager();
      return {
        success: false,
        status: manager.getStatus(),
        error: error instanceof Error ? error.message : 'Failed to restart OpenClaw gateway',
      };
    } finally {
      restartGatewayPromise = null;
    }
  });

  // MCP Server IPC handlers
  ipcMain.handle('mcp:list', () => {
    try {
      const servers = getMcpStore().listServers();
      return { success: true, servers };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list MCP servers' };
    }
  });

  ipcMain.handle('mcp:create', async (_event, data: {
    name: string;
    description: string;
    transportType: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }) => {
    try {
      getMcpStore().createServer(data as McpServerFormData);
      const servers = getMcpStore().listServers();
      // Trigger async MCP bridge refresh (don't await — let UI show DB result immediately)
      refreshMcpBridge().catch(err => console.error('[McpBridge] background refresh error:', err));
      return { success: true, servers };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to create MCP server' };
    }
  });

  ipcMain.handle('mcp:update', async (_event, id: string, data: {
    name?: string;
    description?: string;
    transportType?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }) => {
    try {
      getMcpStore().updateServer(id, data as Partial<McpServerFormData>);
      const servers = getMcpStore().listServers();
      refreshMcpBridge().catch(err => console.error('[McpBridge] background refresh error:', err));
      return { success: true, servers };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update MCP server' };
    }
  });

  ipcMain.handle('mcp:delete', async (_event, id: string) => {
    try {
      getMcpStore().deleteServer(id);
      const servers = getMcpStore().listServers();
      refreshMcpBridge().catch(err => console.error('[McpBridge] background refresh error:', err));
      return { success: true, servers };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete MCP server' };
    }
  });

  ipcMain.handle('mcp:setEnabled', async (_event, options: { id: string; enabled: boolean }) => {
    try {
      getMcpStore().setEnabled(options.id, options.enabled);
      const servers = getMcpStore().listServers();
      refreshMcpBridge().catch(err => console.error('[McpBridge] background refresh error:', err));
      return { success: true, servers };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update MCP server' };
    }
  });

  ipcMain.handle('mcp:fetchMarketplace', async () => {
    const url = app.isPackaged
      ? 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/mcp-marketplace'
      : 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/test/mcp-marketplace';
    try {
      const https = await import('https');
      const data = await new Promise<string>((resolve, reject) => {
        const req = https.get(url, { timeout: 10000 }, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            res.resume();
            return;
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => { body += chunk; });
          res.on('end', () => resolve(body));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      });
      const json = JSON.parse(data);
      const value = json?.data?.value;
      if (!value) {
        return { success: false, error: 'Invalid response: missing data.value' };
      }
      const marketplace = typeof value === 'string' ? JSON.parse(value) : value;
      return { success: true, data: marketplace };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch marketplace' };
    }
  });

  // Explicit bridge refresh — renderer can await this for loading state
  ipcMain.handle('mcp:refreshBridge', async () => {
    try {
      const result = await refreshMcpBridge();
      return { success: true, tools: result.tools, error: result.error };
    } catch (error) {
      return { success: false, tools: 0, error: error instanceof Error ? error.message : 'Failed to refresh MCP bridge' };
    }
  });

  // Cowork IPC handlers
  ipcMain.handle('cowork:session:start', async (_event, options: {
    prompt: string;
    cwd?: string;
    systemPrompt?: string;
    title?: string;
    activeSkillIds?: string[];
    imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
    agentId?: string;
  }) => {
    try {
      const activeEngine = resolveCoworkAgentEngine();
      if (activeEngine === 'openclaw') {
        const engineStatus = await ensureOpenClawRunningForCowork();
        if (engineStatus.phase !== 'running') {
          return getEngineNotReadyResponse(engineStatus);
        }
      }

      const coworkStoreInstance = getCoworkStore();
      const config = coworkStoreInstance.getConfig();
      const systemPrompt = mergeCoworkSystemPrompt(
        activeEngine,
        options.systemPrompt ?? config.systemPrompt,
      );
      const selectedWorkspaceRoot = (options.cwd || config.workingDirectory || '').trim();

      if (!selectedWorkspaceRoot) {
        return {
          success: false,
          error: 'Please select a task folder before submitting.',
        };
      }

      // Generate title from first line of prompt
      const fallbackTitle = options.prompt.split('\n')[0].slice(0, 50) || 'New Session';
      const title = options.title?.trim() || fallbackTitle;
      const taskWorkingDirectory = resolveTaskWorkingDirectory(selectedWorkspaceRoot);

      const session = coworkStoreInstance.createSession(
        title,
        taskWorkingDirectory,
        systemPrompt,
        config.executionMode || 'local',
        options.activeSkillIds || [],
        options.agentId || 'main'
      );

      // Update session status to 'running' before starting async task
      // This ensures the frontend receives the correct status immediately
      coworkStoreInstance.updateSession(session.id, { status: 'running' });

      // Build metadata, include imageAttachments if present
      const messageMetadata: Record<string, unknown> = {};
      if (options.activeSkillIds?.length) {
        messageMetadata.skillIds = options.activeSkillIds;
      }
      if (options.imageAttachments?.length) {
        console.log('[Cowork:StartSession] imageAttachments received via IPC:', {
          count: options.imageAttachments.length,
          details: options.imageAttachments.map(img => ({
            name: img.name,
            mimeType: img.mimeType,
            base64Length: img.base64Data?.length ?? 0,
          })),
        });
        messageMetadata.imageAttachments = options.imageAttachments;
      }
      coworkStoreInstance.addMessage(session.id, {
        type: 'user',
        content: options.prompt,
        metadata: Object.keys(messageMetadata).length > 0 ? messageMetadata : undefined,
      });

      // Update session status to 'running' before starting async task
      // This ensures the frontend receives the correct status immediately
      coworkStoreInstance.updateSession(session.id, { status: 'running' });

      // Start the session asynchronously (skip initial user message since we already added it)
      const runtime = getCoworkEngineRouter();
      runtime.startSession(session.id, options.prompt, {
        skipInitialUserMessage: true,
        systemPrompt,
        skillIds: options.activeSkillIds,
        workspaceRoot: selectedWorkspaceRoot,
        confirmationMode: 'modal',
        imageAttachments: options.imageAttachments,
        agentId: options.agentId,
      }).catch(error => {
        console.error('[Cowork] session error:', error);
        try {
          // The engine router already emits an 'error' event (handled at line ~990)
          // which sends cowork:stream:error to the renderer. Only send here if the
          // session hasn't been marked as error yet, to avoid duplicate messages.
          const existing = coworkStoreInstance.getSession(session.id);
          if (existing?.status === 'error') return;
          const errorMessage = error instanceof Error ? error.message : String(error);
          const windows = BrowserWindow.getAllWindows();
          windows.forEach((win) => {
            if (win.isDestroyed()) return;
            win.webContents.send('cowork:stream:error', { sessionId: session.id, error: errorMessage });
          });
        } catch (handlerError) {
          console.error('[Cowork] failed to send error notification to renderer:', handlerError);
        }
      });

      const sessionWithMessages = coworkStoreInstance.getSession(session.id) || {
        ...session,
        status: 'running' as const,
      };
      return { success: true, session: sessionWithMessages };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start session',
      };
    }
  });

  ipcMain.handle('cowork:session:continue', async (_event, options: {
    sessionId: string;
    prompt: string;
    systemPrompt?: string;
    activeSkillIds?: string[];
    imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
  }) => {
    try {
      const activeEngine = resolveCoworkAgentEngine();
      if (activeEngine === 'openclaw') {
        const engineStatus = await ensureOpenClawRunningForCowork();
        if (engineStatus.phase !== 'running') {
          return getEngineNotReadyResponse(engineStatus);
        }
      }

      const runtime = getCoworkEngineRouter();
      const existingSession = getCoworkStore().getSession(options.sessionId);
      if (options.imageAttachments?.length) {
        console.log('[Cowork:ContinueSession] imageAttachments received via IPC:', {
          sessionId: options.sessionId,
          count: options.imageAttachments.length,
          details: options.imageAttachments.map(img => ({
            name: img.name,
            mimeType: img.mimeType,
            base64Length: img.base64Data?.length ?? 0,
          })),
        });
      }
      runtime.continueSession(options.sessionId, options.prompt, {
        systemPrompt: mergeCoworkSystemPrompt(
          activeEngine,
          options.systemPrompt ?? existingSession?.systemPrompt,
        ),
        skillIds: options.activeSkillIds,
        imageAttachments: options.imageAttachments,
      }).catch(error => {
        console.error('[Cowork] continue error:', error);
        try {
          // The engine router already emits an 'error' event (handled at line ~990)
          // which sends cowork:stream:error to the renderer. Only send here if the
          // session hasn't been marked as error yet, to avoid duplicate messages.
          const existing = getCoworkStore().getSession(options.sessionId);
          if (existing?.status === 'error') return;
          const errorMessage = error instanceof Error ? error.message : String(error);
          const windows = BrowserWindow.getAllWindows();
          windows.forEach((win) => {
            if (win.isDestroyed()) return;
            win.webContents.send('cowork:stream:error', { sessionId: options.sessionId, error: errorMessage });
          });
        } catch (handlerError) {
          console.error('[Cowork] failed to send error notification to renderer:', handlerError);
        }
      });

      const session = getCoworkStore().getSession(options.sessionId);
      return { success: true, session };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to continue session',
      };
    }
  });

  ipcMain.handle('cowork:session:stop', async (_event, sessionId: string) => {
    try {
      const runtime = getCoworkEngineRouter();
      runtime.stopSession(sessionId);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stop session',
      };
    }
  });

  ipcMain.handle('cowork:session:delete', async (_event, sessionId: string) => {
    try {
      getCoworkEngineRouter().stopSession(sessionId);
      const coworkStoreInstance = getCoworkStore();
      coworkStoreInstance.deleteSession(sessionId);
      // Clean up IM session mapping so that new channel messages
      // create a fresh session instead of referencing a deleted one.
      try {
        getIMGatewayManager()?.getIMStore()?.deleteSessionMappingByCoworkSessionId(sessionId);
      } catch {
        // IM store may not be initialised yet; safe to ignore.
      }
      // Notify runtime to purge in-memory caches for this session
      // so that channel messages can create a fresh session.
      try {
        getCoworkEngineRouter().onSessionDeleted(sessionId);
      } catch {
        // Router may not be initialised yet; safe to ignore.
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete session',
      };
    }
  });

  ipcMain.handle('cowork:session:deleteBatch', async (_event, sessionIds: string[]) => {
    try {
      const runtime = getCoworkEngineRouter();
      sessionIds.forEach((sessionId) => {
        runtime.stopSession(sessionId);
      });
      const coworkStoreInstance = getCoworkStore();
      coworkStoreInstance.deleteSessions(sessionIds);
      const router = getCoworkEngineRouter();
      for (const sessionId of sessionIds) {
        try {
          getIMGatewayManager()?.getIMStore()?.deleteSessionMappingByCoworkSessionId(sessionId);
        } catch {
          // IM store may not be initialised yet; safe to ignore.
        }
        try {
          router.onSessionDeleted(sessionId);
        } catch {
          // Router may not be initialised yet; safe to ignore.
        }
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to batch delete sessions',
      };
    }
  });

  ipcMain.handle('cowork:session:pin', async (_event, options: { sessionId: string; pinned: boolean }) => {
    try {
      const coworkStoreInstance = getCoworkStore();
      coworkStoreInstance.setSessionPinned(options.sessionId, options.pinned);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update session pin',
      };
    }
  });

  ipcMain.handle('cowork:session:rename', async (_event, options: { sessionId: string; title: string }) => {
    try {
      const title = options.title.trim();
      if (!title) {
        return { success: false, error: 'Title is required' };
      }
      const coworkStoreInstance = getCoworkStore();
      coworkStoreInstance.updateSession(options.sessionId, { title });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to rename session',
      };
    }
  });

  ipcMain.handle('cowork:session:get', async (_event, sessionId: string) => {
    try {
      const session = getCoworkStore().getSession(sessionId);
      return { success: true, session };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get session',
      };
    }
  });

  ipcMain.handle('cowork:session:remoteManaged', async (_event, sessionId: string) => {
    try {
      const mapping = getIMGatewayManager()?.getIMStore()?.getSessionMappingByCoworkSessionId(sessionId);
      return { success: true, remoteManaged: !!mapping };
    } catch (error) {
      return {
        success: false,
        remoteManaged: false,
        error: error instanceof Error ? error.message : 'Failed to check remote managed session',
      };
    }
  });

  ipcMain.handle('cowork:session:list', async (_event, agentId?: string) => {
    try {
      const sessions = getCoworkStore().listSessions(agentId);
      return { success: true, sessions };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list sessions',
      };
    }
  });

  // ========== Agent IPC Handlers ==========

  ipcMain.handle('agents:list', async () => {
    try {
      const agents = getAgentManager().listAgents();
      return { success: true, agents };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list agents' };
    }
  });

  ipcMain.handle('agents:get', async (_event, id: string) => {
    try {
      const agent = getAgentManager().getAgent(id);
      return { success: true, agent };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get agent' };
    }
  });

  ipcMain.handle('agents:create', async (_event, request: import('./coworkStore').CreateAgentRequest) => {
    try {
      const agent = getAgentManager().createAgent(request, resolveDefaultAgentModelRef());
      // Sync config so workspace files (SOUL.md, IDENTITY.md) are written
      // before OpenClaw scaffolds default templates for the new agent.
      syncOpenClawConfig({ reason: 'agent-created' }).catch(() => {});
      return { success: true, agent };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to create agent' };
    }
  });

  ipcMain.handle('agents:update', async (_event, id: string, updates: import('./coworkStore').UpdateAgentRequest) => {
    try {
      const agent = getAgentManager().updateAgent(id, updates);
      syncOpenClawConfig({ reason: 'agent-updated' }).catch(() => {});
      return { success: true, agent };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update agent' };
    }
  });

  ipcMain.handle('agents:delete', async (_event, id: string) => {
    try {
      const result = getAgentManager().deleteAgent(id);

      // Clean up IM platform bindings that reference the deleted agent
      // so that channels fall back to the default 'main' agent.
      try {
        const imStore = getIMGatewayManager()?.getIMStore();
        if (imStore) {
          const imSettings = imStore.getIMSettings();
          const bindings = imSettings.platformAgentBindings;
          if (bindings) {
            let changed = false;
            for (const [platform, agentId] of Object.entries(bindings)) {
              if (agentId === id) {
                delete bindings[platform];
                changed = true;
              }
            }
            if (changed) {
              imStore.setIMSettings({ platformAgentBindings: bindings });
            }
          }
        }
      } catch {
        // IM store may not be initialised yet; safe to ignore.
      }

      syncOpenClawConfig({ reason: 'agent-deleted' }).catch(() => {});
      return { success: true, deleted: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete agent' };
    }
  });

  ipcMain.handle('agents:presets', async () => {
    try {
      const presets = getAgentManager().getPresetAgents();
      return { success: true, presets };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get presets' };
    }
  });

  ipcMain.handle('agents:addPreset', async (_event, presetId: string) => {
    try {
      const agent = getAgentManager().addPresetAgent(presetId, resolveDefaultAgentModelRef());
      syncOpenClawConfig({ reason: 'agent-preset-added' }).catch(() => {});
      return { success: true, agent };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to add preset agent' };
    }
  });

  ipcMain.handle('cowork:session:exportResultImage', async (
    event,
    options: {
      rect: { x: number; y: number; width: number; height: number };
      defaultFileName?: string;
    }
  ) => {
    try {
      const { rect, defaultFileName } = options || {};
      const captureRect = normalizeCaptureRect(rect);
      if (!captureRect) {
        return { success: false, error: 'Capture rect is required' };
      }

      const image = await event.sender.capturePage(captureRect);
      return savePngWithDialog(event.sender, image.toPNG(), defaultFileName);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to export session image',
      };
    }
  });

  ipcMain.handle('cowork:session:captureImageChunk', async (
    event,
    options: {
      rect: { x: number; y: number; width: number; height: number };
    }
  ) => {
    try {
      const captureRect = normalizeCaptureRect(options?.rect);
      if (!captureRect) {
        return { success: false, error: 'Capture rect is required' };
      }

      const image = await event.sender.capturePage(captureRect);
      const pngBuffer = image.toPNG();

      return {
        success: true,
        width: captureRect.width,
        height: captureRect.height,
        pngBase64: pngBuffer.toString('base64'),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to capture session image chunk',
      };
    }
  });

  ipcMain.handle('cowork:session:saveResultImage', async (
    event,
    options: {
      pngBase64: string;
      defaultFileName?: string;
    }
  ) => {
    try {
      const base64 = typeof options?.pngBase64 === 'string' ? options.pngBase64.trim() : '';
      if (!base64) {
        return { success: false, error: 'Image data is required' };
      }

      const pngBuffer = Buffer.from(base64, 'base64');
      if (pngBuffer.length <= 0) {
        return { success: false, error: 'Invalid image data' };
      }

      return savePngWithDialog(event.sender, pngBuffer, options?.defaultFileName);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save session image',
      };
    }
  });

  ipcMain.handle('cowork:session:exportText', async (
    event,
    options: {
      content: string;
      defaultFileName?: string;
      fileExtension?: string;
    }
  ) => {
    try {
      const content = typeof options?.content === 'string' ? options.content : '';
      if (!content) {
        return { success: false, error: 'Export content is empty' };
      }

      const ext = options?.fileExtension || 'md';
      const filterName = ext === 'json' ? 'JSON' : 'Markdown';
      const defaultName = options?.defaultFileName || `session-export.${ext}`;
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const saveOptions = {
        title: 'Export Session',
        defaultPath: path.join(app.getPath('downloads'), defaultName),
        filters: [{ name: filterName, extensions: [ext] }],
      };
      const saveResult = ownerWindow
        ? await dialog.showSaveDialog(ownerWindow, saveOptions)
        : await dialog.showSaveDialog(saveOptions);

      if (saveResult.canceled || !saveResult.filePath) {
        return { success: true, canceled: true };
      }

      await fs.promises.writeFile(saveResult.filePath, content, 'utf-8');
      return { success: true, canceled: false, path: saveResult.filePath };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to export session',
      };
    }
  });

  ipcMain.handle('cowork:permission:respond', async (_event, options: {
    requestId: string;
    result: PermissionResult;
  }) => {
    try {
      // Dual-dispatch pattern: permission responses arrive through one IPC channel
      // but may target either of two independent subsystems.
      //
      // - resolveAskUser() handles AskUserQuestion plugin requests routed through
      //   the McpBridgeServer HTTP callback. It is a no-op when the requestId does
      //   not match a pending bridge request (i.e. for normal SDK permission requests).
      //
      // - respondToPermission() handles standard Claude Agent SDK permission requests
      //   managed by the CoworkEngineRouter. It is a no-op when the requestId does
      //   not match a pending SDK permission (i.e. for bridge plugin requests).
      //
      // Both calls are safe to invoke unconditionally; exactly one will match.

      // AskUserQuestion plugin responses go to the bridge server, not the runtime
      if (mcpBridgeServer && options.requestId) {
        const result = options.result;
        const askUserResponse: import('./libs/mcpBridgeServer').AskUserResponse = {
          behavior: result.behavior === 'allow' ? 'allow' : 'deny',
          answers: result.behavior === 'allow' && result.updatedInput && typeof result.updatedInput === 'object'
            ? (result.updatedInput as Record<string, unknown>).answers as Record<string, string> | undefined
            : undefined,
        };
        mcpBridgeServer.resolveAskUser(options.requestId, askUserResponse);
      }

      const runtime = getCoworkEngineRouter();
      runtime.respondToPermission(options.requestId, options.result);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to respond to permission',
      };
    }
  });

  ipcMain.handle('cowork:config:get', async () => {
    try {
      const config = getCoworkStore().getConfig();
      return { success: true, config };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get config',
      };
    }
  });

  ipcMain.handle(OpenClawSessionPolicyIpc.Get, async () => {
    try {
      const config = loadOpenClawSessionPolicyConfig(getStore());
      return { success: true, config };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get OpenClaw session policy',
      };
    }
  });

  ipcMain.handle(OpenClawSessionPolicyIpc.Set, async (_event, config: unknown) => {
    try {
      const saved = saveOpenClawSessionPolicyConfig(getStore(), config);
      // Persist first and let the caller decide when to perform a unified sync/restart.
      await syncOpenClawConfig({ reason: 'session-policy-updated', restartGatewayIfRunning: false });
      return { success: true, config: saved };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save OpenClaw session policy',
      };
    }
  });

  ipcMain.handle(OpenClawSessionIpc.Patch, async (_event, input: unknown) => {
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('Invalid OpenClaw session patch input.');
      }

      const request = input as { sessionId?: unknown; patch?: unknown };
      const sessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : '';
      if (!sessionId) {
        throw new Error('Session ID is required.');
      }

      const patch = sanitizeOpenClawSessionPatch(request.patch);
      const runtime = getCoworkEngineRouter();
      await runtime.patchSession(sessionId, patch);

      if (patch.model !== undefined) {
        getCoworkStore().updateSession(sessionId, {
          modelOverride: patch.model ?? '',
        });
      }

      const session = getCoworkStore().getSession(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }

      return {
        success: true,
        session,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to patch OpenClaw session',
      };
    }
  });

  ipcMain.handle('cowork:memory:listEntries', async (_event, input: {
    query?: string;
    status?: 'created' | 'stale' | 'deleted' | 'all';
    includeDeleted?: boolean;
    limit?: number;
    offset?: number;
  }) => {
    try {
      const config = getCoworkStore().getConfig();
      const filePath = resolveMemoryFilePath(config.workingDirectory);

      // Lazy migration: SQLite → MEMORY.md (one-time, cached in memory)
      if (!memoryMigrationDone) {
        migrateSqliteToMemoryMd(filePath, {
          isMigrationDone: () => getStore().get<string>('openclawMemory.migration.v1.completed') === '1',
          markMigrationDone: () => {
            getStore().set('openclawMemory.migration.v1.completed', '1');
            memoryMigrationDone = true;
          },
          getActiveMemoryTexts: () => {
            return getCoworkStore().listUserMemories({ status: 'all', includeDeleted: false, limit: 200 })
              .map((m) => m.text);
          },
        });
        // Even if migration found nothing, skip future checks this session
        memoryMigrationDone = true;
      }

      const query = input?.query?.trim() || '';
      const entries = query
        ? searchMemoryEntries(filePath, query)
        : readMemoryEntries(filePath);
      return { success: true, entries };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list memory entries',
      };
    }
  });
  ipcMain.handle('cowork:memory:createEntry', async (_event, input: {
    text: string;
    confidence?: number;
    isExplicit?: boolean;
  }) => {
    try {
      const config = getCoworkStore().getConfig();
      const filePath = resolveMemoryFilePath(config.workingDirectory);
      const entry = addMemoryEntry(filePath, input.text);
      return { success: true, entry };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create memory entry',
      };
    }
  });
  ipcMain.handle('cowork:memory:updateEntry', async (_event, input: {
    id: string;
    text?: string;
    confidence?: number;
    status?: 'created' | 'stale' | 'deleted';
    isExplicit?: boolean;
  }) => {
    try {
      const config = getCoworkStore().getConfig();
      const filePath = resolveMemoryFilePath(config.workingDirectory);
      if (!input.text) {
        return { success: false, error: 'Memory text is required' };
      }
      const entry = updateMemoryEntry(filePath, input.id, input.text);
      if (!entry) {
        return { success: false, error: 'Memory entry not found' };
      }
      return { success: true, entry };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update memory entry',
      };
    }
  });
  ipcMain.handle('cowork:memory:deleteEntry', async (_event, input: {
    id: string;
  }) => {
    try {
      const config = getCoworkStore().getConfig();
      const filePath = resolveMemoryFilePath(config.workingDirectory);
      const success = deleteMemoryEntry(filePath, input.id);
      return success
        ? { success: true }
        : { success: false, error: 'Memory entry not found' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete memory entry',
      };
    }
  });
  ipcMain.handle('cowork:memory:getStats', async () => {
    try {
      const config = getCoworkStore().getConfig();
      const filePath = resolveMemoryFilePath(config.workingDirectory);
      const entries = readMemoryEntries(filePath);
      return {
        success: true,
        stats: {
          total: entries.length,
          created: entries.length,
          stale: 0,
          deleted: 0,
          explicit: entries.length,
          implicit: 0,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get memory stats',
      };
    }
  });
  ipcMain.handle('cowork:bootstrap:read', async (_event, filename: string) => {
    try {
      const config = getCoworkStore().getConfig();
      const content = readBootstrapFile(config.workingDirectory, filename);
      return { success: true, content };
    } catch (error) {
      return {
        success: false,
        content: '',
        error: error instanceof Error ? error.message : 'Failed to read bootstrap file',
      };
    }
  });
  ipcMain.handle('cowork:bootstrap:write', async (_event, filename: string, content: string) => {
    try {
      const config = getCoworkStore().getConfig();
      writeBootstrapFile(config.workingDirectory, filename, content);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to write bootstrap file',
      };
    }
  });

  const VALID_EMBEDDING_PROVIDERS = ['local', 'openai', 'gemini', 'voyage', 'mistral', 'ollama'] as const;

  function normalizeEmbeddingConfig(config: {
    embeddingEnabled?: boolean;
    embeddingProvider?: string;
    embeddingModel?: string;
    embeddingLocalModelPath?: string;
    embeddingVectorWeight?: number;
    embeddingRemoteBaseUrl?: string;
    embeddingRemoteApiKey?: string;
  }) {
    return {
      embeddingEnabled: typeof config.embeddingEnabled === 'boolean'
        ? config.embeddingEnabled : undefined,
      embeddingProvider: typeof config.embeddingProvider === 'string'
        && (VALID_EMBEDDING_PROVIDERS as readonly string[]).includes(config.embeddingProvider)
        ? config.embeddingProvider : undefined,
      embeddingModel: typeof config.embeddingModel === 'string'
        ? config.embeddingModel.trim() : undefined,
      embeddingLocalModelPath: typeof config.embeddingLocalModelPath === 'string'
        ? config.embeddingLocalModelPath.trim() : undefined,
      embeddingVectorWeight: typeof config.embeddingVectorWeight === 'number'
        && Number.isFinite(config.embeddingVectorWeight)
        ? Math.max(0, Math.min(1, config.embeddingVectorWeight)) : undefined,
      embeddingRemoteBaseUrl: typeof config.embeddingRemoteBaseUrl === 'string'
        ? config.embeddingRemoteBaseUrl.trim() : undefined,
      embeddingRemoteApiKey: typeof config.embeddingRemoteApiKey === 'string'
        ? config.embeddingRemoteApiKey.trim() : undefined,
    };
  }

  ipcMain.handle('cowork:config:set', async (_event, config: {
    workingDirectory?: string;
    executionMode?: 'auto' | 'local' | 'sandbox';
    agentEngine?: CoworkAgentEngine;
    memoryEnabled?: boolean;
    memoryImplicitUpdateEnabled?: boolean;
    memoryLlmJudgeEnabled?: boolean;
    memoryGuardLevel?: 'strict' | 'standard' | 'relaxed';
    memoryUserMemoriesMaxItems?: number;
    skipMissedJobs?: boolean;
    embeddingEnabled?: boolean;
    embeddingProvider?: string;
    embeddingModel?: string;
    embeddingLocalModelPath?: string;
    embeddingVectorWeight?: number;
    embeddingRemoteBaseUrl?: string;
    embeddingRemoteApiKey?: string;
  }) => {
    try {
      const normalizedExecutionMode =
        config.executionMode && String(config.executionMode) === 'container'
          ? 'local'
          : config.executionMode;
      const normalizedAgentEngine = config.agentEngine === 'openclaw'
        ? 'openclaw'
        : undefined;
      const normalizedMemoryEnabled = typeof config.memoryEnabled === 'boolean'
        ? config.memoryEnabled
        : undefined;
      const normalizedMemoryImplicitUpdateEnabled = typeof config.memoryImplicitUpdateEnabled === 'boolean'
        ? config.memoryImplicitUpdateEnabled
        : undefined;
      const normalizedMemoryLlmJudgeEnabled = typeof config.memoryLlmJudgeEnabled === 'boolean'
        ? config.memoryLlmJudgeEnabled
        : undefined;
      const normalizedMemoryGuardLevel = config.memoryGuardLevel === 'strict'
        || config.memoryGuardLevel === 'standard'
        || config.memoryGuardLevel === 'relaxed'
        ? config.memoryGuardLevel
        : undefined;
      const normalizedMemoryUserMemoriesMaxItems =
        typeof config.memoryUserMemoriesMaxItems === 'number' && Number.isFinite(config.memoryUserMemoriesMaxItems)
          ? Math.max(
            MIN_MEMORY_USER_MEMORIES_MAX_ITEMS,
            Math.min(MAX_MEMORY_USER_MEMORIES_MAX_ITEMS, Math.floor(config.memoryUserMemoriesMaxItems))
          )
        : undefined;
      const normalizedSkipMissedJobs = typeof config.skipMissedJobs === 'boolean'
        ? config.skipMissedJobs
        : undefined;
      const normalizedEmbedding = normalizeEmbeddingConfig(config);
      const normalizedConfig: Parameters<CoworkStore['setConfig']>[0] = {
        ...config,
        executionMode: normalizedExecutionMode,
        agentEngine: normalizedAgentEngine,
        memoryEnabled: normalizedMemoryEnabled,
        memoryImplicitUpdateEnabled: normalizedMemoryImplicitUpdateEnabled,
        memoryLlmJudgeEnabled: normalizedMemoryLlmJudgeEnabled,
        memoryGuardLevel: normalizedMemoryGuardLevel,
        memoryUserMemoriesMaxItems: normalizedMemoryUserMemoriesMaxItems,
        skipMissedJobs: normalizedSkipMissedJobs,
        ...normalizedEmbedding,
      };
      const previousConfig = getCoworkStore().getConfig();
      const previousWorkingDir = previousConfig.workingDirectory;
      getCoworkStore().setConfig(normalizedConfig);
      if (normalizedConfig.workingDirectory !== undefined && normalizedConfig.workingDirectory !== previousWorkingDir) {
        getSkillManager().handleWorkingDirectoryChange();
        // Sync MEMORY.md to new workspace directory
        const syncResult = syncMemoryFileOnWorkspaceChange(previousWorkingDir, normalizedConfig.workingDirectory);
        if (syncResult.error) {
          console.warn('[OpenClaw Memory] Workspace sync failed:', syncResult.error);
        }
        // Ensure IDENTITY.md has default content in the new workspace
        try {
          ensureDefaultIdentity(normalizedConfig.workingDirectory);
        } catch (err) {
          console.warn('[OpenClaw] ensureDefaultIdentity failed (non-fatal):', err);
        }
      }

      const nextConfig = getCoworkStore().getConfig();
      if (normalizedAgentEngine !== undefined && normalizedAgentEngine !== previousConfig.agentEngine) {
        getCoworkEngineRouter().handleEngineConfigChanged(normalizedAgentEngine);
      }
      const switchedToOpenClaw = normalizedAgentEngine === 'openclaw'
        && previousConfig.agentEngine !== 'openclaw';

      const shouldSyncOpenClawConfig = normalizedExecutionMode !== undefined
        || normalizedAgentEngine !== undefined
        || Object.values(normalizedEmbedding).some(v => v !== undefined)
        || (normalizedConfig.workingDirectory !== undefined && normalizedConfig.workingDirectory !== previousWorkingDir);
      if (shouldSyncOpenClawConfig) {
        const syncResult = await syncOpenClawConfig({
          reason: 'cowork-config-change',
        });
        if (!syncResult.success && nextConfig.agentEngine === 'openclaw') {
          return {
            success: false,
            code: ENGINE_NOT_READY_CODE,
            error: syncResult.error || 'OpenClaw config sync failed.',
            engineStatus: syncResult.status || getOpenClawEngineManager().getStatus(),
          };
        }
      }

      if (switchedToOpenClaw) {
        void ensureOpenClawRunningForCowork().catch((error) => {
          console.error('[OpenClaw] Failed to auto-start gateway after engine switch:', error);
        });
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set config',
      };
    }
  });

  // ==================== Scheduled Task IPC Handlers (OpenClaw) ====================

  initCronJobServiceManager({
    getOpenClawRuntimeAdapter: () => openClawRuntimeAdapter,
  });
  initScheduledTaskHelpers({
    getIMGatewayManager: () => ({
      getConfig: () => getIMGatewayManager().getConfig() as unknown as Record<string, unknown>,
    }),
  });
  registerScheduledTaskHandlers({
    getCronJobService,
    getIMGatewayManager: () => ({
      getIMStore: () => ({
        getSessionMapping: (conversationId: string, platform: string) =>
          getIMGatewayManager().getIMStore().getSessionMapping(conversationId, platform as Platform),
        listSessionMappings: (platform: string, agentId?: string) =>
          getIMGatewayManager().getIMStore().listSessionMappings(platform as Platform, agentId).map((mapping) => ({
            ...mapping,
            lastActiveAt: String(mapping.lastActiveAt),
          })),
      }),
      primeConversationReplyRoute: (
        platform: string,
        conversationId: string,
        coworkSessionId: string,
      ) => getIMGatewayManager().primeConversationReplyRoute(platform as Platform, conversationId, coworkSessionId),
    }),
    getOpenClawRuntimeAdapter: () => openClawRuntimeAdapter,
  });

  registerNimQrLoginHandlers({
    startNimQrLogin,
    pollNimQrLogin,
  });

  // ==================== Permissions IPC Handlers ====================

  ipcMain.handle('permissions:checkCalendar', async () => {
    try {
      const status = await checkCalendarPermission();

      // Development mode: Auto-request permission if not determined
      // This provides a better dev experience without affecting production
      if (isDev && status === 'not-determined' && process.platform === 'darwin') {
        console.log('[Permissions] Development mode: Auto-requesting calendar permission...');
        try {
          await requestCalendarPermission();
          const newStatus = await checkCalendarPermission();
          console.log('[Permissions] Development mode: Permission status after request:', newStatus);
          return { success: true, status: newStatus, autoRequested: true };
        } catch (requestError) {
          console.warn('[Permissions] Development mode: Auto-request failed:', requestError);
        }
      }

      return { success: true, status };
    } catch (error) {
      console.error('[Main] Error checking calendar permission:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to check permission' };
    }
  });

  ipcMain.handle('permissions:requestCalendar', async () => {
    try {
      // Request permission and check status
      const granted = await requestCalendarPermission();
      const status = await checkCalendarPermission();
      return { success: true, granted, status };
    } catch (error) {
      console.error('[Main] Error requesting calendar permission:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to request permission' };
    }
  });

  // ==================== IM Gateway IPC Handlers ====================

  ipcMain.handle('im:config:get', async () => {
    try {
      const config = getIMGatewayManager().getConfig();
      return { success: true, config };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get IM config',
      };
    }
  });

  // Debounce + serialization for im:config:set → syncOpenClawConfig.
  // Rapid sequential config changes (e.g. toggling 4 platforms) are coalesced
  // into a single gateway restart instead of N restarts.
  // The running/pending flags prevent concurrent sync operations from racing:
  // if a sync is in progress when new changes arrive, they are queued and
  // a follow-up sync runs after the current one completes.
  let imConfigSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let imConfigSyncRunning = false;
  let imConfigSyncPending = false;
  const IM_CONFIG_SYNC_DEBOUNCE_MS = 600;

  const doImConfigSync = async () => {
    imConfigSyncRunning = true;
    try {
      await syncOpenClawConfig({
        reason: 'im-config-change',
      });
      // After config sync, ensure the runtime adapter's WebSocket client
      // is connected so channel events are received.
      if (openClawRuntimeAdapter) {
        try {
          await openClawRuntimeAdapter.connectGatewayIfNeeded();
        } catch (connectError) {
          console.error('[IM] Failed to connect gateway client after config sync:', connectError);
        }
      }
    } catch (error) {
      console.error('[IM] Debounced config sync failed:', error);
    } finally {
      imConfigSyncRunning = false;
      if (imConfigSyncPending) {
        imConfigSyncPending = false;
        scheduleImConfigSync();
      }
    }
  };

  const scheduleImConfigSync = () => {
    if (imConfigSyncRunning) {
      // A sync is already in progress; mark pending so it re-runs after completion.
      imConfigSyncPending = true;
      return;
    }
    if (imConfigSyncTimer) clearTimeout(imConfigSyncTimer);
    imConfigSyncTimer = setTimeout(() => {
      imConfigSyncTimer = null;
      void doImConfigSync();
    }, IM_CONFIG_SYNC_DEBOUNCE_MS);
  };

  ipcMain.handle('im:config:set', async (_event, config: Partial<IMGatewayConfig>, options?: { syncGateway?: boolean }) => {
    try {
      getIMGatewayManager().setConfig(config, { syncGateway: options?.syncGateway });

      // Sync OpenClaw config once for all platform changes (instead of per-platform).
      // setConfig() already persists to DB synchronously, so syncOpenClawConfig just
      // needs to regenerate openclaw.json and restart the gateway once.
      // Only trigger sync when explicitly requested via syncGateway flag (e.g. from
      // the global Save button), to avoid frequent gateway restarts on every field blur.
      const hasOpenClawChange = config.telegram || config.discord || config.dingtalk
        || config.feishu || config.qq || config.wecom || config.popo || config.weixin;
      if (options?.syncGateway && hasOpenClawChange && getOpenClawEngineManager().getStatus().phase === 'running') {
        scheduleImConfigSync();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set IM config',
      };
    }
  });

  // Explicitly trigger OpenClaw config sync + gateway restart.
  // Called from the global Settings Save button after config fields have been
  // persisted to DB via im:config:set (without syncGateway flag).
  ipcMain.handle('im:config:sync', async () => {
    try {
      if (getOpenClawEngineManager().getStatus().phase === 'running') {
        scheduleImConfigSync();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to sync IM config',
      };
    }
  });

  ipcMain.handle('im:gateway:start', async (_event, platform: Platform) => {
    try {
      // Persist enabled state
      const manager = getIMGatewayManager();
      manager.setConfig({ [platform]: { enabled: true } });
      await manager.startGateway(platform);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start gateway',
      };
    }
  });

  ipcMain.handle('im:gateway:stop', async (_event, platform: Platform) => {
    try {
      // Persist disabled state
      const manager = getIMGatewayManager();
      manager.setConfig({ [platform]: { enabled: false } });
      await manager.stopGateway(platform);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stop gateway',
      };
    }
  });

  ipcMain.handle('im:gateway:test', async (
    _event,
    platform: Platform,
    configOverride?: Partial<IMGatewayConfig>
  ) => {
    try {
      const result = await getIMGatewayManager().testGateway(platform, configOverride);
      return { success: true, result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to test gateway connectivity',
      };
    }
  });

  // Weixin QR login
  ipcMain.handle('im:weixin:qr-login-start', async () => {
    try {
      const result = await getIMGatewayManager().weixinQrLoginStart();
      return { success: true, ...result };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : 'Failed to start Weixin QR login' };
    }
  });

  ipcMain.handle('im:weixin:qr-login-wait', async (_event, accountId?: string) => {
    try {
      const result = await getIMGatewayManager().weixinQrLoginWait(accountId);
      if (result.connected) {
        // Restart gateway so the plugin picks up the new token and starts
        // a fresh monitor loop (the old one may be stuck in a session pause).
        console.log('[IMGatewayManager] Weixin login succeeded, restarting OpenClaw gateway');
        await getOpenClawEngineManager().restartGateway();
      }
      return { success: true, ...result };
    } catch (error) {
      return { success: false, connected: false, message: error instanceof Error ? error.message : 'Weixin QR login failed' };
    }
  });

  // POPO QR login
  ipcMain.handle('im:popo:qr-login-start', async () => {
    try {
      const result = getIMGatewayManager().popoQrLoginStart();
      return { success: true, ...result };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : 'Failed to start POPO QR login' };
    }
  });

  ipcMain.handle('im:popo:qr-login-poll', async (_event, taskToken: string) => {
    try {
      const result = await getIMGatewayManager().popoQrLoginPoll(taskToken);
      return result;
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : 'POPO QR login poll failed' };
    }
  });

  ipcMain.handle('im:status:get', async () => {
    try {
      const status = getIMGatewayManager().getStatus();
      return { success: true, status };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get IM status',
      };
    }
  });

  ipcMain.handle('im:getLocalIp', () => {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          return net.address;
        }
      }
    }
    return '127.0.0.1';
  });
  ipcMain.handle('im:openclaw:config-schema', async () => {
    try {
      const result = await getIMGatewayManager().getOpenClawConfigSchema();
      return { success: true, result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get OpenClaw config schema',
      };
    }
  });

  // Email: Test connection
  ipcMain.handle('email:testConnection', async (event, { instanceId }: { instanceId: string }) => {
    try {
      const imManager = getIMGatewayManager();
      const imStore = imManager.getIMStore();
      const emailConfig = imStore.getEmailConfig();
      const instance = emailConfig.instances.find(i => i.instanceId === instanceId);

      if (!instance) {
        throw new Error('Instance not found');
      }

      if (instance.transport === 'imap') {
        // Test IMAP connection using node-imap
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic require with no type definitions
        let Imap: new (config: Record<string, unknown>) => any;
        try {
          Imap = require('imap');
        } catch {
          throw new Error('IMAP module not installed. Please install the imap package.');
        }
        const deriveImapHost = (email: string) => {
          const domain = email.split('@')[1];
          return `imap.${domain}`;
        };

        const connection = new Imap({
          user: instance.email,
          password: instance.password,
          host: instance.imapHost || deriveImapHost(instance.email),
          port: instance.imapPort || 993,
          tls: true,
        });

        await new Promise<void>((resolve, reject) => {
          connection.once('ready', () => {
            connection.end();
            resolve();
          });
          connection.once('error', reject);
          connection.connect();
        });
      } else if (instance.transport === 'ws') {
        // Test WebSocket connection by fetching token
        let fetchIMToken: (apiKey: string, email: string, logger: typeof console) => Promise<unknown>;
        try {
          ({ fetchIMToken } = require('@clawemail/node-sdk'));
        } catch {
          throw new Error('Email SDK not installed. Please install the @clawemail/node-sdk package.');
        }
        await fetchIMToken(instance.apiKey!, instance.email, console);
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // ---- Pairing IPC handlers ----

  ipcMain.handle('im:pairing:list', async (_event, platform: string) => {
    try {
      const stateDir = getOpenClawEngineManager().getStateDir();
      const requests = listPairingRequests(platform, stateDir);
      const allowFrom = readAllowFromStore(platform, stateDir);
      return { success: true, requests, allowFrom };
    } catch (error) {
      return {
        success: false,
        requests: [],
        allowFrom: [],
        error: error instanceof Error ? error.message : 'Failed to list pairing requests',
      };
    }
  });

  ipcMain.handle('im:pairing:approve', async (_event, platform: string, code: string) => {
    try {
      const stateDir = getOpenClawEngineManager().getStateDir();
      const approved = approvePairingCode(platform, code, stateDir);
      if (!approved) {
        return { success: false, error: 'Pairing code not found or expired' };
      }
      await syncOpenClawConfig({
        reason: `im-pairing-approval:${platform}`,
      });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to approve pairing code',
      };
    }
  });

  ipcMain.handle('im:pairing:reject', async (_event, platform: string, code: string) => {
    try {
      const stateDir = getOpenClawEngineManager().getStateDir();
      const rejected = rejectPairingRequest(platform, code, stateDir);
      if (!rejected) {
        return { success: false, error: 'Pairing code not found or expired' };
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to reject pairing request',
      };
    }
  });

  // DingTalk Multi-Instance handlers
  ipcMain.handle('im:dingtalk:instance:add', async (_event, name: string) => {
    try {
      const instanceId = crypto.randomUUID();
      const { DEFAULT_DINGTALK_OPENCLAW_CONFIG: defaults } = await import('./im/types');
      const instance = {
        ...defaults,
        instanceId,
        instanceName: name || 'DingTalk Bot',
      };
      getIMGatewayManager().getIMStore().setDingTalkInstanceConfig(instanceId, instance);
      return { success: true, instance };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add DingTalk instance',
      };
    }
  });

  ipcMain.handle('im:dingtalk:instance:delete', async (_event, instanceId: string) => {
    try {
      getIMGatewayManager().getIMStore().deleteDingTalkInstance(instanceId);
      if (getOpenClawEngineManager().getStatus().phase === 'running') {
        scheduleImConfigSync();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete DingTalk instance',
      };
    }
  });

  ipcMain.handle('im:dingtalk:instance:config:set', async (_event, instanceId: string, config: Partial<DingTalkInstanceConfig>, options?: { syncGateway?: boolean }) => {
    try {
      getIMGatewayManager().getIMStore().setDingTalkInstanceConfig(instanceId, config);
      if (options?.syncGateway && getOpenClawEngineManager().getStatus().phase === 'running') {
        scheduleImConfigSync();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set DingTalk instance config',
      };
    }
  });

  // NIM Multi-Instance handlers
  ipcMain.handle('im:nim:instance:add', async (_event, name: string) => {
    try {
      const instanceId = crypto.randomUUID();
      const { DEFAULT_NIM_OPENCLAW_CONFIG: defaults } = await import('./im/types');
      const instance = {
        ...defaults,
        instanceId,
        instanceName: name || 'NIM Bot',
      };
      getIMGatewayManager().getIMStore().setNimInstanceConfig(instanceId, instance);
      return { success: true, instance };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add NIM instance',
      };
    }
  });

  ipcMain.handle('im:nim:instance:delete', async (_event, instanceId: string) => {
    try {
      getIMGatewayManager().getIMStore().deleteNimInstance(instanceId);
      if (getOpenClawEngineManager().getStatus().phase === 'running') {
        scheduleImConfigSync();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete NIM instance',
      };
    }
  });

  ipcMain.handle('im:nim:instance:config:set', async (_event, instanceId: string, config: Partial<NimInstanceConfig>, options?: { syncGateway?: boolean }) => {
    try {
      getIMGatewayManager().getIMStore().setNimInstanceConfig(instanceId, config);
      if (options?.syncGateway && getOpenClawEngineManager().getStatus().phase === 'running') {
        scheduleImConfigSync();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set NIM instance config',
      };
    }
  });

  // QQ Multi-Instance handlers
  ipcMain.handle('im:qq:instance:add', async (_event, name: string) => {
    try {
      const instanceId = crypto.randomUUID();
      const { DEFAULT_QQ_CONFIG: defaults } = await import('./im/types');
      const instance = {
        ...defaults,
        instanceId,
        instanceName: name || 'QQ Bot',
      };
      getIMGatewayManager().getIMStore().setQQInstanceConfig(instanceId, instance);
      return { success: true, instance };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add QQ instance',
      };
    }
  });

  ipcMain.handle('im:qq:instance:delete', async (_event, instanceId: string) => {
    try {
      getIMGatewayManager().getIMStore().deleteQQInstance(instanceId);
      if (getOpenClawEngineManager().getStatus().phase === 'running') {
        scheduleImConfigSync();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete QQ instance',
      };
    }
  });

  ipcMain.handle('im:qq:instance:config:set', async (_event, instanceId: string, config: Partial<QQInstanceConfig>, options?: { syncGateway?: boolean }) => {
    try {
      getIMGatewayManager().getIMStore().setQQInstanceConfig(instanceId, config);
      if (options?.syncGateway && getOpenClawEngineManager().getStatus().phase === 'running') {
        scheduleImConfigSync();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set QQ instance config',
      };
    }
  });

  // Feishu Multi-Instance handlers
  ipcMain.handle('im:feishu:instance:add', async (_event, name: string) => {
    try {
      const instanceId = crypto.randomUUID();
      const { DEFAULT_FEISHU_OPENCLAW_CONFIG: defaults } = await import('./im/types');
      const instance = {
        ...defaults,
        instanceId,
        instanceName: name || 'Feishu Bot',
      };
      getIMGatewayManager().getIMStore().setFeishuInstanceConfig(instanceId, instance);
      return { success: true, instance };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add Feishu instance',
      };
    }
  });

  ipcMain.handle('im:feishu:instance:delete', async (_event, instanceId: string) => {
    try {
      getIMGatewayManager().getIMStore().deleteFeishuInstance(instanceId);
      if (getOpenClawEngineManager().getStatus().phase === 'running') {
        scheduleImConfigSync();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete Feishu instance',
      };
    }
  });

  ipcMain.handle('im:feishu:instance:config:set', async (_event, instanceId: string, config: Partial<FeishuInstanceConfig>, options?: { syncGateway?: boolean }) => {
    try {
      getIMGatewayManager().getIMStore().setFeishuInstanceConfig(instanceId, config);
      if (options?.syncGateway && getOpenClawEngineManager().getStatus().phase === 'running') {
        scheduleImConfigSync();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set Feishu instance config',
      };
    }
  });

  // Email Multi-Instance handlers
  ipcMain.handle('im:email:instance:add', async (_event, name: string) => {
    try {
      const instanceId = crypto.randomUUID();
      const { DEFAULT_EMAIL_INSTANCE_CONFIG: defaults } = await import('./im/types');
      const instance = {
        ...defaults,
        instanceId,
        instanceName: name || 'Email',
        email: '',
        agentId: 'main',
      };
      getIMGatewayManager().getIMStore().setEmailInstanceConfig(instanceId, instance);
      return { success: true, instance };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add email instance',
      };
    }
  });

  // WeCom Multi-Instance handlers
  ipcMain.handle('im:wecom:instance:add', async (_event, name: string) => {
    try {
      const instanceId = crypto.randomUUID();
      const { DEFAULT_WECOM_CONFIG: defaults } = await import('./im/types');
      const instance = {
        ...defaults,
        instanceId,
        instanceName: name || 'WeCom Bot',
      };
      getIMGatewayManager().getIMStore().setWecomInstanceConfig(instanceId, instance);
      return { success: true, instance };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add WeCom instance',
      };
    }
  });

  ipcMain.handle('im:email:instance:delete', async (_event, instanceId: string) => {
    try {
      getIMGatewayManager().getIMStore().deleteEmailInstance(instanceId);
      if (getOpenClawEngineManager().getStatus().phase === 'running') {
        scheduleImConfigSync();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete email instance',
      };
    }
  });

  ipcMain.handle('im:wecom:instance:delete', async (_event, instanceId: string) => {
    try {
      getIMGatewayManager().getIMStore().deleteWecomInstance(instanceId);
      if (getOpenClawEngineManager().getStatus().phase === 'running') {
        scheduleImConfigSync();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete WeCom instance',
      };
    }
  });

  ipcMain.handle('im:email:instance:config:set', async (_event, instanceId: string, config: Partial<EmailMultiInstanceConfig['instances'][number]>, options?: { syncGateway?: boolean }) => {
    try {
      getIMGatewayManager().getIMStore().setEmailInstanceConfig(instanceId, config);
      if (options?.syncGateway && getOpenClawEngineManager().getStatus().phase === 'running') {
        scheduleImConfigSync();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set email instance config',
      };
    }
  });

  ipcMain.handle('im:wecom:instance:config:set', async (_event, instanceId: string, config: Partial<WecomInstanceConfig>, options?: { syncGateway?: boolean }) => {
    try {
      getIMGatewayManager().getIMStore().setWecomInstanceConfig(instanceId, config);
      if (options?.syncGateway && getOpenClawEngineManager().getStatus().phase === 'running') {
        scheduleImConfigSync();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set WeCom instance config',
      };
    }
  });

  // Telegram Multi-Instance handlers
  ipcMain.handle('im:telegram:instance:add', async (_event, name: string) => {
    try {
      const instanceId = crypto.randomUUID();
      const { DEFAULT_TELEGRAM_OPENCLAW_CONFIG: defaults } = await import('./im/types');
      const instance = {
        ...defaults,
        instanceId,
        instanceName: name || 'Telegram Bot',
      };
      getIMGatewayManager().getIMStore().setTelegramInstanceConfig(instanceId, instance);
      return { success: true, instance };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add Telegram instance',
      };
    }
  });

  ipcMain.handle('im:telegram:instance:delete', async (_event, instanceId: string) => {
    try {
      getIMGatewayManager().getIMStore().deleteTelegramInstance(instanceId);
      if (getOpenClawEngineManager().getStatus().phase === 'running') {
        scheduleImConfigSync();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete Telegram instance',
      };
    }
  });

  ipcMain.handle('im:telegram:instance:config:set', async (_event, instanceId: string, config: Partial<TelegramInstanceConfig>, options?: { syncGateway?: boolean }) => {
    try {
      getIMGatewayManager().getIMStore().setTelegramInstanceConfig(instanceId, config);
      if (options?.syncGateway && getOpenClawEngineManager().getStatus().phase === 'running') {
        scheduleImConfigSync();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set Telegram instance config',
      };
    }
  });

  // Discord Multi-Instance handlers
  ipcMain.handle('im:discord:instance:add', async (_event, name: string) => {
    try {
      const instanceId = crypto.randomUUID();
      const { DEFAULT_DISCORD_OPENCLAW_CONFIG: defaults } = await import('./im/types');
      const instance = {
        ...defaults,
        instanceId,
        instanceName: name || 'Discord Bot',
      };
      getIMGatewayManager().getIMStore().setDiscordInstanceConfig(instanceId, instance);
      return { success: true, instance };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add Discord instance',
      };
    }
  });

  ipcMain.handle('im:discord:instance:delete', async (_event, instanceId: string) => {
    try {
      getIMGatewayManager().getIMStore().deleteDiscordInstance(instanceId);
      if (getOpenClawEngineManager().getStatus().phase === 'running') {
        scheduleImConfigSync();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete Discord instance',
      };
    }
  });

  ipcMain.handle('im:discord:instance:config:set', async (_event, instanceId: string, config: Partial<DiscordInstanceConfig>, options?: { syncGateway?: boolean }) => {
    try {
      getIMGatewayManager().getIMStore().setDiscordInstanceConfig(instanceId, config);
      if (options?.syncGateway && getOpenClawEngineManager().getStatus().phase === 'running') {
        scheduleImConfigSync();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set Discord instance config',
      };
    }
  });

  // Feishu bot install helpers
  ipcMain.handle('feishu:install:qrcode', async (_event, { isLark }: { isLark: boolean }) => {
    try {
      return await getIMGatewayManager().startFeishuInstallQrcode(isLark);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : '获取二维码失败');
    }
  });

  ipcMain.handle('feishu:install:poll', async (_event, { deviceCode }: { deviceCode: string }) => {
    try {
      return await getIMGatewayManager().pollFeishuInstall(deviceCode);
    } catch (error) {
      return { done: false, error: error instanceof Error ? error.message : '轮询失败' };
    }
  });

  ipcMain.handle('feishu:install:verify', async (_event, { appId, appSecret }: { appId: string; appSecret: string }) => {
    try {
      return await getIMGatewayManager().verifyFeishuCredentials(appId, appSecret);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '验证失败' };
    }
  });

  // DingTalk bot install helpers
  ipcMain.handle('dingtalk:install:qrcode', async () => {
    try {
      return await getIMGatewayManager().startDingTalkInstallQrcode();
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : '获取二维码失败');
    }
  });

  ipcMain.handle('dingtalk:install:poll', async (_event, { deviceCode }: { deviceCode: string }) => {
    try {
      return await getIMGatewayManager().pollDingTalkInstall(deviceCode);
    } catch (error) {
      return { done: false, error: error instanceof Error ? error.message : '轮询失败' };
    }
  });

  ipcMain.handle('dingtalk:install:verify', async (_event, { clientId, clientSecret }: { clientId: string; clientSecret: string }) => {
    try {
      return await getIMGatewayManager().verifyDingTalkCredentials(clientId, clientSecret);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '验证失败' };
    }
  });

  // GitHub Copilot device code authentication handlers
  ipcMain.handle('github-copilot:request-device-code', async () => {
    const { requestDeviceCode } = await import('./libs/githubCopilotAuth');
    try {
      const result = await requestDeviceCode();
      return {
        userCode: result.user_code,
        verificationUri: result.verification_uri,
        deviceCode: result.device_code,
        interval: result.interval,
        expiresIn: result.expires_in,
      };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to request device code');
    }
  });

  ipcMain.handle('github-copilot:poll-for-token', async (_event, { deviceCode, interval, expiresIn }: { deviceCode: string; interval: number; expiresIn: number }) => {
    const { pollForAccessToken, getCopilotToken, getGitHubUser } = await import('./libs/githubCopilotAuth');
    try {
      const githubAccessToken = await pollForAccessToken(deviceCode, interval, expiresIn);
      const githubUser = await getGitHubUser(githubAccessToken);
      const { token: copilotToken, expiresAt, baseUrl } = await getCopilotToken(githubAccessToken);
      // Store the GitHub access token for later token refresh
      getStore().set('github_copilot_github_token', githubAccessToken);
      // Register with the token manager for automatic refresh
      setCopilotTokenState({ copilotToken, baseUrl, expiresAt, githubToken: githubAccessToken });
      return { success: true, token: copilotToken, githubUser, baseUrl };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Authentication failed' };
    }
  });

  ipcMain.handle('github-copilot:cancel-polling', async () => {
    const { cancelPolling } = await import('./libs/githubCopilotAuth');
    cancelPolling();
  });

  ipcMain.handle('github-copilot:sign-out', async () => {
    getStore().delete('github_copilot_github_token');
    clearCopilotTokenState();
  });

  ipcMain.handle('github-copilot:refresh-token', async () => {
    try {
      const state = await refreshCopilotTokenNow();
      return { success: true, token: state.copilotToken, baseUrl: state.baseUrl };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Token refresh failed' };
    }
  });

  ipcMain.handle('generate-session-title', async (_event, userInput: string | null) => {
    return generateSessionTitle(userInput);
  });

  ipcMain.handle('get-recent-cwds', async (_event, limit?: number) => {
    const boundedLimit = limit ? Math.min(Math.max(limit, 1), 20) : 8;
    return getCoworkStore().listRecentCwds(boundedLimit);
  });

  ipcMain.handle('get-api-config', async () => {
    return getCurrentApiConfig();
  });

  ipcMain.handle('check-api-config', async (_event, options?: { probeModel?: boolean }) => {
    const { config, error } = resolveCurrentApiConfig();
    if (config && options?.probeModel) {
      const probe = await probeCoworkModelReadiness();
      if (probe.ok === false) {
        return { hasConfig: false, config: null, error: probe.error };
      }
    }
    return { hasConfig: config !== null, config, error };
  });

  ipcMain.handle('save-api-config', async (_event, config: {
    apiKey: string;
    baseURL: string;
    model: string;
    apiType?: 'anthropic' | 'openai';
  }) => {
    try {
      saveCoworkApiConfig(config);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save API config',
      };
    }
  });

  // Dialog handlers
  ipcMain.handle('dialog:selectDirectory', async (event) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions = {
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
    };
    const result = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) {
      return { success: true, path: null };
    }
    return { success: true, path: result.filePaths[0] };
  });

  ipcMain.handle('dialog:selectFile', async (event, options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions = {
      properties: ['openFile'] as ('openFile')[],
      title: options?.title,
      filters: options?.filters,
    };
    const result = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) {
      return { success: true, path: null };
    }
    return { success: true, path: result.filePaths[0] };
  });

  ipcMain.handle('dialog:selectFiles', async (event, options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions = {
      properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
      title: options?.title,
      filters: options?.filters,
    };
    const result = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) {
      return { success: true, paths: [] };
    }
    return { success: true, paths: result.filePaths };
  });

  ipcMain.handle(
    'dialog:showMessageBox',
    async (event, options: { message: string; type?: 'none' | 'info' | 'error' | 'question' | 'warning'; title?: string }) => {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const { dialog } = await import('electron');
      return dialog.showMessageBox(ownerWindow!, {
        type: options.type || 'warning',
        title: options.title || '',
        message: options.message,
        buttons: ['OK'],
      });
    }
  );

  ipcMain.handle(
    'dialog:saveInlineFile',
    async (
      _event,
      options?: { dataBase64?: string; fileName?: string; mimeType?: string; cwd?: string }
    ) => {
      try {
        const dataBase64 = typeof options?.dataBase64 === 'string' ? options.dataBase64.trim() : '';
        if (!dataBase64) {
          return { success: false, path: null, error: 'Missing file data' };
        }

        const buffer = Buffer.from(dataBase64, 'base64');
        if (!buffer.length) {
          return { success: false, path: null, error: 'Invalid file data' };
        }
        if (buffer.length > MAX_INLINE_ATTACHMENT_BYTES) {
          return {
            success: false,
            path: null,
            error: `File too large (max ${Math.floor(MAX_INLINE_ATTACHMENT_BYTES / (1024 * 1024))}MB)`,
          };
        }

        const dir = resolveInlineAttachmentDir(options?.cwd);
        await fs.promises.mkdir(dir, { recursive: true });

        const safeFileName = sanitizeAttachmentFileName(options?.fileName);
        const extension = inferAttachmentExtension(safeFileName, options?.mimeType);
        const baseName = extension ? safeFileName.slice(0, -extension.length) : safeFileName;
        const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const finalName = `${baseName || 'attachment'}-${uniqueSuffix}${extension}`;
        const outputPath = path.join(dir, finalName);

        await fs.promises.writeFile(outputPath, buffer);
        return { success: true, path: outputPath };
      } catch (error) {
        return {
          success: false,
          path: null,
          error: error instanceof Error ? error.message : 'Failed to save inline file',
        };
      }
    }
  );

  // Read a local file as a data URL (data:<mime>;base64,...)
  const MAX_READ_AS_DATA_URL_BYTES = 20 * 1024 * 1024;
  const MIME_BY_EXT: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.ico': 'image/x-icon',
    '.avif': 'image/avif',
  };
  ipcMain.handle(
    'dialog:readFileAsDataUrl',
    async (_event, filePath?: string): Promise<{ success: boolean; dataUrl?: string; error?: string }> => {
      try {
        if (typeof filePath !== 'string' || !filePath.trim()) {
          return { success: false, error: 'Missing file path' };
        }
        const resolvedPath = path.resolve(filePath.trim());
        const stat = await fs.promises.stat(resolvedPath);
        if (!stat.isFile()) {
          return { success: false, error: 'Not a file' };
        }
        if (stat.size > MAX_READ_AS_DATA_URL_BYTES) {
          return {
            success: false,
            error: `File too large (max ${Math.floor(MAX_READ_AS_DATA_URL_BYTES / (1024 * 1024))}MB)`,
          };
        }
        const buffer = await fs.promises.readFile(resolvedPath);
        const ext = path.extname(resolvedPath).toLowerCase();
        const mimeType = MIME_BY_EXT[ext] || 'application/octet-stream';
        const base64 = buffer.toString('base64');
        return { success: true, dataUrl: `data:${mimeType};base64,${base64}` };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to read file',
        };
      }
    }
  );

  // Shell handlers - 打开文件/文件夹
  ipcMain.handle('shell:openPath', async (_event, filePath: string) => {
    try {
      const normalizedPath = normalizeWindowsShellPath(filePath);
      const result = await shell.openPath(normalizedPath);
      if (result) {
        // 如果返回非空字符串，表示打开失败
        return { success: false, error: result };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('shell:showItemInFolder', async (_event, filePath: string) => {
    try {
      const normalizedPath = normalizeWindowsShellPath(filePath);
      shell.showItemInFolder(normalizedPath);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle(AppUpdateIpc.GetState, async () => {
    return getAppUpdateCoordinator().getState();
  });

  ipcMain.handle(AppUpdateIpc.CheckNow, async (_event, options?: { manual?: boolean }) => {
    return getAppUpdateCoordinator().checkNow(options);
  });

  ipcMain.handle(AppUpdateIpc.RetryDownload, async () => {
    const state = await getAppUpdateCoordinator().retryDownload();
    return { success: true, state };
  });

  ipcMain.handle(AppUpdateIpc.CancelDownload, async () => {
    const state = getAppUpdateCoordinator().cancelDownload();
    return { success: true, state };
  });

  ipcMain.handle(AppUpdateIpc.InstallReady, async () => {
    return getAppUpdateCoordinator().installReadyUpdate();
  });

  // Helper: detect if a URL belongs to GitHub Copilot and apply token refresh on 401.
  const isCopilotUrl = (url: string) =>
    url.includes('githubcopilot.com');
  const retryCopilotWithRefreshedToken = async (
    opts: { url: string; method: string; headers: Record<string, string>; body?: string },
  ): Promise<{ headers: Record<string, string>; retried: boolean }> => {
    try {
      const state = await refreshCopilotTokenNow();
      const refreshedHeaders = { ...opts.headers, Authorization: `Bearer ${state.copilotToken}` };
      console.log('[CopilotRetry] token refreshed, retrying request');
      return { headers: refreshedHeaders, retried: true };
    } catch (err) {
      console.warn('[CopilotRetry] token refresh failed, not retrying:', err);
      return { headers: opts.headers, retried: false };
    }
  };

  // API 代理处理程序 - 解决 CORS 问题
  ipcMain.handle('api:fetch', async (_event, options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }) => {
    console.log(`[api:fetch] ${options.method} ${options.url}, headers: ${JSON.stringify(options.headers)}, body: ${options.body}`);

    const doFetch = async (headers: Record<string, string>) => {
      const response = await session.defaultSession.fetch(options.url, {
        method: options.method,
        headers,
        body: options.body,
      });

      const contentType = response.headers.get('content-type') || '';
      let data: string | object;

      if (contentType.includes('text/event-stream')) {
        data = await response.text();
      } else if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        data,
      };
    };

    try {
      let result = await doFetch(options.headers);
      console.log(`[api:fetch] ${options.method} ${options.url} -> ${result.status} ${result.statusText}`, typeof result.data === 'object' ? JSON.stringify(result.data) : result.data);

      // Auto-retry once for Copilot 401/403
      if (!result.ok && (result.status === 401 || result.status === 403) && isCopilotUrl(options.url)) {
        console.log('[api:fetch] Copilot auth error, attempting token refresh and retry');
        const { headers: refreshedHeaders, retried } = await retryCopilotWithRefreshedToken(options);
        if (retried) {
          result = await doFetch(refreshedHeaders);
          console.log(`[api:fetch] retry -> ${result.status} ${result.statusText}`);
        }
      }

      return result;
    } catch (error) {
      console.error(`[api:fetch] ${options.method} ${options.url} -> ERROR:`, error instanceof Error ? error.message : error);
      return {
        ok: false,
        status: 0,
        statusText: error instanceof Error ? error.message : 'Network error',
        headers: {},
        data: null,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // SSE 流式 API 代理
  ipcMain.handle('api:stream', async (event, options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    requestId: string;
  }) => {
    const controller = new AbortController();

    // 存储 controller 以便后续取消
    activeStreamControllers.set(options.requestId, controller);

    try {
      let response = await session.defaultSession.fetch(options.url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        signal: controller.signal,
      });

      // Auto-retry once for Copilot 401/403
      if (!response.ok && (response.status === 401 || response.status === 403) && isCopilotUrl(options.url)) {
        console.log('[api:stream] Copilot auth error, attempting token refresh and retry');
        const { headers: refreshedHeaders, retried } = await retryCopilotWithRefreshedToken(options);
        if (retried) {
          response = await session.defaultSession.fetch(options.url, {
            method: options.method,
            headers: refreshedHeaders,
            body: options.body,
            signal: controller.signal,
          });
          console.log(`[api:stream] retry -> ${response.status} ${response.statusText}`);
        }
      }

      if (!response.ok) {
        const errorData = await response.text();
        activeStreamControllers.delete(options.requestId);
        return {
          ok: false,
          status: response.status,
          statusText: response.statusText,
          error: errorData,
        };
      }

      if (!response.body) {
        activeStreamControllers.delete(options.requestId);
        return {
          ok: false,
          status: response.status,
          statusText: 'No response body',
        };
      }

      // 读取流式响应并通过 IPC 发送
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      const readStream = async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              event.sender.send(`api:stream:${options.requestId}:done`);
              break;
            }
            const chunk = decoder.decode(value);
            event.sender.send(`api:stream:${options.requestId}:data`, chunk);
          }
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            event.sender.send(`api:stream:${options.requestId}:abort`);
          } else {
            event.sender.send(`api:stream:${options.requestId}:error`,
              error instanceof Error ? error.message : 'Stream error');
          }
        } finally {
          activeStreamControllers.delete(options.requestId);
        }
      };

      // 异步读取流，立即返回成功状态
      readStream();

      return {
        ok: true,
        status: response.status,
        statusText: response.statusText,
      };
    } catch (error) {
      activeStreamControllers.delete(options.requestId);
      return {
        ok: false,
        status: 0,
        statusText: error instanceof Error ? error.message : 'Network error',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // 取消流式请求
  ipcMain.handle('api:stream:cancel', (_event, requestId: string) => {
    const controller = activeStreamControllers.get(requestId);
    if (controller) {
      controller.abort();
      activeStreamControllers.delete(requestId);
      return true;
    }
    return false;
  });

  // ─── end OAuth ───

  // 企微 SDK 授权弹窗白名单域名
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

    stopOpenClawTokenProxy();

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
    try {
      getCronJobService().stopPolling();
    } catch {
      // CronJobService may not have been initialized — safe to ignore.
    }

    sqliteBackupManager?.stopPeriodicBackupLoop();

    // Close the SQLite database to flush the WAL and release the file lock.
    try {
      getStore().close();
    } catch {
      // Store may not have been initialized — safe to ignore.
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
    const profiler = new StartupProfiler();

    profiler.mark('app.whenReady');
    console.log('[Main] initApp: waiting for app.whenReady()');
    await app.whenReady();
    profiler.measure('app.whenReady');
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

    profiler.mark('initStore');
    console.log('[Main] initApp: starting initStore()');
    store = await initStore();
    profiler.measure('initStore');
    console.log('[Main] initApp: store initialized');
    refreshEndpointsTestMode(store);
    sqliteBackupManager = new SqliteBackupManager(app.getPath('userData'));

    const startSqliteBackupLoop = async (): Promise<void> => {
      if (!sqliteBackupManager) return;
      await sqliteBackupManager.startPeriodicBackupLoop(() => getStore().getDatabase());
    };

    const stopSqliteBackupLoop = (): void => {
      sqliteBackupManager?.stopPeriodicBackupLoop();
    };

    if (getSqliteAutoBackupEnabledFromConfig(getStore().get<AppConfigSettings>('app_config'))) {
      await startSqliteBackupLoop().catch((error) => {
        console.error('[SqliteBackup] Failed to start periodic backup loop:', error);
      });
    }

    // Defensive recovery: app may be force-closed during execution and leave
    // stale running flags in DB. Normalize them on startup.
    const resetCount = getCoworkStore().resetRunningSessions();
    console.log('[Main] initApp: resetRunningSessions done, count:', resetCount);
    if (resetCount > 0) {
      console.log(`[Main] Reset ${resetCount} stuck cowork session(s) from running -> idle`);
    }
    // Inject store getter into claudeSettings
    setStoreGetter(() => store);
    // Inject auth getters for lobsterai-server provider routing
    // The getter proactively triggers a background token refresh when the
    // accessToken is within 5 minutes of expiry, so that the SDK always
    // gets a fresh token without blocking.
    //
    // refreshOnce() is the single entry-point for all token refresh paths
    // (proactive, proxy 401/403 retry). It deduplicates concurrent calls via
    // pendingTokenRefresh so that rolling refresh tokens are never consumed twice.
    const refreshOnce = async (reason: string): Promise<string | null> => {
      if (pendingTokenRefresh) {
        return pendingTokenRefresh;
      }
      let resolvedToken: string | null = null;
      pendingTokenRefresh = (async () => {
        try {
          const tokens = getAuthTokens();
          if (!tokens?.refreshToken) return null;
          const serverBaseUrl = getServerApiBaseUrl();
          const resp = await net.fetch(`${serverBaseUrl}/api/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: tokens.refreshToken }),
          });
          if (resp.ok) {
            const body = await resp.json() as { code: number; data: { accessToken: string; refreshToken?: string } };
            if (body.code === 0 && body.data) {
              saveAuthTokens(body.data.accessToken, body.data.refreshToken || tokens.refreshToken);
              console.log(`[Auth] token refresh succeeded (reason: ${reason})`);
              resolvedToken = body.data.accessToken;
              // Token proxy handles fresh tokens dynamically — no need
              // to restart the gateway on token refresh.
              syncOpenClawConfig({ reason: `token-refresh:${reason}`, restartGatewayIfRunning: false }).catch((err) => {
                console.warn('[Auth] post-refresh OpenClaw config sync failed:', err);
              });
            }
          }
        } catch (err) {
          console.warn(`[Auth] token refresh failed (reason: ${reason}):`, err);
        } finally {
          pendingTokenRefresh = null;
        }
        return resolvedToken;
      })();
      return pendingTokenRefresh;
    };

    setAuthTokensGetter(() => {
      const tokens = getAuthTokens();
      if (!tokens) return null;
      // Check if accessToken is close to expiry and trigger background refresh
      try {
        const payload = JSON.parse(Buffer.from(tokens.accessToken.split('.')[1], 'base64').toString());
        const expiresAt = payload.exp * 1000;
        if (expiresAt - Date.now() < 5 * 60 * 1000) {
          void refreshOnce('proactive'); // fire-and-forget
        }
      } catch { /* unable to parse JWT, return token as-is */ }
      return tokens;
    });
    setServerBaseUrlGetter(() => getServerApiBaseUrl());

    // Initialize Copilot token manager and restore token state if available
    initCopilotTokenManager(getStore);
    const storedGithubToken = getStore().get('github_copilot_github_token') as string | undefined;
    if (storedGithubToken) {
      import('./libs/githubCopilotAuth').then(({ getCopilotToken }) =>
        getCopilotToken(storedGithubToken).then(({ token, expiresAt, baseUrl }) => {
          setCopilotTokenState({ copilotToken: token, baseUrl, expiresAt, githubToken: storedGithubToken });
          console.log('[Main] restored Copilot token state from stored GitHub token');
        })
      ).catch((err) => {
        console.warn('[Main] failed to restore Copilot token on startup:', err);
      });
    }

    registerProxyTokenRefresher('lobsterai-server', async () => {
      const tokens = getAuthTokens();
      if (!tokens?.refreshToken) return null;
      const serverBaseUrl = getServerApiBaseUrl();
      try {
        const resp = await net.fetch(`${serverBaseUrl}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: tokens.refreshToken }),
        });
        if (resp.ok) {
          const body = await resp.json() as { code: number; data: { accessToken: string; refreshToken?: string } };
          if (body.code === 0 && body.data) {
            saveAuthTokens(body.data.accessToken, body.data.refreshToken || tokens.refreshToken);
            console.log('[Auth] proxy token refresh succeeded');
            return body.data.accessToken;
          }
        }
      } catch (err) {
        console.warn('[Auth] proxy token refresh failed:', err);
      }
      return null;
    });

    registerProxyTokenRefresher('github-copilot', async () => {
      try {
        const { refreshCopilotTokenNow } = await import('./libs/copilotTokenManager');
        const refreshed = await refreshCopilotTokenNow();
        return refreshed.copilotToken;
      } catch (err) {
        console.warn('[Auth] Copilot proxy token refresh failed:', err);
        return null;
      }
    });

    // Start the lightweight token proxy before OpenClaw config sync so that
    // lobsterai-server provider can use the proxy URL in its config.
    profiler.mark('openClawTokenProxy');
    try {
      await startOpenClawTokenProxy({
        getAuthTokens,
        refreshToken: refreshOnce,
        getServerBaseUrl: getServerApiBaseUrl,
      });
      console.log('[Main] OpenClaw token proxy started');
    } catch (err) {
      console.warn('[Main] OpenClaw token proxy failed to start (non-fatal):', err);
    }
    profiler.measure('openClawTokenProxy');

    // Enterprise config sync — must run before openclawConfigSync
    profiler.mark('enterpriseConfigSync');
    // so enterprise data is in SQLite when the config is generated.
    const enterpriseConfigPath = resolveEnterpriseConfigPath();
    if (enterpriseConfigPath) {
      try {
        const imStoreInstance = getIMGatewayManager().getIMStore();
        const mcpStoreInstance = getMcpStore();
        syncEnterpriseConfig(
          enterpriseConfigPath,
          store,
          imStoreInstance,
          (server) => {
            const existing = mcpStoreInstance.listServers().find(s => s.name === server.name);
            if (existing) {
              mcpStoreInstance.updateServer(existing.id, {
                name: server.name,
                description: server.description,
                transportType: server.transportType as 'stdio' | 'sse' | 'http',
                command: server.command,
                args: server.args,
                env: server.env,
              });
            } else {
              mcpStoreInstance.createServer({
                name: server.name,
                description: server.description,
                transportType: server.transportType as 'stdio' | 'sse' | 'http',
                command: server.command,
                args: server.args,
                env: server.env,
              });
            }
          },
          () => {
            // Clear all MCP servers (for overwrite mode)
            for (const s of mcpStoreInstance.listServers()) {
              mcpStoreInstance.deleteServer(s.id);
            }
          },
          (config) => {
            const cs = getCoworkStore();
            cs.setConfig(config);
          },
          () => {
            const cs = getCoworkStore();
            return cs.getConfig().workingDirectory;
          },
        );
      } catch (error) {
        console.error('[Enterprise] config sync failed:', error);
      }
    } else {
      // No enterprise config package found — clear any previously stored config
      // so the app exits enterprise mode after the package is removed.
      const hadEnterprise = store.get('enterprise_config');
      if (hadEnterprise) {
        store.delete('enterprise_config');
        // Reset executionMode to default so sandbox mode reverts to "off".
        const cs = getCoworkStore();
        cs.setConfig({ executionMode: 'local' });
        console.log('[Enterprise] config package removed, cleared enterprise mode and reset executionMode');
      }
    }
    profiler.measure('enterpriseConfigSync');

    bindCoworkRuntimeForwarder();
    bindOpenClawStatusForwarder();

    const defaultAgentModelRef = resolveDefaultAgentModelRef();
    const backfilledAgentModels = getCoworkStore().backfillEmptyAgentModels(defaultAgentModelRef);
    const qualifiedAgentModels = migrateAgentModelRefs();
    if (backfilledAgentModels > 0 || qualifiedAgentModels > 0) {
      console.log(
        `[Main] migrated agent model bindings: backfilled=${backfilledAgentModels}, qualified=${qualifiedAgentModels}`,
      );
    }

    // Start proxy BEFORE config sync so proxy-dependent providers (e.g. copilot)
    // get the correct baseURL on the first write, avoiding a mid-startup config
    // overwrite that triggers unnecessary gateway hot-reload.
    profiler.mark('applyProxyPreference');
    const appConfig = getStore().get<AppConfigSettings>('app_config');
    await applyProxyPreference(getUseSystemProxyFromConfig(appConfig));
    profiler.measure('applyProxyPreference');

    profiler.mark('coworkOpenAICompatProxy');
    await startCoworkOpenAICompatProxy().catch((error) => {
      console.error('Failed to start OpenAI compatibility proxy:', error);
    });
    profiler.measure('coworkOpenAICompatProxy');

    profiler.mark('syncOpenClawConfig');
    const startupSync = await syncOpenClawConfig({
      reason: 'startup',
      restartGatewayIfRunning: false,
    });
    if (!startupSync.success) {
      console.error('[OpenClaw] Startup config sync failed:', startupSync.error);
    }
    profiler.measure('syncOpenClawConfig');
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

    // ── Step 1: Show window ASAP ──────────────────────────────────────
    // CSP + createWindow moved before skill initialisation so the user
    // sees the loading UI within ~1-2 s instead of waiting for the full
    // skill bootstrap (~6-8 s previously).
    setContentSecurityPolicy();

    profiler.mark('createWindow');
    console.log('[Main] initApp: creating window');
    createWindow();
    profiler.measure('createWindow');
    console.log('[Main] initApp: window created');

    // ── Step 2-4: Skill bootstrap (non-blocking) ────────────────────
    console.log('[Main] initApp: starting skill bootstrap');
    profiler.mark('skillManager');
    const manager = getSkillManager();
    console.log('[Main] initApp: getSkillManager done');

    // When skills change (install/enable/disable/delete), re-sync AGENTS.md
    // so OpenClaw's IM channel agents pick up the latest skill list.
    manager.onSkillsChanged(() => {
      syncOpenClawConfig({ reason: 'skills-changed' }).catch((error) => {
        console.warn('[Main] Failed to sync OpenClaw config after skills change:', error);
      });
    });

    // Parallelise independent skill sub-tasks (Step 4).
    await Promise.all([
      // Group A: file-system skill operations (sync, must run in order)
      (async () => {
        profiler.mark('syncBundledSkills');
        try {
          manager.syncBundledSkillsToUserData();
          console.log('[Main] initApp: syncBundledSkillsToUserData done');
        } catch (error) {
          console.error('[Main] initApp: syncBundledSkillsToUserData failed:', error);
        }
        profiler.measure('syncBundledSkills');

        try {
          manager.recoverInterruptedUpgrades();
          console.log('[Main] initApp: recoverInterruptedUpgrades done');
        } catch (error) {
          console.error('[Main] initApp: recoverInterruptedUpgrades failed:', error);
        }

        try {
          manager.startWatching();
          console.log('[Main] initApp: startWatching done');
        } catch (error) {
          console.error('[Main] initApp: startWatching failed:', error);
        }
      })(),

      // Group B: python runtime (independent, async)
      (async () => {
        profiler.mark('pythonRuntime');
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
        profiler.measure('pythonRuntime');
      })(),
    ]);

    // Skill services (web-search bridge) — fire-and-forget (Step 2).
    // No IPC handler or downstream init depends on this completing.
    try {
      const skillServices = getSkillServiceManager();
      console.log('[Main] initApp: getSkillServiceManager done');
      const t0 = performance.now();
      void skillServices.startAll().then(() => {
        console.log(`[Main] initApp: skill services started (background, ${(performance.now() - t0).toFixed(0)}ms)`);
      }).catch((error) => {
        console.error('[Main] initApp: skill services failed:', error);
      });
    } catch (error) {
      console.error('[Main] initApp: skill services init failed:', error);
    }
    profiler.measure('skillManager');

    console.log(profiler.summary());

    // Windows/Linux cold start: parse deep link from process.argv
    // Always buffer since renderer is not ready yet after createWindow()
    const coldStartDeepLink = process.argv.find(arg => arg.startsWith('lobsterai://'));
    if (coldStartDeepLink) {
      try {
        const parsed = new URL(coldStartDeepLink);
        if (parsed.hostname === 'auth' && parsed.pathname === '/callback') {
          const code = parsed.searchParams.get('code');
          if (code) {
            pendingAuthCode = code;
          }
        }
      } catch (e) {
        console.error('[Main] Failed to parse cold-start deep link:', e);
      }
    }

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
    const preventSleepEnabled = getStore().get<boolean>('prevent_sleep_enabled');
    if (preventSleepEnabled) {
      try {
        setPreventSleepBlockerEnabled(true);
      } catch (err) {
        console.error('[Main] Failed to start prevent-sleep blocker:', err);
      }
    }

    let lastLanguage = getStore().get<AppConfigSettings>('app_config')?.language;
    let lastUseSystemProxy = getUseSystemProxyFromConfig(getStore().get<AppConfigSettings>('app_config'));
    let lastSqliteAutoBackupEnabled = getSqliteAutoBackupEnabledFromConfig(
      getStore().get<AppConfigSettings>('app_config'),
    );
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

      const previousSqliteAutoBackupEnabled = oldConfig
        ? getSqliteAutoBackupEnabledFromConfig(oldConfig)
        : lastSqliteAutoBackupEnabled;
      const currentSqliteAutoBackupEnabled = getSqliteAutoBackupEnabledFromConfig(newConfig);
      if (currentSqliteAutoBackupEnabled !== previousSqliteAutoBackupEnabled) {
        if (currentSqliteAutoBackupEnabled) {
          void startSqliteBackupLoop().catch((error) => {
            console.error('[SqliteBackup] Failed to enable periodic backup loop:', error);
          });
        } else {
          stopSqliteBackupLoop();
        }
      }
      lastSqliteAutoBackupEnabled = currentSqliteAutoBackupEnabled;
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
