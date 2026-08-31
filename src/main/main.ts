import crypto from 'crypto';
import {
  app,
  BrowserWindow,
  clipboard,
  type ContextMenuParams,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  nativeTheme,
  net,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  session,
  shell,
  type WebContents,
} from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { CoworkSystemMessageKind } from '../common/coworkSystemMessages';
import { buildGoalSettingMessageMetadata } from '../common/goalCommandDisplay';
import type { OpenClawSessionPatch } from '../common/openclawSession';
import { buildSessionTitleFromInput } from '../common/sessionTitle';
import { buildScheduledTaskEnginePrompt } from '../scheduledTask/enginePrompt';
import {
  migrateScheduledTaskRunsToOpenclaw,
  migrateScheduledTasksToOpenclaw,
} from '../scheduledTask/migrate';
import {
  AgentId,
} from '../shared/agent/constants';
import {
  LogReporterAction,
  LogReporterSource,
  LogReporterStoreKey,
} from '../shared/analytics/constants';
import { AppIpcChannel } from '../shared/app/constants';
import { AppSettingsAutoLaunchErrorCode, AppSettingsIpc } from '../shared/appSettings/constants';
import { AppUpdateIpc } from '../shared/appUpdate/constants';
import { ArtifactBrowserPartition, ArtifactPreviewIpc, ArtifactPreviewProtocol } from '../shared/artifactPreview/constants';
import { createAccountOwnerKey } from '../shared/auth/accountOwner';
import {
  AuthIpcChannel,
  type AuthLifecycleEvent,
  AuthLifecycleEventType,
  AuthRefreshOutcome,
  AuthRefreshReason,
  type AuthSessionChangedEvent,
  AuthSessionChangeReason,
  AuthSessionStatus,
} from '../shared/auth/constants';
import {
  type BrowserDiagnosticResultStep,
  BrowserDiagnosticStatus,
  BrowserDiagnosticStep,
  BrowserIpc,
  BrowserRuntimeProfile,
  type BrowserWebAccessConfig,
  normalizeBrowserWebAccessConfig,
} from '../shared/browserWebAccess/constants';
import { ClipboardIpc } from '../shared/clipboard/constants';
import {
  type CoworkBrowserAnnotationMessageBatch,
  normalizeBrowserAnnotationBatches,
} from '../shared/cowork/browserAnnotations';
import {
  COWORK_BTW_EVENT_QUESTION_MAX_CHARS,
  COWORK_BTW_IDENTIFIER_MAX_CHARS,
  COWORK_BTW_RESULT_MAX_CHARS,
  type CoworkBtwAbortRequest,
  type CoworkBtwAbortResponse,
  type CoworkBtwEntry,
  type CoworkBtwSubmitRequest,
  type CoworkBtwSubmitResponse,
  normalizeCoworkBtwQuestion,
} from '../shared/cowork/btw';
import {
  COWORK_MESSAGE_PAGE_SIZE,
  COWORK_SEARCH_MESSAGE_PAGE_MAX_SIZE,
  COWORK_SEARCH_MESSAGE_PAGE_SIZE,
  COWORK_SESSION_PAGE_SIZE,
  COWORK_TEMP_ATTACHMENTS_DIR_NAME,
  COWORK_TEMP_DIR_NAME,
  CoworkContextUsageFailureReason,
  CoworkContextUsageSource,
  CoworkForkMode,
  CoworkIpcChannel,
} from '../shared/cowork/constants';
import {
  buildCoworkImageAttachmentPreviews,
  type CoworkImageAttachmentPreview,
  formatCoworkImageAttachmentLimit,
  validateCoworkImageAttachmentSize,
} from '../shared/cowork/imageAttachments';
import { containsPlanModePrompt } from '../shared/cowork/planMode';
import type { CoworkSearchMessageCursor } from '../shared/cowork/search';
import {
  type CoworkSelectedTextSnippet,
  normalizeCoworkSelectedTextSnippets,
} from '../shared/cowork/selectedText';
import {
  CoworkSteerRejectReason,
  CoworkSteerStatus,
} from '../shared/cowork/steer';
import { stripNullChars } from '../shared/cowork/text';
import {
  DataMigrationIpc,
  type DataMigrationLastRestoreResult,
  DataMigrationRestoreStatus,
} from '../shared/dataMigration/constants';
import { DialogIpc } from '../shared/dialog/constants';
import {
  EnterpriseAccountIpcChannel,
  EnterpriseAccountMode,
  EnterpriseApiErrorCode,
  EnterpriseQuotaMessageMetadataKey,
} from '../shared/enterpriseAccount/constants';
import { resolveEnterpriseQuotaError } from '../shared/enterpriseAccount/quotaError';
import {
  HtmlShareAccessMode,
  type HtmlShareAccessMode as HtmlShareAccessModeValue,
  type HtmlShareAnalyticsInput,
  type HtmlShareConfigurableStatus,
  HtmlShareIpc,
  HtmlShareSourceType,
  type HtmlShareSourceType as HtmlShareSourceTypeValue,
  HtmlShareStatus,
  type HtmlShareStatus as HtmlShareStatusValue,
} from '../shared/htmlShare/constants';
import type {
  InstalledKitRecord,
  KitReference,
  ResolvedKitCapabilities,
} from '../shared/kit/constants';
import { KitStoreKey } from '../shared/kit/constants';
import { LibraryChangeReason, LibraryIpc } from '../shared/library/constants';
import type { LibraryChangedPayload } from '../shared/library/types';
import {
  type ListLocalWebServicesOptions,
  type LocalWebService,
  LocalWebServicesIpc,
} from '../shared/localWebServices/constants';
import { canonicalizeMediaModelId, HAPPYHORSE_1_1_MODEL_ID, mediaModelDisplayName } from '../shared/mediaModelAliases';
import {
  normalizeNotificationSettings,
  type NotificationSettings,
  TaskCompletionNotificationMode,
  WaitingNotificationKind,
} from '../shared/notifications/constants';
import {
  OpenClawEngineIpc,
  OpenClawGatewayRepairErrorCode,
} from '../shared/openclawEngine/constants';
import { PlatformRegistry } from '../shared/platform';
import type { ProviderConfig } from '../shared/providers';
import {
  ModelRuntimeProfile,
  OpenClawProviderId,
  parseModelThinkingLevel,
  ProviderName,
} from '../shared/providers';
import {
  ShareDeploymentCandidateSource,
  type ShareDeploymentCreateNodeInput,
  type ShareDeploymentDetectCandidatesInput,
  type ShareDeploymentDownloadPersistenceInput,
  type ShareDeploymentGetByLocalServiceInput,
  ShareDeploymentIpc,
  ShareDeploymentKind,
  ShareDeploymentPackageManager,
  type ShareDeploymentPersistence,
  ShareDeploymentPersistenceBindingKind,
  ShareDeploymentPersistenceProvider,
  ShareDeploymentPersistenceUpdateMode,
  type ShareDeploymentProjectCandidate,
  type ShareDeploymentSelectPersistencePathInput,
} from '../shared/shareDeployment/constants';
import type { ShellOpenFailureReason as ShellOpenFailureReasonType } from '../shared/shell/constants';
import { type ShellGetBrowserAppsInput, ShellIpc, ShellOpenFailureReason } from '../shared/shell/constants';
import { AgentManager } from './agentManager';
import { APP_NAME, APP_USER_MODEL_ID, DB_FILENAME } from './appConstants';
import { createLocalFileProtocolResponse } from './artifactLocalFileProtocol';
import { authQuotaGateStateFromQuota, AuthSubscriptionStatus, createDefaultAuthQuotaGateState, normalizeAuthQuota } from './authQuota';
import { type AutoLaunchStatus, getAutoLaunchStatus, isAutoLaunched, setAutoLaunchEnabled } from './autoLaunchManager';
import { getRecentComputerUseLogEntries } from './computerUse/computerUseLogs';
import { type CoworkForkContextMessage, type CoworkMessage, CoworkStore } from './coworkStore';
import {
  buildEnterpriseAccountRequestHeaders,
  clearEnterpriseAccountContext,
  fetchEnterpriseAccountContext,
  fetchEnterpriseAccountIdentities,
  getPersistedEnterpriseAccountContext,
  normalizeEnterpriseAccountContext,
  persistEnterpriseAccountContext,
  readAccountMode,
  requestEnterpriseQuotaIncrease,
} from './enterpriseAccount/context';
import {
  createEnterpriseAuthSessionSnapshot,
  createEnterpriseMembershipRevocationHandler,
  EnterpriseMembershipRevocationSource,
  readEnterpriseApiErrorCode,
  resolveEnterpriseMembershipRevocationSource,
} from './enterpriseAccount/membershipRevocation';
import { setLanguage, t } from './i18n';
import { IMGatewayConfig, IMGatewayManager } from './im';
import {
  approvePairingCode,
  listPairingRequests,
  readAllowFromStore,
  rejectPairingRequest,
} from './im/imPairingStore';
import { pollNimQrLogin, startNimQrLogin } from './im/nimQrLoginService';
import type {
  DingTalkInstanceConfig,
  DiscordInstanceConfig,
  EmailMultiInstanceConfig,
  FeishuInstanceConfig,
  NimInstanceConfig,
  Platform,
  QQInstanceConfig,
  TelegramInstanceConfig,
  WecomInstanceConfig,
} from './im/types';
import { registerActivityIpcHandlers } from './ipcHandlers/activity';
import { registerAgentHandlers } from './ipcHandlers/agents';
import { registerAsrIpcHandlers } from './ipcHandlers/asr';
import { registerCoworkSubagentHandlers } from './ipcHandlers/coworkSubagent';
import { ensureDshEngineReady, registerDshHandlers } from './ipcHandlers/dsh/handlers';
import { registerEnterpriseAccountHandlers } from './ipcHandlers/enterpriseAccount';
import { registerKitHandlers } from './ipcHandlers/kits';
import { registerMcpHandlers } from './ipcHandlers/mcp';
import { registerNimQrLoginHandlers } from './ipcHandlers/nimQrLogin';
import { registerPermissionIpcHandlers } from './ipcHandlers/permissions/handlers';
import { registerPluginHandlers } from './ipcHandlers/plugins';
import {
  getCronJobService,
  initCronJobServiceManager,
  initScheduledTaskHelpers,
  migrateScheduledTaskAnnounceJobs,
  registerScheduledTaskHandlers,
} from './ipcHandlers/scheduledTask';
import { registerSessionDiagnosticsHandlers } from './ipcHandlers/sessionDiagnostics';
import { registerSiteIpcHandlers } from './ipcHandlers/site';
import { registerSkillHandlers } from './ipcHandlers/skills';
import { LibraryIndexService } from './library/libraryIndexService';
import { registerLibraryIpcHandlers } from './library/libraryIpc';
import { LibraryLocalStore } from './library/libraryLocalStore';
import {
  type CoworkAgentEngine,
  CoworkEngineRouter,
  OpenClawRuntimeAdapter,
  type PermissionResult,
} from './libs/agentEngine';
import { AppUpdateCoordinator, INSTALLATION_UUID_KEY } from './libs/appUpdateCoordinator';
import { AuthCallbackRouter } from './libs/authCallbackRouter';
import {
  appendCallbackReturnTo,
  appendLoginParams,
  startAuthLocalCallback,
} from './libs/authLocalCallbackServer';
import {
  AuthSessionManager,
  resolveAuthSessionStatusFromError,
} from './libs/authSessionManager';
import type { BrowserAnnotationAssetIdentity, SaveBrowserAnnotationAssetInput } from './libs/browserAnnotationAssetStore';
import { BrowserAnnotationAssetStore } from './libs/browserAnnotationAssetStore';
import {
  clearServerModelMetadata,
  evaluateServerModelRunGate,
  getAllServerModelMetadata,
  getCurrentApiConfig,
  getServerModelMetadata,
  isKnownPackageKimiK3ModelId,
  resolveAllEnabledProviderConfigs,
  resolveCurrentApiConfig,
  resolveRawApiConfig,
  type ServerModelMetadataInput,
  ServerModelRunGateReason,
  setAuthTokensGetter,
  setServerBaseUrlGetter,
  setStoreGetter,
  updateServerModelMetadata,
} from './libs/claudeSettings';
import { appendClientBannerVersion } from './libs/clientBannerRequest';
import {
  clearCopilotTokenState,
  initCopilotTokenManager,
  refreshCopilotTokenNow,
  setCopilotTokenState,
} from './libs/copilotTokenManager';
import { saveCoworkApiConfig } from './libs/coworkConfigStore';
import { getCoworkLogPath } from './libs/coworkLogger';
import {
  registerProxyTokenRefresher,
  startCoworkOpenAICompatProxy,
  stopCoworkOpenAICompatProxy,
} from './libs/coworkOpenAICompatProxy';
import {
  type CoworkTempJanitor,
  createCoworkTempJanitor,
  ensureCoworkTempGitignore,
  findCoworkTempRoot,
} from './libs/coworkTempJanitor';
import {
  generateSessionTitle,
  getElectronNodeRuntimePath,
  probeCoworkModelReadiness,
} from './libs/coworkUtil';
import {
  assertDataMigrationSqliteSnapshotMatchesLiveSync,
  buildDataMigrationBackupFileName,
  consumeLastRestoreResultSync,
  createMigrationArchive,
  ensureTarGzFileName,
  inspectMigrationArchive,
  performDataMigrationRestoreSync,
  performPendingDataMigrationRestoreSync,
} from './libs/dataMigration/dataMigrationService';
import { DesktopNotificationManager } from './libs/desktopNotificationManager';
import {
  getHtmlSharePublicBaseUrl,
  getKitStoreUrl,
  getPortalTasksUrl,
  getServerApiBaseUrl,
  getSkillStoreUrl,
  refreshEndpointsTestMode,
} from './libs/endpoints';
import {
  mergeEnterpriseOpenclawConfig,
  resolveEnterpriseConfigPath,
  syncEnterpriseConfig,
} from './libs/enterpriseConfigSync';
import {
  createOfficePreviewSession,
  createPreviewSession,
  destroyPreviewSession,
  isPreviewServerUrl,
  stopHtmlPreviewServer,
} from './libs/htmlPreviewServer';
import {
  type ArtifactFileShareSourceType,
  packageArtifactFile,
} from './libs/htmlShare/artifactFileSharePackager';
import {
  deleteHtmlSharePermanently,
  getHtmlShareAnalytics,
  getHtmlShareBySource,
  getHtmlShareQuota,
  getPublishingTrialPolicy,
  updateHtmlShare,
  updateHtmlShareAccessMode,
  updateHtmlShareStatus,
  uploadHtmlShare,
} from './libs/htmlShare/htmlShareClient';
import { packageHtmlFile } from './libs/htmlShare/htmlSharePackager';
import {
  buildArtifactFileClientSourceKey,
  buildArtifactIdentityClientSourceKey,
  buildHtmlShareClientSourceKey,
} from './libs/htmlShare/htmlShareSourceKey';
import { getKeyfromAttribution, initializeKeyfromAttribution } from './libs/keyfromAttribution';
import { LibraryThumbnailRenderer } from './libs/libraryThumbnailRenderer';
import { LibraryThumbnailService } from './libs/libraryThumbnailService';
import { isLikelyBlankThumbnailBitmap } from './libs/libraryThumbnailValidation';
import { exportLogsZip } from './libs/logExport';
import { MainLogReporter } from './libs/mainLogReporter';
import { inferImageMimeTypeFromDataUrl, type PersistedGeneratedImageAsset, persistGeneratedImageAssets, type PersistGeneratedImageAssetsResult, persistGeneratedVideoAssets, type RemoteGeneratedMediaAsset } from './libs/mediaAssetPersistence';
import {
  migrateAgentModelRefs,
  parsePrimaryModelRef,
  resolveQualifiedAgentModelRef,
  resolveServerModelRefForRun,
  ServerModelRefResolutionStatus,
  shouldSyncServerModelConfig,
  syncServerModelConfigIfNeeded,
} from './libs/openclawAgentModels';
import {
  buildManagedSessionKey,
  DEFAULT_MANAGED_AGENT_ID,
  OpenClawChannelSessionSync,
} from './libs/openclawChannelSessionSync';
import {
  CONFIG_DELIVERY_FALLBACK_REASON_PREFIX,
  deliverOpenClawConfigToGateway,
  OpenClawConfigDeliveryMode,
} from './libs/openclawConfigDelivery';
import {
  classifyAppConfigChange,
  classifyCoworkConfigChange,
  classifyImOpenClawConfigChange,
  createStableConfigFingerprint,
  OpenClawConfigImpact,
  OpenClawConfigImpactReason,
  removeImpactDecisionReasons,
} from './libs/openclawConfigImpact';
import { buildProviderSelection, OpenClawConfigSync } from './libs/openclawConfigSync';
import { OpenClawEngineManager, type OpenClawEngineStatus } from './libs/openclawEngineManager';
import {
  backupOpenClawConfig,
  getOpenClawGatewayRepairBusyError,
} from './libs/openclawGatewayRepair';
import {
  getCoworkParentSessionId,
  resolveCoworkSessionIdByOpenClawSessionKey,
} from './libs/openclawLocalSessionResolver';
import {
  addMemoryEntry,
  deleteMemoryEntry,
  ensureDefaultIdentity,
  getMainAgentWorkspacePath,
  migrateSqliteToMemoryMd,
  readBootstrapFile,
  readMemoryEntries,
  readMemoryFileRaw,
  resolveMemoryFilePath,
  searchMemoryEntries,
  updateMemoryEntry,
  writeBootstrapFile,
  writeMemoryFileRaw,
} from './libs/openclawMemoryFile';
import {
  migrateLegacyOpenClawPluginInstalls,
  OpenClawPluginInstallMigrationStatus,
} from './libs/openclawPluginInstallMigration';
import { collectReferencedEnvVarNames, pickReferencedSecretEnvVars } from './libs/openclawSecretEnv';
import {
  getOpenClawTokenProxyPort,
  startOpenClawTokenProxy,
  stopOpenClawTokenProxy,
} from './libs/openclawTokenProxy';
import { migrateMainAgentWorkspace } from './libs/openclawWorkspaceMigration';
import { ensurePythonRuntimeReady } from './libs/pythonRuntime';
import { isAnalyticsEndpointUrl, sanitizeUrlForLog, serializeForLog } from './libs/sanitizeForLog';
import { packageNodeServiceDeployment } from './libs/shareDeployment/nodeServiceDeploymentPackager';
import {
  analyzeNodeServiceProjectDirectory,
  detectNodeServiceProjectCandidates,
} from './libs/shareDeployment/nodeServiceProjectAnalyzer';
import {
  buildNodeDeploymentClientSourceKey,
  buildStaticDeploymentClientSourceKey,
  downloadDeploymentPersistenceArchive,
  getDeploymentPersistence,
  getNodeDeployment,
  getNodeDeploymentByLocalService,
  uploadNodeDeployment,
  uploadStaticDeployment,
} from './libs/shareDeployment/shareDeploymentClient';
import {
  reconcileShareDeploymentAccess,
  type ShareDeploymentAccessSyncFailure,
  ShareDeploymentAccessSyncOperation,
  ShareDeploymentOperationCoordinator,
} from './libs/shareDeployment/shareDeploymentOperationCoordinator';
import { SqliteBackupTrigger } from './libs/sqliteBackup/constants';
import { SqliteBackupManager } from './libs/sqliteBackup/sqliteBackupManager';
import {
  buildServerModelCapabilityHeaders,
  runStartupCacheWarmup,
} from './libs/startupCacheWarmup';
import {
  applySystemProxyEnv,
  resolveSystemProxyUrlForTargets,
  restoreOriginalProxyEnv,
  setSystemProxyEnabled,
} from './libs/systemProxy';
import { getLogFilePath, getRecentMainLogEntries, initLogger } from './logger';
import { type AskUserResponse, McpRuntime } from './mcp/mcpRuntime';
import {
  type AccountBoundValue,
  type AuthExchangeIntentSnapshot,
  type AuthStateSnapshot,
  bindAccountValue,
  canAccessTrackedMediaTask,
  clearMediaTaskOwnerAliasesForOwner,
  createAccountScopedFetch,
  isAuthExchangeIntentCurrent,
  isAuthStateSnapshotCurrent,
  isMediaAccountScopeCurrent,
  isMediaAccountScopeSnapshotCurrent,
  type MediaAccountScope,
  rebindMediaAccountScope,
  rememberMediaTaskOwnerAliases,
  resolveAccountBoundValue,
  shouldRemoveMediaTaskAfterPoll,
} from './mediaAccountIsolation';
import {
  MediaGenerationGateReason,
  MediaGenerationTool,
  type MediaSelectionState,
  resolveMediaGenerationGate,
} from './mediaGenerationPolicy';
import {
  applyMediaReferencesToGenerationParams,
  type MediaAttachmentRefMain,
  MediaGenerationRequestType,
  summarizeMediaGenerationParamsForLog,
} from './mediaGenerationReferences';
import { OpenClawSessionIpc } from './openclawSession/constants';
import { OpenClawSessionPolicyIpc } from './openclawSessionPolicy/constants';
import {
  loadOpenClawSessionPolicyConfig,
  saveOpenClawSessionPolicyConfig,
} from './openclawSessionPolicy/store';
import { registerVoiceInputPermissionHandler } from './permissions/voiceInputPermission';
import { isHiddenUserPluginId } from './plugins/pluginManager';
import { SkillManager } from './skills/skillManager';
import { getSkillServiceManager } from './skills/skillServices';
import {
  notifySkinChanged,
  registerSkinElectronIntegration,
  SKIN_PRIVILEGED_SCHEME,
  SkinRuntimeController,
} from './skins';
import { SqliteStore } from './sqliteStore';
import { StartupProfiler } from './startupProfiler';
import { SubagentMessageStore } from './subagentMessageStore';
import { SubagentRunStore } from './subagentRunStore';
import { createTray, destroyTray, updateTrayMenu, updateTrayReminder } from './trayManager';
import {
  AppWindowStoreKey,
  MIN_APP_WINDOW_HEIGHT,
  MIN_APP_WINDOW_WIDTH,
  resolveInitialAppWindowState,
} from './windowState';
import { createWindowStatePersistManager } from './windowStatePersist';

protocol.registerSchemesAsPrivileged([
  {
    scheme: ArtifactPreviewProtocol.LocalFile,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
  SKIN_PRIVILEGED_SCHEME,
]);

const gwDiagTs = (): string => {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const tz = d.getTimezoneOffset();
  const sign = tz <= 0 ? '+' : '-';
  const abs = Math.abs(tz);
  return `[GW-RESTART-DIAG] ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
};

// Configure the app identity before any OS-level surfaces are created.
app.name = APP_NAME;
app.setName(APP_NAME);
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

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
const MAX_ARTIFACT_SHARE_CONTENT_CHARS = 30 * 1024 * 1024;
const SHARE_DEPLOYMENT_PROJECT_CANDIDATE_MAX_ITEMS = 24;
const SHARE_DEPLOYMENT_CANDIDATE_SOURCES = new Set<string>(
  Object.values(ShareDeploymentCandidateSource),
);
const shareDeploymentOperationCoordinator = new ShareDeploymentOperationCoordinator();
const ENGINE_NOT_READY_CODE = 'ENGINE_NOT_READY';
const LOCAL_WEB_SERVICE_PROBE_TIMEOUT_MS = 700;
const LOCAL_WEB_SERVICE_TITLE_MAX_LENGTH = 80;
const LOCAL_WEB_SERVICE_PORTS = Array.from(
  new Set([
    3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010, 3333, 4000, 4173, 5000, 5173,
    5174, 5175, 5176, 5177, 5178, 5179, 5180, 8000, 8080, 8081, 8888,
  ]),
).sort((a, b) => a - b);
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

interface HtmlShareCreateFromHtmlFileInput {
  sessionId: string;
  artifactId: string;
  filePath: string;
  title: string;
  accessMode?: HtmlShareAccessModeValue;
}

interface HtmlShareUpdateFromHtmlFileInput extends HtmlShareCreateFromHtmlFileInput {
  shareId: string;
  currentStatus?: HtmlShareStatusValue;
}

interface HtmlShareGetByHtmlFileInput {
  filePath: string;
}

interface HtmlShareCreateFromArtifactFileInput {
  sourceType: ArtifactFileShareSourceType;
  sessionId: string;
  artifactId: string;
  title: string;
  accessMode?: HtmlShareAccessModeValue;
  fileName?: string;
  filePath?: string;
  content?: string;
  remoteUrl?: string;
}

interface HtmlShareUpdateFromArtifactFileInput extends HtmlShareCreateFromArtifactFileInput {
  shareId: string;
  currentStatus?: HtmlShareStatusValue;
}

interface HtmlShareGetByArtifactFileInput {
  sourceType: ArtifactFileShareSourceType;
  sessionId?: string;
  artifactId?: string;
  filePath?: string;
}

interface HtmlShareGetBySourceInput {
  sourceType: HtmlShareSourceTypeValue;
  clientSourceKey: string;
}

interface HtmlShareUpdateStatusInput {
  shareId: string;
  status: HtmlShareConfigurableStatus;
}

interface HtmlShareUpdateAccessModeInput {
  shareId: string;
  accessMode: HtmlShareAccessModeValue;
}

function sanitizeHtmlShareAnalyticsInput(input: unknown): HtmlShareAnalyticsInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid HTML share analytics request.');
  }
  const source = input as Record<string, unknown>;
  const from = sanitizeOptionalHtmlShareString(source.from, 'from', 10);
  const to = sanitizeOptionalHtmlShareString(source.to, 'to', 10);
  if (Boolean(from) !== Boolean(to)) {
    throw new Error('from and to must be provided together.');
  }
  for (const [fieldName, value] of [['from', from], ['to', to]] as const) {
    if (!value) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error(`${fieldName} must use YYYY-MM-DD format.`);
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new Error(`${fieldName} must be a valid date.`);
    }
  }
  return {
    shareId: sanitizeHtmlShareString(source.shareId, 'shareId', 64),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
}

interface ShareDeploymentAnalyzeProjectDirectoryInput {
  projectDirectory: string;
  localServiceUrl?: string;
}

function sanitizeHtmlShareString(
  value: unknown,
  fieldName: string,
  maxLength = IPC_STRING_MAX_CHARS,
): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required.`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${fieldName} is too long.`);
  }
  return trimmed;
}

function sanitizeOptionalHtmlShareString(
  value: unknown,
  fieldName: string,
  maxLength = IPC_STRING_MAX_CHARS,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return sanitizeHtmlShareString(value, fieldName, maxLength);
}

function sanitizeOptionalShareDeploymentCommand(
  value: unknown,
  fieldName: string,
  maxLength = 512,
): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new Error(`${fieldName} is too long.`);
  }
  return trimmed;
}

function sanitizeHtmlShareTitle(value: unknown): string {
  return sanitizeHtmlShareString(value, 'title', 255);
}

function sanitizeArtifactFileShareSourceType(value: unknown): ArtifactFileShareSourceType {
  const sourceType = sanitizeHtmlShareString(value, 'sourceType', 32);
  if (
    sourceType !== HtmlShareSourceType.ImageFile &&
    sourceType !== HtmlShareSourceType.SvgFile &&
    sourceType !== HtmlShareSourceType.DocumentFile &&
    sourceType !== HtmlShareSourceType.MarkdownFile &&
    sourceType !== HtmlShareSourceType.MermaidFile
  ) {
    throw new Error('sourceType must be image_file, svg_file, document_file, markdown_file, or mermaid_file.');
  }
  return sourceType;
}

function sanitizeHtmlShareAccessMode(
  value: unknown,
  defaultValue?: HtmlShareAccessModeValue,
): HtmlShareAccessModeValue | undefined {
  if (value === undefined) return defaultValue;
  const accessMode = sanitizeHtmlShareString(value, 'accessMode', 32);
  if (accessMode !== HtmlShareAccessMode.Code && accessMode !== HtmlShareAccessMode.Public) {
    throw new Error('accessMode must be code or public.');
  }
  return accessMode;
}

function sanitizeHtmlShareConfigurableStatus(
  value: unknown,
): HtmlShareConfigurableStatus | undefined {
  if (value === undefined) return undefined;
  const status = sanitizeHtmlShareString(value, 'status', 32);
  if (status !== HtmlShareStatus.Live && status !== HtmlShareStatus.Disabled) {
    throw new Error('status must be live or disabled.');
  }
  return status;
}

function sanitizeHtmlShareStatus(value: unknown): HtmlShareStatusValue | undefined {
  if (value === undefined) return undefined;
  const status = sanitizeHtmlShareString(value, 'currentStatus', 32);
  if (
    status !== HtmlShareStatus.Live &&
    status !== HtmlShareStatus.Disabled &&
    status !== HtmlShareStatus.Failed
  ) {
    throw new Error('currentStatus must be live, disabled, or failed.');
  }
  return status;
}

function sanitizeCreateFromHtmlFileInput(input: unknown): HtmlShareCreateFromHtmlFileInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid HTML share request.');
  }
  const source = input as Record<string, unknown>;
  return {
    sessionId: sanitizeHtmlShareString(source.sessionId, 'sessionId', 128),
    artifactId: sanitizeHtmlShareString(source.artifactId, 'artifactId', 128),
    filePath: sanitizeHtmlShareString(source.filePath, 'filePath', 4096),
    title: sanitizeHtmlShareTitle(source.title),
    accessMode: sanitizeHtmlShareAccessMode(source.accessMode, HtmlShareAccessMode.Code),
  };
}

function sanitizeUpdateFromHtmlFileInput(input: unknown): HtmlShareUpdateFromHtmlFileInput {
  const source = sanitizeCreateFromHtmlFileInput(input);
  const record = input as Record<string, unknown>;
  return {
    ...source,
    shareId: sanitizeHtmlShareString(record.shareId, 'shareId', 64),
    currentStatus: sanitizeHtmlShareStatus(record.currentStatus),
    accessMode: sanitizeHtmlShareAccessMode(record.accessMode),
  };
}

function sanitizeGetByHtmlFileInput(input: unknown): HtmlShareGetByHtmlFileInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid HTML share lookup request.');
  }
  const source = input as Record<string, unknown>;
  return {
    filePath: sanitizeHtmlShareString(source.filePath, 'filePath', 4096),
  };
}

function sanitizeCreateFromArtifactFileInput(input: unknown): HtmlShareCreateFromArtifactFileInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid artifact share request.');
  }
  const source = input as Record<string, unknown>;
  const options: HtmlShareCreateFromArtifactFileInput = {
    sourceType: sanitizeArtifactFileShareSourceType(source.sourceType),
    sessionId: sanitizeHtmlShareString(source.sessionId, 'sessionId', 128),
    artifactId: sanitizeHtmlShareString(source.artifactId, 'artifactId', 128),
    title: sanitizeHtmlShareTitle(source.title),
    accessMode: sanitizeHtmlShareAccessMode(source.accessMode, HtmlShareAccessMode.Code),
    fileName: sanitizeOptionalHtmlShareString(source.fileName, 'fileName', 255),
    filePath: sanitizeOptionalHtmlShareString(source.filePath, 'filePath', 4096),
    content: sanitizeOptionalHtmlShareString(
      source.content,
      'content',
      MAX_ARTIFACT_SHARE_CONTENT_CHARS,
    ),
    remoteUrl: sanitizeOptionalHtmlShareString(source.remoteUrl, 'remoteUrl', 4096),
  };
  if (!options.filePath && !options.content && !options.remoteUrl) {
    throw new Error('Artifact share source is required.');
  }
  return options;
}

function sanitizeUpdateFromArtifactFileInput(
  input: unknown,
): HtmlShareUpdateFromArtifactFileInput {
  const source = sanitizeCreateFromArtifactFileInput(input);
  const record = input as Record<string, unknown>;
  return {
    ...source,
    shareId: sanitizeHtmlShareString(record.shareId, 'shareId', 64),
    currentStatus: sanitizeHtmlShareStatus(record.currentStatus),
    accessMode: sanitizeHtmlShareAccessMode(record.accessMode),
  };
}

function sanitizeGetByArtifactFileInput(input: unknown): HtmlShareGetByArtifactFileInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid artifact share lookup request.');
  }
  const source = input as Record<string, unknown>;
  const options: HtmlShareGetByArtifactFileInput = {
    sourceType: sanitizeArtifactFileShareSourceType(source.sourceType),
    sessionId: sanitizeOptionalHtmlShareString(source.sessionId, 'sessionId', 128),
    artifactId: sanitizeOptionalHtmlShareString(source.artifactId, 'artifactId', 128),
    filePath: sanitizeOptionalHtmlShareString(source.filePath, 'filePath', 4096),
  };
  if (!options.filePath && (!options.sessionId || !options.artifactId)) {
    throw new Error('Artifact share lookup source is required.');
  }
  return options;
}

function sanitizeGetHtmlShareBySourceInput(input: unknown): HtmlShareGetBySourceInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid HTML share source lookup request.');
  }
  const source = input as Record<string, unknown>;
  const sourceType = sanitizeHtmlShareString(source.sourceType, 'sourceType', 32);
  if (!Object.values(HtmlShareSourceType).includes(sourceType as HtmlShareSourceTypeValue)) {
    throw new Error('Invalid HTML share source type.');
  }
  return {
    sourceType: sourceType as HtmlShareSourceTypeValue,
    clientSourceKey: sanitizeHtmlShareString(
      source.clientSourceKey,
      'clientSourceKey',
      128,
    ),
  };
}

function sanitizeUpdateHtmlShareStatusInput(input: unknown): HtmlShareUpdateStatusInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid HTML share status request.');
  }
  const source = input as Record<string, unknown>;
  const status = sanitizeHtmlShareConfigurableStatus(source.status);
  if (!status) {
    throw new Error('status is required.');
  }
  return {
    shareId: sanitizeHtmlShareString(source.shareId, 'shareId', 64),
    status,
  };
}

function sanitizeUpdateHtmlShareAccessModeInput(input: unknown): HtmlShareUpdateAccessModeInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid HTML share access mode request.');
  }
  const source = input as Record<string, unknown>;
  const accessMode = sanitizeHtmlShareAccessMode(source.accessMode);
  if (!accessMode) {
    throw new Error('accessMode is required.');
  }
  return {
    shareId: sanitizeHtmlShareString(source.shareId, 'shareId', 64),
    accessMode,
  };
}

function sanitizeOptionalShareDeploymentCandidateText(
  value: unknown,
  fieldName: string,
  maxLength = 1024,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) {
    throw new Error(`${fieldName} is too long.`);
  }
  return trimmed;
}

function sanitizeShareDeploymentCandidateSource(
  value: unknown,
): ShareDeploymentProjectCandidate['source'] | null {
  if (typeof value !== 'string') return null;
  return SHARE_DEPLOYMENT_CANDIDATE_SOURCES.has(value)
    ? value as ShareDeploymentProjectCandidate['source']
    : null;
}

function sanitizeShareDeploymentCandidateConfidence(value: unknown): number {
  const confidence = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(confidence)) return 0;
  return Math.max(0, Math.min(100, Math.round(confidence)));
}

function sanitizeOptionalShareDeploymentCandidateInteger(
  value: unknown,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(numberValue) && numberValue >= 0 ? numberValue : undefined;
}

function sanitizeShareDeploymentProjectCandidate(
  value: unknown,
  index: number,
): ShareDeploymentProjectCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const directory = sanitizeOptionalShareDeploymentCandidateText(
    source.directory,
    `projectCandidates[${index}].directory`,
    4096,
  );
  if (!directory) return null;
  const candidateSource = sanitizeShareDeploymentCandidateSource(source.source);
  if (!candidateSource) return null;
  const reason = sanitizeOptionalShareDeploymentCandidateText(
    source.reason,
    `projectCandidates[${index}].reason`,
  );
  const evidence = sanitizeOptionalShareDeploymentCandidateText(
    source.evidence,
    `projectCandidates[${index}].evidence`,
    2048,
  );
  const messageId = sanitizeOptionalShareDeploymentCandidateText(
    source.messageId,
    `projectCandidates[${index}].messageId`,
    128,
  );
  const artifactId = sanitizeOptionalShareDeploymentCandidateText(
    source.artifactId,
    `projectCandidates[${index}].artifactId`,
    128,
  );
  const pid = sanitizeOptionalShareDeploymentCandidateInteger(source.pid);
  const detectedAt = sanitizeOptionalShareDeploymentCandidateInteger(source.detectedAt);
  return {
    directory,
    source: candidateSource,
    confidence: sanitizeShareDeploymentCandidateConfidence(source.confidence),
    ...(reason ? { reason } : {}),
    ...(evidence ? { evidence } : {}),
    ...(messageId ? { messageId } : {}),
    ...(artifactId ? { artifactId } : {}),
    ...(pid !== undefined ? { pid } : {}),
    ...(detectedAt !== undefined ? { detectedAt } : {}),
  };
}

function sanitizeShareDeploymentProjectCandidates(value: unknown): ShareDeploymentProjectCandidate[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error('projectCandidates must be an array.');
  }
  return value
    .slice(0, SHARE_DEPLOYMENT_PROJECT_CANDIDATE_MAX_ITEMS)
    .map((candidate, index) => sanitizeShareDeploymentProjectCandidate(candidate, index))
    .filter((candidate): candidate is ShareDeploymentProjectCandidate => Boolean(candidate));
}

function sanitizeShareDeploymentDetectProjectCandidatesInput(
  input: unknown,
): ShareDeploymentDetectCandidatesInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid deployment project detection request.');
  }
  const source = input as Record<string, unknown>;
  return {
    localServiceUrl: sanitizeHtmlShareString(source.localServiceUrl, 'localServiceUrl', 2048),
    workingDirectory: sanitizeOptionalHtmlShareString(source.workingDirectory, 'workingDirectory', 4096),
    projectCandidates: sanitizeShareDeploymentProjectCandidates(source.projectCandidates),
    cachedProjectDirectory: sanitizeOptionalHtmlShareString(
      source.cachedProjectDirectory,
      'cachedProjectDirectory',
      4096,
    ),
  };
}

function sanitizeShareDeploymentAnalyzeProjectDirectoryInput(
  input: unknown,
): ShareDeploymentAnalyzeProjectDirectoryInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid deployment project analysis request.');
  }
  const source = input as Record<string, unknown>;
  return {
    projectDirectory: sanitizeHtmlShareString(source.projectDirectory, 'projectDirectory', 4096),
    localServiceUrl: sanitizeOptionalHtmlShareString(source.localServiceUrl, 'localServiceUrl', 2048),
  };
}

function sanitizeShareDeploymentPersistenceBinding(value: unknown): ShareDeploymentPersistence['bindings'][number] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const appPath = sanitizeOptionalHtmlShareString(source.appPath, 'appPath', 256);
  const dataPath = sanitizeOptionalHtmlShareString(source.dataPath, 'dataPath', 256);
  if (!appPath || !dataPath) return null;
  const kind = source.kind === ShareDeploymentPersistenceBindingKind.Directory
    ? ShareDeploymentPersistenceBindingKind.Directory
    : ShareDeploymentPersistenceBindingKind.File;
  const sizeBytes = typeof source.sizeBytes === 'number'
    ? Math.max(0, Math.round(source.sizeBytes))
    : undefined;
  return {
    appPath,
    dataPath,
    kind,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
  };
}

function sanitizeShareDeploymentPersistence(value: unknown): ShareDeploymentPersistence | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid service data settings.');
  }
  const source = value as Record<string, unknown>;
  const bindings = Array.isArray(source.bindings)
    ? source.bindings
        .slice(0, 8)
        .map(sanitizeShareDeploymentPersistenceBinding)
        .filter((binding): binding is ShareDeploymentPersistence['bindings'][number] => Boolean(binding))
    : [];
  return {
    enabled: Boolean(source.enabled) && bindings.length > 0,
    provider: ShareDeploymentPersistenceProvider.Filesystem,
    mountPath: sanitizeOptionalHtmlShareString(source.mountPath, 'mountPath', 256),
    quotaBytes: typeof source.quotaBytes === 'number' && source.quotaBytes > 0
      ? Math.round(source.quotaBytes)
      : undefined,
    bindings,
  };
}

function sanitizeShareDeploymentPort(value: unknown): number {
  const port = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('port must be a valid TCP port.');
  }
  return port;
}

function sanitizeShareDeploymentPersistenceUpdateMode(
  value: unknown,
): ShareDeploymentPersistenceUpdateMode {
  if (value === undefined || value === ShareDeploymentPersistenceUpdateMode.Preserve) {
    return ShareDeploymentPersistenceUpdateMode.Preserve;
  }
  if (value === ShareDeploymentPersistenceUpdateMode.Replace) {
    return ShareDeploymentPersistenceUpdateMode.Replace;
  }
  throw new Error('persistenceUpdateMode must be preserve or replace.');
}

function formatShareDeploymentAccessSyncError(
  failures: ShareDeploymentAccessSyncFailure[],
): string | undefined {
  if (failures.length === 0) return undefined;
  const message = failures
    .map(failure => failure.error || (
      failure.operation === ShareDeploymentAccessSyncOperation.AccessMode
        ? t('htmlShareAccessModeUpdateFailed')
        : t('htmlShareStatusUpdateFailed')
    ))
    .join('; ');
  return t('nodeDeploymentAccessStatusApplyFailed', { message });
}

function sanitizeShareDeploymentCreateNodeInput(input: unknown): ShareDeploymentCreateNodeInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid node deployment request.');
  }
  const source = input as Record<string, unknown>;
  return {
    sessionId: sanitizeHtmlShareString(source.sessionId, 'sessionId', 128),
    artifactId: sanitizeHtmlShareString(source.artifactId, 'artifactId', 128),
    title: sanitizeHtmlShareTitle(source.title),
    localServiceUrl: sanitizeHtmlShareString(source.localServiceUrl, 'localServiceUrl', 2048),
    projectDirectory: sanitizeHtmlShareString(source.projectDirectory, 'projectDirectory', 4096),
    accessMode: sanitizeHtmlShareAccessMode(source.accessMode, HtmlShareAccessMode.Code),
    previousAccessMode: sanitizeHtmlShareAccessMode(source.previousAccessMode),
    nodeVersion: sanitizeHtmlShareString(source.nodeVersion, 'nodeVersion', 32),
    installCommand: sanitizeOptionalShareDeploymentCommand(source.installCommand, 'installCommand'),
    buildCommand: sanitizeOptionalShareDeploymentCommand(source.buildCommand, 'buildCommand'),
    startCommand: sanitizeOptionalShareDeploymentCommand(source.startCommand, 'startCommand'),
    port: sanitizeShareDeploymentPort(source.port),
    persistence: sanitizeShareDeploymentPersistence(source.persistence),
    persistenceUpdateMode: sanitizeShareDeploymentPersistenceUpdateMode(
      source.persistenceUpdateMode,
    ),
    targetShareStatus:
      sanitizeHtmlShareConfigurableStatus(source.targetShareStatus) ?? HtmlShareStatus.Live,
    quotaReservationId: sanitizeOptionalHtmlShareString(
      source.quotaReservationId,
      'quotaReservationId',
      64,
    ),
  };
}

function sanitizeShareDeploymentGetByLocalServiceInput(
  input: unknown,
): ShareDeploymentGetByLocalServiceInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid deployment lookup request.');
  }
  const source = input as Record<string, unknown>;
  return {
    sessionId: sanitizeHtmlShareString(source.sessionId, 'sessionId', 128),
    localServiceUrl: sanitizeHtmlShareString(source.localServiceUrl, 'localServiceUrl', 2048),
    projectDirectory: sanitizeOptionalHtmlShareString(source.projectDirectory, 'projectDirectory', 4096),
  };
}

function sanitizeShareDeploymentSelectPersistencePathInput(
  input: unknown,
): ShareDeploymentSelectPersistencePathInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid service data path selection request.');
  }
  const source = input as Record<string, unknown>;
  if (
    source.kind !== ShareDeploymentPersistenceBindingKind.Directory &&
    source.kind !== ShareDeploymentPersistenceBindingKind.File
  ) {
    throw new Error('Invalid service data path kind.');
  }
  return {
    projectDirectory: sanitizeHtmlShareString(source.projectDirectory, 'projectDirectory', 4096),
    kind: source.kind,
  };
}

function sanitizeShareDeploymentPersistenceDeploymentIdInput(value: unknown): string {
  return sanitizeHtmlShareString(value, 'deploymentId', 128);
}

function sanitizeShareDeploymentDownloadPersistenceInput(
  input: unknown,
): ShareDeploymentDownloadPersistenceInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid service data download request.');
  }
  const source = input as Record<string, unknown>;
  return {
    deploymentId: sanitizeShareDeploymentPersistenceDeploymentIdInput(source.deploymentId),
    projectDirectory: sanitizeOptionalHtmlShareString(source.projectDirectory, 'projectDirectory', 4096),
    shareId: sanitizeOptionalHtmlShareString(source.shareId, 'shareId', 128),
  };
}

const SHARE_DEPLOYMENT_PERSISTENCE_EXCLUDED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.output',
]);

function isSensitiveShareDeploymentPersistenceFileName(fileName: string): boolean {
  const normalized = fileName.trim().toLowerCase();
  return normalized === '.env' ||
    normalized.startsWith('.env.') ||
    /(?:^|[-_.])(secret|credential|credentials|token|private[-_.]?key)(?:[-_.]|$)/i.test(fileName);
}

async function estimateShareDeploymentPersistencePathBytes(filePath: string): Promise<number | undefined> {
  const maxVisited = 2000;
  let visited = 0;
  let total = 0;
  async function visit(currentPath: string): Promise<void> {
    if (visited >= maxVisited) return;
    visited += 1;
    const stats = await fs.promises.lstat(currentPath);
    if (stats.isSymbolicLink()) return;
    if (stats.isFile()) {
      total += stats.size;
      return;
    }
    if (!stats.isDirectory()) return;
    const entries = await fs.promises.readdir(currentPath);
    await Promise.all(entries.map(entry => visit(path.join(currentPath, entry))));
  }
  try {
    await visit(filePath);
    return total;
  } catch {
    return undefined;
  }
}

async function buildShareDeploymentPersistenceBindingFromPath(
  projectDirectory: string,
  selectedPath: string,
): Promise<ShareDeploymentPersistence['bindings'][number]> {
  const projectRoot = await fs.promises.realpath(projectDirectory);
  const targetPath = await fs.promises.realpath(selectedPath);
  const relativePath = path.relative(projectRoot, targetPath).replace(/\\/g, '/');
  if (
    !relativePath ||
    relativePath === '.' ||
    relativePath.startsWith('../') ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error('Selected service data must be inside the project directory.');
  }
  const segments = relativePath.split('/').filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some(segment => SHARE_DEPLOYMENT_PERSISTENCE_EXCLUDED_SEGMENTS.has(segment)) ||
    segments.some(segment => segment === '..' || segment.startsWith('.env'))
  ) {
    throw new Error('Selected service data path is not supported.');
  }
  const stats = await fs.promises.lstat(targetPath);
  if (stats.isSymbolicLink()) {
    throw new Error('Symbolic links cannot be used as service data.');
  }
  const kind = stats.isDirectory()
    ? ShareDeploymentPersistenceBindingKind.Directory
    : stats.isFile()
      ? ShareDeploymentPersistenceBindingKind.File
      : null;
  if (!kind) {
    throw new Error('Selected service data must be a file or directory.');
  }
  if (
    kind === ShareDeploymentPersistenceBindingKind.File &&
    isSensitiveShareDeploymentPersistenceFileName(path.basename(targetPath))
  ) {
    throw new Error('Selected service data path is not supported.');
  }
  const sizeBytes = await estimateShareDeploymentPersistencePathBytes(targetPath);
  return {
    appPath: relativePath,
    dataPath: relativePath,
    kind,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
  };
}

function sanitizeShellGetBrowserAppsInput(input: unknown): ShellGetBrowserAppsInput {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid browser app lookup request.');
  }
  const source = input as Record<string, unknown>;
  return {
    projectDirectory: sanitizeOptionalHtmlShareString(source.projectDirectory, 'projectDirectory', 4096),
  };
}

function buildArtifactShareClientSourceKey(options: HtmlShareGetByArtifactFileInput): string {
  if (options.filePath) {
    return buildArtifactFileClientSourceKey(options.sourceType, options.filePath);
  }
  if (!options.sessionId || !options.artifactId) {
    throw new Error('Artifact share source key is missing.');
  }
  return buildArtifactIdentityClientSourceKey(
    options.sourceType,
    options.sessionId,
    options.artifactId,
  );
}

const cleanHtmlTitle = (value: string): string =>
  value.replace(/\s+/g, ' ').trim().slice(0, LOCAL_WEB_SERVICE_TITLE_MAX_LENGTH);

const extractHtmlTitle = (html: string): string => {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return '';
  return cleanHtmlTitle(
    match[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
};

const probeLocalWebService = async (port: number): Promise<LocalWebService | null> => {
  const url = `http://localhost:${port}/`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCAL_WEB_SERVICE_PROBE_TIMEOUT_MS);

  try {
    const response = await session.defaultSession.fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('text/html')) {
      return null;
    }

    const html = await response.text();
    const title = extractHtmlTitle(html) || `localhost:${port}`;
    return {
      id: `localhost:${port}`,
      title,
      url,
      host: 'localhost',
      port,
      online: true,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

const sanitizeLocalWebServicePorts = (ports: unknown): number[] => {
  if (!Array.isArray(ports)) return [];
  return Array.from(
    new Set(
      ports
        .filter((port): port is number => Number.isInteger(port) && port > 0 && port <= 65535)
        .slice(0, IPC_MAX_ITEMS),
    ),
  );
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
  if (thinkingLevel !== undefined) {
    if (thinkingLevel !== null && thinkingLevel !== '' && !parseModelThinkingLevel(thinkingLevel)) {
      throw new Error('Unsupported session thinking level.');
    }
    patch.thinkingLevel = thinkingLevel;
  }

  const reasoningLevel = sanitizeOptionalPatchValue(source.reasoningLevel);
  if (reasoningLevel !== undefined) patch.reasoningLevel = reasoningLevel;

  const elevatedLevel = sanitizeOptionalPatchValue(source.elevatedLevel);
  if (elevatedLevel !== undefined) patch.elevatedLevel = elevatedLevel;

  const responseUsage = sanitizeOptionalPatchValue(source.responseUsage);
  if (responseUsage !== undefined)
    patch.responseUsage = responseUsage as OpenClawSessionPatch['responseUsage'];

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
      if (
        !providerMap[selection.providerId].models.some(
          entry => entry.id === selection.sessionModelId,
        )
      ) {
        providerMap[selection.providerId].models.push({ id: selection.sessionModelId });
      }
    }
  }

  const serverModelIds = getAllServerModelMetadata()
    .map(model => model.modelId.trim())
    .filter(Boolean);
  if (serverModelIds.length > 0) {
    const serverProvider = providerMap[OpenClawProviderId.LobsteraiServer]
      ?? { models: [] };
    for (const modelId of serverModelIds) {
      if (!serverProvider.models.some(model => model.id === modelId)) {
        serverProvider.models.push({ id: modelId });
      }
    }
    providerMap[OpenClawProviderId.LobsteraiServer] = serverProvider;
  }

  return providerMap;
};

const openClawConfigHasServerModels = (modelIds: string[]): boolean => {
  const normalizedModelIds = modelIds.map(modelId => modelId.trim()).filter(Boolean);
  if (normalizedModelIds.length === 0) return true;

  try {
    const configPath = getOpenClawEngineManager().getConfigPath();
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      models?: {
        providers?: Record<string, { models?: Array<{ id?: string }> }>;
      };
    };
    const serverProviderModels = parsed.models?.providers?.[OpenClawProviderId.LobsteraiServer]?.models;
    if (!Array.isArray(serverProviderModels)) return false;

    const configuredModelIds = new Set(
      serverProviderModels
        .map(model => (typeof model.id === 'string' ? model.id.trim() : ''))
        .filter(Boolean),
    );
    return normalizedModelIds.every(modelId => configuredModelIds.has(modelId));
  } catch (error) {
    console.debug('[Auth:getModels] OpenClaw config inspection failed; scheduling model sync.', error);
    return false;
  }
};

const normalizeOpenClawModelRef = (modelRef: string): string => {
  const normalized = modelRef.trim();
  if (!normalized) return normalized;

  const qualification = resolveQualifiedAgentModelRef({
    agentModel: normalized,
    availableProviders: buildAvailableOpenClawProviders(),
  });

  return qualification.status === 'qualified' ? qualification.primaryModel : normalized;
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
      return path.join(resolved, COWORK_TEMP_DIR_NAME, COWORK_TEMP_ATTACHMENTS_DIR_NAME, 'manual');
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

  return fs
    .readdirSync(logDir)
    .filter(f => OPENCLAW_DAILY_LOG_RE.test(f))
    .map(f => ({ archiveName: f, filePath: path.join(logDir, f) }))
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
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'undefined'
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
    const result = value
      .slice(0, IPC_MAX_ITEMS)
      .map(entry => sanitizeIpcPayload(entry, depth + 1, localSeen));
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

  // Preserve image metadata as-is; previews are already size-bounded, while
  // legacy imageAttachments may contain historical base64 payloads.
  // Browser annotations nest deeper than IPC_MAX_DEPTH (screenshot/anchor sit
  // at depth 5), so re-normalize them instead of generic depth truncation;
  // normalizeBrowserAnnotationBatches enforces its own count/length bounds.
  let sanitizedMetadata: unknown;
  if (messageRecord.metadata && typeof messageRecord.metadata === 'object') {
    const {
      imageAttachments,
      imageAttachmentPreviews,
      browserAnnotations,
      ...rest
    } = messageRecord.metadata as Record<string, unknown>;
    const sanitizedRest = sanitizeIpcPayload(rest) as Record<string, unknown> | undefined;
    const sanitizedBrowserAnnotations = Array.isArray(browserAnnotations) && browserAnnotations.length > 0
      ? normalizeBrowserAnnotationBatches(browserAnnotations)
      : [];
    sanitizedMetadata = {
      ...(sanitizedRest && typeof sanitizedRest === 'object' ? sanitizedRest : {}),
      ...(Array.isArray(imageAttachments) && imageAttachments.length > 0
        ? { imageAttachments }
        : {}),
      ...(Array.isArray(imageAttachmentPreviews) && imageAttachmentPreviews.length > 0
        ? { imageAttachmentPreviews }
        : {}),
      ...(sanitizedBrowserAnnotations.length > 0
        ? { browserAnnotations: sanitizedBrowserAnnotations }
        : {}),
    };
  } else {
    sanitizedMetadata = undefined;
  }

  return {
    ...message,
    content:
      typeof messageRecord.content === 'string'
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
    throw new Error(
      `Cannot use a drive root as the working directory (${resolvedWorkspaceRoot}). Please select a subfolder instead, for example: ${resolvedWorkspaceRoot}Projects`,
    );
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
  const normalized =
    typeof defaultFileName === 'string' && defaultFileName.trim()
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
  // Automation hook: end-to-end tests cannot drive the native save dialog, so
  // an explicit directory override saves the PNG directly.
  const autosaveDir = process.env.LOBSTERAI_EXPORT_IMAGE_AUTOSAVE_DIR;
  if (autosaveDir) {
    const outputPath = ensurePngFileName(path.join(autosaveDir, defaultName));
    await fs.promises.mkdir(autosaveDir, { recursive: true });
    await fs.promises.writeFile(outputPath, pngData);
    return { success: true, canceled: false, path: outputPath };
  }
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
let startupDataMigrationRestoreResult: DataMigrationLastRestoreResult | null = null;
try {
  startupDataMigrationRestoreResult = performPendingDataMigrationRestoreSync({
    userDataPath: app.getPath('userData'),
    rollbackRootPath: path.join(app.getPath('appData'), `${APP_NAME}-migration-rollbacks`),
  });
} catch (error) {
  console.error('[DataMigration] pending restore failed before logger initialization:', error);
}
initLogger();
if (startupDataMigrationRestoreResult) {
  const status = startupDataMigrationRestoreResult.status;
  console.log(`[DataMigration] pending restore finished with status ${status}`);
}

const isDev = process.env.NODE_ENV === 'development';
const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const DEV_SERVER_URL = process.env.ELECTRON_START_URL || 'http://localhost:5175';
const enableVerboseLogging =
  process.env.ELECTRON_ENABLE_LOGGING === '1' || process.env.ELECTRON_ENABLE_LOGGING === 'true';
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
  const trimmed = inputPath.trim();
  if (!trimmed) return inputPath;

  let normalized = trimmed;
  if (/^(?:file|localfile):\/\//i.test(normalized)) {
    normalized = safeDecodeURIComponent(normalized.replace(/^(?:file|localfile):\/\//i, ''));
  }

  if (!isWindows) {
    return normalized;
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
    secureDnsMode: 'off',
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
process.on('uncaughtException', error => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', error => {
  console.error('Unhandled Rejection:', error);
});

process.on('exit', code => {
  console.log(`[Main] Process exiting with code: ${code}`);
});

let store: SqliteStore | null = null;
let coworkStore: CoworkStore | null = null;
let openClawRuntimeAdapter: OpenClawRuntimeAdapter | null = null;
let coworkEngineRouter: CoworkEngineRouter | null = null;
let skillManager: SkillManager | null = null;
let mcpRuntime: McpRuntime | null = null;
let skinRuntimeController: SkinRuntimeController | null = null;
let imGatewayManager: IMGatewayManager | null = null;
let storeInitPromise: Promise<SqliteStore> | null = null;
let sqliteBackupManager: SqliteBackupManager | null = null;
let openClawEngineManager: OpenClawEngineManager | null = null;
let openClawConfigSync: OpenClawConfigSync | null = null;
let openClawBootstrapPromise: Promise<OpenClawEngineStatus> | null = null;
let cachedSubscriptionStatus: string = AuthSubscriptionStatus.Free;
let cachedMediaGenerationEntitled = false;
let openClawStatusForwarderBound = false;
let coworkRuntimeForwarderBound = false;
let memoryMigrationDone = false;
let preventSleepBlockerId: number | null = null;
let appUpdateCoordinator: AppUpdateCoordinator | null = null;
let mainLogReporter: MainLogReporter | null = null;
let libraryIndexService: LibraryIndexService | null = null;

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
        setTimeout(() => reject(new Error('Store initialization timed out after 15s')), 15_000),
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

const formatAutoLaunchStatusForLog = (status: AutoLaunchStatus): string => {
  const launchItems = status.launchItems
    ?.map(item => `${item.name}:${item.enabled ? 'enabled' : 'disabled'}:${item.args.join(' ') || '(no-args)'}`)
    .join(',');

  return [
    `status=${status.status ?? 'unknown'}`,
    `openAtLogin=${status.openAtLogin}`,
    `executableWillLaunchAtLogin=${status.executableWillLaunchAtLogin ?? 'unknown'}`,
    launchItems ? `launchItems=${launchItems}` : null,
  ].filter(Boolean).join(', ');
};

const getAppUpdateCoordinator = (): AppUpdateCoordinator => {
  if (!appUpdateCoordinator) {
    appUpdateCoordinator = new AppUpdateCoordinator(getStore());
  }
  return appUpdateCoordinator;
};

const getMainLogReporter = (): MainLogReporter => {
  if (!mainLogReporter) {
    mainLogReporter = new MainLogReporter({
      appVersion: app.getVersion(),
      fetch: async (url, signal) => {
        const response = await session.defaultSession.fetch(url, { method: 'GET', signal });
        const result = { ok: response.ok, status: response.status };
        await response.body?.cancel();
        return result;
      },
      store: getStore(),
    });
  }
  return mainLogReporter;
};

const forwardOpenClawStatus = (status: OpenClawEngineStatus): void => {
  const windows = BrowserWindow.getAllWindows();
  windows.forEach(win => {
    if (win.isDestroyed()) return;
    try {
      win.webContents.send(OpenClawEngineIpc.OnProgress, status);
    } catch (error) {
      console.error('Failed to forward OpenClaw engine status:', error);
    }
  });
};

const bindOpenClawStatusForwarder = (): void => {
  if (openClawStatusForwarderBound) return;
  const manager = getOpenClawEngineManager();
  manager.on('status', status => {
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

const bootstrapOpenClawEngine = async (
  options: { forceReinstall?: boolean; reason?: string } = {},
) => {
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

      // Start AskUser HTTP server before config sync
      await startAskUserServer().catch((err: unknown) => {
        console.error(`[OpenClaw] bootstrap: AskUser server startup failed (non-fatal):`, err);
      });
      console.log(
        `[OpenClaw] bootstrap: AskUser server setup done (${elapsed()}), askUserUrl=${getMcpRuntime().getAskUserCallbackUrl() || 'null'}`,
      );

      // Ensure IDENTITY.md has default content in the main agent workspace
      try {
        ensureDefaultIdentity(getMainAgentWorkspacePath(manager.getStateDir()));
      } catch (err) {
        console.warn('[OpenClaw] bootstrap: ensureDefaultIdentity failed (non-fatal):', err);
      }

      const syncResult = await syncOpenClawConfig({
        reason: `bootstrap:${reason}`,
        restartGatewayIfRunning: false,
      });
      console.log(
        `[OpenClaw] bootstrap: syncOpenClawConfig done (${elapsed()}), success=${syncResult.success}`,
      );
      if (!syncResult.success) {
        return syncResult.status || manager.getStatus();
      }
      if (options.forceReinstall) {
        console.log(
          `${gwDiagTs()} bootstrap: forceReinstall requested, stopping gateway before reinstall`,
        );
        await manager.stopGateway();
        console.log(`[OpenClaw] bootstrap: stopGateway done (${elapsed()})`);
      }
      const ensuredStatus = await manager.ensureReady();
      console.log(
        `[OpenClaw] bootstrap: ensureReady done (${elapsed()}), phase=${ensuredStatus.phase}`,
      );
      if (ensuredStatus.phase !== 'ready' && ensuredStatus.phase !== 'running') {
        return ensuredStatus;
      }
      const result = await manager.startGateway(`bootstrap:${reason}`);
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

// Injected after the auth session manager is created. This keeps gateway startup
// able to await an in-flight refresh without exposing refresh internals globally.
let waitForPendingTokenRefresh: () => Promise<void> = async () => {};

const ensureOpenClawRunningForCowork = async () => {
  const configApplyStatus = await waitForOpenClawConfigApply('cowork engine startup');
  if (configApplyStatus) {
    return configApplyStatus;
  }

  const manager = getOpenClawEngineManager();
  const status = manager.getStatus();
  if (status.phase === 'running') {
    // Token proxy handles dynamic token injection — no need to restart
    // the gateway for token changes. Just wait for any in-flight refresh.
    await waitForPendingTokenRefresh();
    return manager.getStatus();
  }
  if (status.phase === 'starting') {
    return status;
  }

  // Wait for any in-flight token refresh so that the gateway starts with
  // a fresh token rather than the stale one that triggered the refresh.
  await waitForPendingTokenRefresh();

  // Ensure AskUser server is started and config is synced before launching the gateway,
  // so that mcp.servers config is available in openclaw.json when the gateway loads.
  await startAskUserServer().catch((err: unknown) => {
    console.error('[OpenClaw] ensureRunning: AskUser server startup failed (non-fatal):', err);
  });
  const syncResult = await syncOpenClawConfig({
    reason: 'ensureRunning:mcpConfig',
    restartGatewayIfRunning: false,
  });
  if (!syncResult.success) {
    console.error('[OpenClaw] ensureRunning: config sync failed:', syncResult.error);
  }

  console.log(`${gwDiagTs()} ensureRunning: gateway not running (phase=${status.phase}), starting`);
  return await manager.startGateway('ensure-running-for-cowork');
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

const resolveAgentDefaultWorkingDirectory = (agentId?: string): string => {
  const resolvedAgentId = agentId?.trim() || 'main';
  const agentWorkingDirectory = getAgentManager()
    .getAgent(resolvedAgentId)
    ?.workingDirectory?.trim();
  if (agentWorkingDirectory) return agentWorkingDirectory;
  return getCoworkStore().getConfig().workingDirectory.trim();
};

const resolveSessionWorkingDirectory = (options: { cwd?: string; agentId?: string }): string => {
  const explicitWorkingDirectory = options.cwd?.trim();
  if (explicitWorkingDirectory) return explicitWorkingDirectory;
  return resolveAgentDefaultWorkingDirectory(options.agentId);
};

const isLobsteraiServerModelRef = (modelRef: string): boolean => {
  const normalized = modelRef.trim();
  if (!normalized) return false;

  const parsed = parsePrimaryModelRef(normalized);
  if (parsed) {
    return parsed.providerId === ProviderName.LobsteraiServer;
  }

  return getAllServerModelMetadata().some(model => model.modelId === normalized);
};

const shouldRefreshServerQuotaForSession = (sessionId: string): boolean => {
  const session = getCoworkStore().getSession(sessionId);
  const sessionModelRef = session?.modelOverride?.trim();
  if (sessionModelRef) {
    return isLobsteraiServerModelRef(sessionModelRef);
  }

  const agentModelRef = session?.agentId
    ? getAgentManager().getAgent(session.agentId)?.model?.trim()
    : '';
  if (agentModelRef) {
    return isLobsteraiServerModelRef(agentModelRef);
  }

  const apiConfig = resolveCurrentApiConfig();
  return apiConfig.providerMetadata?.providerName === ProviderName.LobsteraiServer;
};

const resolveCoworkAgentEngine = (): CoworkAgentEngine => {
  return 'openclaw';
};

const getOpenClawConfigSync = (): OpenClawConfigSync => {
  if (!openClawConfigSync) {
    openClawConfigSync = new OpenClawConfigSync({
      engineManager: getOpenClawEngineManager(),
      getCoworkConfig: () => getCoworkStore().getConfig(),
      getBrowserWebAccessConfig: () => getStore().get<AppConfigSettings>('app_config')?.browserWebAccess,
      isEnterprise: () => !!getStore().get('enterprise_config'),
      getOpenClawSessionPolicy: () => loadOpenClawSessionPolicyConfig(getStore()),
      getSkillsList: () =>
        getSkillManager()
          .listSkills()
          .map(s => ({ id: s.id, name: s.name, enabled: s.enabled })),
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
      getPopoInstances: () => {
        try {
          return getIMGatewayManager().getIMStore().getPopoInstances();
        } catch {
          return [];
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
      getResolvedMcpServers: () => {
        // Synchronous wrapper: returns last resolved servers from cache.
        // The async resolution happens during syncOpenClawConfig via McpRuntime.
        return getMcpRuntime().getResolvedServersCache();
      },
      getAskUserCallbackUrl: () => getMcpRuntime().getAskUserCallbackUrl(),
      getMediaCallbackUrl: () => getMcpRuntime().getMediaCallbackUrl(),
      getMcpBridgeSecret: () => getMcpRuntime().getBridgeSecret(),
      getAgents: () => getCoworkStore().listAgents(),
      getUserPlugins: () =>
        getCoworkStore()
          .listUserPlugins()
          .filter(p => !isHiddenUserPluginId(p.pluginId))
          .map(p => ({ pluginId: p.pluginId, enabled: p.enabled, config: p.config })),
      canUseMediaGeneration: () => cachedMediaGenerationEntitled,
    });
  }
  return openClawConfigSync;
};

// Deferred gateway restart: when a config change requires a gateway restart
// but active cowork sessions or cron jobs exist, defer it until all workloads
// complete. Polling applies it at the first idle point; after the overdue
// threshold we keep the same request queued and surface a clearer pending
// state instead of repeatedly re-syncing or terminating in-flight work.
let deferredRestartTimer: ReturnType<typeof setInterval> | null = null;
let deferredRestartTimeout: ReturnType<typeof setTimeout> | null = null;
let deferredRestartOverdue = false;
const DEFERRED_RESTART_POLL_MS = 3_000;
const DEFERRED_RESTART_OVERDUE_MS = 5 * 60_000;

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
  if (deferredRestartTimer) {
    clearInterval(deferredRestartTimer);
    deferredRestartTimer = null;
  }
  if (deferredRestartTimeout) {
    clearTimeout(deferredRestartTimeout);
    deferredRestartTimeout = null;
  }
  deferredRestartOverdue = false;
};

type SyncOpenClawConfigOptions = {
  reason: string;
  restartGatewayIfRunning?: boolean;
  expectedImpact?: OpenClawConfigImpact;
};

type SyncOpenClawConfigResult = {
  success: boolean;
  changed: boolean;
  status?: OpenClawEngineStatus;
  error?: string;
};

type GatewayConfigApplyState = {
  reason: string;
  startedAt: number;
  restartRequired: boolean;
  promise: Promise<void>;
};

let openClawConfigApplyQueue: Promise<void> = Promise.resolve();
let openClawConfigApplyState: GatewayConfigApplyState | null = null;
let openClawConfigApplyGeneration = 0;
let deferredRestartReason: string | null = null;

const buildConfigApplyPendingStatus = (message: string): OpenClawEngineStatus => {
  const current = getOpenClawEngineManager().getStatus();
  return {
    phase: 'starting',
    version: current.version,
    message,
    canRetry: false,
  };
};

const waitForOpenClawConfigApply = async (context: string): Promise<OpenClawEngineStatus | null> => {
  const pendingApply = openClawConfigApplyState;
  if (pendingApply) {
    console.log(
      '[OpenClawConfigApply] waiting for pending config sync before proceeding.',
      `Context ${context}.`,
      `Reason ${pendingApply.reason}.`,
      `Restart required ${pendingApply.restartRequired}.`,
    );
    try {
      await pendingApply.promise;
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'OpenClaw config sync failed.';
      return buildConfigApplyPendingStatus(message);
    }
  }

  if (deferredRestartReason) {
    return buildConfigApplyPendingStatus(
      deferredRestartOverdue
        ? t('openClawConfigApplyOverdue')
        : t('openClawConfigApplyPending'),
    );
  }

  return null;
};

const DEFERRED_SYNC_REASON_PREFIX = 'deferred:';

const executeDeferredGatewayRestart = async (reason: string) => {
  clearDeferredRestart();
  deferredRestartReason = null;
  console.log(
    `${gwDiagTs()} executeDeferredGatewayRestart: performing deferred restart (reason: ${reason})`,
  );
  // When the sync below re-defers (workloads still active), the re-scheduled
  // reason flows back here on the next attempt — don't stack another
  // `deferred:` prefix. Unbounded stacking also breaks the
  // selfRestartSatisfiesSync() prefix check, misclassifying restarts that a
  // gateway self-restart would satisfy as needing a full respawn.
  const syncReason = reason.startsWith(DEFERRED_SYNC_REASON_PREFIX)
    ? reason
    : `${DEFERRED_SYNC_REASON_PREFIX}${reason}`;
  await syncOpenClawConfig({
    reason: syncReason,
    restartGatewayIfRunning: true,
    expectedImpact: OpenClawConfigImpact.Restart,
  });
};

// A hard restart requested while the gateway is restarting itself (config
// reload → SIGUSR1) is parked here instead of killing the mid-restart process.
// When the gateway client reconnects we either drop it (the self-restart
// already loaded the on-disk config) or replay it (env vars need a respawn).
type PendingSelfRestartReevaluation = {
  reasons: string[];
  requiresRespawn: boolean;
  gatewayPid: number | null;
};
let pendingSelfRestartReevaluation: PendingSelfRestartReevaluation | null = null;

/**
 * True when this sync's restart demand is satisfied by the gateway reloading
 * the on-disk config (which a self-restart does). Env-var changes need a
 * respawn (same-process restart keeps the old environment), and explicit
 * restart flags may depend on out-of-config state — except the
 * config-delivery fallback, whose only goal is on-disk config convergence.
 */
const selfRestartSatisfiesSync = (
  options: SyncOpenClawConfigOptions,
  secretEnvVarsChanged: boolean,
): boolean => {
  if (secretEnvVarsChanged) {
    return false;
  }
  if (options.restartGatewayIfRunning === true) {
    return options.reason.startsWith(
      `${DEFERRED_SYNC_REASON_PREFIX}${CONFIG_DELIVERY_FALLBACK_REASON_PREFIX}`,
    );
  }
  return true;
};

const scheduleDeferredGatewayRestart = (reason: string) => {
  // If already scheduled, the latest config is already on disk — just let
  // the existing timer handle the restart.
  if (deferredRestartTimer) {
    console.log(
      `${gwDiagTs()} scheduleDeferredGatewayRestart: already scheduled, skipping (reason: ${reason})`,
    );
    return;
  }

  console.log(
    `${gwDiagTs()} scheduleDeferredGatewayRestart: scheduling deferred restart, polling every ${DEFERRED_RESTART_POLL_MS}ms, overdue threshold ${DEFERRED_RESTART_OVERDUE_MS}ms (reason: ${reason})`,
  );
  deferredRestartReason = reason;
  deferredRestartOverdue = false;
  deferredRestartTimer = setInterval(() => {
    if (!hasActiveGatewayWorkloads()) {
      void executeDeferredGatewayRestart(reason);
    }
  }, DEFERRED_RESTART_POLL_MS);

  // Do not kill an active task at the threshold. Keep the original interval
  // alive so the restart happens at the first idle poll, and avoid re-running
  // sync every five minutes while a long task is still active.
  deferredRestartTimeout = setTimeout(() => {
    deferredRestartTimeout = null;
    if (hasActiveGatewayWorkloads()) {
      deferredRestartOverdue = true;
      console.warn(
        `${gwDiagTs()} scheduleDeferredGatewayRestart: overdue while workloads remain active; restart stays queued until the first idle poll (reason: ${reason})`,
      );
      return;
    }
    console.warn(
      `${gwDiagTs()} scheduleDeferredGatewayRestart: overdue threshold reached after workloads drained; applying queued restart (reason: ${reason})`,
    );
    void executeDeferredGatewayRestart(reason);
  }, DEFERRED_RESTART_OVERDUE_MS);
};

const _syncOpenClawConfigImpl = async (
  options: SyncOpenClawConfigOptions = { reason: 'unknown' },
): Promise<SyncOpenClawConfigResult> => {
  const D = gwDiagTs;
  console.log(
    `${D()} ──── syncOpenClawConfig START reason=${options.reason} restartIfRunning=${!!options.restartGatewayIfRunning} expectedImpact=${options.expectedImpact ?? OpenClawConfigImpact.None}`,
  );

  const configSync = getOpenClawConfigSync();
  const manager = getOpenClawEngineManager();
  const migrationSecretEnvVars = {
    ...manager.getSecretEnvVars(),
    ...configSync.collectSecretEnvVars(),
  };
  const pluginInstallMigration = await migrateLegacyOpenClawPluginInstalls({
    configPath: manager.getConfigPath(),
    stateDir: manager.getStateDir(),
    runtimeRoot: manager.getRuntimeRoot(),
    electronNodeRuntimePath: getElectronNodeRuntimePath(),
    env: process.env,
    secretEnvVars: migrationSecretEnvVars,
  });
  if (pluginInstallMigration.status === OpenClawPluginInstallMigrationStatus.Failed) {
    const message = `OpenClaw legacy plugin install migration failed: ${pluginInstallMigration.error}`;
    console.error('[OpenClaw] Legacy plugin install migration blocked config sync:', new Error(message));
    const status = manager.setExternalError(message);
    return {
      success: false,
      changed: false,
      status,
      error: message,
    };
  }
  const pluginInstallMigrationChanged =
    pluginInstallMigration.status === OpenClawPluginInstallMigrationStatus.Migrated;

  // Resolve MCP servers before sync (async → cache for synchronous callback)
  try {
    await getMcpRuntime().refreshResolvedServersCache();
  } catch (err) {
    console.warn(`[OpenClaw] getResolvedMcpServers failed (non-fatal):`, err);
    getMcpRuntime().clearResolvedServersCache();
  }

  const syncResult = configSync.sync(options.reason);
  console.log(
    `${D()} sync() ok=${syncResult.ok} changed=${syncResult.changed} bindingsChanged=${!!syncResult.bindingsChanged} restartImpact=${syncResult.restartImpact ?? OpenClawConfigImpact.None}`,
  );
  if (!syncResult.ok) {
    console.log(`${D()} sync FAILED: ${syncResult.error}`);
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

  let enterpriseConfigChanged = false;
  try {
    enterpriseConfigChanged = mergeEnterpriseOpenclawConfig(manager.getConfigPath());
  } catch {
    /* non-critical */
  }

  const effectiveConfigChanged =
    syncResult.changed || pluginInstallMigrationChanged || enterpriseConfigChanged;
  console.log(
    `${D()} final config changed=${effectiveConfigChanged} (sync=${syncResult.changed} legacyMigration=${pluginInstallMigrationChanged} enterprise=${enterpriseConfigChanged})`,
  );

  const nextSecretEnvVars = configSync.collectSecretEnvVars();
  const prevSecretEnvVars = manager.getSecretEnvVars();
  let referencedSecretEnvVarNames: Set<string> | null = null;
  try {
    const configText = fs.readFileSync(manager.getConfigPath(), 'utf8');
    referencedSecretEnvVarNames = collectReferencedEnvVarNames(configText);
  } catch (error) {
    console.warn('[OpenClawConfigSync] failed to inspect referenced secret env vars, comparing all secrets:', error);
  }
  const effectiveNextSecretEnvVars = referencedSecretEnvVarNames
    ? pickReferencedSecretEnvVars(nextSecretEnvVars, referencedSecretEnvVarNames)
    : nextSecretEnvVars;
  const effectivePrevSecretEnvVars = referencedSecretEnvVarNames
    ? pickReferencedSecretEnvVars(prevSecretEnvVars, referencedSecretEnvVarNames)
    : prevSecretEnvVars;
  const secretEnvVarsChanged = JSON.stringify(effectiveNextSecretEnvVars) !== JSON.stringify(effectivePrevSecretEnvVars);
  manager.setSecretEnvVars(nextSecretEnvVars);

  // Diagnostic: print which env vars changed
  if (secretEnvVarsChanged) {
    const allKeys = new Set([...Object.keys(effectivePrevSecretEnvVars), ...Object.keys(effectiveNextSecretEnvVars)]);
    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];
    for (const k of allKeys) {
      const prev = effectivePrevSecretEnvVars[k];
      const next = effectiveNextSecretEnvVars[k];
      if (prev === next) continue;
      if (prev === undefined) {
        added.push(k);
      } else if (next === undefined) {
        removed.push(k);
      } else {
        modified.push(k);
      }
    }
    console.log(`${D()} SECRET ENV VARS CHANGED!`);
    if (added.length) console.log(`${D()}   added: ${added.join(', ')}`);
    if (removed.length) console.log(`${D()}   removed: ${removed.join(', ')}`);
    if (modified.length) console.log(`${D()}   modified: ${modified.join(', ')}`);
  } else {
    console.log(`${D()} secretEnvVars unchanged (${Object.keys(effectiveNextSecretEnvVars).length}/${Object.keys(nextSecretEnvVars).length} referenced keys)`);
  }

  // Force a hard restart when env/bindings changed, or when the caller explicitly
  // requires a running gateway restart. Some IM account state changes are stored
  // outside openclaw.json, so the explicit flag must not depend on config diffing.
  const expectedRestartImpact =
    effectiveConfigChanged
    && options.expectedImpact === OpenClawConfigImpact.Restart;
  const syncRestartImpact =
    syncResult.restartImpact === OpenClawConfigImpact.Restart;
  const needsHardRestart =
    secretEnvVarsChanged ||
    syncResult.bindingsChanged === true ||
    syncRestartImpact ||
    expectedRestartImpact ||
    options.restartGatewayIfRunning === true;

  console.log(
    `${D()} needsHardRestart=${needsHardRestart} (envChanged=${secretEnvVarsChanged} bindingsChanged=${!!syncResult.bindingsChanged} configChanged=${effectiveConfigChanged} restartImpact=${syncResult.restartImpact ?? OpenClawConfigImpact.None} expectedRestart=${expectedRestartImpact} restartFlag=${!!options.restartGatewayIfRunning})`,
  );

  if (!needsHardRestart) {
    if (!effectiveConfigChanged) {
      console.log(`${D()} ──── NO RESTART, config unchanged. reason=${options.reason}`);
      return {
        success: true,
        changed: false,
      };
    }
    // The gateway's file watcher can miss writes that land right after a
    // (re)start, so never rely on it alone: push the final on-disk content
    // through config.set for a positive hot-apply ack, or schedule a deferred
    // restart when the RPC path is unavailable.
    const deliveryManager = getOpenClawEngineManager();
    const delivery = await deliverOpenClawConfigToGateway({
      reason: options.reason,
      gatewayPhase: deliveryManager.getStatus().phase,
      readConfigFile: () => fs.readFileSync(deliveryManager.getConfigPath(), 'utf8'),
      ensureRpcClient: async () => (
        openClawRuntimeAdapter ? openClawRuntimeAdapter.ensureGatewayRpcClient() : null
      ),
      scheduleDeferredRestart: scheduleDeferredGatewayRestart,
    });
    console.log(
      `${D()} ──── NO RESTART, hot delivery mode=${delivery.mode} restartScheduled=${delivery.restartScheduled}. reason=${options.reason}`,
    );
    if (delivery.mode === OpenClawConfigDeliveryMode.Rejected) {
      return {
        success: false,
        changed: true,
        status: deliveryManager.getStatus(),
        error: delivery.detail,
      };
    }
    return {
      success: true,
      changed: true,
    };
  }

  const status = manager.getStatus();
  if (status.phase !== 'running') {
    console.log(
      `${D()} ──── RESTART NEEDED but gateway not running (phase=${status.phase}), skipping. reason=${options.reason}`,
    );
    return {
      success: true,
      changed: true,
      status,
    };
  }

  if (hasActiveGatewayWorkloads()) {
    console.log(`${D()} ──── RESTART DEFERRED (active workloads). reason=${options.reason}`);
    scheduleDeferredGatewayRestart(options.reason);
    return {
      success: true,
      changed: true,
      status,
    };
  }

  if (manager.isGatewaySelfRestartActive()) {
    // Killing the gateway mid self-restart poisons its single-instance lock
    // (empty lock file → 30s of "gateway already running; lock timeout").
    // Park the demand; the gateway-ready callback re-evaluates it.
    const requiresRespawn = !selfRestartSatisfiesSync(options, secretEnvVarsChanged);
    pendingSelfRestartReevaluation = {
      reasons: [...(pendingSelfRestartReevaluation?.reasons ?? []), options.reason],
      requiresRespawn: (pendingSelfRestartReevaluation?.requiresRespawn ?? false) || requiresRespawn,
      gatewayPid: pendingSelfRestartReevaluation?.gatewayPid ?? manager.getGatewayProcessPid(),
    };
    console.log(
      `${D()} ──── RESTART PARKED (gateway self-restart in progress). reason=${options.reason}, requiresRespawn=${requiresRespawn}`,
    );
    return {
      success: true,
      changed: true,
      status,
    };
  }

  console.log(
    `${D()} ──── HARD RESTART EXECUTING. reason=${options.reason}, phase=${status.phase}, port=${status.message?.match(/loopback:(\d+)/)?.[1] ?? 'unknown'}`,
  );
  if (openClawRuntimeAdapter) {
    openClawRuntimeAdapter.disconnectGatewayClient();
  }

  await manager.stopGateway();
  const restarted = await manager.startGateway(`config-sync:${options.reason}`);
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

const syncOpenClawConfig = async (
  options: SyncOpenClawConfigOptions = { reason: 'unknown' },
): Promise<SyncOpenClawConfigResult> => {
  const generation = ++openClawConfigApplyGeneration;
  const startAfterPrevious = openClawConfigApplyQueue.catch(() => {});
  const restartRequired =
    options.restartGatewayIfRunning === true
    || options.expectedImpact === OpenClawConfigImpact.Restart;
  const resultPromise = startAfterPrevious.then(() => _syncOpenClawConfigImpl(options));
  const barrierPromise = resultPromise.then((result) => {
    if (!result.success) {
      throw new Error(result.error || 'OpenClaw config sync failed.');
    }
  });
  barrierPromise.catch(() => {
    // The awaiter will surface the error when a user action is blocked by this barrier.
  });

  openClawConfigApplyState = {
    reason: options.reason,
    startedAt: Date.now(),
    restartRequired,
    promise: barrierPromise,
  };

  openClawConfigApplyQueue = resultPromise.then(
    (): void => undefined,
    (): void => undefined,
  );

  try {
    return await resultPromise;
  } catch (error) {
    return {
      success: false,
      changed: false,
      error: error instanceof Error ? error.message : 'OpenClaw config sync failed.',
    };
  } finally {
    if (generation === openClawConfigApplyGeneration) {
      openClawConfigApplyState = null;
    }
  }
};

// The gateway client reconnected — any self-restart has settled. Resolve the
// parked restart demand: a same-pid (in-process) restart already loaded the
// on-disk config, so only env-var style demands still need a real respawn.
// A changed pid means the process was respawned with fresh env anyway.
const handleGatewaySelfRestartSettled = () => {
  const manager = getOpenClawEngineManager();
  manager.clearGatewaySelfRestart();
  const pending = pendingSelfRestartReevaluation;
  if (!pending) {
    return;
  }
  pendingSelfRestartReevaluation = null;
  const currentPid = manager.getGatewayProcessPid();
  const respawned = pending.gatewayPid != null && currentPid != null && currentPid !== pending.gatewayPid;
  if (pending.requiresRespawn && !respawned) {
    console.log(
      `${gwDiagTs()} parked restart still required after gateway self-restart (reasons: ${pending.reasons.join(', ')}); executing now`,
    );
    void syncOpenClawConfig({
      reason: `self-restart-reevaluate:${pending.reasons[0]}`,
      restartGatewayIfRunning: true,
    });
    return;
  }
  console.log(
    `${gwDiagTs()} parked restart satisfied by gateway self-restart (reasons: ${pending.reasons.join(', ')}, respawned=${respawned})`,
  );
};

type OpenClawGatewayRepairResult = {
  success: boolean;
  status?: OpenClawEngineStatus;
  originalPath: string;
  backupPath?: string;
  error?: string;
  errorCode?: OpenClawGatewayRepairErrorCode;
  recoverable?: boolean;
};

let openClawGatewayRepairPromise: Promise<OpenClawGatewayRepairResult> | null = null;

const isOpenClawGatewayRepairSuccess = (status: OpenClawEngineStatus): boolean => {
  return status.phase === 'running' || status.phase === 'ready';
};

const buildOpenClawRepairBusyResult = (
  originalPath: string,
  status: OpenClawEngineStatus,
): OpenClawGatewayRepairResult | null => {
  const busyError = getOpenClawGatewayRepairBusyError(hasActiveGatewayWorkloads());
  if (!busyError) {
    return null;
  }
  return {
    success: false,
    status,
    originalPath,
    error: busyError,
    errorCode: OpenClawGatewayRepairErrorCode.Busy,
    recoverable: true,
  };
};

const repairOpenClawGatewayState = (): Promise<OpenClawGatewayRepairResult> => {
  if (openClawGatewayRepairPromise) {
    console.log('[OpenClawRepair] repair already in progress, joining existing request.');
    return openClawGatewayRepairPromise;
  }

  let promise: Promise<OpenClawGatewayRepairResult>;
  promise = (async (): Promise<OpenClawGatewayRepairResult> => {
    const manager = getOpenClawEngineManager();
    const originalPath = manager.getConfigPath();

    const initialBusyResult = buildOpenClawRepairBusyResult(originalPath, manager.getStatus());
    if (initialBusyResult) {
      console.warn('[OpenClawRepair] repair was blocked because gateway work is still running.');
      return initialBusyResult;
    }

    const pendingApplyStatus = await waitForOpenClawConfigApply('manual OpenClaw repair');
    if (pendingApplyStatus) {
      console.warn('[OpenClawRepair] repair was blocked while configuration changes are still applying.');
      return {
        success: false,
        status: pendingApplyStatus,
        originalPath,
        error: pendingApplyStatus.message || 'OpenClaw is still applying configuration changes.',
        errorCode: OpenClawGatewayRepairErrorCode.ConfigApplyPending,
        recoverable: true,
      };
    }

    const postApplyBusyResult = buildOpenClawRepairBusyResult(originalPath, manager.getStatus());
    if (postApplyBusyResult) {
      console.warn('[OpenClawRepair] repair was blocked because gateway work started during the check.');
      return postApplyBusyResult;
    }

    if (openClawBootstrapPromise) {
      console.log('[OpenClawRepair] waiting for the current OpenClaw startup attempt to finish.');
      await openClawBootstrapPromise.catch((error: unknown): null => {
        console.warn('[OpenClawRepair] existing startup attempt failed before repair:', error);
        return null;
      });
    }

    const postBootstrapBusyResult = buildOpenClawRepairBusyResult(originalPath, manager.getStatus());
    if (postBootstrapBusyResult) {
      console.warn('[OpenClawRepair] repair was blocked because gateway work started after startup finished.');
      return postBootstrapBusyResult;
    }

    try {
      console.log('[OpenClawRepair] starting gateway state repair.');
      if (openClawRuntimeAdapter) {
        openClawRuntimeAdapter.disconnectGatewayClient();
      }

      await manager.stopGateway();
      const backupResult = backupOpenClawConfig(originalPath);
      if (backupResult.backupPath) {
        console.log(`[OpenClawRepair] backed up OpenClaw config to ${backupResult.backupPath}.`);
      } else {
        console.log('[OpenClawRepair] no OpenClaw config file was present, continuing with regeneration.');
      }

      const status = await bootstrapOpenClawEngine({
        forceReinstall: false,
        reason: 'manual-repair',
      });
      const success = isOpenClawGatewayRepairSuccess(status);
      if (success) {
        console.log('[OpenClawRepair] gateway state repair completed successfully.');
      } else {
        console.warn('[OpenClawRepair] gateway state repair completed but the gateway is not ready.');
      }

      return {
        success,
        status,
        originalPath: backupResult.originalPath,
        backupPath: backupResult.backupPath,
        error: success ? undefined : status.message || 'Failed to restart OpenClaw gateway after repair.',
      };
    } catch (error) {
      console.error('[OpenClawRepair] gateway state repair failed:', error);
      return {
        success: false,
        status: manager.getStatus(),
        originalPath,
        error: error instanceof Error ? error.message : 'Failed to repair OpenClaw gateway state.',
      };
    }
  })().finally(() => {
    if (openClawGatewayRepairPromise === promise) {
      openClawGatewayRepairPromise = null;
    }
  });

  openClawGatewayRepairPromise = promise;
  return promise;
};

const bindCoworkRuntimeForwarder = (): void => {
  if (coworkRuntimeForwarderBound) return;
  const runtime = getCoworkEngineRouter();

  runtime.on('message', (sessionId: string, message: unknown, beforeMessageId?: string) => {
    const safeMessage = sanitizeCoworkMessageForIpc(message);
    const windows = BrowserWindow.getAllWindows();
    const messageType = typeof message === 'object' && message && 'type' in message
      ? (message as { type?: unknown }).type
      : undefined;
    if (beforeMessageId) {
      console.log('[ThinkingOrder] IPC forwarding with beforeMessageId=', beforeMessageId, 'type=', messageType);
    }
    console.log('[CoworkForwarder] forwarding message: sessionId=', sessionId, 'type=', messageType, 'windowCount=', windows.length);
    windows.forEach((win) => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send('cowork:stream:message', { sessionId, message: safeMessage, beforeMessageId });
      } catch (error) {
        console.error('Failed to forward cowork message:', error);
      }
    });
  });

  runtime.on(
    'messageUpdate',
    (sessionId: string, messageId: string, content: string, metadata?: Record<string, unknown>) => {
      const safeContent = truncateIpcString(content, IPC_UPDATE_CONTENT_MAX_CHARS);
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (win.isDestroyed()) return;
        try {
          win.webContents.send('cowork:stream:messageUpdate', {
            sessionId,
            messageId,
            content: safeContent,
            metadata,
          });
        } catch (error) {
          console.error('Failed to forward cowork message update:', error);
        }
      });
    },
  );

  runtime.on('sessionStatus', (sessionId: string, status: string) => {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(win => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send('cowork:stream:sessionStatus', { sessionId, status });
      } catch (error) {
        console.error('[CoworkRuntime] failed to forward session status:', error);
      }
    });
  });

  runtime.on('btwResult', (sessionId: string, result: CoworkBtwEntry) => {
    const safeResult: CoworkBtwEntry = {
      ...result,
      sessionId,
      question: truncateIpcString(result.question, COWORK_BTW_EVENT_QUESTION_MAX_CHARS),
      ...(result.answer !== undefined
        ? { answer: truncateIpcString(result.answer, COWORK_BTW_RESULT_MAX_CHARS) }
        : {}),
      ...(result.error !== undefined
        ? { error: truncateIpcString(result.error, IPC_STRING_MAX_CHARS) }
        : {}),
    };
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(win => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send(CoworkIpcChannel.StreamBtwResult, {
          sessionId,
          result: safeResult,
        });
      } catch (error) {
        console.error('[CoworkBtw] failed to forward side-question result:', error);
      }
    });
  });

  runtime.on('contextUsageUpdate', (sessionId: string, usage: unknown) => {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(win => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send('cowork:stream:contextUsage', { sessionId, usage });
      } catch (error) {
        console.error('[CoworkRuntime] failed to forward context usage:', error);
      }
    });
  });

  runtime.on('goalUpdate', (sessionId: string, goal: unknown) => {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(win => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send(CoworkIpcChannel.StreamGoal, { sessionId, goal });
      } catch (error) {
        console.error('[CoworkRuntime] failed to forward goal update:', error);
      }
    });
  });

  runtime.on('contextMaintenance', (sessionId: string, active: boolean) => {
    const windows = BrowserWindow.getAllWindows();
    console.log(
      `[CoworkRuntime] forwarding context maintenance ${active ? 'start' : 'end'} for session ${sessionId} to ${windows.length} windows.`,
    );
    windows.forEach(win => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send('cowork:stream:contextMaintenance', { sessionId, active });
      } catch (error) {
        console.error('[CoworkRuntime] failed to forward context maintenance status:', error);
      }
    });
  });

  runtime.on('permissionRequest', (sessionId: string, request: unknown) => {
    if (runtime.getSessionConfirmationMode(sessionId) === 'text') {
      return;
    }
    const safeRequest = sanitizePermissionRequestForIpc(request);
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(win => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send('cowork:stream:permission', { sessionId, request: safeRequest });
      } catch (error) {
        console.error('Failed to forward cowork permission request:', error);
      }
    });
    const { requestId, toolName } = (request ?? {}) as { requestId?: unknown; toolName?: unknown };
    if (typeof requestId === 'string' && requestId) {
      getDesktopNotificationManager().handlePermissionRequest(sessionId, {
        requestId,
        toolName: typeof toolName === 'string' ? toolName : '',
      });
    }
  });

  runtime.on('permissionResolved', (_sessionId: string, requestId: string) => {
    getDesktopNotificationManager().handlePermissionResolved(requestId);
  });

  runtime.on('sessionStopped', (sessionId: string) => {
    getDesktopNotificationManager().handleSessionStopped(sessionId);
  });

  runtime.on('complete', (sessionId: string, claudeSessionId: string | null) => {
    mediaSelectionBySession.delete(sessionId);
    mediaTurnAccountScopeBySession.delete(sessionId);
    skinRuntimeController?.handleRuntimeComplete(sessionId);
    mediaReferencesBySession.delete(sessionId);
    getDesktopNotificationManager().handleComplete(sessionId);
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(win => {
      if (win.isDestroyed()) return;
      win.webContents.send('cowork:stream:complete', { sessionId, claudeSessionId });
    });
    // If this session used a server model, notify renderer to refresh quota.
    try {
      if (shouldRefreshServerQuotaForSession(sessionId)) {
        const windows = BrowserWindow.getAllWindows();
        windows.forEach(win => {
          if (win.isDestroyed()) return;
          win.webContents.send(AuthIpcChannel.QuotaChanged);
        });
      }
    } catch {
      // ignore
    }
  });

  runtime.on('error', (sessionId: string, error: string) => {
    mediaSelectionBySession.delete(sessionId);
    mediaTurnAccountScopeBySession.delete(sessionId);
    skinRuntimeController?.handleRuntimeError(sessionId);
    mediaReferencesBySession.delete(sessionId);
    // Mark session as error in store so the .catch() fallback can detect duplicates.
    try {
      getCoworkStore().updateSession(sessionId, { status: 'error' });
    } catch {
      /* ignore */
    }
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(win => {
      if (win.isDestroyed()) return;
      win.webContents.send('cowork:stream:error', { sessionId, error });
    });
    try {
      if (shouldRefreshServerQuotaForSession(sessionId)) {
        windows.forEach(win => {
          if (!win.isDestroyed()) {
            win.webContents.send('auth:quotaChanged');
          }
        });
      }
    } catch {
      // Quota refresh is best-effort after a runtime error.
    }
  });

  coworkRuntimeForwarderBound = true;
};

const getCoworkEngineRouter = () => {
  if (!coworkEngineRouter) {
    if (!openClawRuntimeAdapter) {
      openClawRuntimeAdapter = new OpenClawRuntimeAdapter(
        getCoworkStore(),
        getOpenClawEngineManager(),
        {
          normalizeModelRef: normalizeOpenClawModelRef,
          onChannelPromptSubmit: event => {
            void getMainLogReporter().report({
              action: LogReporterAction.ImPromptSubmit,
              source: LogReporterSource.OpenClawChannel,
              ...event,
            });
          },
          onGatewayClientReady: () => {
            getCronJobService().notifyGatewayReady();
            handleGatewaySelfRestartSettled();
          },
        },
        new SubagentRunStore(getStore().getDatabase()),
        new SubagentMessageStore(getStore().getDatabase()),
      );
      // Wire up channel session sync for IM conversations via OpenClaw
      try {
        const imManager = getIMGatewayManager();
        const imStore = imManager.getIMStore();
        if (imStore) {
          const channelSessionSync = new OpenClawChannelSessionSync({
            coworkStore: getCoworkStore(),
            imStore,
            getDefaultCwd: (agentId?: string) =>
              resolveAgentDefaultWorkingDirectory(agentId) || os.homedir(),
            resolveJobName: jobId => getCronJobService().getJobNameSync(jobId),
            resolveJobDelivery: jobId => getCronJobService().getJobDeliverySync(jobId),
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

let coworkTempJanitor: CoworkTempJanitor | null = null;

const getCoworkTempJanitor = (): CoworkTempJanitor => {
  if (!coworkTempJanitor) {
    coworkTempJanitor = createCoworkTempJanitor({
      listAllCwds: () => getCoworkStore().listRecentSessionCwds(0),
      listActiveCwds: () => {
        try {
          const activeSessionIds = getCoworkEngineRouter().getActiveSessionIds();
          return getCoworkStore().listSessionCwds(activeSessionIds);
        } catch (error) {
          console.warn('[CoworkTempJanitor] failed to resolve active session cwds:', error);
          return [];
        }
      },
    });
  }
  return coworkTempJanitor;
};

const getDesktopNotificationManager = (): DesktopNotificationManager => {
  if (!desktopNotificationManager) {
    desktopNotificationManager = new DesktopNotificationManager({
      getWindow: () => mainWindow,
      getNotificationIconPath,
      getNotificationSettings: () =>
        getStore().get<AppConfigSettings>('app_config')?.notificationSettings,
      getSessionTitle: (sessionId: string) => {
        try {
          return getCoworkStore().getSession(sessionId, 0)?.title ?? null;
        } catch {
          return null;
        }
      },
      focusMainWindow: focusMainWindowForReason,
      openSession: (sessionId: string) => {
        const targetWindow = mainWindow && !mainWindow.isDestroyed()
          ? mainWindow
          : ensureMainWindowForReason?.('desktop notification') ?? null;
        if (!targetWindow || targetWindow.isDestroyed()) {
          console.warn(`[DesktopNotification] could not open session ${sessionId} because no main window was available`);
          return;
        }

        pendingOpenSessionFromNotificationId = sessionId;
        if (targetWindow.webContents.isLoadingMainFrame()) {
          targetWindow.webContents.once('did-finish-load', flushOpenSessionFromNotification);
          return;
        }

        flushOpenSessionFromNotification();
      },
      updateTrayReminder: (count: number, onClick?: () => void) => {
        updateTrayReminder(() => mainWindow, { count, onClick });
      },
    });
  }
  return desktopNotificationManager;
};

const getSkillManager = () => {
  if (!skillManager) {
    skillManager = new SkillManager(getStore);
  }
  return skillManager;
};

const getMcpRuntime = (): McpRuntime => {
  if (!mcpRuntime) {
    mcpRuntime = new McpRuntime({
      getStore,
      syncOpenClawConfig,
      onAskUserRequested: (sessionId, request) => {
        getDesktopNotificationManager().handlePermissionRequest(sessionId, request);
      },
      onAskUserDismissed: (requestId) => {
        getDesktopNotificationManager().handlePermissionResolved(requestId);
      },
    });
  }
  return mcpRuntime;
};

const startAskUserServer = async (): Promise<void> => {
  await getMcpRuntime().startAskUserServer();
};

const getIMGatewayManager = () => {
  if (!imGatewayManager) {
    const sqliteStore = getStore();

    // Get Cowork dependencies for IM Cowork mode
    const runtime = getCoworkEngineRouter();
    const store = getCoworkStore();

    imGatewayManager = new IMGatewayManager(sqliteStore.getDatabase(), {
      coworkRuntime: runtime,
      coworkStore: store,
      ensureCoworkReady: async () => {
        const status = await ensureOpenClawRunningForCowork();
        if (status.phase !== 'running') {
          throw new Error(
            status.message || 'AI engine is initializing. Please try again in a moment.',
          );
        }
      },
      syncOpenClawConfig: async (
        reason?: string,
        options?: { restartGatewayIfRunning?: boolean },
      ) => {
        await syncOpenClawConfig({
          reason: reason || 'im-gateway-sync',
          restartGatewayIfRunning: options?.restartGatewayIfRunning,
        });
      },
      ensureOpenClawGatewayConnected: async () => {
        const configApplyStatus = await waitForOpenClawConfigApply('IM gateway client connection');
        if (configApplyStatus) {
          throw new Error(configApplyStatus.message || 'OpenClaw is applying configuration changes.');
        }
        if (openClawRuntimeAdapter) {
          await openClawRuntimeAdapter.connectGatewayIfNeeded();
        }
      },
      getOpenClawGatewayClient: () => openClawRuntimeAdapter?.getGatewayClient() ?? null,
      ensureOpenClawGatewayReady: async () => {
        if (!openClawRuntimeAdapter) {
          throw new Error('OpenClaw runtime adapter not initialized.');
        }
        const configApplyStatus = await waitForOpenClawConfigApply('IM gateway readiness check');
        if (configApplyStatus) {
          throw new Error(configApplyStatus.message || 'OpenClaw is applying configuration changes.');
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
            ...(hasChannel
              ? { to: deliveryTo }
              : message.conversationId
                ? { to: message.conversationId }
                : {}),
          },
          agentId: DEFAULT_MANAGED_AGENT_ID,
          ...(hasChannel
            ? {}
            : { sessionKey: buildManagedSessionKey(sessionId, DEFAULT_MANAGED_AGENT_ID) }),
        });
        return {
          id: task.id,
          name: task.name,
          agentId: task.agentId,
          sessionKey: task.sessionKey,
          payloadText:
            task.payload.kind === 'systemEvent'
              ? task.payload.text
              : task.payload.kind === 'agentTurn'
                ? task.payload.message
                : '',
          scheduleAt: task.schedule.kind === 'at' ? task.schedule.at : request.scheduleAt,
        };
      },
    });

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
    imGatewayManager.on('statusChange', status => {
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('im:status:change', status);
        }
      });
    });

    imGatewayManager.on('message', message => {
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

const refreshImSessionWorkingDirectoriesForAgent = (agentId: string): number => {
  const normalizedAgentId = agentId.trim() || AgentId.Main;
  const resolvedCwd = resolveAgentDefaultWorkingDirectory(normalizedAgentId);
  if (!resolvedCwd) {
    return 0;
  }

  try {
    const imStore = getIMGatewayManager().getIMStore();
    const coworkStore = getCoworkStore();
    let updatedCount = 0;

    for (const mapping of imStore.listSessionMappings()) {
      if ((mapping.agentId || AgentId.Main) !== normalizedAgentId) {
        continue;
      }

      const session = coworkStore.getSession(mapping.coworkSessionId);
      if (!session || session.cwd === resolvedCwd) {
        continue;
      }

      coworkStore.updateSession(session.id, { cwd: resolvedCwd }, { touchUpdatedAt: false });
      updatedCount += 1;
    }

    if (updatedCount > 0) {
      console.debug(
        `[ChannelSessionSync] refreshed ${updatedCount} IM session working directories for agent ${normalizedAgentId} to ${resolvedCwd}`,
      );
    }

    openClawRuntimeAdapter?.clearChannelSessionCache();
    return updatedCount;
  } catch (error) {
    console.warn('[ChannelSessionSync] failed to refresh IM session working directories:', error);
    return 0;
  }
};

function mergeCoworkSystemPrompt(systemPrompt?: string): string | undefined {
  const scheduledTaskPrompt = buildScheduledTaskEnginePrompt();
  const normalizedSystemPrompt = systemPrompt?.trim() || '';
  if (normalizedSystemPrompt && normalizedSystemPrompt.includes(scheduledTaskPrompt)) {
    return normalizedSystemPrompt;
  }
  const sections = [scheduledTaskPrompt, normalizedSystemPrompt].filter(Boolean);
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

type CoworkImageAttachmentMain = {
  name: string;
  mimeType: string;
  base64Data: string;
  sizeBytes?: number;
  localPath?: string;
  previewMimeType?: string;
  previewBase64Data?: string;
};

function validateCoworkImageAttachmentsForRuntime(
  imageAttachments?: CoworkImageAttachmentMain[],
): { ok: true } | { ok: false; error: string } {
  for (const attachment of imageAttachments ?? []) {
    const validation = validateCoworkImageAttachmentSize(attachment);
    if (!validation.ok) {
      return {
        ok: false,
        error: `Image attachment ${attachment.name} exceeds the ${formatCoworkImageAttachmentLimit(validation.maxBytes)} limit.`,
      };
    }
  }
  return { ok: true };
}

function buildCoworkUserSelectionMetadata(options: {
  prompt?: string;
  skillIds?: string[];
  kitIds?: string[];
  kitReferences?: KitReference[];
  resolvedKitCapabilities?: ResolvedKitCapabilities;
  selectedTextSnippets?: CoworkSelectedTextSnippet[];
  browserAnnotations?: CoworkBrowserAnnotationMessageBatch[];
  imageAttachmentPreviews?: CoworkImageAttachmentPreview[];
}): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {
    ...(options.prompt ? buildGoalSettingMessageMetadata(options.prompt) : undefined),
  };

  if (options.skillIds?.length) {
    metadata.skillIds = options.skillIds;
  }
  if (options.kitIds?.length) {
    metadata.kitIds = options.kitIds;
    if (options.kitReferences?.length) {
      metadata.kitReferences = options.kitReferences;
    }
    if (options.resolvedKitCapabilities) {
      metadata.resolvedKitCapabilities = options.resolvedKitCapabilities;
    }
  }
  if (options.imageAttachmentPreviews?.length) {
    metadata.imageAttachmentPreviews = options.imageAttachmentPreviews;
  }
  if (options.selectedTextSnippets?.length) {
    metadata.selectedTextSnippets = options.selectedTextSnippets;
  }
  if (options.browserAnnotations?.length) {
    metadata.browserAnnotations = options.browserAnnotations;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function normalizeSelectedTextSnippetsForIpc(value: unknown): CoworkSelectedTextSnippet[] {
  const result = normalizeCoworkSelectedTextSnippets(value);
  if (result.success === false) {
    throw new Error(`Invalid selected text snippets: ${result.error}`);
  }
  return result.snippets;
}

// 获取正确的预加载脚本路径
const PRELOAD_PATH = app.isPackaged
  ? path.join(__dirname, 'preload.js')
  : path.join(__dirname, '../dist-electron/preload.js');

const BROWSER_ANNOTATION_PRELOAD_PATH = app.isPackaged
  ? path.join(__dirname, 'browserAnnotationPreload.js')
  : path.join(__dirname, '../dist-electron/browserAnnotationPreload.js');

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

const getNotificationIconPath = (): string | null => {
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'app-icon/512x512.png'),
        path.join(process.resourcesPath, 'icon.icns'),
      ]
    : [
        path.join(__dirname, 'build/icons/png/512x512.png'),
        path.join(__dirname, '../build/icons/png/512x512.png'),
      ];
  return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
};

// 保存对主窗口的引用
let mainWindow: BrowserWindow | null = null;
let dataMigrationRestoreWindow: BrowserWindow | null = null;
let desktopNotificationManager: DesktopNotificationManager | null = null;
let ensureMainWindowForReason: ((reason: string) => BrowserWindow | null) | null = null;
let isOpenSessionFromNotificationReady = false;
let pendingOpenSessionFromNotificationId: string | null = null;

const flushOpenSessionFromNotification = (): void => {
  if (!pendingOpenSessionFromNotificationId || !isOpenSessionFromNotificationReady) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isLoadingMainFrame()) return;

  const sessionId = pendingOpenSessionFromNotificationId;
  pendingOpenSessionFromNotificationId = null;
  console.log(`[DesktopNotification] opening session ${sessionId} from notification`);
  mainWindow.webContents.send(CoworkIpcChannel.OpenSessionFromNotification, { sessionId });
};

const focusMainWindowForReason = (reason: string): void => {
  const targetWindow = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow
    : ensureMainWindowForReason?.(reason) ?? null;
  if (!targetWindow || targetWindow.isDestroyed()) {
    console.warn(`[Main] no main window was available after ${reason}`);
    return;
  }
  try {
    if (targetWindow.isMinimized()) targetWindow.restore();
    if (!targetWindow.isVisible()) targetWindow.show();
    if (!targetWindow.isFocused()) targetWindow.focus();
    if (process.platform === 'darwin') {
      app.focus({ steal: true });
    }
    console.log(`[Main] focused main window after ${reason}`);
  } catch (error) {
    console.warn(`[Main] failed to focus main window after ${reason}:`, error);
  }
};

let isQuitting = false;
let isDataMigrationRestoreInProgress = false;
let isHidingMainWindowAfterFullScreen = false;

const hideMainWindowForClose = (win: BrowserWindow): void => {
  if (win.isDestroyed()) return;

  if (!isMac || !win.isFullScreen()) {
    console.log(`[Main] hiding main window for close, platform=${process.platform}, fullscreen=${win.isFullScreen()}, maximized=${win.isMaximized()}, visible=${win.isVisible()}`);
    win.hide();
    return;
  }

  if (isHidingMainWindowAfterFullScreen) {
    console.log('[Main] hide after full-screen close is already pending');
    return;
  }

  console.log('[Main] main window close requested while macOS full-screen; leaving full-screen before hiding');
  isHidingMainWindowAfterFullScreen = true;
  let settled = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  const finish = (source: 'leave-full-screen' | 'timeout') => {
    if (settled) return;
    settled = true;
    isHidingMainWindowAfterFullScreen = false;
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    if (!win.isDestroyed()) {
      console.log(`[Main] hiding main window after macOS full-screen exit, source=${source}, fullscreen=${win.isFullScreen()}, visible=${win.isVisible()}`);
      win.hide();
    }
  };

  win.once('leave-full-screen', () => {
    setTimeout(() => finish('leave-full-screen'), 100);
  });
  fallbackTimer = setTimeout(() => finish('timeout'), 1_500);
  try {
    win.setFullScreen(false);
  } catch (error) {
    console.warn('[Main] failed to leave macOS full-screen before hiding main window:', error);
    finish('timeout');
  }
};

// 存储活跃的流式请求控制器
const activeStreamControllers = new Map<string, AbortController>();

// Media generation selection and authenticated owner per session turn.
const mediaSelectionBySession = new Map<string, AccountBoundValue<MediaSelectionState>>();
const mediaTurnAccountScopeBySession = new Map<string, MediaAccountScope>();
let resolveCurrentMediaAccountScope = (): MediaAccountScope | null => null;

// Media attachment references per session (for @ mentions, FR-9)
const mediaReferencesBySession = new Map<string, MediaAttachmentRefMain[]>();
const persistedGeneratedImageAssetsByUrl = new Map<string, PersistedGeneratedImageAsset>();
const persistedGeneratedVideoAssetsByUrl = new Map<string, PersistedGeneratedImageAsset>();

const resolveGeneratedMediaAssetMimeType = (mediaType: 'image' | 'video', url: string): string => {
  if (mediaType === 'image') {
    return inferImageMimeTypeFromDataUrl(url) || 'image/png';
  }
  return 'video/mp4';
};

// Async video task polling (FR-8)
interface MediaTaskTracker {
  taskId: string;
  sessionId: string;
  mediaType: 'image' | 'video';
  model: string;
  ownerAccountKey: string;
  accountGeneration: number;
  startedAt: number;
  pollCount: number;
  timeoutMs: number;
  lastPollAt?: number;
}
const pendingMediaTasks = new Map<string, MediaTaskTracker>();
const mediaTaskOwnerById = new Map<string, string>();
const mediaStatusPollCounts = new Map<string, number>();
const mediaTasksHandledByStatusPolling = new Set<string>();
let mediaTaskPollTimer: ReturnType<typeof setInterval> | null = null;
let mediaTaskPollInFlight = false;
const MEDIA_POLL_FAST_MS = 10_000;
const MEDIA_POLL_SLOW_MS = 30_000;
const MEDIA_POLL_MEDIUM_MS = 120_000;
const MEDIA_POLL_IDLE_MS = 600_000;
const MEDIA_POLL_FAST_COUNT = 6;
const MEDIA_POLL_SLOW_COUNT = 18;
const MEDIA_POLL_MEDIUM_COUNT = 10;
const MEDIA_TASK_DEFAULT_TIMEOUT_MS = 172_800_000;
const TERMINAL_MEDIA_TASK_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

const rememberMediaTaskOwnership = (
  ownerAccountKey: string,
  ...taskIds: unknown[]
): void => {
  rememberMediaTaskOwnerAliases(mediaTaskOwnerById, ownerAccountKey, taskIds);
};

const resolveMediaTaskOwner = (taskId: unknown): string | undefined => {
  const normalizedTaskId = String(taskId ?? '').trim();
  if (!normalizedTaskId) return undefined;
  return pendingMediaTasks.get(normalizedTaskId)?.ownerAccountKey
    ?? mediaTaskOwnerById.get(normalizedTaskId);
};

const normalizeOptionalMediaModelId = (modelId: string | undefined): string | undefined => {
  const canonicalModelId = canonicalizeMediaModelId(modelId);
  return canonicalModelId || undefined;
};

const normalizeMediaSelectionState = (selection?: MediaSelectionState): MediaSelectionState | undefined => {
  if (!selection) return undefined;
  const normalized: MediaSelectionState = {
    ...selection,
    modelId: normalizeOptionalMediaModelId(selection.modelId),
    imageModelId: normalizeOptionalMediaModelId(selection.imageModelId),
    videoModelId: normalizeOptionalMediaModelId(selection.videoModelId),
  };
  const displayModelId = normalized.modelId || normalized.imageModelId || normalized.videoModelId;
  if (displayModelId) {
    normalized.modelName = mediaModelDisplayName(displayModelId, selection.modelName);
  }
  return normalized;
};

const resolveMediaSelectionForSession = (sessionId: string | null): MediaSelectionState | undefined => {
  let current = sessionId?.trim() || null;
  const seen = new Set<string>();

  for (let depth = 0; current && depth < 16; depth++) {
    if (seen.has(current)) return undefined;
    seen.add(current);

    const selection = normalizeMediaSelectionState(resolveAccountBoundValue(
      mediaSelectionBySession.get(current),
      resolveCurrentMediaAccountScope(),
    ));
    if (selection && selection.mode !== 'none') {
      return selection;
    }

    try {
      current = getCoworkParentSessionId(getStore().getDatabase(), current);
    } catch (error) {
      console.warn('[MediaGeneration] failed to resolve parent media selection:', error);
      return undefined;
    }
  }

  return undefined;
};

const resolveMediaTurnAccountScopeForSession = (
  sessionId: string | null,
): MediaAccountScope | null => {
  let current = sessionId?.trim() || null;
  const seen = new Set<string>();

  for (let depth = 0; current && depth < 16; depth++) {
    if (seen.has(current)) return null;
    seen.add(current);

    const scope = mediaTurnAccountScopeBySession.get(current);
    if (scope) return scope;

    try {
      current = getCoworkParentSessionId(getStore().getDatabase(), current);
    } catch (error) {
      console.warn('[MediaGeneration] failed to resolve parent turn account scope:', error);
      return null;
    }
  }

  return null;
};

const getSkinRuntimeController = (): SkinRuntimeController => {
  if (!skinRuntimeController) {
    skinRuntimeController = new SkinRuntimeController({
      rootDir: path.join(app.getPath('userData'), 'skins'),
      getInstalledKits: () => (
        getStore().get<Record<string, InstalledKitRecord>>(KitStoreKey.Installed) ?? {}
      ),
      getParentSessionId: sessionId => (
        getCoworkParentSessionId(getStore().getDatabase(), sessionId)
      ),
      resolveSessionId: sessionKey => (
        resolveCoworkSessionIdByOpenClawSessionKey(getStore().getDatabase(), sessionKey)
      ),
      resolveMediaSelection: resolveMediaSelectionForSession,
      onChanged: notifySkinChanged,
    });
  }
  return skinRuntimeController;
};

const mediaModelIdForOutput = (model: unknown, fallback?: string): string => {
  const rawModel = typeof model === 'string' && model.trim() ? model : fallback;
  return mediaModelDisplayName(rawModel, rawModel) || 'default';
};

type HappyHorse11Selection = {
  type: 't2v' | 'i2v' | 'r2v';
  upstreamModel: string;
  reason: string;
  imageCount: number;
};

const isHappyHorse11Model = (modelId: string): boolean =>
  canonicalizeMediaModelId(modelId) === HAPPYHORSE_1_1_MODEL_ID;

const addImageInputValue = (values: Set<string>, value: unknown): void => {
  if (value == null) return;
  if (Array.isArray(value)) {
    value.forEach(item => addImageInputValue(values, item));
    return;
  }
  const text = String(value).trim();
  if (text) values.add(text);
};

const nestedMediaUrl = (value: unknown): unknown => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return (value as Record<string, unknown>).url;
  }
  return value;
};

const addImageMediaItems = (values: Set<string>, media: unknown): void => {
  if (!Array.isArray(media)) return;
  for (const item of media) {
    if (typeof item === 'string') {
      addImageInputValue(values, item);
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const mediaType = typeof record.type === 'string' ? record.type.toLowerCase() : '';
    if (mediaType.includes('video') || mediaType.includes('audio')) continue;
    addImageInputValue(values, record.url ?? nestedMediaUrl(record.image_url));
  }
};

const countVideoImageInputs = (params: Record<string, unknown>): number => {
  const images = new Set<string>();
  addImageInputValue(images, params.images);
  addImageInputValue(images, params.imageUrls);
  addImageInputValue(images, params.referenceImages);
  addImageInputValue(images, params.firstFrame);
  addImageInputValue(images, params.first_frame);
  addImageInputValue(images, params.firstFrameImage);
  addImageInputValue(images, params.first_frame_image);
  addImageInputValue(images, params.image);
  addImageInputValue(images, params.imageUrl);
  addImageInputValue(images, params.image_url);
  addImageInputValue(images, params.referenceImage);
  addImageInputValue(images, params.lastFrame);
  addImageInputValue(images, params.last_frame);
  addImageInputValue(images, params.lastFrameImage);
  addImageInputValue(images, params.last_frame_image);
  addImageMediaItems(images, params.media);

  const providerOptions = params.providerOptions;
  if (providerOptions && typeof providerOptions === 'object' && !Array.isArray(providerOptions)) {
    addImageMediaItems(images, (providerOptions as Record<string, unknown>).media);
  }
  const input = params.input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    addImageMediaItems(images, (input as Record<string, unknown>).media);
  }

  return images.size;
};

const resolveHappyHorse11Selection = (
  modelId: string,
  params: Record<string, unknown>,
): HappyHorse11Selection | null => {
  if (!isHappyHorse11Model(modelId)) return null;
  const imageCount = countVideoImageInputs(params);
  if (imageCount === 0) {
    return {
      type: 't2v',
      upstreamModel: 'happyhorse-1.1-t2v',
      reason: '未检测到输入图片，使用文生视频子模型 happyhorse-1.1-t2v',
      imageCount,
    };
  }
  if (imageCount === 1) {
    return {
      type: 'i2v',
      upstreamModel: 'happyhorse-1.1-i2v',
      reason: '检测到 1 张输入图片，使用图生视频子模型 happyhorse-1.1-i2v',
      imageCount,
    };
  }
  return {
    type: 'r2v',
    upstreamModel: 'happyhorse-1.1-r2v',
    reason: `检测到 ${imageCount} 张输入图片，使用参考生视频子模型 happyhorse-1.1-r2v`,
    imageCount,
  };
};

type MediaStatusPollUpdate = {
  sessionId: string;
  toolCallId: string;
  details: Record<string, unknown>;
};
let lastReloadAt = 0;
const MIN_RELOAD_INTERVAL_MS = 5000;
type AppConfigSettings = {
  api?: unknown;
  app?: Record<string, unknown>;
  model?: unknown;
  providers?: Record<string, unknown>;
  shortcuts?: Record<string, unknown>;
  theme?: string;
  language?: string;
  useSystemProxy?: boolean;
  sqliteAutoBackupEnabled?: boolean;
  usageAnalyticsEnabled?: boolean;
  notificationSettings?: Partial<NotificationSettings>;
  browserWebAccess?: Partial<BrowserWebAccessConfig>;
};

const getUseSystemProxyFromConfig = (config?: { useSystemProxy?: boolean }): boolean => {
  return config?.useSystemProxy === true;
};

const hasBrowserWebAccessConfigChanged = (
  previousConfig?: AppConfigSettings,
  nextConfig?: AppConfigSettings,
): boolean => {
  return JSON.stringify(normalizeBrowserWebAccessConfig(previousConfig?.browserWebAccess)) !==
    JSON.stringify(normalizeBrowserWebAccessConfig(nextConfig?.browserWebAccess));
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

const MEDIA_STATUS_POLL_KEY_SEPARATOR = '\u0000';

const getMediaStatusPollKey = (
  sessionId: string | null,
  ownerAccountKey: string,
  taskId: string,
): string => (
  [sessionId ?? 'unknown', ownerAccountKey, taskId].join(MEDIA_STATUS_POLL_KEY_SEPARATOR)
);

const incrementMediaStatusPollCount = (
  sessionId: string | null,
  ownerAccountKey: string,
  taskId: string,
): number => {
  const key = getMediaStatusPollKey(sessionId, ownerAccountKey, taskId);
  const nextCount = (mediaStatusPollCounts.get(key) ?? 0) + 1;
  mediaStatusPollCounts.set(key, nextCount);
  return nextCount;
};

const markMediaTaskHandledByStatusPolling = (
  sessionId: string,
  ownerAccountKey: string,
  taskId: string,
): void => {
  mediaTasksHandledByStatusPolling.add(getMediaStatusPollKey(sessionId, ownerAccountKey, taskId));
  const tracker = pendingMediaTasks.get(taskId);
  if (tracker?.ownerAccountKey === ownerAccountKey) {
    pendingMediaTasks.delete(taskId);
  }
};

const isMediaTaskHandledByStatusPolling = (
  sessionId: string,
  ownerAccountKey: string,
  taskId: string,
): boolean => (
  mediaTasksHandledByStatusPolling.has(getMediaStatusPollKey(sessionId, ownerAccountKey, taskId))
);

const clearMediaStatusPollCountsForSession = (sessionId: string): void => {
  const prefix = `${sessionId}${MEDIA_STATUS_POLL_KEY_SEPARATOR}`;
  for (const key of mediaStatusPollCounts.keys()) {
    if (key.startsWith(prefix)) {
      mediaStatusPollCounts.delete(key);
    }
  }
};

const clearHandledMediaTasksForSession = (sessionId: string): void => {
  const prefix = `${sessionId}${MEDIA_STATUS_POLL_KEY_SEPARATOR}`;
  for (const key of mediaTasksHandledByStatusPolling) {
    if (key.startsWith(prefix)) {
      mediaTasksHandledByStatusPolling.delete(key);
    }
  }
};

const clearMediaPollingStateForOwner = (ownerAccountKey: string): void => {
  const ownerSegment = `${MEDIA_STATUS_POLL_KEY_SEPARATOR}${ownerAccountKey}${MEDIA_STATUS_POLL_KEY_SEPARATOR}`;
  for (const [taskId, tracker] of pendingMediaTasks) {
    if (tracker.ownerAccountKey === ownerAccountKey) {
      pendingMediaTasks.delete(taskId);
    }
  }
  for (const key of mediaStatusPollCounts.keys()) {
    if (key.includes(ownerSegment)) {
      mediaStatusPollCounts.delete(key);
    }
  }
  for (const key of mediaTasksHandledByStatusPolling) {
    if (key.includes(ownerSegment)) {
      mediaTasksHandledByStatusPolling.delete(key);
    }
  }
  clearMediaTaskOwnerAliasesForOwner(mediaTaskOwnerById, ownerAccountKey);
};

const emitMediaStatusPollUpdate = (update: MediaStatusPollUpdate): void => {
  BrowserWindow.getAllWindows().forEach(win => {
    if (win.isDestroyed()) return;
    win.webContents.send(CoworkIpcChannel.MediaStatusPollUpdate, update);
  });
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

const windowStatePersist = createWindowStatePersistManager({
  getMainWindow: () => mainWindow,
  getStore,
});

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

const EDIT_CONTEXT_FORM_CONTROLS = new Set<ContextMenuParams['formControlType']>([
  'input-email',
  'input-number',
  'input-password',
  'input-search',
  'input-telephone',
  'input-text',
  'input-url',
  'text-area',
]);

const shouldShowEditContextMenu = (params: ContextMenuParams): boolean =>
  params.isEditable && EDIT_CONTEXT_FORM_CONTROLS.has(params.formControlType);

const hasReadOnlySelection = (params: ContextMenuParams): boolean =>
  !params.isEditable && params.selectionText.length > 0;

const shouldShowTextContextMenu = (params: ContextMenuParams): boolean =>
  shouldShowEditContextMenu(params) || hasReadOnlySelection(params);

const installEditContextMenu = (webContents: WebContents) => {
  webContents.on('context-menu', (_event, params) => {
    if (!shouldShowTextContextMenu(params)) return;

    const isEditContext = shouldShowEditContextMenu(params);

    const template: MenuItemConstructorOptions[] = [];

    template.push(
      { label: t('contextMenuCut'), role: 'cut', enabled: isEditContext && params.editFlags.canCut },
      { label: t('contextMenuCopy'), role: 'copy', enabled: isEditContext ? params.editFlags.canCopy : true },
      { label: t('contextMenuPaste'), role: 'paste', enabled: isEditContext && params.editFlags.canPaste },
      { type: 'separator' },
      { label: t('contextMenuSelectAll'), role: 'selectAll', enabled: isEditContext && params.editFlags.canSelectAll },
    );

    const targetWindow = BrowserWindow.fromWebContents(webContents);
    if (!targetWindow || targetWindow.isDestroyed()) return;

    try {
      Menu.buildFromTemplate(template).popup({
        window: targetWindow,
        x: params.x,
        y: params.y,
      });
    } catch (error) {
      console.warn('[Main] failed to show edit context menu:', error);
    }
  });
  console.log('[Main] edit context menu installed for main window.');
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
  if (!app.isPackaged) {
    // In dev mode, setAsDefaultProtocolClient needs the electron exe path
    // and the app entry point as extra args so the OS can relaunch correctly
    app.setAsDefaultProtocolClient('lobsterai', process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  } else {
    app.setAsDefaultProtocolClient('lobsterai');
  }

  const authCallbackRouter = new AuthCallbackRouter({
    getTarget: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return null;
      return mainWindow.webContents;
    },
    onParseError: error => {
      console.error('[Main] Failed to parse deep link:', error);
    },
  });

  /**
   * Parse a lobsterai:// deep link and send (or buffer) the auth code.
   */
  const handleDeepLink = (url: string) => {
    authCallbackRouter.handleDeepLink(url);
  };

  // First-frame gate for window activation. Showing a window whose renderer
  // has never painted produces a stuck plain-white window (field case: slow
  // first load after install while security software scans the fresh files,
  // user clicks the desktop icon, second-instance force-showed the blank
  // window). Activation requests arriving before the first frame are queued
  // and honored from ready-to-show / did-finish-load.
  let hasRenderedFirstFrame = false;
  let pendingShowOnFirstFrame = false;

  const focusMainWindow = (reason: string) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      if (!mainWindow.isVisible() && !hasRenderedFirstFrame) {
        pendingShowOnFirstFrame = true;
        console.log(`[Main] deferred showing main window after ${reason}: renderer has not painted yet`);
        return;
      }
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.moveTop();
      if (!mainWindow.isFocused()) mainWindow.focus();
      if (process.platform === 'darwin') {
        app.focus({ steal: true });
      }
      if (process.platform === 'win32') {
        const wasAlwaysOnTop = mainWindow.isAlwaysOnTop();
        mainWindow.setAlwaysOnTop(true, 'normal');
        mainWindow.show();
        mainWindow.focus();
        mainWindow.setAlwaysOnTop(wasAlwaysOnTop, 'normal');
        mainWindow.flashFrame(false);
      }
      console.log(`[Main] focused main window after ${reason}`);
    } catch (error) {
      console.warn(`[Main] failed to focus main window after ${reason}:`, error);
    }
  };

  ipcMain.on('log:fromRenderer', (_event, level: string, tag: string, message: string) => {
    const fn = level === 'error' ? console.error
      : level === 'warn' ? console.warn
        : level === 'debug' ? console.debug
          : console.log;
    // Keep renderer diagnostics useful without allowing an accidental large
    // payload or malformed tag to inflate the main-process log indefinitely.
    const safeTag = (typeof tag === 'string' ? tag : 'Unknown')
      .replace(/[^a-zA-Z0-9_.-]/g, '_')
      .slice(0, 64) || 'Unknown';
    const safeMessage = (typeof message === 'string' ? message : String(message ?? ''))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2_000);
    fn(`[Renderer][${safeTag}] ${safeMessage}`);
  });

  // Allow renderer to retrieve a buffered auth code on init
  ipcMain.handle(AuthIpcChannel.GetPendingCallback, () =>
    authCallbackRouter.markListenerReadyAndConsumePending());

  // macOS: handle open-url event for deep links
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.on('second-instance', (_event, commandLine, workingDirectory) => {
    console.debug('[Main] second-instance event', { commandLine, workingDirectory });
    if (isDataMigrationRestoreInProgress) {
      console.log('[DataMigration] ignored second-instance activation while restore is in progress.');
      return;
    }

    // Check for deep link in command line args (Windows/Linux)
    const deepLink = commandLine.find(arg => arg.startsWith('lobsterai://'));
    if (deepLink) {
      handleDeepLink(deepLink);
    }

    focusMainWindow('second instance activation');
  });

  // IPC 处理程序
  // One-shot arrival log: renderer startup has stalled on this invoke in the
  // field, and this line tells whether the request reached the main process.
  let firstStoreGetLogged = false;
  ipcMain.handle('store:get', (_event, key) => {
    if (!firstStoreGetLogged) {
      firstStoreGetLogged = true;
      console.log(`[Main] first store:get IPC received from renderer, key=${String(key)}`);
    }
    return getStore().get(key);
  });

  ipcMain.handle('store:set', async (_event, key, value) => {
    const previousAppConfig = key === 'app_config'
      ? getStore().get<AppConfigSettings>('app_config')
      : undefined;
    getStore().set(key, value);
    if (key === 'app_config') {
      const nextAppConfig = value as AppConfigSettings | undefined;
      const previousNotificationSettings = normalizeNotificationSettings(
        previousAppConfig?.notificationSettings,
      );
      const nextNotificationSettings = normalizeNotificationSettings(
        nextAppConfig?.notificationSettings,
      );
      if (
        previousNotificationSettings.taskCompletionNotificationMode !== TaskCompletionNotificationMode.Off &&
        nextNotificationSettings.taskCompletionNotificationMode === TaskCompletionNotificationMode.Off
      ) {
        getDesktopNotificationManager().clearAllCompletions('task completion notifications disabled');
      }
      if (
        previousNotificationSettings.permissionNotificationsEnabled &&
        !nextNotificationSettings.permissionNotificationsEnabled
      ) {
        getDesktopNotificationManager().closeWaitingNotifications(
          WaitingNotificationKind.Permission,
          'permission notifications disabled',
        );
      }
      if (
        previousNotificationSettings.questionNotificationsEnabled &&
        !nextNotificationSettings.questionNotificationsEnabled
      ) {
        getDesktopNotificationManager().closeWaitingNotifications(
          WaitingNotificationKind.Question,
          'question notifications disabled',
        );
      }
      const browserWebAccessChanged = hasBrowserWebAccessConfigChanged(previousAppConfig, nextAppConfig);
      const systemProxyChanged = getUseSystemProxyFromConfig(previousAppConfig) !==
        getUseSystemProxyFromConfig(nextAppConfig);
      refreshEndpointsTestMode(getStore());
      const impactDecision = classifyAppConfigChange(previousAppConfig, value);
      const proxyChanged = impactDecision.reasons.includes(OpenClawConfigImpactReason.AppUseSystemProxy);
      const actionDecision = removeImpactDecisionReasons(impactDecision, [
        OpenClawConfigImpactReason.AppUseSystemProxy,
      ]);

      if (proxyChanged && getOpenClawEngineManager().getStatus().phase === 'running') {
        console.log('[OpenClaw] Deferred app_config sync to the system proxy watcher.');
        return;
      }

      const shouldSyncOpenClawConfig = actionDecision.impact !== OpenClawConfigImpact.None || browserWebAccessChanged;
      let syncResult: Awaited<ReturnType<typeof syncOpenClawConfig>> | null = null;
      if (shouldSyncOpenClawConfig) {
        syncResult = await syncOpenClawConfig({
          reason: 'app-config-change',
          restartGatewayIfRunning: actionDecision.impact === OpenClawConfigImpact.Restart,
        });
        if (!syncResult.success) {
          console.error('[OpenClaw] Failed to sync config after app_config update:', syncResult.error);
        }
      }
      if (syncResult?.success && browserWebAccessChanged && !systemProxyChanged && actionDecision.impact !== OpenClawConfigImpact.Restart) {
        const engineStatus = getOpenClawEngineManager().getStatus();
        if (engineStatus.phase === 'running') {
          console.log(`${gwDiagTs()} browser access settings changed, restarting gateway`);
          void getOpenClawEngineManager().restartGateway('browser-access-settings-change');
        }
      }
    }
  });

  ipcMain.handle('store:remove', (_event, key) => {
    getStore().delete(key);
  });

  ipcMain.handle('enterprise:getConfig', () => {
    try {
      return {
        success: true as const,
        config: getStore().get('enterprise_config') ?? null,
      };
    } catch (error) {
      console.error('[Enterprise] failed to read enterprise UI config:', error);
      throw error;
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

  ipcMain.handle('log:exportZip', async event => {
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
          ...getRecentComputerUseLogEntries(),
          ...manager.getRecentGatewayLogEntries(),
          ...getRecentOpenClawDailyLogEntries(manager.getOpenClawDailyLogDir()),
          ...(process.platform === 'win32'
            ? [
                {
                  archiveName: 'install-timing.log',
                  filePath: path.join(app.getPath('appData'), 'LobsterAI', 'install-timing.log'),
                },
              ]
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
  ipcMain.handle(AppSettingsIpc.GetAutoLaunch, () => {
    const stored = getStore().get<boolean>('auto_launch_enabled');
    try {
      const status = getAutoLaunchStatus();
      if (stored !== undefined && stored !== status.enabled) {
        console.warn(
          `[AutoLaunch] stored state (${stored}) differs from OS state (${status.enabled}); ${formatAutoLaunchStatusForLog(status)}`,
        );
        getStore().set('auto_launch_enabled', status.enabled);
      }
      return { enabled: status.enabled };
    } catch (error) {
      console.error('[AutoLaunch] failed to read OS state; falling back to stored state:', error);
      return { enabled: stored ?? false };
    }
  });

  ipcMain.handle(AppSettingsIpc.SetAutoLaunch, (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      return { success: false, error: 'Invalid parameter: enabled must be boolean' };
    }
    try {
      setAutoLaunchEnabled(enabled);
      const status = getAutoLaunchStatus();
      console.log(
        `[AutoLaunch] set requested=${enabled}, actual=${status.enabled}; ${formatAutoLaunchStatusForLog(status)}`,
      );
      if (status.enabled !== enabled) {
        return {
          success: false,
          enabled: status.enabled,
          errorCode: status.status === 'requires-approval'
            ? AppSettingsAutoLaunchErrorCode.RequiresApproval
            : AppSettingsAutoLaunchErrorCode.UpdateFailed,
        };
      }
      getStore().set('auto_launch_enabled', status.enabled);
      return { success: true, enabled: status.enabled };
    } catch (error) {
      console.error('[AutoLaunch] failed to update auto-launch setting:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set auto-launch',
      };
    }
  });

  ipcMain.handle(AppSettingsIpc.GetPreventSleep, () => {
    const enabled = getStore().get<boolean>('prevent_sleep_enabled') ?? false;
    return { enabled };
  });

  ipcMain.handle(AppSettingsIpc.SetPreventSleep, (_event, enabled: unknown) => {
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

  ipcMain.handle('app:relaunch', () => {
    console.log('[Main] app:relaunch requested, scheduling restart...');
    app.relaunch();
    app.quit();
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

  ipcMain.on('window-close', (event) => {
    console.log(`[Main] window-close IPC received from renderer, url=${event.sender.getURL()}`);
    mainWindow?.close();
  });

  ipcMain.handle('window:isMaximized', () => {
    return mainWindow?.isMaximized() ?? false;
  });

  ipcMain.on(
    'window:showSystemMenu',
    (_event, position: { x?: number; y?: number } | undefined) => {
      showSystemMenu(position);
    },
  );

  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:getSystemLocale', () => app.getLocale());
  ipcMain.handle(AppIpcChannel.GetKeyfromAttribution, () => getKeyfromAttribution(getStore()));

  ipcMain.handle(AppIpcChannel.OpenSystemNotificationSettings, async () => {
    try {
      let url: string | null = null;
      if (process.platform === 'darwin') {
        // Deep link into this app's notification permission pane. Unpackaged
        // dev builds have no notification registration to open.
        if (!app.isPackaged) return { success: false, error: 'Unavailable in development builds' };
        url = `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${encodeURIComponent(APP_USER_MODEL_ID)}`;
      } else if (process.platform === 'win32') {
        url = 'ms-settings:notifications';
      }
      if (!url) return { success: false, error: 'Unsupported platform' };
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      console.warn('[DesktopNotification] failed to open system notification settings:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to open system notification settings',
      };
    }
  });

  // ── Auth IPC handlers ──

  let authAccountGeneration = 0;
  let authExchangeIntentSequence = 0;
  let activeAuthExchangeIntent: AuthExchangeIntentSnapshot | null = null;

  /**
   * Helper: Persist auth tokens into the kv store.
   */
  const saveAuthTokens = (accessToken: string, refreshToken: string) => {
    getStore().set('auth_tokens', { accessToken, refreshToken });
  };

  const getAuthTokens = (): { accessToken: string; refreshToken: string } | null => {
    return getStore().get<{ accessToken: string; refreshToken: string }>('auth_tokens') || null;
  };

  const captureAuthStateSnapshot = (): AuthStateSnapshot | null => {
    const tokens = getAuthTokens();
    return tokens
      ? {
        accountGeneration: authAccountGeneration,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      }
      : null;
  };

  const isCurrentAuthStateSnapshot = (snapshot: AuthStateSnapshot | null): boolean => (
    snapshot !== null
    && isAuthStateSnapshotCurrent(snapshot, authAccountGeneration, getAuthTokens())
  );

  const clearAuthTokens = () => {
    getStore().delete('auth_tokens');
  };

  const getEnterpriseAccountHeaders = (): Record<string, string> => (
    buildEnterpriseAccountRequestHeaders(
      getPersistedEnterpriseAccountContext(getStore()),
    )
  );

  const getAuthUser = (): Record<string, unknown> | null => {
    try {
      return getStore().get<Record<string, unknown>>(LogReporterStoreKey.AuthUser) || null;
    } catch (error) {
      console.warn('[Auth] failed to read cached auth user:', error);
      return null;
    }
  };

  const saveAuthUser = (user: Record<string, unknown>) => {
    try {
      getStore().set(LogReporterStoreKey.AuthUser, user);
    } catch (error) {
      console.warn('[Auth] failed to save auth user for attribution:', error);
    }
  };

  const getCurrentMediaAccountScope = (): MediaAccountScope | null => {
    if (!getAuthTokens()) return null;
    try {
      const user = getStore().get<Record<string, unknown>>(LogReporterStoreKey.AuthUser);
      const enterpriseContext = getPersistedEnterpriseAccountContext(getStore());
      if (
        !enterpriseContext
        && (
          user?.accountMode === EnterpriseAccountMode.Enterprise
          || cachedSubscriptionStatus === AuthSubscriptionStatus.Enterprise
        )
      ) {
        return null;
      }
      const ownerAccountKey = createAccountOwnerKey({
        user,
        enterpriseId: enterpriseContext?.enterpriseId,
      });
      return ownerAccountKey
        ? { ownerAccountKey, accountGeneration: authAccountGeneration }
        : null;
    } catch (error) {
      console.warn('[MediaGeneration] failed to resolve authenticated account owner:', error);
      return null;
    }
  };
  resolveCurrentMediaAccountScope = getCurrentMediaAccountScope;

  const captureEnterpriseAuthSessionSnapshot = (
    accountScope = getCurrentMediaAccountScope(),
  ) => createEnterpriseAuthSessionSnapshot(
    accountScope,
    getPersistedEnterpriseAccountContext(getStore())?.enterpriseId,
  );

  const handleEnterpriseMembershipRevocation = createEnterpriseMembershipRevocationHandler({
    getCurrentSession: captureEnterpriseAuthSessionSnapshot,
    invalidateCurrentSession: (event) => {
      console.warn(
        '[EnterpriseAccount] invalidating revoked enterprise auth session '
        + `source=${event.source} code=${event.code} `
        + `generation=${event.requestSession?.accountGeneration ?? 'unknown'}`,
      );
      clearLocalAuthSession({
        reason: AuthSessionChangeReason.EnterpriseMembershipRevoked,
        notifyRenderer: true,
      });
    },
  });

  const notifyAuthQuotaChanged = (): void => {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) win.webContents.send(AuthIpcChannel.QuotaChanged);
    });
  };

  const handleEnterpriseAccountContextMismatch = (
    code: number,
    requestAccountScope: MediaAccountScope | null,
  ): boolean => {
    if (code === EnterpriseApiErrorCode.NotMember) {
      return handleEnterpriseMembershipRevocation({
        code,
        source: EnterpriseMembershipRevocationSource.JsonApi,
        requestSession: captureEnterpriseAuthSessionSnapshot(requestAccountScope),
      });
    }

    const currentAccountScope = getCurrentMediaAccountScope();
    if (
      code !== EnterpriseApiErrorCode.AccountModeMismatch
      || !getAuthTokens()
      || !isMediaAccountScopeSnapshotCurrent(requestAccountScope, currentAccountScope)
    ) {
      return false;
    }

    authExchangeIntentSequence += 1;
    activeAuthExchangeIntent = null;
    authAccountGeneration += 1;
    const quotaGateChanged = (
      cachedSubscriptionStatus !== AuthSubscriptionStatus.Free
      || cachedMediaGenerationEntitled
    );
    cachedSubscriptionStatus = AuthSubscriptionStatus.Free;
    cachedMediaGenerationEntitled = false;
    clearAuthTokens();
    clearAuthUser();
    clearEnterpriseAccountContext(getStore());
    clearServerModelMetadata();
    mediaSelectionBySession.clear();
    mediaTurnAccountScopeBySession.clear();
    mediaReferencesBySession.clear();
    if (requestAccountScope) {
      clearMediaPollingStateForOwner(requestAccountScope.ownerAccountKey);
    }
    if (pendingMediaTasks.size === 0) {
      stopMediaPollTimer();
    }
    syncOpenClawConfig({
      reason: 'enterprise-account-context-invalidated',
      restartGatewayIfRunning: quotaGateChanged,
    }).catch(error => {
      console.warn('[EnterpriseAccount] failed to sync OpenClaw after context invalidation:', error);
    });

    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send(EnterpriseAccountIpcChannel.ContextInvalidated);
      }
    });

    const dialogOptions = {
      type: 'warning' as const,
      title: t('enterpriseAccountContextMismatchTitle'),
      message: t('enterpriseAccountContextMismatchMessage'),
      buttons: [t('enterpriseAccountContextMismatchConfirm')],
    };
    const ownerWindow = BrowserWindow.getFocusedWindow()
      ?? (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);
    const prompt = ownerWindow
      ? dialog.showMessageBox(ownerWindow, dialogOptions)
      : dialog.showMessageBox(dialogOptions);
    void prompt.catch(error => {
      console.warn('[EnterpriseAccount] failed to show account context mismatch prompt:', error);
    });
    console.warn(
      `[EnterpriseAccount] invalidated account context and media polling after server code ${code}`,
    );
    return true;
  };

  const getAuthUserId = (): string | null => {
    try {
      const user = getAuthUser();
      const yid = user?.yid;
      if (typeof yid === 'string' && yid.trim()) return yid;
      const userId = user?.userId;
      if (typeof userId === 'string' && userId.trim()) return userId;
    } catch (error) {
      console.warn('[Auth] failed to read auth user for attribution:', error);
    }
    return null;
  };

  const clearAuthUser = () => {
    try {
      getStore().delete(LogReporterStoreKey.AuthUser);
    } catch (error) {
      console.warn('[Auth] failed to clear auth user for attribution:', error);
    }
  };

  const getOrCreateInstallationId = (): string | null => {
    try {
      const existing = getStore().get<string>(INSTALLATION_UUID_KEY);
      if (typeof existing === 'string' && existing.trim()) {
        return existing;
      }
      const nextId = crypto.randomUUID();
      getStore().set(INSTALLATION_UUID_KEY, nextId);
      return nextId;
    } catch (error) {
      console.warn('[Auth] failed to get installation uuid:', error);
      return null;
    }
  };

  const buildKeyfromPayload = (): {
    firstKeyfrom: string;
    latestKeyfrom: string;
    uuid?: string;
    userId?: string;
    version: string;
  } => {
    const { firstKeyfrom, latestKeyfrom } = getKeyfromAttribution(getStore());
    const uuid = getOrCreateInstallationId();
    const userId = getAuthUserId();
    return {
      firstKeyfrom,
      latestKeyfrom,
      ...(uuid ? { uuid } : {}),
      ...(userId ? { userId } : {}),
      version: app.getVersion(),
    };
  };

  const withKeyfromBody = <T extends Record<string, unknown>>(body: T) => ({
    ...body,
    ...buildKeyfromPayload(),
  });

  const appendKeyfromQuery = (url: string): string => {
    const parsed = new URL(url);
    const payload = buildKeyfromPayload();
    for (const [key, value] of Object.entries(payload)) {
      if (value) {
        parsed.searchParams.set(key, String(value));
      }
    }
    return parsed.toString();
  };

  const emitAuthLifecycleEvent = (event: AuthLifecycleEvent): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(AuthIpcChannel.LifecycleEvent, event);
    }
  };

  const emitAuthSessionChanged = (event: AuthSessionChangedEvent): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(AuthIpcChannel.SessionChanged, event);
      }
    }
  };

  const getAuthSessionKey = (): string | null => {
    if (!getAuthTokens()) return null;
    const scope = getCurrentMediaAccountScope();
    return `${scope?.ownerAccountKey ?? 'unresolved'}:${authAccountGeneration}`;
  };

  const authSessionManager = new AuthSessionManager({
    getTokens: getAuthTokens,
    getSessionKey: getAuthSessionKey,
    saveTokens: tokens => saveAuthTokens(tokens.accessToken, tokens.refreshToken),
    fetch: (url, options) => {
      const headers = new Headers(options?.headers);
      for (const [name, value] of Object.entries(getEnterpriseAccountHeaders())) {
        headers.set(name, value);
      }
      return net.fetch(url, {
        ...options,
        headers,
      });
    },
    getRefreshUrl: () => `${getServerApiBaseUrl()}/api/auth/refresh`,
    buildRefreshRequestBody: refreshToken => JSON.stringify(withKeyfromBody({ refreshToken })),
    onTerminalFailure: (result) => {
      if (result.errorCode === EnterpriseApiErrorCode.NotMember) {
        handleEnterpriseMembershipRevocation({
          code: result.errorCode,
          source: EnterpriseMembershipRevocationSource.Refresh,
          requestSession: captureEnterpriseAuthSessionSnapshot(),
        });
        return;
      }
      clearLocalAuthSession({
        reason: AuthSessionChangeReason.RefreshRejected,
        notifyRenderer: true,
      });
    },
    onRefreshSuccess: result => {
      syncOpenClawConfig({
        reason: `token-refresh:${result.reason}`,
        restartGatewayIfRunning: false,
      }).catch((error) => {
        console.warn('[Auth] post-refresh OpenClaw config sync failed:', error);
      });
    },
    onLifecycleEvent: emitAuthLifecycleEvent,
    log: {
      info: message => console.log(message),
      warn: (message, error) => {
        if (error === undefined) {
          console.warn(message);
        } else {
          console.warn(message, error);
        }
      },
    },
  });
  waitForPendingTokenRefresh = () => authSessionManager.waitForPendingRefresh();

  const fetchWithAuth = async (url: string, options?: RequestInit): Promise<Response> => {
    const requestEnterpriseSession = captureEnterpriseAuthSessionSnapshot();
    const response = await authSessionManager.fetchWithAuth(url, options);
    if (
      requestEnterpriseSession
      && response.headers.get('content-type')?.includes('application/json')
    ) {
      try {
        const code = readEnterpriseApiErrorCode(await response.clone().json());
        if (code === EnterpriseApiErrorCode.NotMember) {
          handleEnterpriseMembershipRevocation({
            code,
            source: resolveEnterpriseMembershipRevocationSource(url),
            requestSession: requestEnterpriseSession,
          });
        }
      } catch {
        // The original response remains available to the endpoint-specific parser.
      }
    }
    return response;
  };

  type AvailableServerModel = ServerModelMetadataInput & {
    modelId: string;
    modelName: string;
    provider: string;
    apiFormat: string;
    costMultiplier?: number;
    description?: string;
    moreModel?: boolean;
    accessible?: boolean;
    restrictionHint?: string;
  };

  const loadAvailableServerModels = async (options: {
    reason: string;
    awaitConfigSync?: boolean;
    forceConfigSync?: boolean;
  }): Promise<AvailableServerModel[]> => {
    const requestAccountGeneration = authAccountGeneration;
    const requestAccountScope = getCurrentMediaAccountScope();
    const serverBaseUrl = getServerApiBaseUrl();
    const url = appendKeyfromQuery(`${serverBaseUrl}/api/models/available`);
    console.log(`[Auth:getModels] requesting available models at ${url}`);
    const resp = await fetchWithAuth(url, {
      headers: buildServerModelCapabilityHeaders(app.getVersion()),
    });
    console.log('[Auth:getModels] Response status:', resp.status);
    if (!resp.ok) {
      throw new Error(`Server model request failed with HTTP ${resp.status}.`);
    }

    const responseAuthState = captureAuthStateSnapshot();
    const data = (await resp.json()) as {
      code: number;
      message?: string;
      data?: AvailableServerModel[];
    };
    if (
      authAccountGeneration !== requestAccountGeneration
      || !isCurrentAuthStateSnapshot(responseAuthState)
      || !isMediaAccountScopeSnapshotCurrent(
        requestAccountScope,
        getCurrentMediaAccountScope(),
      )
    ) {
      throw new Error('Account changed while loading server models');
    }
    if (handleEnterpriseAccountContextMismatch(data.code ?? -1, requestAccountScope)) {
      throw new Error('Enterprise account context changed while loading server models');
    }
    console.log('[Auth:getModels] Response data:', JSON.stringify(data).slice(0, 500));
    if (data.code !== 0 || !Array.isArray(data.data)) {
      throw new Error(data.message || 'Server model response is invalid.');
    }

    const serverModelsChanged = updateServerModelMetadata(data.data);
    const serverModelIds = data.data.map(model => model.modelId);
    const serverModelsMissingFromConfig = !openClawConfigHasServerModels(serverModelIds);
    const configSyncOptions = {
      metadataChanged: serverModelsChanged,
      modelsMissingFromConfig: serverModelsMissingFromConfig,
      forceConfigSync: options.forceConfigSync,
    };
    if (shouldSyncServerModelConfig(configSyncOptions)) {
      console.log(
        `[Auth:getModels] syncing OpenClaw config for ${serverModelIds.length} server model(s); `
        + `metadataChanged=${serverModelsChanged} missingFromConfig=${serverModelsMissingFromConfig} `
        + `forced=${options.forceConfigSync === true}`,
      );
      const syncPromise = syncServerModelConfigIfNeeded({
        ...configSyncOptions,
        sync: () => syncOpenClawConfig({
          reason: options.reason,
          restartGatewayIfRunning: false,
        }),
      });
      if (options.awaitConfigSync) {
        await syncPromise;
      } else {
        syncPromise.catch((error) => {
          console.warn('[Auth:getModels] failed to sync OpenClaw config after loading server models:', error);
        });
      }
    } else {
      console.debug('[Auth:getModels] server model metadata unchanged, skipping config sync');
    }

    return data.data.map((model) => {
      const metadata = getServerModelMetadata(model.modelId);
      return {
        ...model,
        runtimeProfile: metadata?.runtimeProfile,
        supportsImage: metadata?.supportsImage,
        supportsVideo: metadata?.supportsVideo,
        supportsThinking: metadata?.supportsThinking,
        thinkingConfig: metadata?.thinkingConfig,
        requestCapabilities: metadata?.requestCapabilities,
        supportsToolCalling: metadata?.supportsToolCalling,
        agenticReady: metadata?.agenticReady,
        contextWindow: metadata?.contextWindow,
        maxTokens: metadata?.maxTokens,
        explicitContextCache: metadata?.explicitContextCache,
      };
    });
  };

  let pendingServerModelPreflightRefresh: Promise<AvailableServerModel[]> | null = null;

  const refreshServerModelsForRunPreflight = (): Promise<AvailableServerModel[]> => {
    if (pendingServerModelPreflightRefresh) {
      return pendingServerModelPreflightRefresh;
    }
    pendingServerModelPreflightRefresh = loadAvailableServerModels({
      reason: 'server-model-run-preflight',
      awaitConfigSync: true,
      forceConfigSync: true,
    }).finally(() => {
      pendingServerModelPreflightRefresh = null;
    });
    return pendingServerModelPreflightRefresh;
  };

  const resolveCoworkRunModelRef = (options: {
    sessionId?: string;
    modelOverride?: string;
    agentId?: string;
  }): string => {
    const session = options.sessionId
      ? getCoworkStore().getSession(options.sessionId)
      : null;
    const agentId = options.agentId?.trim() || session?.agentId || 'main';
    const rawModelRef = options.modelOverride?.trim()
      || session?.modelOverride?.trim()
      || getAgentManager().getAgent(agentId)?.model?.trim()
      || resolveDefaultAgentModelRef();
    return rawModelRef?.trim() || '';
  };

  const getServerModelRunGateError = (reason: ServerModelRunGateReason): string => {
    switch (reason) {
      case ServerModelRunGateReason.MetadataMissing:
        return t('serverModelMetadataUnavailable');
      case ServerModelRunGateReason.RuntimeProfileMissing:
      case ServerModelRunGateReason.RuntimeProfileUnsupported:
      case ServerModelRunGateReason.TransportUnsupported:
        return t('serverModelRuntimeProfileUnsupported');
      case ServerModelRunGateReason.ToolCallingUnavailable:
        return t('serverModelToolCallingUnavailable');
      case ServerModelRunGateReason.AgenticNotReady:
        return t('serverModelAgenticNotReady');
    }
  };

  const ensureServerModelReadyForRun = async (
    modelRef: string,
  ): Promise<{ allowed: true } | { allowed: false; error: string }> => {
    const resolveRunModelRef = () => resolveServerModelRefForRun({
      modelRef,
      availableProviders: buildAvailableOpenClawProviders(),
      isKnownServerModelCandidate: isKnownPackageKimiK3ModelId,
    });
    const blockForUnavailableIdentity = (
      status: string,
      modelId: string,
      providerIds?: string[],
    ): { allowed: false; error: string } => {
      console.warn(
        `[Cowork] blocked server model run for "${modelId}"; `
        + `providerResolution=${status}`
        + (providerIds?.length ? ` providers=${providerIds.join(',')}` : ''),
      );
      return {
        allowed: false,
        error: t('serverModelMetadataUnavailable'),
      };
    };

    let resolution = resolveRunModelRef();
    let refreshed = false;
    if (resolution.status === ServerModelRefResolutionStatus.RefreshRequired) {
      try {
        await refreshServerModelsForRunPreflight();
        refreshed = true;
      } catch (error) {
        console.warn(
          `[Cowork] failed to refresh server model metadata before resolving "${resolution.modelId}":`,
          error,
        );
        return {
          allowed: false,
          error: t('serverModelMetadataUnavailable'),
        };
      }
      resolution = resolveRunModelRef();
    }

    if (resolution.status === ServerModelRefResolutionStatus.Ambiguous) {
      return blockForUnavailableIdentity(
        resolution.status,
        resolution.modelId,
        resolution.providerIds,
      );
    }
    if (resolution.status === ServerModelRefResolutionStatus.RefreshRequired) {
      return blockForUnavailableIdentity(resolution.status, resolution.modelId);
    }
    if (
      resolution.status === ServerModelRefResolutionStatus.NonServer
      || resolution.status === ServerModelRefResolutionStatus.Unresolved
    ) {
      return { allowed: true };
    }

    let gate = evaluateServerModelRunGate(resolution.modelId);
    const requiresFreshK3Metadata = gate.allowed === true
      && gate.metadata.runtimeProfile === ModelRuntimeProfile.MoonshotKimiK3;
    if (!refreshed && (gate.allowed === false || requiresFreshK3Metadata)) {
      try {
        await refreshServerModelsForRunPreflight();
        refreshed = true;
      } catch (error) {
        console.warn(
          `[Cowork] failed to refresh server model metadata before run for "${resolution.modelId}":`,
          error,
        );
        return {
          allowed: false,
          error: t('serverModelMetadataUnavailable'),
        };
      }
      const refreshedResolution = resolveRunModelRef();
      if (
        refreshedResolution.status !== ServerModelRefResolutionStatus.Server
        || refreshedResolution.modelId !== resolution.modelId
      ) {
        return blockForUnavailableIdentity(
          refreshedResolution.status,
          refreshedResolution.modelId,
          'providerIds' in refreshedResolution
            ? refreshedResolution.providerIds
            : undefined,
        );
      }
      resolution = refreshedResolution;
      gate = evaluateServerModelRunGate(resolution.modelId);
    }
    if (gate.allowed === true) {
      return { allowed: true };
    }

    console.warn(
      `[Cowork] blocked server model run for "${resolution.modelId}"; reason=${gate.reason}.`,
    );
    return {
      allowed: false,
      error: getServerModelRunGateError(gate.reason),
    };
  };

  const capturePublishingRequest = (): {
    accountScope: MediaAccountScope;
    scopedFetch: typeof fetchWithAuth;
  } => {
    const accountScope = getCurrentMediaAccountScope();
    if (accountScope === null) {
      throw new Error(t('authLoginRequired'));
    }
    return {
      accountScope,
      scopedFetch: createAccountScopedFetch(
        accountScope,
        getCurrentMediaAccountScope,
        fetchWithAuth,
      ),
    };
  };

  let pendingEnterpriseAccountContextRefresh: {
    generation: number;
    promise: ReturnType<typeof fetchEnterpriseAccountContext>;
  } | null = null;

  const refreshEnterpriseAccountContext = (): ReturnType<typeof fetchEnterpriseAccountContext> => {
    const generation = authAccountGeneration;
    const requestAccountScope = getCurrentMediaAccountScope();
    const requestEnterpriseSession = captureEnterpriseAuthSessionSnapshot(requestAccountScope);
    if (pendingEnterpriseAccountContextRefresh?.generation === generation) {
      return pendingEnterpriseAccountContextRefresh.promise;
    }

    const promise = fetchEnterpriseAccountContext({
      getServerBaseUrl: getServerApiBaseUrl,
      fetchWithAuth,
      store: getStore(),
      isRequestCurrent: () => authAccountGeneration === generation && getAuthTokens() !== null,
      onAccountModeMismatch: () => {
        handleEnterpriseAccountContextMismatch(
          EnterpriseApiErrorCode.AccountModeMismatch,
          requestAccountScope,
        );
      },
      onMembershipRevoked: () => {
        handleEnterpriseMembershipRevocation({
          code: EnterpriseApiErrorCode.NotMember,
          source: EnterpriseMembershipRevocationSource.EnterpriseContext,
          requestSession: requestEnterpriseSession,
        });
      },
    }).finally(() => {
      if (pendingEnterpriseAccountContextRefresh?.promise === promise) {
        pendingEnterpriseAccountContextRefresh = null;
      }
    });
    pendingEnterpriseAccountContextRefresh = { generation, promise };
    return promise;
  };

  const syncEnterpriseAccountContextFromPayload = async (
    payload: unknown,
  ) => {
    const context = normalizeEnterpriseAccountContext(payload);
    if (context) {
      persistEnterpriseAccountContext(getStore(), context);
      console.debug(`[EnterpriseAccount] applied context from auth payload for enterprise ${context.enterpriseId} with role ${context.role}`);
      return context;
    }

    if (readAccountMode(payload) === EnterpriseAccountMode.Personal) {
      clearEnterpriseAccountContext(getStore());
      console.debug('[EnterpriseAccount] cleared context from personal auth payload');
      return null;
    }

    const result = await refreshEnterpriseAccountContext();
    return result.context;
  };

  registerEnterpriseAccountHandlers({
    getContext: refreshEnterpriseAccountContext,
    getIdentities: () => {
      const generation = authAccountGeneration;
      return fetchEnterpriseAccountIdentities({
        getServerBaseUrl: getServerApiBaseUrl,
        fetchWithAuth,
        isRequestCurrent: () => authAccountGeneration === generation && getAuthTokens() !== null,
      });
    },
    requestQuotaIncrease: (enterpriseId, requestType) => {
      const currentContext = getPersistedEnterpriseAccountContext(getStore());
      if (!currentContext || currentContext.enterpriseId !== enterpriseId) {
        console.warn('[EnterpriseAccount] rejected quota request outside the current enterprise context');
        return Promise.resolve({
          success: false,
          error: 'Enterprise account context changed before the quota request',
        });
      }
      const generation = authAccountGeneration;
      return requestEnterpriseQuotaIncrease({
        getServerBaseUrl: getServerApiBaseUrl,
        fetchWithAuth,
        isRequestCurrent: () => authAccountGeneration === generation && getAuthTokens() !== null,
      }, enterpriseId, requestType);
    },
  });

  const extractSessionIdFromKey = (sessionKey: string): string | null =>
    resolveCoworkSessionIdByOpenClawSessionKey(getStore().getDatabase(), sessionKey);

  /**
   * Handle media generation tool callbacks from the OpenClaw plugin.
   */
  const handleMediaGenerationCallback = async (request: {
    tool: string;
    args: Record<string, unknown>;
    context: { sessionKey: string; toolCallId: string };
  }): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean; details?: Record<string, unknown> }> => {
    const { tool, args } = request;
    const skinRuntime = getSkinRuntimeController();
    if (skinRuntime.handlesTool(tool)) {
      return skinRuntime.handleToolRequest(request);
    }
    const action = (args.action as string) || 'generate';
    const serverBaseUrl = getServerApiBaseUrl();
    const sessionId = extractSessionIdFromKey(request.context.sessionKey);
    const requestAccountScope = resolveMediaTurnAccountScopeForSession(sessionId);
    const isRequestAccountCurrent = (): boolean => (
      requestAccountScope !== null
      && isMediaAccountScopeCurrent(requestAccountScope, getCurrentMediaAccountScope())
    );
    const staleAccountResult = () => ({
      content: [{
        type: 'text',
        text: t('authAccountChanged'),
      }],
      isError: true,
      details: { status: 'cancelled', warnings: ['MEDIA_ACCOUNT_CHANGED'] },
    });
    if (
      requestAccountScope === null
      || !isMediaAccountScopeCurrent(requestAccountScope, getCurrentMediaAccountScope())
    ) {
      return staleAccountResult();
    }
    const selection = resolveMediaSelectionForSession(sessionId);
    const prompt = typeof args.prompt === 'string' ? args.prompt : '';
    const explicitModel = canonicalizeMediaModelId(typeof args.model === 'string' ? args.model : '');
    const resolvedModelFromSelection = tool === MediaGenerationTool.Image
      ? canonicalizeMediaModelId(selection?.imageModelId || selection?.modelId || '')
      : canonicalizeMediaModelId(selection?.videoModelId || selection?.modelId || '');
    let selectedModel = explicitModel || resolvedModelFromSelection;
    let selectedModelSource = explicitModel ? 'tool' : resolvedModelFromSelection ? 'selection' : 'none';

    if (action === 'generate' && tool === MediaGenerationTool.Image) {
      const skinPreflight = await skinRuntime.preflightLobsterImageGeneration(
        sessionId,
        selection,
      );
      if (!isRequestAccountCurrent()) return staleAccountResult();
      if (skinPreflight) return skinPreflight;
    }

    if (action === 'generate' && resolvedModelFromSelection && explicitModel && explicitModel !== resolvedModelFromSelection) {
      console.warn(`[MediaGeneration] overriding LLM model choice "${explicitModel}" with user selection "${resolvedModelFromSelection}"`);
      selectedModel = resolvedModelFromSelection;
      selectedModelSource = 'selection-override';
    }
    console.log('[MediaGeneration] received tool request:', serializeForLog({
      tool,
      action,
      sessionId: sessionId ?? '',
      toolCallId: request.context.toolCallId,
      selectionMode: selection?.mode ?? 'none',
      selectedModel,
      selectedModelSource,
      promptLength: prompt.length,
      promptPreview: prompt.slice(0, 120),
    }));

    // Tool gating: for generate action, check if media selection allows this tool
    if (action === 'generate') {
      const gate = resolveMediaGenerationGate({ action, tool, selection });
      if (gate.allowed === false) {
        if (gate.reason === MediaGenerationGateReason.MediaNotEnabled) {
          console.warn('[MediaGeneration] blocked generate request because no media model was selected for this turn.');
        } else {
          console.warn('[MediaGeneration] blocked generate request because the selected turn model has a different media type.');
        }
        return {
          content: [{ type: 'text', text: gate.message }],
          isError: true,
          details: { status: 'failed', warnings: [gate.reason] },
        };
      }
    }

    try {
      if (action === 'list') {
        const mediaType = tool === MediaGenerationTool.Image ? 'image' : 'video';
        const endpoint = mediaType === 'image' ? '/api/media/images/models' : '/api/media/videos/models';
        console.log(`[MediaGeneration] listing ${mediaType} models from server.`);
        const resp = await fetchWithAuth(`${serverBaseUrl}${endpoint}`);
        console.log(`[MediaGeneration] server returned HTTP ${resp.status} for ${mediaType} model list.`);
        const body = await resp.json() as { code: number; data?: unknown[]; message?: string };
        if (!isRequestAccountCurrent()) return staleAccountResult();
        if (handleEnterpriseAccountContextMismatch(body.code, requestAccountScope)) {
          return {
            content: [{ type: 'text', text: t('enterpriseAccountContextMismatchMessage') }],
            isError: true,
          };
        }
        if (body.code !== 0) {
          console.warn('[MediaGeneration] server rejected model list request:', serializeForLog({ mediaType, code: body.code, message: body.message }));
          return { content: [{ type: 'text', text: body.message || 'Failed to list models.' }], isError: true };
        }
        const models = (body.data || []).map(model => {
          const mediaModel = model as { modelId?: string; displayName?: string };
          const modelId = canonicalizeMediaModelId(mediaModel.modelId);
          return {
            ...(model as Record<string, unknown>),
            modelId,
            displayName: mediaModelDisplayName(modelId, mediaModel.displayName),
          };
        });
        console.log(`[MediaGeneration] server returned ${models.length} ${mediaType} models.`);
        let text = models.length > 0
          ? `Available ${mediaType} models:\n\n${(models as Array<{ modelId: string; displayName: string; capabilities?: string; parameterSpec?: Record<string, unknown> }>).map(m => {
              let line = `### ${m.displayName} (model: "${m.modelId}")`;
              if (m.capabilities) line += `\n${m.capabilities}`;
              if (m.parameterSpec) line += `\nSupported parameters:\n${JSON.stringify(m.parameterSpec, null, 2)}`;
              return line;
            }).join('\n\n')}`
          : `No ${mediaType} models available.`;
        if (resolvedModelFromSelection) {
          text += `\n\n---\n**Note:** The user has already selected model "${resolvedModelFromSelection}" for this session. You MUST use this model for the generate action. Do NOT choose a different model.`;
        }
        return { content: [{ type: 'text', text }], details: { status: 'succeeded', models } };
      }

      if (action === 'status') {
        const taskId = args.taskId as string;
        if (!taskId) {
          console.warn('[MediaGeneration] blocked status request because taskId was missing.');
          return { content: [{ type: 'text', text: 'taskId is required for status action.' }], isError: true };
        }
        if (requestAccountScope === null) return staleAccountResult();
        const taskOwnerAccountKey = resolveMediaTaskOwner(taskId);
        if (!canAccessTrackedMediaTask(taskOwnerAccountKey, requestAccountScope)) {
          return staleAccountResult();
        }
        const pollCount = incrementMediaStatusPollCount(
          sessionId,
          requestAccountScope.ownerAccountKey,
          taskId,
        );
        const mediaType = tool === MediaGenerationTool.Image ? 'images' : 'videos';
        const statusMediaType = tool === MediaGenerationTool.Image ? 'image' : 'video';
        console.log(`[MediaGeneration] checking ${mediaType} task status for task ${taskId}.`);
        const resp = await fetchWithAuth(`${serverBaseUrl}/api/media/${mediaType}/tasks/${taskId}`);
        console.log(`[MediaGeneration] server returned HTTP ${resp.status} for ${mediaType} task status.`);
        const body = await resp.json() as { code: number; data?: Record<string, unknown>; message?: string };
        if (!isRequestAccountCurrent()) return staleAccountResult();
        if (handleEnterpriseAccountContextMismatch(body.code, requestAccountScope)) {
          return {
            content: [{ type: 'text', text: t('enterpriseAccountContextMismatchMessage') }],
            isError: true,
            details: {
              status: 'failed',
              warnings: ['ENTERPRISE_ACCOUNT_CONTEXT_MISMATCH'],
            },
          };
        }
        if (body.code !== 0) {
          console.warn('[MediaGeneration] server rejected task status request:', serializeForLog({ mediaType, taskId, code: body.code, message: body.message }));
          return { content: [{ type: 'text', text: body.message || 'Failed to get task status.' }], isError: true };
        }
        const task = body.data!;
        rememberMediaTaskOwnership(
          requestAccountScope.ownerAccountKey,
          task.taskId,
          task.upstreamTaskId,
        );
        const status = task.status as string;
        const resultUrls = (task.resultUrls as string[]) || [];
        const outputModel = mediaModelIdForOutput(task.model);
        const upstreamModel = typeof task.upstreamModel === 'string' && task.upstreamModel.trim()
          ? task.upstreamModel.trim()
          : undefined;
        const modelSelectionReason = typeof task.modelSelectionReason === 'string' && task.modelSelectionReason.trim()
          ? task.modelSelectionReason.trim()
          : undefined;
        if (sessionId && TERMINAL_MEDIA_TASK_STATUSES.has(status)) {
          markMediaTaskHandledByStatusPolling(
            sessionId,
            requestAccountScope.ownerAccountKey,
            taskId,
          );
        }
        const assets = resultUrls.map(url => ({
          type: statusMediaType,
          url,
          mimeType: resolveGeneratedMediaAssetMimeType(statusMediaType, url),
        }));

        let resultLines: string[];
        let detailsAssets: unknown[] = assets;
        if (status === 'succeeded' && statusMediaType === 'image' && sessionId) {
          const persistResult = await persistGeneratedImages(sessionId, assets);
          if (!isRequestAccountCurrent()) return staleAccountResult();
          if (persistResult && persistResult.saved.length > 0) {
            detailsAssets = persistResult.saved;
            resultLines = persistResult.saved.map(asset =>
              `  - [${asset.filename}](${pathToFileURL(asset.filePath).toString()})`
            );
          } else {
            resultLines = resultUrls.map((url, index) => `  - ![Generated image ${index + 1}](${url})`);
          }
        } else if (status === 'succeeded' && statusMediaType === 'video' && sessionId) {
          const persistResult = await persistGeneratedVideos(sessionId, assets);
          if (!isRequestAccountCurrent()) return staleAccountResult();
          if (persistResult && persistResult.saved.length > 0) {
            detailsAssets = persistResult.saved;
            resultLines = persistResult.saved.map(asset =>
              `  - [${asset.filename}](${pathToFileURL(asset.filePath).toString()})`
            );
          } else {
            resultLines = resultUrls.map(url => `  - ${url}`);
          }
        } else {
          resultLines = statusMediaType === 'image'
            ? resultUrls.map((_url, index) => `  - Generated image ${index + 1}`)
            : resultUrls.map(url => `  - ${url}`);
        }

        const lines = [
          `Task ID: ${task.upstreamTaskId || task.taskId}`,
          `Model: ${outputModel}`,
          ...(upstreamModel ? [`Selected model: ${upstreamModel}`] : []),
          ...(modelSelectionReason ? [`Selection reason: ${modelSelectionReason}`] : []),
          `Status: ${status}`,
          ...(task.progress ? [`Progress: ${task.progress}%`] : []),
          ...(resultUrls.length > 0 ? [`Results:\n${resultLines.join('\n')}`] : []),
          ...(task.errorMessage ? [`Error: ${task.errorMessage}`] : []),
        ];
        const details = {
          taskId: String(task.taskId),
          ...(task.upstreamTaskId ? { upstreamTaskId: String(task.upstreamTaskId) } : {}),
          status,
          ...(pollCount > 1 ? { pollCount } : {}),
          model: outputModel,
          ...(upstreamModel ? { upstreamModel } : {}),
          ...(modelSelectionReason ? { modelSelectionReason } : {}),
          mediaType: statusMediaType,
          ...(detailsAssets.length > 0 ? { assets: detailsAssets } : {}),
          ...(task.quotaRemaining != null ? { billing: { quotaRemaining: task.quotaRemaining } } : {}),
        };
        if (sessionId) {
          emitMediaStatusPollUpdate({
            sessionId,
            toolCallId: request.context.toolCallId,
            details,
          });
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          details,
        };
      }

      if (action === 'cancel' && tool === MediaGenerationTool.Video) {
        const taskId = args.taskId as string;
        if (!taskId) {
          console.warn('[MediaGeneration] blocked cancel request because taskId was missing.');
          return { content: [{ type: 'text', text: 'taskId is required for cancel action.' }], isError: true };
        }
        if (requestAccountScope === null) return staleAccountResult();
        const taskOwnerAccountKey = resolveMediaTaskOwner(taskId);
        if (!canAccessTrackedMediaTask(taskOwnerAccountKey, requestAccountScope)) {
          return staleAccountResult();
        }
        console.log(`[MediaGeneration] cancelling video task ${taskId}.`);
        const resp = await fetchWithAuth(`${serverBaseUrl}/api/media/videos/tasks/${taskId}/cancel`, { method: 'POST' });
        console.log(`[MediaGeneration] server returned HTTP ${resp.status} for video task cancel.`);
        const body = await resp.json() as { code: number; message?: string };
        if (!isRequestAccountCurrent()) return staleAccountResult();
        if (handleEnterpriseAccountContextMismatch(body.code, requestAccountScope)) {
          return {
            content: [{ type: 'text', text: t('enterpriseAccountContextMismatchMessage') }],
            isError: true,
          };
        }
        if (body.code !== 0) {
          console.warn('[MediaGeneration] server rejected task cancel request:', serializeForLog({ taskId, code: body.code, message: body.message }));
          return { content: [{ type: 'text', text: body.message || 'Failed to cancel task.' }], isError: true };
        }
        return {
          content: [{ type: 'text', text: `Task ${taskId} cancelled successfully.` }],
          details: { taskId, status: 'cancelled' },
        };
      }

      // action === 'generate'
      const mediaType = tool === MediaGenerationTool.Image ? 'image' : 'video';
      const endpoint = mediaType === 'image' ? '/api/media/images/generate' : '/api/media/videos/generate';

      // Video generation confirmation: inform user about cost and duration
      if (mediaType === 'video') {
        const durationSec = typeof args.durationSeconds === 'number' ? args.durationSeconds : null;
        const costPoints = durationSec ? durationSec * 100 : null;
        const portalTasksUrl = getPortalTasksUrl();
        const subtitle = costPoints
          ? `本次生成大约预计消耗 **${costPoints}** 积分`
          : '费用约为 **100** 积分/秒';
        const questionText = [
          '请确认当前描述无误，提交后将无法取消。',
          '视频生成任务耗时较长，请耐心等待。',
          '',
          `生成后请妥善保存视频，若误删可在[「个人主页-用量详情-生成任务」](${portalTasksUrl})中下载`,
          '~~（链接有时效性，请尽快下载）~~',
        ].join('\n');
        const confirmResponse = await getMcpRuntime().askUserInternal(
          [{
            question: questionText,
            title: '确认生成视频？',
            subtitle,
            options: [
              { label: '确认生成', description: '开始视频生成任务' },
              { label: '取消', description: '暂不生成' },
            ],
          }],
          undefined,
          { sessionKey: request.context.sessionKey },
        );

        const userCancelled = confirmResponse?.behavior === 'deny'
          || confirmResponse?.answers?.[questionText] === '取消';

        if (!isRequestAccountCurrent()) return staleAccountResult();
        if (userCancelled) {
          console.log('[MediaGeneration] user cancelled video generation confirmation.');
          return {
            content: [{ type: 'text', text: 'Video generation cancelled by user.' }],
            isError: true,
            details: { status: 'cancelled', reason: 'USER_CANCELLED' },
          };
        }
      }

      let params: Record<string, unknown> = {};
      if (args.image) {
        const existing = (args.images as string[]) || [];
        params.images = [args.image as string, ...existing];
      } else if (args.images) {
        params.images = args.images;
      }
      if (args.imageRoles) params.imageRoles = args.imageRoles;
      if (args.firstFrame) params.firstFrame = args.firstFrame;
      if (args.lastFrame) params.lastFrame = args.lastFrame;
      if (args.referenceImages) params.referenceImages = args.referenceImages;
      if (args.media) params.media = args.media;
      if (args.video) {
        const existing = (args.videos as string[]) || [];
        params.videos = [args.video as string, ...existing];
      } else if (args.videos) {
        params.videos = args.videos;
      }
      if (args.videoRoles) params.videoRoles = args.videoRoles;
      if (args.aspectRatio) params.aspectRatio = args.aspectRatio;
      if (args.resolution) params.resolution = args.resolution;
      if (args.size) params.size = args.size;
      if (mediaType === 'image') {
        if (args.n != null) params.n = args.n;
        if (args.quality) params.quality = args.quality;
        if (args.outputFormat) params.outputFormat = args.outputFormat;
        if (args.output_format) params.output_format = args.output_format;
        if (args.temperature != null) params.temperature = args.temperature;
        if (args.imageSize) params.imageSize = args.imageSize;
      }
      if (args.count) params.count = args.count;
      if (args.durationSeconds != null) params.durationSeconds = args.durationSeconds;
      if (args.audio != null) params.audio = args.audio;
      if (args.watermark != null) params.watermark = args.watermark;
      if (args.seed != null) params.seed = args.seed;
      if (args.returnLastFrame != null) params.returnLastFrame = args.returnLastFrame;
      if (args.cameraFixed != null) params.cameraFixed = args.cameraFixed;
      if (args.filename) params.filename = args.filename;
      if (args.providerOptions) {
        params.providerOptions = args.providerOptions;
        const providerOptions = args.providerOptions;
        if (providerOptions && typeof providerOptions === 'object' && !Array.isArray(providerOptions)) {
          const rawMedia = (providerOptions as Record<string, unknown>).media;
          if (!params.media && Array.isArray(rawMedia)) {
            params.media = rawMedia;
          }
        }
      }

      const refs = sessionId ? mediaReferencesBySession.get(sessionId) : undefined;
      params = applyMediaReferencesToGenerationParams({
        mediaType: mediaType === MediaGenerationRequestType.Video
          ? MediaGenerationRequestType.Video
          : MediaGenerationRequestType.Image,
        params,
        refs,
      });

      // Convert local file paths to data URLs
      const MEDIA_MIME: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
        '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
      };
      const resolveRef = async (ref: string): Promise<string> => {
        if (!ref || ref.startsWith('http') || ref.startsWith('oss://') || ref.startsWith('data:')) return ref;
        const filePath = ref.startsWith('file://') ? fileURLToPath(ref) : path.resolve(ref);
        const buf = await fs.promises.readFile(filePath);
        const mime = MEDIA_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
        return `data:${mime};base64,${buf.toString('base64')}`;
      };
      const resolveStringParam = async (name: string) => {
        if (typeof params[name] === 'string') {
          params[name] = await resolveRef(params[name] as string);
        }
      };
      const resolveStringArrayParam = async (name: string) => {
        if (Array.isArray(params[name])) {
          params[name] = await Promise.all((params[name] as string[]).map(resolveRef));
        }
      };
      const resolveMediaItem = async (item: unknown): Promise<unknown> => {
        if (typeof item === 'string') {
          return resolveRef(item);
        }
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return item;
        }
        const next: Record<string, unknown> = { ...(item as Record<string, unknown>) };
        if (typeof next.url === 'string') {
          next.url = await resolveRef(next.url);
        }
        for (const key of ['image_url', 'video_url', 'audio_url']) {
          const nested = next[key];
          if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
            const nestedRecord = nested as Record<string, unknown>;
            if (typeof nestedRecord.url === 'string') {
              next[key] = { ...nestedRecord, url: await resolveRef(nestedRecord.url) };
            }
          }
        }
        return next;
      };
      if (Array.isArray(params.images)) {
        params.images = await Promise.all((params.images as string[]).map(resolveRef));
      }
      await resolveStringParam('firstFrame');
      await resolveStringParam('lastFrame');
      await resolveStringArrayParam('referenceImages');
      if (Array.isArray(params.videos)) {
        params.videos = await Promise.all((params.videos as string[]).map(resolveRef));
      }
      if (Array.isArray(params.media)) {
        params.media = await Promise.all((params.media as unknown[]).map(resolveMediaItem));
      }

      const inferVideoGenerationType = (): string => {
        const normalizedModel = selectedModel.toLowerCase();
        if (normalizedModel.includes('happyhorse-1.1-r2v')) return 'r2v';
        if (normalizedModel.includes('happyhorse-1.1-t2v')) return 't2v';
        if (normalizedModel.includes('happyhorse-1.1-i2v')) return 'i2v';
        if (normalizedModel.includes('happyhorse-1.0-r2v')) return 'r2v';
        if (normalizedModel.includes('happyhorse-1.0-t2v')) return 't2v';
        if (normalizedModel.includes('happyhorse-1.0-i2v')) return 'i2v';

        const imageRoles = Array.isArray(params.imageRoles)
          ? (params.imageRoles as unknown[]).map(role => String(role).toLowerCase())
          : [];
        const mediaItems = Array.isArray(params.media) ? params.media as unknown[] : [];
        const mediaTypes = mediaItems
          .filter(item => item && typeof item === 'object' && !Array.isArray(item))
          .map(item => String((item as Record<string, unknown>).type || '').toLowerCase());
        const hasReferenceImage = (Array.isArray(params.referenceImages) && (params.referenceImages as unknown[]).length > 0)
          || imageRoles.some(role => role === 'reference_image' || role === 'reference')
          || mediaTypes.some(type => type === 'reference_image');
        if (hasReferenceImage) return 'r2v';

        const hasFirstFrame = typeof params.firstFrame === 'string'
          || imageRoles.some(role => role === 'first_frame' || role === 'firstframe')
          || mediaTypes.some(type => type === 'first_frame')
          || (Array.isArray(params.images) && (params.images as unknown[]).length > 0);
        return hasFirstFrame ? 'i2v' : 't2v';
      };

      const happyHorse11Selection = mediaType === 'video'
        ? resolveHappyHorse11Selection(selectedModel, params)
        : null;
      const generateReq = {
        model: selectedModel,
        type: mediaType === 'video'
          ? (happyHorse11Selection?.type ?? inferVideoGenerationType())
          : mediaType,
        prompt,
        params,
      };

      console.log('[MediaGeneration] sending generate request to server:', serializeForLog({
        endpoint,
        mediaType,
        selectedModel,
        selectedModelSource,
        ...(happyHorse11Selection ? {
          upstreamModel: happyHorse11Selection.upstreamModel,
          modelSelectionReason: happyHorse11Selection.reason,
          inputImageCount: happyHorse11Selection.imageCount,
        } : {}),
        promptLength: prompt.length,
        promptPreview: prompt.slice(0, 120),
        params: summarizeMediaGenerationParamsForLog(params),
      }));
      if (!isRequestAccountCurrent()) return staleAccountResult();
      const idempotencyKey = crypto.randomUUID();
      const resp = await fetchWithAuth(`${serverBaseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(generateReq),
      });
      console.log(`[MediaGeneration] server returned HTTP ${resp.status} for ${mediaType} generate request.`);
      const body = await resp.json() as { code: number; data?: Record<string, unknown>; message?: string };
      if (!isRequestAccountCurrent()) return staleAccountResult();
      if (handleEnterpriseAccountContextMismatch(body.code, requestAccountScope)) {
        return {
          content: [{ type: 'text', text: t('enterpriseAccountContextMismatchMessage') }],
          isError: true,
          details: {
            status: 'failed',
            warnings: ['ENTERPRISE_ACCOUNT_CONTEXT_MISMATCH'],
          },
        };
      }

      const enterpriseQuotaError = resolveEnterpriseQuotaError(body.code, body.message);
      if (enterpriseQuotaError) {
        console.warn('[MediaGeneration] server rejected generate request because enterprise quota is unavailable:', serializeForLog({
          mediaType,
          selectedModel,
          code: enterpriseQuotaError.code,
          reason: enterpriseQuotaError.reason,
          message: body.message,
        }));
        notifyAuthQuotaChanged();
        const message = body.message?.trim() || t('enterpriseMediaQuotaUnavailable');
        return {
          content: [{
            type: 'text',
            text: `${message} (error ${enterpriseQuotaError.code})`,
          }],
          isError: true,
          details: {
            status: 'failed',
            [EnterpriseQuotaMessageMetadataKey.ErrorCode]: enterpriseQuotaError.code,
            [EnterpriseQuotaMessageMetadataKey.Reason]: enterpriseQuotaError.reason,
            warnings: [enterpriseQuotaError.reason],
          },
        };
      }
      if (body.code === 40203) {
        console.warn('[MediaGeneration] server rejected generate request because subscription is required.');
        return {
          content: [{ type: 'text', text: 'Media generation requires an active subscription. Please subscribe to use this feature.' }],
          isError: true,
          details: { status: 'failed', warnings: ['MEDIA_SUBSCRIPTION_REQUIRED'] },
        };
      }
      if (body.code === 40204) {
        console.warn('[MediaGeneration] server rejected generate request because quota was exhausted.');
        return {
          content: [{ type: 'text', text: 'Media generation quota exhausted for this period. Please wait for quota reset or upgrade your plan.' }],
          isError: true,
          details: { status: 'failed', warnings: ['MEDIA_QUOTA_EXHAUSTED'] },
        };
      }
      if (body.code !== 0) {
        console.warn('[MediaGeneration] server rejected generate request:', serializeForLog({ mediaType, selectedModel, code: body.code, message: body.message }));
        return {
          content: [{ type: 'text', text: body.message || 'Media generation request failed.' }],
          isError: true,
          details: { status: 'failed', warnings: [body.message || 'Unknown error'] },
        };
      }

      const task = body.data!;
      rememberMediaTaskOwnership(
        requestAccountScope.ownerAccountKey,
        task.taskId,
        task.upstreamTaskId,
      );
      const status = task.status as string;
      const resultUrls = (task.resultUrls as string[]) || [];
      const outputModel = mediaModelIdForOutput(task.model, selectedModel);
      const upstreamModel = typeof task.upstreamModel === 'string' && task.upstreamModel.trim()
        ? task.upstreamModel.trim()
        : happyHorse11Selection?.upstreamModel;
      const modelSelectionReason = typeof task.modelSelectionReason === 'string' && task.modelSelectionReason.trim()
        ? task.modelSelectionReason.trim()
        : happyHorse11Selection?.reason;
      console.log('[MediaGeneration] server accepted generate request:', serializeForLog({
        mediaType,
        taskId: task.taskId,
        status,
        model: outputModel,
        upstreamModel,
        modelSelectionReason,
        resultCount: resultUrls.length,
        quotaRemaining: task.quotaRemaining,
      }));
      const assets = resultUrls.map(url => ({
        type: mediaType,
        url,
        mimeType: resolveGeneratedMediaAssetMimeType(mediaType, url),
        ...(args.filename ? { filename: args.filename as string } : {}),
      }));
      let detailsAssets: unknown[] = assets;

      const billing: Record<string, unknown> = {};
      if (task.quotaRemaining != null) billing.quotaRemaining = task.quotaRemaining;
      if (mediaType === 'image') {
        if (args.count) billing.frozenImages = args.count;
        else if (args.n) billing.frozenImages = args.n;
      } else {
        if (args.durationSeconds) billing.frozenVideoSeconds = args.durationSeconds;
      }

      const lines = [
        `${mediaType === 'image' ? 'Image' : 'Video'} generation task created.`,
        `Task ID: ${task.upstreamTaskId || task.taskId}`,
        `Model: ${outputModel}`,
        ...(upstreamModel ? [`Selected model: ${upstreamModel}`] : []),
        ...(modelSelectionReason ? [`Selection reason: ${modelSelectionReason}`] : []),
        `Status: ${status}`,
        ...(task.quotaRemaining != null ? [`Quota remaining: ${task.quotaRemaining}`] : []),
      ];

      if (status === 'succeeded' && mediaType === 'image' && sessionId) {
        const persistResult = await persistGeneratedImages(sessionId, assets);
        if (!isRequestAccountCurrent()) return staleAccountResult();
        if (persistResult && persistResult.saved.length > 0) {
          detailsAssets = persistResult.saved;
          const fileLines = persistResult.saved.map(asset =>
            `  - [${asset.filename}](${pathToFileURL(asset.filePath).toString()})`
          );
          lines.push(`Results:\n${fileLines.join('\n')}`);
        } else if (assets.length > 0) {
          const resultLines = resultUrls.map((url, index) => `  - ![Generated image ${index + 1}](${url})`);
          lines.push(`Results:\n${resultLines.join('\n')}`);
        }
      } else if (status === 'succeeded' && mediaType === 'video' && sessionId) {
        const persistResult = await persistGeneratedVideos(sessionId, assets);
        if (!isRequestAccountCurrent()) return staleAccountResult();
        if (persistResult && persistResult.saved.length > 0) {
          detailsAssets = persistResult.saved;
          const fileLines = persistResult.saved.map(asset =>
            `  - [${asset.filename}](${pathToFileURL(asset.filePath).toString()})`
          );
          lines.push(`Results:\n${fileLines.join('\n')}`);
        } else if (assets.length > 0) {
          const resultLines = resultUrls.map(url => `  - ${url}`);
          lines.push(`Results:\n${resultLines.join('\n')}`);
        }
      } else if (status === 'succeeded' && assets.length > 0) {
        const resultLines = resultUrls.map(url => `  - ${url}`);
        lines.push(`Results:\n${resultLines.join('\n')}`);
      }

      // Register async media tasks for background polling if not already completed.
      if (status !== 'succeeded' && status !== 'failed' && status !== 'cancelled') {
        if (sessionId && requestAccountScope && isRequestAccountCurrent()) {
          const metadata = task.metadata as Record<string, unknown> | undefined;
          const expiresAfterSec = metadata?.execution_expires_after ?? task.execution_expires_after;
          const timeoutMs = typeof expiresAfterSec === 'number' && expiresAfterSec > 0
            ? expiresAfterSec * 1000
            : MEDIA_TASK_DEFAULT_TIMEOUT_MS;
          registerMediaTaskForPolling({
            taskId: String(task.taskId),
            sessionId,
            mediaType,
            model: upstreamModel || outputModel,
            ownerAccountKey: requestAccountScope.ownerAccountKey,
            accountGeneration: requestAccountScope.accountGeneration,
            startedAt: Date.now(),
            pollCount: 0,
            timeoutMs,
          });
        }
      }

      if (!isRequestAccountCurrent()) return staleAccountResult();
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: {
          taskId: String(task.taskId),
          ...(task.upstreamTaskId ? { upstreamTaskId: String(task.upstreamTaskId) } : {}),
          status,
          model: outputModel,
          ...(upstreamModel ? { upstreamModel } : {}),
          ...(modelSelectionReason ? { modelSelectionReason } : {}),
          ...(detailsAssets.length > 0 ? { assets: detailsAssets } : {}),
          ...(Object.keys(billing).length > 0 ? { billing } : {}),
        },
      };
    } catch (error) {
      if (!isRequestAccountCurrent()) return staleAccountResult();
      const msg = error instanceof Error ? error.message : String(error);
      if (msg === 'No auth tokens') {
        console.warn('[MediaGeneration] blocked media generation because the user is not logged in.');
        return { content: [{ type: 'text', text: t('authLoginRequired') }], isError: true };
      }
      console.error('[MediaGeneration] media generation request failed:', error);
      return { content: [{ type: 'text', text: `Media generation error: ${msg}` }], isError: true };
    }
  };

  getMcpRuntime().setMediaGenerationHandler(handleMediaGenerationCallback);

  const registerMediaTaskForPolling = (tracker: MediaTaskTracker) => {
    rememberMediaTaskOwnership(tracker.ownerAccountKey, tracker.taskId);
    pendingMediaTasks.set(tracker.taskId, tracker);
    ensureMediaPollTimerRunning();
  };

  const ensureMediaPollTimerRunning = () => {
    if (mediaTaskPollTimer) return;
    mediaTaskPollTimer = setInterval(() => {
      if (mediaTaskPollInFlight) return;
      mediaTaskPollInFlight = true;
      void pollPendingMediaTasks().catch(error => {
        console.warn('[MediaGeneration] pending task polling cycle failed:', error);
      }).finally(() => {
        mediaTaskPollInFlight = false;
      });
    }, MEDIA_POLL_FAST_MS);
  };

  const stopMediaPollTimer = () => {
    if (mediaTaskPollTimer) {
      clearInterval(mediaTaskPollTimer);
      mediaTaskPollTimer = null;
    }
  };

  const pollPendingMediaTasks = async () => {
    if (pendingMediaTasks.size === 0) {
      stopMediaPollTimer();
      return;
    }

    const serverBaseUrl = getServerApiBaseUrl();
    const now = Date.now();
    const tasksToRemove = new Map<string, MediaTaskTracker>();

    for (const [taskId, tracker] of pendingMediaTasks) {
      const reboundAccountScope = rebindMediaAccountScope(
        tracker.ownerAccountKey,
        getCurrentMediaAccountScope(),
      );
      if (reboundAccountScope === null) {
        // Keep the task paused in memory. If the user switches back to the
        // owning account, polling resumes with that account's new generation.
        continue;
      }
      if (tracker.accountGeneration !== reboundAccountScope.accountGeneration) {
        tracker.accountGeneration = reboundAccountScope.accountGeneration;
      }
      const trackerAccountScope: MediaAccountScope = {
        ownerAccountKey: tracker.ownerAccountKey,
        accountGeneration: tracker.accountGeneration,
      };

      if (isMediaTaskHandledByStatusPolling(
        tracker.sessionId,
        tracker.ownerAccountKey,
        taskId,
      )) {
        tasksToRemove.set(taskId, tracker);
        continue;
      }

      if (now - tracker.startedAt > tracker.timeoutMs) {
        tasksToRemove.set(taskId, tracker);
        emitMediaTaskMessage(tracker.sessionId, `${tracker.mediaType === 'video' ? 'Video' : 'Image'} generation timed out.\nTask ID: ${taskId}\nStatus: timeout`);
        continue;
      }

      if (tracker.pollCount >= MEDIA_POLL_FAST_COUNT) {
        const lastPollTime = tracker.lastPollAt ?? tracker.startedAt;
        const sinceLast = now - lastPollTime;
        const totalSlowAndMedium = MEDIA_POLL_FAST_COUNT + MEDIA_POLL_SLOW_COUNT;
        const totalBeforeIdle = totalSlowAndMedium + MEDIA_POLL_MEDIUM_COUNT;
        if (tracker.pollCount >= totalBeforeIdle) {
          if (sinceLast < MEDIA_POLL_IDLE_MS) continue;
        } else if (tracker.pollCount >= totalSlowAndMedium) {
          if (sinceLast < MEDIA_POLL_MEDIUM_MS) continue;
        } else {
          if (sinceLast < MEDIA_POLL_SLOW_MS) continue;
        }
      }

      tracker.pollCount++;
      tracker.lastPollAt = now;

      try {
        const endpoint = tracker.mediaType === 'video' ? 'videos' : 'images';
        const resp = await fetchWithAuth(`${serverBaseUrl}/api/media/${endpoint}/tasks/${taskId}`);
        const body = await resp.json() as { code: number; data?: Record<string, unknown>; message?: string };

        if (!isMediaAccountScopeCurrent(trackerAccountScope, getCurrentMediaAccountScope())) {
          continue;
        }
        if (handleEnterpriseAccountContextMismatch(body.code, trackerAccountScope)) continue;
        if (body.code !== 0) continue;
        const task = body.data!;
        rememberMediaTaskOwnership(
          tracker.ownerAccountKey,
          task.taskId,
          task.upstreamTaskId,
        );
        const status = task.status as string;
        if (isMediaTaskHandledByStatusPolling(
          tracker.sessionId,
          tracker.ownerAccountKey,
          taskId,
        )) {
          tasksToRemove.set(taskId, tracker);
          continue;
        }

        if (TERMINAL_MEDIA_TASK_STATUSES.has(status)) {
          const resultUrls = (task.resultUrls as string[]) || [];
          const outputModel = mediaModelIdForOutput(task.model, tracker.model);
          const upstreamModel = typeof task.upstreamModel === 'string' && task.upstreamModel.trim()
            ? task.upstreamModel.trim()
            : undefined;
          const modelSelectionReason = typeof task.modelSelectionReason === 'string' && task.modelSelectionReason.trim()
            ? task.modelSelectionReason.trim()
            : undefined;
          const displayModel = upstreamModel || outputModel;
          const assets = resultUrls.map(url => ({
            type: tracker.mediaType,
            url,
            mimeType: resolveGeneratedMediaAssetMimeType(tracker.mediaType, url),
          }));
          if (status === 'succeeded' && tracker.mediaType === 'image') {
            const persistResult = await persistGeneratedImages(tracker.sessionId, assets);
            if (!isMediaAccountScopeCurrent(trackerAccountScope, getCurrentMediaAccountScope())) {
              continue;
            }
            if (persistResult && persistResult.saved.length > 0) {
              const fileLines = persistResult.saved.map(asset => `  - [${asset.filename}](${pathToFileURL(asset.filePath).toString()})`);
              emitMediaTaskMessage(
                tracker.sessionId,
                `Saved generated ${persistResult.saved.length === 1 ? 'image' : 'images'}:\n${fileLines.join('\n')}`,
                {
                  toolResultDetails: {
                    status: 'succeeded',
                    assets: persistResult.saved,
                  },
                },
              );
            } else {
              const resultLines = resultUrls.map((_url, index) => `  - Generated image ${index + 1}`);
              emitMediaTaskMessage(tracker.sessionId, [
                'Image generation succeeded.',
                `Task ID: ${taskId}`,
                `Model: ${displayModel}`,
                ...(modelSelectionReason ? [`Selection reason: ${modelSelectionReason}`] : []),
                ...(resultUrls.length > 0 ? [`Results:\n${resultLines.join('\n')}`] : []),
                ...(task.errorMessage ? [`Error: ${task.errorMessage}`] : []),
              ].join('\n'));
            }
          } else if (status === 'succeeded' && tracker.mediaType === 'video') {
            const persistResult = await persistGeneratedVideos(tracker.sessionId, assets);
            if (!isMediaAccountScopeCurrent(trackerAccountScope, getCurrentMediaAccountScope())) {
              continue;
            }
            if (persistResult && persistResult.saved.length > 0) {
              const fileLines = persistResult.saved.map(asset => `  - [${asset.filename}](${pathToFileURL(asset.filePath).toString()})`);
              emitMediaTaskMessage(
                tracker.sessionId,
                [
                  `Saved generated ${persistResult.saved.length === 1 ? 'video' : 'videos'}:`,
                  `Model: ${displayModel}`,
                  ...(modelSelectionReason ? [`Selection reason: ${modelSelectionReason}`] : []),
                  fileLines.join('\n'),
                ].join('\n'),
                {
                  toolResultDetails: {
                    status: 'succeeded',
                    model: outputModel,
                    ...(upstreamModel ? { upstreamModel } : {}),
                    ...(modelSelectionReason ? { modelSelectionReason } : {}),
                    assets: persistResult.saved,
                  },
                },
              );
            } else {
              const resultLines = resultUrls.map(url => `  - ${url}`);
              emitMediaTaskMessage(tracker.sessionId, [
                'Video generation succeeded.',
                `Task ID: ${taskId}`,
                `Model: ${displayModel}`,
                ...(modelSelectionReason ? [`Selection reason: ${modelSelectionReason}`] : []),
                ...(resultUrls.length > 0 ? [`Results:\n${resultLines.join('\n')}`] : []),
                ...(task.errorMessage ? [`Error: ${task.errorMessage}`] : []),
              ].join('\n'));
            }
          } else {
            const resultLines = tracker.mediaType === 'image'
              ? resultUrls.map((_url, index) => `  - Generated image ${index + 1}`)
              : resultUrls.map(url => `  - ${url}`);
            const lines = [
              `${tracker.mediaType === 'video' ? 'Video' : 'Image'} generation ${status}.`,
              `Task ID: ${taskId}`,
              `Model: ${tracker.model}`,
              ...(resultUrls.length > 0 ? [`Results:\n${resultLines.join('\n')}`] : []),
              ...(task.errorMessage ? [`Error: ${task.errorMessage}`] : []),
            ];
            emitMediaTaskMessage(tracker.sessionId, lines.join('\n'));
          }
          if (!shouldRemoveMediaTaskAfterPoll(
            trackerAccountScope,
            getCurrentMediaAccountScope(),
            true,
          )) {
            continue;
          }
          tasksToRemove.set(taskId, tracker);
          notifyAuthQuotaChanged();
        }
      } catch (error) {
        // Keep retries quiet during transient failures while retaining enough
        // sampled context to diagnose a task that remains stuck for hours.
        if (tracker.pollCount === 1 || tracker.pollCount % 10 === 0) {
          console.warn(
            `[MediaGeneration] pending ${tracker.mediaType} task ${taskId} poll failed; retrying`,
            error,
          );
        }
      }
    }

    for (const [taskId, tracker] of tasksToRemove) {
      if (pendingMediaTasks.get(taskId) === tracker) {
        pendingMediaTasks.delete(taskId);
      }
    }

    if (pendingMediaTasks.size === 0) {
      stopMediaPollTimer();
    }
  };

  const emitMediaTaskMessage = (sessionId: string, content: string, metadata?: Record<string, unknown>) => {
    let message: CoworkMessage = {
      id: `media-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'system' as const,
      content,
      timestamp: Date.now(),
      ...(metadata ? { metadata } : {}),
    };
    try {
      message = getCoworkStore().addMessage(sessionId, {
        type: 'system',
        content,
        ...(metadata ? { metadata } : {}),
      });
    } catch {
      // Session may have been deleted
    }
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('cowork:stream:message', { sessionId, message });
      }
    });
  };

  const persistGeneratedImages = async (
    sessionId: string,
    assets: RemoteGeneratedMediaAsset[],
  ): Promise<PersistGeneratedImageAssetsResult | null> => {
    const imageAssets = assets.filter(asset => asset.type === 'image' && asset.url.trim());
    if (imageAssets.length === 0) return null;

    const sessionForAssets = getCoworkStore().getSession(sessionId);
    const cwd = sessionForAssets?.cwd?.trim();
    if (!cwd) {
      console.warn('[MediaGeneration] skipped image persistence because the session working directory was missing.');
      return null;
    }

    const cachedAssets: PersistedGeneratedImageAsset[] = [];
    const pendingAssets = imageAssets.filter(asset => {
      const key = `${sessionId}:${asset.url.trim()}`;
      const cached = persistedGeneratedImageAssetsByUrl.get(key);
      if (cached) {
        cachedAssets.push(cached);
        return false;
      }
      return true;
    });
    if (pendingAssets.length === 0) {
      return cachedAssets.length > 0 ? { saved: cachedAssets, failed: [] } : null;
    }

    try {
      const result = await persistGeneratedImageAssets({
        cwd,
        assets: pendingAssets,
        fetchAsset: url => session.defaultSession.fetch(url),
      });
      for (const saved of result.saved) {
        persistedGeneratedImageAssetsByUrl.set(`${sessionId}:${saved.originalUrl || saved.url}`, saved);
      }
      for (const failed of result.failed) {
        console.warn('[MediaGeneration] failed to persist generated image:', serializeForLog({ sessionId, error: failed.error }));
      }
      return {
        saved: [...cachedAssets, ...result.saved],
        failed: result.failed,
      };
    } catch (error) {
      console.warn('[MediaGeneration] failed to persist generated image assets:', error);
      return cachedAssets.length > 0 ? { saved: cachedAssets, failed: [] } : null;
    }
  };

  const persistGeneratedVideos = async (
    sessionId: string,
    assets: RemoteGeneratedMediaAsset[],
  ): Promise<PersistGeneratedImageAssetsResult | null> => {
    const videoAssets = assets.filter(asset => asset.type === 'video' && asset.url.trim());
    if (videoAssets.length === 0) return null;

    const sessionForAssets = getCoworkStore().getSession(sessionId);
    const cwd = sessionForAssets?.cwd?.trim();
    if (!cwd) {
      console.warn('[MediaGeneration] skipped video persistence because the session working directory was missing.');
      return null;
    }

    const cachedAssets: PersistedGeneratedImageAsset[] = [];
    const pendingAssets = videoAssets.filter(asset => {
      const key = `${sessionId}:${asset.url.trim()}`;
      const cached = persistedGeneratedVideoAssetsByUrl.get(key);
      if (cached) {
        cachedAssets.push(cached);
        return false;
      }
      return true;
    });
    if (pendingAssets.length === 0) {
      return cachedAssets.length > 0 ? { saved: cachedAssets, failed: [] } : null;
    }

    try {
      const result = await persistGeneratedVideoAssets({
        cwd,
        assets: pendingAssets,
        fetchAsset: url => session.defaultSession.fetch(url),
      });
      for (const saved of result.saved) {
        persistedGeneratedVideoAssetsByUrl.set(`${sessionId}:${saved.originalUrl || saved.url}`, saved);
      }
      for (const failed of result.failed) {
        console.warn('[MediaGeneration] failed to persist generated video:', serializeForLog({ sessionId, error: failed.error }));
      }
      return {
        saved: [...cachedAssets, ...result.saved],
        failed: result.failed,
      };
    } catch (error) {
      console.warn('[MediaGeneration] failed to persist generated video assets:', error);
      return cachedAssets.length > 0 ? { saved: cachedAssets, failed: [] } : null;
    }
  };

  const MEDIA_ENTITLEMENT_SYNC_REASON = 'media-entitlement-changed';

  const getAuthQuotaGateState = () => ({
    subscriptionStatus: cachedSubscriptionStatus,
    mediaGenerationEntitled: cachedMediaGenerationEntitled,
  });

  const hasAuthQuotaGateStateChanged = (previous: ReturnType<typeof getAuthQuotaGateState>) => (
    cachedSubscriptionStatus !== previous.subscriptionStatus
    || cachedMediaGenerationEntitled !== previous.mediaGenerationEntitled
  );

  const syncOpenClawConfigIfAuthQuotaGateChanged = (previous: ReturnType<typeof getAuthQuotaGateState>) => {
    if (hasAuthQuotaGateStateChanged(previous)) {
      // The auth quota gate is enforced in the main process. Let config sync
      // decide whether its rendered changes require a restart instead of
      // forcing one before the post-login server-model metadata sync.
      syncOpenClawConfig({ reason: MEDIA_ENTITLEMENT_SYNC_REASON, restartGatewayIfRunning: false }).catch((error) => {
        console.warn('[Auth] failed to sync OpenClaw config after quota gate changed:', error);
      });
      return true;
    }
    return false;
  };

  const resetAuthQuotaGateState = () => {
    const defaultGateState = createDefaultAuthQuotaGateState();
    cachedSubscriptionStatus = defaultGateState.subscriptionStatus;
    cachedMediaGenerationEntitled = defaultGateState.mediaGenerationEntitled;
  };

  const clearLocalAuthSession = (options: {
    reason: AuthSessionChangeReason;
    notifyRenderer: boolean;
  }): void => {
    const previousAccountScope = getCurrentMediaAccountScope();
    const previousQuotaGateState = getAuthQuotaGateState();
    authExchangeIntentSequence += 1;
    activeAuthExchangeIntent = null;
    authAccountGeneration += 1;
    mediaSelectionBySession.clear();
    mediaTurnAccountScopeBySession.clear();
    mediaReferencesBySession.clear();
    if (previousAccountScope) {
      clearMediaPollingStateForOwner(previousAccountScope.ownerAccountKey);
    }
    if (pendingMediaTasks.size === 0) {
      stopMediaPollTimer();
    }
    clearAuthTokens();
    clearAuthUser();
    clearEnterpriseAccountContext(getStore());
    clearServerModelMetadata();
    resetAuthQuotaGateState();

    const quotaGateSyncScheduled = syncOpenClawConfigIfAuthQuotaGateChanged(previousQuotaGateState);
    if (!quotaGateSyncScheduled) {
      const syncReason = options.reason === AuthSessionChangeReason.EnterpriseMembershipRevoked
        ? 'enterprise-membership-revoked-server-models-cleared'
        : options.reason === AuthSessionChangeReason.RefreshRejected
          ? 'auth-session-expired-server-models-cleared'
          : 'auth-logout-server-models-cleared';
      syncOpenClawConfig({
        reason: syncReason,
        restartGatewayIfRunning: false,
      }).catch(error => {
        console.warn('[Auth] failed to sync OpenClaw config after auth cleanup:', error);
      });
    }

    if (options.notifyRenderer) {
      emitAuthSessionChanged({
        status: AuthSessionStatus.Expired,
        reason: options.reason,
      });
      emitAuthLifecycleEvent({
        eventType: AuthLifecycleEventType.TerminalExpired,
        outcome: AuthSessionStatus.Expired,
        reason: options.reason,
      });
    }
  };

  /**
   * Normalize quota data from various server response formats into a unified shape.
   */
  const normalizeQuota = (raw: Record<string, unknown>) => {
    const quota = normalizeAuthQuota(raw, {
      freePlanName: t('authPlanFree'),
      standardPlanName: t('authPlanStandard'),
      fallbackSubscriptionStatus: cachedSubscriptionStatus,
    });
    const quotaGateState = authQuotaGateStateFromQuota(quota);
    cachedSubscriptionStatus = quotaGateState.subscriptionStatus;
    cachedMediaGenerationEntitled = quotaGateState.mediaGenerationEntitled;
    return quota;
  };

  ipcMain.handle(AuthIpcChannel.Login, async (_event, { loginUrl }: { loginUrl?: string } = {}) => {
    const baseUrl = loginUrl || `${getServerApiBaseUrl()}/login`;
    const fallbackUrl = appendLoginParams(baseUrl, { source: 'electron' });
    let localCallback: Awaited<ReturnType<typeof startAuthLocalCallback>> | null = null;

    try {
      console.log('[Auth] starting browser login with local callback server');
      localCallback = await startAuthLocalCallback({
        onCode: code => {
          authCallbackRouter.handleAuthCode(code);
          focusMainWindow('local auth callback');
        },
      });
      const returnTo = appendLoginParams(baseUrl, {
        source: 'electron',
        electronLogin: 'success',
      });
      const finalUrl = appendLoginParams(baseUrl, {
        source: 'electron',
        redirect_uri: appendCallbackReturnTo(localCallback.redirectUri, returnTo),
        state: localCallback.state,
      });
      console.log('[Auth] opening portal login with local callback redirect');
      await shell.openExternal(finalUrl);
      return { success: true, redirectUrl: finalUrl };
    } catch (error) {
      // The callback may be shared by another login page and will clean itself up on timeout.
      console.warn('[Auth] local callback login failed, falling back to deep link login:', error);
      try {
        await shell.openExternal(fallbackUrl);
        return { success: true, redirectUrl: fallbackUrl };
      } catch (fallbackError) {
        console.error('[Auth] login failed:', fallbackError);
        return {
          success: false,
          error: fallbackError instanceof Error ? fallbackError.message : 'Failed to open login',
        };
      }
    }
  });

  registerActivityIpcHandlers({
    ipcMain,
    getMainWindow: () => mainWindow,
    getServerBaseUrl: getServerApiBaseUrl,
    getClientVersion: () => app.getVersion(),
    platform: process.platform,
    hasAuthTokens: () => getAuthTokens() !== null,
    fetchPublic: (url, options) => net.fetch(url, options),
    fetchWithAuth,
  });

  ipcMain.handle(AuthIpcChannel.Exchange, async (_event, { code }: { code: string }) => {
    const startingTokens = getAuthTokens();
    const startingUser = getAuthUser();
    const startingEnterpriseContext = getPersistedEnterpriseAccountContext(getStore());
    const startingQuotaGateState = getAuthQuotaGateState();
    const startingServerModels = getAllServerModelMetadata();
    const exchangeIntent: AuthExchangeIntentSnapshot = {
      intentId: ++authExchangeIntentSequence,
      accountGeneration: authAccountGeneration,
      accessToken: startingTokens?.accessToken ?? null,
      refreshToken: startingTokens?.refreshToken ?? null,
    };
    activeAuthExchangeIntent = exchangeIntent;
    const isExchangeIntentCurrent = (): boolean => isAuthExchangeIntentCurrent(
      exchangeIntent,
      activeAuthExchangeIntent?.intentId ?? null,
      authAccountGeneration,
      getAuthTokens(),
    );
    let committedExchangeGeneration: number | null = null;

    try {
      const serverBaseUrl = getServerApiBaseUrl();
      const exchangeUrl = `${serverBaseUrl}/api/auth/exchange`;
      console.log(`[Auth] requesting auth exchange at ${exchangeUrl}`);
      const resp = await net.fetch(exchangeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withKeyfromBody({ authCode: code })),
      });
      if (!resp.ok) {
        return { success: false, error: `Exchange failed: ${resp.status}` };
      }
      const body = (await resp.json()) as {
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
      if (!isExchangeIntentCurrent()) {
        return { success: false, error: t('authAccountChanged') };
      }

      const previousAccountScope = getCurrentMediaAccountScope();
      activeAuthExchangeIntent = null;
      authAccountGeneration += 1;
      const exchangeAccountGeneration = authAccountGeneration;
      clearEnterpriseAccountContext(getStore());
      clearServerModelMetadata();
      // A login exchange can switch accounts without an explicit logout.
      // Reset entitlement fallbacks before normalizing the new account so a
      // partial quota payload cannot inherit the previous account's plan.
      resetAuthQuotaGateState();
      saveAuthTokens(body.data.accessToken, body.data.refreshToken);
      saveAuthUser(body.data.user);
      committedExchangeGeneration = exchangeAccountGeneration;
      const enterpriseContext = await syncEnterpriseAccountContextFromPayload(body.data);
      const requiresEnterpriseContext = (
        readAccountMode(body.data) === EnterpriseAccountMode.Enterprise
        || body.data.quota.subscriptionStatus === AuthSubscriptionStatus.Enterprise
      );
      if (requiresEnterpriseContext && !enterpriseContext) {
        throw new Error('Enterprise account context was unavailable after token exchange');
      }
      if (
        authAccountGeneration !== exchangeAccountGeneration
        || authExchangeIntentSequence !== exchangeIntent.intentId
      ) {
        return { success: false, error: t('authAccountChanged') };
      }
      mediaSelectionBySession.clear();
      mediaTurnAccountScopeBySession.clear();
      mediaReferencesBySession.clear();
      if (previousAccountScope) {
        clearMediaPollingStateForOwner(previousAccountScope.ownerAccountKey);
      }
      if (pendingMediaTasks.size === 0) {
        stopMediaPollTimer();
      }
      console.log(
        `[Auth] exchange completed; enterpriseContext=${enterpriseContext ? 'present' : 'absent'}`,
      );
      const quota = normalizeQuota(body.data.quota);
      syncOpenClawConfigIfAuthQuotaGateChanged(startingQuotaGateState);
      return {
        success: true,
        user: body.data.user,
        quota,
        enterpriseContext,
      };
    } catch (error) {
      if (
        committedExchangeGeneration !== null
        && authAccountGeneration === committedExchangeGeneration
        && authExchangeIntentSequence === exchangeIntent.intentId
      ) {
        authAccountGeneration += 1;
        if (startingTokens) {
          saveAuthTokens(startingTokens.accessToken, startingTokens.refreshToken);
        } else {
          clearAuthTokens();
        }
        if (startingUser) {
          saveAuthUser(startingUser);
        } else {
          clearAuthUser();
        }
        if (startingEnterpriseContext) {
          persistEnterpriseAccountContext(getStore(), startingEnterpriseContext);
        } else {
          clearEnterpriseAccountContext(getStore());
        }
        updateServerModelMetadata(startingServerModels);
        cachedSubscriptionStatus = startingQuotaGateState.subscriptionStatus;
        cachedMediaGenerationEntitled = startingQuotaGateState.mediaGenerationEntitled;
        syncOpenClawConfig({
          reason: 'auth-exchange-rollback',
          restartGatewayIfRunning: false,
        }).catch(syncError => {
          console.warn('[Auth] failed to sync OpenClaw config after exchange rollback:', syncError);
        });
        console.warn('[Auth] rolled back local credentials after an incomplete exchange');
      }
      console.error('[Auth] exchange failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Exchange failed',
      };
    } finally {
      if (activeAuthExchangeIntent?.intentId === exchangeIntent.intentId) {
        activeAuthExchangeIntent = null;
      }
    }
  });

  ipcMain.handle(AuthIpcChannel.GetUser, async () => {
    const createUnavailableResponse = () => {
      const hasCredentials = Boolean(getAuthTokens());
      return {
        success: false,
        status: hasCredentials
          ? AuthSessionStatus.TemporarilyUnavailable
          : AuthSessionStatus.Unauthenticated,
        hasCredentials,
        cachedUser: hasCredentials ? getAuthUser() : null,
      };
    };

    try {
      const tokens = getAuthTokens();
      if (!tokens) {
        return {
          success: false,
          status: AuthSessionStatus.Unauthenticated,
          hasCredentials: false,
        };
      }
      const requestAccountGeneration = authAccountGeneration;
      const requestAccountScope = getCurrentMediaAccountScope();
      const serverBaseUrl = getServerApiBaseUrl();
      // Fetch user profile
      const profileResp = await fetchWithAuth(`${serverBaseUrl}/api/user/profile`);
      if (authAccountGeneration !== requestAccountGeneration) {
        return createUnavailableResponse();
      }
      if (!profileResp.ok) {
        return {
          success: false,
          status: AuthSessionStatus.TemporarilyUnavailable,
          hasCredentials: true,
          cachedUser: getAuthUser(),
        };
      }
      const profileResponseAuthState = captureAuthStateSnapshot();
      const profileBody = (await profileResp.json()) as {
        code: number;
        data: Record<string, unknown>;
      };
      if (!isCurrentAuthStateSnapshot(profileResponseAuthState)) {
        return createUnavailableResponse();
      }
      if (handleEnterpriseAccountContextMismatch(profileBody.code, requestAccountScope)) {
        return createUnavailableResponse();
      }
      if (profileBody.code !== 0 || !profileBody.data) {
        return {
          success: false,
          status: AuthSessionStatus.TemporarilyUnavailable,
          hasCredentials: true,
          cachedUser: getAuthUser(),
        };
      }
      saveAuthUser(profileBody.data);
      // Fetch quota separately
      const quotaResp = await fetchWithAuth(`${serverBaseUrl}/api/user/quota`);
      if (authAccountGeneration !== requestAccountGeneration) {
        return createUnavailableResponse();
      }
      let quota = null;
      if (quotaResp.ok) {
        const quotaResponseAuthState = captureAuthStateSnapshot();
        const quotaBody = (await quotaResp.json()) as {
          code: number;
          data: Record<string, unknown>;
        };
        if (!isCurrentAuthStateSnapshot(quotaResponseAuthState)) {
          return createUnavailableResponse();
        }
        if (handleEnterpriseAccountContextMismatch(quotaBody.code, requestAccountScope)) {
          return createUnavailableResponse();
        }
        if (quotaBody.code === 0 && quotaBody.data) {
          const previousQuotaGateState = getAuthQuotaGateState();
          quota = normalizeQuota(quotaBody.data);
          syncOpenClawConfigIfAuthQuotaGateChanged(previousQuotaGateState);
        }
      }
      if (authAccountGeneration !== requestAccountGeneration) {
        return createUnavailableResponse();
      }
      const enterpriseContext = await syncEnterpriseAccountContextFromPayload(profileBody.data);
      if (authAccountGeneration !== requestAccountGeneration) {
        return createUnavailableResponse();
      }
      const requiresEnterpriseContext = (
        readAccountMode(profileBody.data) === EnterpriseAccountMode.Enterprise
        || quota?.subscriptionStatus === AuthSubscriptionStatus.Enterprise
      );
      if (requiresEnterpriseContext && !enterpriseContext) {
        console.warn('[Auth] enterprise account context was unavailable during profile refresh');
        return createUnavailableResponse();
      }
      console.log(
        `[Auth] profile refresh completed; quota=${quota ? 'present' : 'absent'}; `
        + `enterpriseContext=${enterpriseContext ? 'present' : 'absent'}`,
      );
      return {
        success: true,
        status: AuthSessionStatus.Authenticated,
        user: profileBody.data,
        quota,
        enterpriseContext,
      };
    } catch (error) {
      const status = resolveAuthSessionStatusFromError(error);
      if (status === AuthSessionStatus.TemporarilyUnavailable) {
        console.warn('[Auth] getUser temporarily unavailable:', error);
      }
      return {
        success: false,
        status,
        hasCredentials: status !== AuthSessionStatus.Unauthenticated && Boolean(getAuthTokens()),
        cachedUser: status === AuthSessionStatus.TemporarilyUnavailable
          ? getAuthUser()
          : null,
      };
    }
  });

  ipcMain.handle(AuthIpcChannel.GetQuota, async () => {
    try {
      const tokens = getAuthTokens();
      if (!tokens) return { success: false };
      const requestAccountGeneration = authAccountGeneration;
      const requestAccountScope = getCurrentMediaAccountScope();
      const serverBaseUrl = getServerApiBaseUrl();
      const resp = await fetchWithAuth(`${serverBaseUrl}/api/user/quota`);
      if (authAccountGeneration !== requestAccountGeneration) return { success: false };
      if (!resp.ok) return { success: false };
      const responseAuthState = captureAuthStateSnapshot();
      const body = (await resp.json()) as { code: number; data: Record<string, unknown> };
      if (!isCurrentAuthStateSnapshot(responseAuthState)) return { success: false };
      if (handleEnterpriseAccountContextMismatch(body.code, requestAccountScope)) {
        return { success: false };
      }
      if (body.code !== 0 || !body.data) return { success: false };
      const previousQuotaGateState = getAuthQuotaGateState();
      const quota = normalizeQuota(body.data);
      syncOpenClawConfigIfAuthQuotaGateChanged(previousQuotaGateState);
      const enterpriseContextResult = await refreshEnterpriseAccountContext();
      if (authAccountGeneration !== requestAccountGeneration) return { success: false };
      return {
        success: true,
        quota,
        enterpriseContext: enterpriseContextResult.context,
      };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle(AuthIpcChannel.GetProfileSummary, async () => {
    try {
      const tokens = getAuthTokens();
      if (!tokens) return { success: false };
      const requestAccountGeneration = authAccountGeneration;
      const requestAccountScope = getCurrentMediaAccountScope();
      if (requestAccountScope === null) return { success: false };
      const serverBaseUrl = getServerApiBaseUrl();
      const profileSummaryUrl = appendKeyfromQuery(`${serverBaseUrl}/api/user/profile-summary`);
      console.log(`[Auth] requesting profile summary at ${profileSummaryUrl}`);
      const resp = await fetchWithAuth(profileSummaryUrl);
      if (
        authAccountGeneration !== requestAccountGeneration
        || !isMediaAccountScopeCurrent(requestAccountScope, getCurrentMediaAccountScope())
      ) {
        return { success: false };
      }
      if (!resp.ok) return { success: false };
      const responseAuthState = captureAuthStateSnapshot();
      const body = (await resp.json()) as { code: number; data: Record<string, unknown> };
      if (
        !isCurrentAuthStateSnapshot(responseAuthState)
        || !isMediaAccountScopeCurrent(requestAccountScope, getCurrentMediaAccountScope())
      ) {
        return { success: false };
      }
      if (handleEnterpriseAccountContextMismatch(body.code, requestAccountScope)) {
        return { success: false };
      }
      if (body.code !== 0 || !body.data) return { success: false };
      return { success: true, data: body.data };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle(AuthIpcChannel.ClaimCreditsFinalReward, async (_event, payload: { campaignCode?: string }) => {
    try {
      const campaignCode = payload?.campaignCode?.trim();
      if (!campaignCode) return { success: false, error: 'Missing campaign code' };
      const serverBaseUrl = getServerApiBaseUrl();
      const url = appendKeyfromQuery(`${serverBaseUrl}/api/credits-reset-campaign/free-credits/claim`);
      const resp = await fetchWithAuth(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignCode }),
      });
      const body = (await resp.json()) as {
        code: number;
        message?: string;
        data?: Record<string, unknown>;
      };
      if (!resp.ok || body.code !== 0 || !body.data) {
        return { success: false, error: body.message || `Claim failed (${resp.status})` };
      }
      return { success: true, data: body.data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Claim failed',
      };
    }
  });

  ipcMain.handle(AuthIpcChannel.GetActiveClientBanner, async () => {
    try {
      const serverBaseUrl = getServerApiBaseUrl();
      const url = appendKeyfromQuery(appendClientBannerVersion(
        `${serverBaseUrl}/api/client-banners/active?placement=desktop_sidebar`,
        app.getVersion(),
      ));
      const resp = await net.fetch(url, { cache: 'no-store' });
      if (!resp.ok) return { success: false };
      const body = (await resp.json()) as { code: number; data: Record<string, unknown> | null };
      if (body.code !== 0) return { success: false };
      return { success: true, data: body.data ?? null };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle(AuthIpcChannel.GetActiveClientBanners, async () => {
    try {
      const serverBaseUrl = getServerApiBaseUrl();
      const url = appendKeyfromQuery(appendClientBannerVersion(
        `${serverBaseUrl}/api/client-banners/active-list?placement=desktop_sidebar`,
        app.getVersion(),
      ));
      const resp = await net.fetch(url, { cache: 'no-store' });
      if (!resp.ok) return { success: false };
      const body = (await resp.json()) as { code: number; data: Record<string, unknown>[] | null };
      if (body.code !== 0) return { success: false };
      return { success: true, data: Array.isArray(body.data) ? body.data : [] };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle(AuthIpcChannel.GetClientBannerSnapshot, async () => {
    const serverBaseUrl = getServerApiBaseUrl();
    try {
      const snapshotUrl = appendKeyfromQuery(
        appendClientBannerVersion(
          `${serverBaseUrl}/api/client-banners/snapshot?placement=desktop_sidebar`,
          app.getVersion(),
        ),
      );
      const snapshotResponse = await net.fetch(snapshotUrl, { cache: 'no-store' });
      if (snapshotResponse.ok) {
        const snapshotBody = (await snapshotResponse.json()) as {
          code: number;
          data?: {
            serverTime?: string;
            nextRefreshAt?: string | null;
            banners?: Record<string, unknown>[];
          };
        };
        if (snapshotBody.code === 0
            && snapshotBody.data
            && typeof snapshotBody.data.serverTime === 'string'
            && Array.isArray(snapshotBody.data.banners)) {
          return {
            success: true,
            data: {
              serverTime: snapshotBody.data.serverTime,
              nextRefreshAt: snapshotBody.data.nextRefreshAt ?? null,
              clientVersion: app.getVersion(),
              banners: snapshotBody.data.banners,
            },
          };
        }
      }
    } catch {
      // Fall through to the legacy list endpoint during mixed-version rollout.
    }

    try {
      const legacyUrl = appendKeyfromQuery(
        appendClientBannerVersion(
          `${serverBaseUrl}/api/client-banners/active-list?placement=desktop_sidebar`,
          app.getVersion(),
        ),
      );
      const legacyResponse = await net.fetch(legacyUrl, { cache: 'no-store' });
      if (!legacyResponse.ok) return { success: false };
      const legacyBody = (await legacyResponse.json()) as {
        code: number;
        data: Record<string, unknown>[] | null;
      };
      if (legacyBody.code !== 0) return { success: false };
      return {
        success: true,
        data: {
          serverTime: new Date().toISOString(),
          nextRefreshAt: null,
          clientVersion: app.getVersion(),
          banners: Array.isArray(legacyBody.data) ? legacyBody.data : [],
        },
      };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle(AuthIpcChannel.Logout, async () => {
    const tokens = getAuthTokens();
    const enterpriseHeaders = getEnterpriseAccountHeaders();
    const logoutBody = JSON.stringify(withKeyfromBody({}));
    clearLocalAuthSession({
      reason: AuthSessionChangeReason.UserLogout,
      notifyRenderer: false,
    });
    console.log('[Auth] cleared local login state and scheduled server model config refresh');

    if (tokens) {
      try {
        const serverBaseUrl = getServerApiBaseUrl();
        const logoutUrl = `${serverBaseUrl}/api/auth/logout`;
        console.log(`[Auth] requesting logout at ${logoutUrl}`);
        await net.fetch(logoutUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            'Content-Type': 'application/json',
            ...enterpriseHeaders,
          },
          body: logoutBody,
        });
      } catch (error) {
        console.warn('[Auth] remote logout failed after local credentials were cleared:', error);
      }
    }
    return { success: true };
  });

  ipcMain.handle(AuthIpcChannel.RefreshToken, async () => {
    try {
      const result = await authSessionManager.refresh(AuthRefreshReason.Manual);
      return result.outcome === AuthRefreshOutcome.Success
        ? { success: true, accessToken: result.accessToken, outcome: result.outcome }
        : { success: false, outcome: result.outcome };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle(AuthIpcChannel.GetAccessToken, async () => {
    const tokens = getAuthTokens();
    return tokens?.accessToken || null;
  });

  ipcMain.handle(AuthIpcChannel.GetPricingCatalog, async () => {
    try {
      const serverBaseUrl = getServerApiBaseUrl();
      const url = `${serverBaseUrl}/api/models/pricing-catalog`;
      console.log(`[Auth:getPricingCatalog] requesting public pricing catalog at ${url}`);
      const resp = await net.fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      console.log(`[Auth:getPricingCatalog] server returned HTTP ${resp.status}.`);
      if (!resp.ok) {
        return { success: false, error: `HTTP ${resp.status}` };
      }
      const body = await resp.json() as {
        code: number;
        message?: string;
        data?: {
          textModels?: unknown[];
          imageModels?: unknown[];
          videoModels?: unknown[];
        };
      };
      if (body.code !== 0) {
        console.warn('[Auth:getPricingCatalog] server rejected pricing catalog request:', serializeForLog({
          code: body.code,
          message: body.message,
        }));
        return { success: false, error: body.message || 'Failed to load pricing catalog.' };
      }
      const textModels = Array.isArray(body.data?.textModels) ? body.data.textModels : [];
      const imageModels = Array.isArray(body.data?.imageModels) ? body.data.imageModels : [];
      const videoModels = Array.isArray(body.data?.videoModels) ? body.data.videoModels : [];
      console.log(
        '[Auth:getPricingCatalog] loaded public pricing catalog: '
        + `${textModels.length} text, ${imageModels.length} image, ${videoModels.length} video models.`,
      );
      return { success: true, textModels, imageModels, videoModels };
    } catch (error) {
      console.error('[Auth:getPricingCatalog] pricing catalog request failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  ipcMain.handle(AuthIpcChannel.GetModels, async () => {
    try {
      const tokens = getAuthTokens();
      if (!tokens) {
        console.log('[Auth:getModels] No auth tokens available');
        return { success: false };
      }
      const models = await loadAvailableServerModels({
        reason: 'server-models-updated',
      });
      return { success: true, models };
    } catch (e) {
      console.error('[Auth:getModels] Error:', e);
      return { success: false };
    }
  });

  ipcMain.handle(HtmlShareIpc.CreateFromHtmlFile, async (_event, input: unknown) => {
    let archivePath: string | undefined;
    try {
      const { scopedFetch } = capturePublishingRequest();
      const options = sanitizeCreateFromHtmlFileInput(input);
      console.debug(
        `[HtmlShare] received HTML file share request for session ${options.sessionId} and artifact ${options.artifactId}`,
      );
      console.debug(
        `[HtmlShare] HTML file share uses access mode ${options.accessMode ?? 'server-default'} and source file ${options.filePath}`,
      );
      const clientSourceKey = buildHtmlShareClientSourceKey(options.filePath);
      const packaged = await packageHtmlFile(options.filePath);
      archivePath = packaged.archivePath;
      console.debug(
        `[HtmlShare] packaged HTML file share with ${packaged.totalFiles} files, ${packaged.totalBytes} bytes, entry ${packaged.entryFile}, and ${packaged.warnings.length} warnings`,
      );
      const result = await uploadHtmlShare(
        getServerApiBaseUrl(),
        getHtmlSharePublicBaseUrl(),
        scopedFetch,
        {
          archivePath: packaged.archivePath,
          sourceType: HtmlShareSourceType.HtmlFile,
          clientSourceKey,
          sessionId: options.sessionId,
          artifactId: options.artifactId,
          title: options.title,
          entryFile: packaged.entryFile,
          accessMode: options.accessMode,
          sourceSha256: packaged.sourceSha256,
        },
      );
      console.debug(
        `[HtmlShare] HTML file share finished with success ${result.success} and code ${result.code ?? 'none'}`,
      );
      return { ...result, warnings: packaged.warnings };
    } catch (error) {
      console.error('[HtmlShare] failed to create share from HTML file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create share',
      };
    } finally {
      if (archivePath) {
        const archiveDir = path.dirname(archivePath);
        fs.promises
          .rm(archiveDir, { recursive: true, force: true })
          .then(() => {
            console.debug(`[HtmlShare] cleaned temporary archive directory ${archiveDir}`);
          })
          .catch((cleanupError): undefined => {
            console.warn('[HtmlShare] temporary archive cleanup failed:', cleanupError);
            return undefined;
          });
      }
    }
  });

  ipcMain.handle(HtmlShareIpc.GetByHtmlFile, async (_event, input: unknown) => {
    try {
      const options = sanitizeGetByHtmlFileInput(input);
      const clientSourceKey = buildHtmlShareClientSourceKey(options.filePath);
      return await getHtmlShareBySource(
        getServerApiBaseUrl(),
        getHtmlSharePublicBaseUrl(),
        fetchWithAuth,
        HtmlShareSourceType.HtmlFile,
        clientSourceKey,
      );
    } catch (error) {
      console.error('[HtmlShare] failed to look up share from HTML file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load share',
      };
    }
  });

  ipcMain.handle(HtmlShareIpc.UpdateFromHtmlFile, async (_event, input: unknown) => {
    let archivePath: string | undefined;
    try {
      const { scopedFetch } = capturePublishingRequest();
      const options = sanitizeUpdateFromHtmlFileInput(input);
      const clientSourceKey = buildHtmlShareClientSourceKey(options.filePath);
      const packaged = await packageHtmlFile(options.filePath);
      archivePath = packaged.archivePath;
      const result = await updateHtmlShare(
        getServerApiBaseUrl(),
        getHtmlSharePublicBaseUrl(),
        scopedFetch,
        options.shareId,
        {
          archivePath: packaged.archivePath,
          sourceType: HtmlShareSourceType.HtmlFile,
          clientSourceKey,
          sessionId: options.sessionId,
          artifactId: options.artifactId,
          title: options.title,
          entryFile: packaged.entryFile,
          accessMode: options.accessMode,
          sourceSha256: packaged.sourceSha256,
        },
      );
      return { ...result, warnings: packaged.warnings };
    } catch (error) {
      console.error('[HtmlShare] failed to update share from HTML file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update share',
      };
    } finally {
      if (archivePath) {
        const archiveDir = path.dirname(archivePath);
        fs.promises
          .rm(archiveDir, { recursive: true, force: true })
          .then(() => {
            console.debug(`[HtmlShare] cleaned temporary archive directory ${archiveDir}`);
          })
          .catch((cleanupError): undefined => {
            console.warn('[HtmlShare] temporary archive cleanup failed:', cleanupError);
            return undefined;
          });
      }
    }
  });

  ipcMain.handle(HtmlShareIpc.CreateFromArtifactFile, async (_event, input: unknown) => {
    let archivePath: string | undefined;
    try {
      const { scopedFetch } = capturePublishingRequest();
      const options = sanitizeCreateFromArtifactFileInput(input);
      console.debug(
        `[HtmlShare] received ${options.sourceType} share request for session ${options.sessionId} and artifact ${options.artifactId}`,
      );
      const clientSourceKey = buildArtifactShareClientSourceKey(options);
      const packaged = await packageArtifactFile({
        sourceType: options.sourceType,
        fileName: options.fileName,
        filePath: options.filePath,
        content: options.content,
        remoteUrl: options.remoteUrl,
      });
      archivePath = packaged.archivePath;
      console.debug(
        `[HtmlShare] packaged ${options.sourceType} share with ${packaged.totalBytes} bytes and entry ${packaged.entryFile}`,
      );
      const result = await uploadHtmlShare(
        getServerApiBaseUrl(),
        getHtmlSharePublicBaseUrl(),
        scopedFetch,
        {
          archivePath: packaged.archivePath,
          sourceType: options.sourceType,
          clientSourceKey,
          sessionId: options.sessionId,
          artifactId: options.artifactId,
          title: options.title,
          entryFile: packaged.entryFile,
          accessMode: options.accessMode,
          sourceSha256: packaged.sourceSha256,
        },
      );
      return { ...result, warnings: packaged.warnings };
    } catch (error) {
      console.error('[HtmlShare] failed to create share from artifact file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create share',
      };
    } finally {
      if (archivePath) {
        const archiveDir = path.dirname(archivePath);
        fs.promises
          .rm(archiveDir, { recursive: true, force: true })
          .then(() => {
            console.debug(`[HtmlShare] cleaned temporary archive directory ${archiveDir}`);
          })
          .catch((cleanupError): undefined => {
            console.warn('[HtmlShare] temporary archive cleanup failed:', cleanupError);
            return undefined;
          });
      }
    }
  });

  ipcMain.handle(HtmlShareIpc.GetByArtifactFile, async (_event, input: unknown) => {
    try {
      const options = sanitizeGetByArtifactFileInput(input);
      const clientSourceKey = buildArtifactShareClientSourceKey(options);
      return await getHtmlShareBySource(
        getServerApiBaseUrl(),
        getHtmlSharePublicBaseUrl(),
        fetchWithAuth,
        options.sourceType,
        clientSourceKey,
      );
    } catch (error) {
      console.error('[HtmlShare] failed to look up share from artifact file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load share',
      };
    }
  });

  ipcMain.handle(HtmlShareIpc.GetBySource, async (_event, input: unknown) => {
    try {
      const options = sanitizeGetHtmlShareBySourceInput(input);
      return await getHtmlShareBySource(
        getServerApiBaseUrl(),
        getHtmlSharePublicBaseUrl(),
        fetchWithAuth,
        options.sourceType,
        options.clientSourceKey,
      );
    } catch (error) {
      console.error('[HtmlShare] failed to look up share from source:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load share',
      };
    }
  });

  ipcMain.handle(HtmlShareIpc.UpdateFromArtifactFile, async (_event, input: unknown) => {
    let archivePath: string | undefined;
    try {
      const { scopedFetch } = capturePublishingRequest();
      const options = sanitizeUpdateFromArtifactFileInput(input);
      const clientSourceKey = buildArtifactShareClientSourceKey(options);
      const packaged = await packageArtifactFile({
        sourceType: options.sourceType,
        fileName: options.fileName,
        filePath: options.filePath,
        content: options.content,
        remoteUrl: options.remoteUrl,
      });
      archivePath = packaged.archivePath;
      const result = await updateHtmlShare(
        getServerApiBaseUrl(),
        getHtmlSharePublicBaseUrl(),
        scopedFetch,
        options.shareId,
        {
          archivePath: packaged.archivePath,
          sourceType: options.sourceType,
          clientSourceKey,
          sessionId: options.sessionId,
          artifactId: options.artifactId,
          title: options.title,
          entryFile: packaged.entryFile,
          accessMode: options.accessMode,
          sourceSha256: packaged.sourceSha256,
        },
      );
      return { ...result, warnings: packaged.warnings };
    } catch (error) {
      console.error('[HtmlShare] failed to update share from artifact file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update share',
      };
    } finally {
      if (archivePath) {
        const archiveDir = path.dirname(archivePath);
        fs.promises
          .rm(archiveDir, { recursive: true, force: true })
          .then(() => {
            console.debug(`[HtmlShare] cleaned temporary archive directory ${archiveDir}`);
          })
          .catch((cleanupError): undefined => {
            console.warn('[HtmlShare] temporary archive cleanup failed:', cleanupError);
            return undefined;
          });
      }
    }
  });

  ipcMain.handle(HtmlShareIpc.UpdateStatus, async (_event, input: unknown) => {
    try {
      const options = sanitizeUpdateHtmlShareStatusInput(input);
      return await updateHtmlShareStatus(
        getServerApiBaseUrl(),
        getHtmlSharePublicBaseUrl(),
        fetchWithAuth,
        options.shareId,
        options.status,
      );
    } catch (error) {
      console.error('[HtmlShare] failed to update share status:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update share status',
      };
    }
  });

  ipcMain.handle(HtmlShareIpc.UpdateAccessMode, async (_event, input: unknown) => {
    try {
      const options = sanitizeUpdateHtmlShareAccessModeInput(input);
      return await updateHtmlShareAccessMode(
        getServerApiBaseUrl(),
        getHtmlSharePublicBaseUrl(),
        fetchWithAuth,
        options.shareId,
        options.accessMode,
      );
    } catch (error) {
      console.error('[HtmlShare] failed to update share access mode:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update share access mode',
      };
    }
  });

  ipcMain.handle(HtmlShareIpc.Get, async (_event, shareId: unknown) => {
    try {
      const id = sanitizeHtmlShareString(shareId, 'shareId', 64);
      const resp = await fetchWithAuth(
        `${getServerApiBaseUrl()}/api/html-shares/${encodeURIComponent(id)}`,
      );
      const body = (await resp.json().catch((): null => null)) as {
        code?: number;
        message?: string;
        data?: unknown;
      } | null;
      if (!resp.ok || body?.code !== 0) {
        return { success: false, error: body?.message || `Share lookup failed: ${resp.status}` };
      }
      return { success: true, share: body.data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load share',
      };
    }
  });

  ipcMain.handle(HtmlShareIpc.GetQuota, async () => {
    try {
      return await getHtmlShareQuota(getServerApiBaseUrl(), fetchWithAuth);
    } catch (error) {
      console.error('[HtmlShare] failed to load publishing quota:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load share quota',
      };
    }
  });

  ipcMain.handle(HtmlShareIpc.GetTrialPolicy, async () => {
    try {
      return await getPublishingTrialPolicy(
        getServerApiBaseUrl(),
        (url, options) => fetch(url, options),
      );
    } catch (error) {
      console.error('[HtmlShare] failed to load publishing trial policy:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load publishing trial policy',
      };
    }
  });

  ipcMain.handle(HtmlShareIpc.GetAnalytics, async (_event, input: unknown) => {
    try {
      const options = sanitizeHtmlShareAnalyticsInput(input);
      return await getHtmlShareAnalytics(
        getServerApiBaseUrl(),
        fetchWithAuth,
        options.shareId,
        options,
      );
    } catch (error) {
      console.error('[HtmlShare] failed to load owner analytics:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load share analytics',
      };
    }
  });

  ipcMain.handle(HtmlShareIpc.Disable, async (_event, shareId: unknown) => {
    try {
      const id = sanitizeHtmlShareString(shareId, 'shareId', 64);
      return await updateHtmlShareStatus(
        getServerApiBaseUrl(),
        getHtmlSharePublicBaseUrl(),
        fetchWithAuth,
        id,
        HtmlShareStatus.Disabled,
      );
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to disable share',
      };
    }
  });

  ipcMain.handle(HtmlShareIpc.DeletePermanently, async (_event, shareId: unknown) => {
    try {
      const id = sanitizeHtmlShareString(shareId, 'shareId', 64);
      return await deleteHtmlSharePermanently(
        getServerApiBaseUrl(),
        fetchWithAuth,
        id,
      );
    } catch (error) {
      console.error('[HtmlShare] failed to permanently delete shared file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete shared file',
      };
    }
  });

  ipcMain.handle(ShareDeploymentIpc.DetectProjectCandidates, async (_event, input: unknown) => {
    try {
      const options = sanitizeShareDeploymentDetectProjectCandidatesInput(input);
      const candidates = await detectNodeServiceProjectCandidates(options);
      return {
        success: true,
        candidates,
      };
    } catch (error) {
      console.error('[ShareDeployment] failed to detect project candidates:', error);
      return {
        success: false,
        candidates: [],
        error: error instanceof Error ? error.message : 'Failed to detect project candidates',
      };
    }
  });

  ipcMain.handle(ShareDeploymentIpc.AnalyzeProjectDirectory, async (_event, input: unknown) => {
    try {
      const options = sanitizeShareDeploymentAnalyzeProjectDirectoryInput(input);
      return await analyzeNodeServiceProjectDirectory(options);
    } catch (error) {
      console.error('[ShareDeployment] failed to analyze project directory:', error);
      return {
        success: false,
        projectDirectory: '',
        packageManager: ShareDeploymentPackageManager.Unknown,
        nodeVersion: '20',
        installCommand: 'npm install',
        buildCommand: '',
        startCommand: '',
        totalFiles: 0,
        totalBytes: 0,
        excludedCount: 0,
        warnings: [],
        blockers: [error instanceof Error ? error.message : 'Failed to analyze project directory'],
      };
    }
  });

  ipcMain.handle(ShareDeploymentIpc.SelectPersistencePath, async (event, input: unknown) => {
    try {
      const options = sanitizeShareDeploymentSelectPersistencePathInput(input);
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      let defaultPath: string | undefined;
      try {
        const stats = await fs.promises.stat(options.projectDirectory);
        if (stats.isDirectory()) {
          defaultPath = options.projectDirectory;
        }
      } catch {
        defaultPath = undefined;
      }
      const dialogOptions = {
        properties: options.kind === ShareDeploymentPersistenceBindingKind.File
          ? ['openFile'] as 'openFile'[]
          : ['openDirectory'] as 'openDirectory'[],
        defaultPath,
      };
      const result = ownerWindow
        ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      if (result.canceled || result.filePaths.length === 0) {
        return {
          success: true,
        };
      }
      const binding = await buildShareDeploymentPersistenceBindingFromPath(
        options.projectDirectory,
        result.filePaths[0],
      );
      return {
        success: true,
        binding,
      };
    } catch (error) {
      console.error('[ShareDeployment] failed to select service data path:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to select service data path',
      };
    }
  });

  ipcMain.handle(ShareDeploymentIpc.CreateNodeDeployment, async (_event, input: unknown) => {
    let archivePath: string | undefined;
    try {
      const { accountScope, scopedFetch } = capturePublishingRequest();
      const options = sanitizeShareDeploymentCreateNodeInput(input);
      const operationSourceKey = buildNodeDeploymentClientSourceKey({
        sessionId: options.sessionId,
        localServiceUrl: options.localServiceUrl,
        projectDirectory: options.projectDirectory,
      });
      console.debug(
        `[ShareDeployment] received node deployment request for session ${options.sessionId} and artifact ${options.artifactId}`,
      );
      const accountOperationKey = `${accountScope.ownerAccountKey}:${operationSourceKey}`;
      return await shareDeploymentOperationCoordinator.run(accountOperationKey, async () => {
        const packaged = await packageNodeServiceDeployment({
          projectDirectory: options.projectDirectory,
          localServiceUrl: options.localServiceUrl,
          installCommand: options.installCommand,
          buildCommand: options.buildCommand,
          startCommand: options.startCommand,
          port: options.port,
          persistence: options.persistence,
        });
        archivePath = packaged.archivePath;
        const analysis = options.persistence
          ? {
              ...packaged.analysis,
              persistence: options.persistence,
            }
          : packaged.analysis;
        const isStaticDeployment = packaged.deploymentKind === ShareDeploymentKind.StaticSite;
        const clientSourceKey = isStaticDeployment
          ? buildStaticDeploymentClientSourceKey({
              sessionId: options.sessionId,
              localServiceUrl: options.localServiceUrl,
              projectDirectory: options.projectDirectory,
            })
          : operationSourceKey;
        const serverBaseUrl = getServerApiBaseUrl();
        const publicBaseUrl = getHtmlSharePublicBaseUrl();
        const result = isStaticDeployment
          ? await uploadStaticDeployment(
              serverBaseUrl,
              publicBaseUrl,
              scopedFetch,
              {
                ...options,
                archivePath: packaged.archivePath,
                sourceSha256: packaged.sourceSha256,
                analysis,
                archiveBytes: packaged.archiveBytes,
                clientSourceKey,
                deploymentKind: ShareDeploymentKind.StaticSite,
                entryFile: packaged.entryFile ?? 'index.html',
                spaFallback: packaged.spaFallback ?? true,
              },
            )
          : await uploadNodeDeployment(
              serverBaseUrl,
              publicBaseUrl,
              scopedFetch,
              {
                ...options,
                archivePath: packaged.archivePath,
                sourceSha256: packaged.sourceSha256,
                analysis,
                archiveBytes: packaged.archiveBytes,
                clientSourceKey,
                deploymentKind: ShareDeploymentKind.NodeService,
              },
            );
        let finalResult = result;
        if (result.success && result.deployment) {
          const accessSync = await reconcileShareDeploymentAccess(
            result.deployment,
            {
              accessMode: options.accessMode ?? HtmlShareAccessMode.Code,
              previousAccessMode: options.previousAccessMode,
              targetShareStatus: options.targetShareStatus ?? HtmlShareStatus.Live,
            },
            {
              updateAccessMode: (shareId, accessMode) => updateHtmlShareAccessMode(
                serverBaseUrl,
                publicBaseUrl,
                scopedFetch,
                shareId,
                accessMode,
              ),
              updateStatus: (shareId, status) => updateHtmlShareStatus(
                serverBaseUrl,
                publicBaseUrl,
                scopedFetch,
                shareId,
                status,
              ),
            },
          );
          finalResult = {
            ...result,
            deployment: accessSync.deployment,
            accessSyncError: formatShareDeploymentAccessSyncError(accessSync.failures),
          };
        }
        console.debug(
          `[ShareDeployment] local service deployment request finished with kind ${packaged.deploymentKind} success ${finalResult.success} and code ${finalResult.code ?? 'none'}`,
        );
        return finalResult;
      });
    } catch (error) {
      console.error('[ShareDeployment] failed to create node deployment:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create node deployment',
      };
    } finally {
      if (archivePath) {
        const archiveDir = path.dirname(archivePath);
        fs.promises
          .rm(archiveDir, { recursive: true, force: true })
          .then(() => {
            console.debug(`[ShareDeployment] cleaned temporary archive directory ${archiveDir}`);
          })
          .catch((cleanupError): undefined => {
            console.warn('[ShareDeployment] temporary archive cleanup failed:', cleanupError);
            return undefined;
          });
      }
    }
  });

  ipcMain.handle(ShareDeploymentIpc.Get, async (_event, deploymentId: unknown) => {
    try {
      const id = sanitizeHtmlShareString(deploymentId, 'deploymentId', 128);
      return await getNodeDeployment(
        getServerApiBaseUrl(),
        getHtmlSharePublicBaseUrl(),
        fetchWithAuth,
        id,
      );
    } catch (error) {
      console.error('[ShareDeployment] failed to load deployment:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load deployment',
      };
    }
  });

  ipcMain.handle(ShareDeploymentIpc.GetPersistence, async (_event, deploymentId: unknown) => {
    try {
      const id = sanitizeShareDeploymentPersistenceDeploymentIdInput(deploymentId);
      return await getDeploymentPersistence(getServerApiBaseUrl(), fetchWithAuth, id);
    } catch (error) {
      console.error('[ShareDeployment] failed to load service data:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load service data',
      };
    }
  });

  ipcMain.handle(ShareDeploymentIpc.DownloadPersistenceArchive, async (_event, input: unknown) => {
    try {
      const options = sanitizeShareDeploymentDownloadPersistenceInput(input);
      return await downloadDeploymentPersistenceArchive(
        getServerApiBaseUrl(),
        fetchWithAuth,
        options,
      );
    } catch (error) {
      console.error('[ShareDeployment] failed to download service data:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to download service data',
      };
    }
  });

  ipcMain.handle(ShareDeploymentIpc.GetByLocalService, async (_event, input: unknown) => {
    try {
      const options = sanitizeShareDeploymentGetByLocalServiceInput(input);
      return await getNodeDeploymentByLocalService(
        getServerApiBaseUrl(),
        getHtmlSharePublicBaseUrl(),
        fetchWithAuth,
        options,
      );
    } catch (error) {
      console.error('[ShareDeployment] failed to load deployment by local service:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load deployment',
      };
    }
  });

  // Media generation IPC handlers
  ipcMain.handle(CoworkIpcChannel.GetMediaModels, async (_event, type: 'image' | 'video') => {
    try {
      if (type !== 'image' && type !== 'video') {
        console.warn('[Media:getModels] rejected invalid media type');
        return { success: false, error: 'Invalid media type' };
      }
      const tokens = getAuthTokens();
      const requestAccountScope = getCurrentMediaAccountScope();
      if (!tokens || requestAccountScope === null) {
        console.warn('[Media:getModels] No auth tokens, skipping');
        return { success: false, error: t('authLoginRequired') };
      }
      const serverBaseUrl = getServerApiBaseUrl();
      const endpoint = type === 'image' ? '/api/media/images/models' : '/api/media/videos/models';
      const resp = await fetchWithAuth(`${serverBaseUrl}${endpoint}`);
      const body = await resp.json() as { code: number; data?: unknown[]; message?: string };
      if (!isMediaAccountScopeCurrent(requestAccountScope, getCurrentMediaAccountScope())) {
        return { success: false, error: t('authAccountChanged') };
      }
      if (handleEnterpriseAccountContextMismatch(body.code, requestAccountScope)) {
        return { success: false, error: t('enterpriseAccountContextMismatchMessage') };
      }
      if (!resp.ok) return { success: false, error: body.message || `HTTP ${resp.status}` };
      if (body.code !== 0) return { success: false, error: body.message };
      const models = (body.data || []).map(model => {
        const mediaModel = model as { modelId?: string; displayName?: string };
        const modelId = canonicalizeMediaModelId(mediaModel.modelId);
        return {
          ...(model as Record<string, unknown>),
          modelId,
          displayName: mediaModelDisplayName(modelId, mediaModel.displayName),
        };
      });
      return { success: true, models };
    } catch (e) {
      console.error('[Media:getModels] Error:', e);
      return { success: false, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  });

  ipcMain.handle('media:getTaskStatus', async (_event, taskId: number, type: 'image' | 'video') => {
    try {
      if (type !== 'image' && type !== 'video') {
        console.warn('[Media:getTaskStatus] rejected invalid media type');
        return { success: false, error: 'Invalid media type' };
      }
      const tokens = getAuthTokens();
      const requestAccountScope = getCurrentMediaAccountScope();
      if (!tokens || requestAccountScope === null) {
        return { success: false, error: t('authLoginRequired') };
      }
      const taskOwnerAccountKey = resolveMediaTaskOwner(taskId);
      if (!canAccessTrackedMediaTask(taskOwnerAccountKey, requestAccountScope)) {
        return { success: false, error: t('mediaTaskAccountMismatch') };
      }
      const serverBaseUrl = getServerApiBaseUrl();
      const mediaPath = type === 'image' ? 'images' : 'videos';
      const taskUrl = `${serverBaseUrl}/api/media/${mediaPath}/tasks/${taskId}`;
      console.debug(`[Media:getTaskStatus] requesting ${type} task ${taskId}`);
      const resp = await fetchWithAuth(taskUrl);
      const body = await resp.json() as { code: number; data?: unknown; message?: string };
      const responseTask = body.data && typeof body.data === 'object'
        ? body.data as Record<string, unknown>
        : null;
      console.debug(
        `[Media:getTaskStatus] response HTTP ${resp.status}; code=${body.code}; status=${String(responseTask?.status ?? 'unknown')}`,
      );
      if (!isMediaAccountScopeCurrent(requestAccountScope, getCurrentMediaAccountScope())) {
        return { success: false, error: t('authAccountChanged') };
      }
      if (handleEnterpriseAccountContextMismatch(body.code, requestAccountScope)) {
        return { success: false, error: t('enterpriseAccountContextMismatchMessage') };
      }
      if (!resp.ok) return { success: false, error: body.message || `HTTP ${resp.status}` };
      if (body.code !== 0) return { success: false, error: body.message };
      const task = body.data as Record<string, unknown> | undefined;
      rememberMediaTaskOwnership(
        requestAccountScope.ownerAccountKey,
        task?.taskId,
        task?.upstreamTaskId,
      );
      return { success: true, task: body.data };
    } catch (e) {
      console.error('[Media:getTaskStatus] Error:', e);
      return { success: false, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  });

  // Skills IPC handlers
  registerSkillHandlers({
    getSkillManager,
    getSkillStoreUrl,
    getOpenClawRuntimeAdapter: () => openClawRuntimeAdapter,
  });

  // Kits IPC handlers
  registerKitHandlers({
    getStore,
    getKitStoreUrl,
    getSkillManager,
    syncOpenClawConfig,
  });

  ipcMain.handle(OpenClawEngineIpc.GetStatus, async () => {
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

  ipcMain.handle(OpenClawEngineIpc.Install, async () => {
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

  ipcMain.handle(OpenClawEngineIpc.RetryInstall, async () => {
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
  ipcMain.handle(OpenClawEngineIpc.RestartGateway, async () => {
    console.log(
      `${gwDiagTs()} IPC ${OpenClawEngineIpc.RestartGateway}: manual restart requested from renderer`,
    );
    if (restartGatewayPromise) {
      console.log(
        `${gwDiagTs()} IPC ${OpenClawEngineIpc.RestartGateway}: restart already in progress, joining existing promise`,
      );
      const status = await restartGatewayPromise;
      return { success: status.phase === 'running' || status.phase === 'ready', status };
    }
    try {
      const manager = getOpenClawEngineManager();
      restartGatewayPromise = manager.restartGateway('ipc-manual');
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

  ipcMain.handle(OpenClawEngineIpc.RepairGatewayState, async () => {
    try {
      return await repairOpenClawGatewayState();
    } catch (error) {
      const manager = getOpenClawEngineManager();
      return {
        success: false,
        status: manager.getStatus(),
        originalPath: manager.getConfigPath(),
        error: error instanceof Error ? error.message : 'Failed to repair OpenClaw gateway state',
      };
    }
  });

  ipcMain.handle(DataMigrationIpc.Backup, async event => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    try {
      const saveOptions = {
        title: t('dataMigrationBackupDialogTitle'),
        defaultPath: path.join(app.getPath('downloads'), buildDataMigrationBackupFileName()),
        filters: [{ name: t('dataMigrationBackupArchiveFilter'), extensions: ['gz'] }],
      };
      const saveResult = ownerWindow
        ? await dialog.showSaveDialog(ownerWindow, saveOptions)
        : await dialog.showSaveDialog(saveOptions);
      if (saveResult.canceled || !saveResult.filePath) {
        return { success: true, canceled: true };
      }

      const outputPath = ensureTarGzFileName(saveResult.filePath);
      if (hasActiveGatewayWorkloads()) {
        return {
          success: false,
          error: t('dataMigrationBackupBlockedByActiveWorkloads'),
        };
      }
      const backupManager = sqliteBackupManager ?? new SqliteBackupManager(app.getPath('userData'));
      const sqliteRecord = await backupManager.createBackup({
        db: getStore().getDatabase(),
        trigger: SqliteBackupTrigger.Manual,
      });
      const sqliteSnapshotPath = path.join(
        backupManager.getPaths().snapshotsDir,
        sqliteRecord.fileName,
      );
      assertDataMigrationSqliteSnapshotMatchesLiveSync(
        path.join(app.getPath('userData'), DB_FILENAME),
        sqliteSnapshotPath,
      );

      const archive = await createMigrationArchive({
        userDataPath: app.getPath('userData'),
        outputPath,
        sqliteSnapshotPath,
        archiveKind: 'backup',
      });
      return {
        success: true,
        canceled: false,
        path: archive.outputPath,
        sizeBytes: archive.sizeBytes,
      };
    } catch (error) {
      console.error('[DataMigration] backup failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to back up LobsterAI data',
      };
    }
  });

  ipcMain.handle(DataMigrationIpc.Restore, async event => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    let rendererReleased = false;
    try {
      const openOptions = {
        title: t('dataMigrationRestoreDialogTitle'),
        properties: ['openFile'] as 'openFile'[],
        filters: [
          { name: t('dataMigrationBackupArchiveFilter'), extensions: ['gz', 'tgz'] },
          { name: t('dataMigrationAllFilesFilter'), extensions: ['*'] },
        ],
      };
      const openResult = ownerWindow
        ? await dialog.showOpenDialog(ownerWindow, openOptions)
        : await dialog.showOpenDialog(openOptions);
      if (openResult.canceled || openResult.filePaths.length === 0) {
        return { success: true, canceled: true };
      }

      const archivePath = openResult.filePaths[0];
      await inspectMigrationArchive(archivePath);
      isDataMigrationRestoreInProgress = true;
      isCleanupInProgress = true;
      isQuitting = true;
      await releaseRendererWindowsForDataMigrationRestore();
      rendererReleased = true;
      await showDataMigrationRestoreProgressWindow();
      await runAppCleanup('data migration restore');
      isCleanupFinished = true;
      isCleanupInProgress = false;

      const restoreResult = performDataMigrationRestoreSync({
        userDataPath: app.getPath('userData'),
        rollbackRootPath: path.join(app.getPath('appData'), `${APP_NAME}-migration-rollbacks`),
        archivePath,
      });
      const success = restoreResult?.status === DataMigrationRestoreStatus.Success;
      console.log(
        `[DataMigration] restore finished with status ${restoreResult?.status ?? 'unknown'}; `
        + `rollback archive ${restoreResult?.rollbackPath ?? 'was not created'}.`,
      );
      if (!success) {
        console.error('[DataMigration] restore failed:', restoreResult?.error ?? 'Unknown restore error');
      }
      if (rendererReleased) {
        setTimeout(() => {
          app.relaunch();
          app.exit(0);
        }, 100);
      }
      return {
        success,
        scheduledRestart: rendererReleased,
        rollbackPath: restoreResult?.rollbackPath,
        error: success ? undefined : restoreResult?.error || 'Failed to import LobsterAI data backup',
      };
    } catch (error) {
      isCleanupInProgress = false;
      const message = error instanceof Error ? error.message : 'Failed to import LobsterAI data backup';
      console.error('[DataMigration] restore scheduling failed:', error);
      if (rendererReleased) {
        dialog.showErrorBox(t('dataMigrationRestoreDialogTitle'), message);
        setTimeout(() => {
          app.relaunch();
          app.exit(0);
        }, 100);
      } else {
        isDataMigrationRestoreInProgress = false;
        isQuitting = false;
      }
      return {
        success: false,
        scheduledRestart: rendererReleased,
        error: message,
      };
    }
  });

  ipcMain.handle(DataMigrationIpc.GetLastRestoreResult, async () => {
    try {
      return {
        success: true,
        result: consumeLastRestoreResultSync(app.getPath('userData')),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read data migration result',
      };
    }
  });

  const getBrowserControlBaseUrl = (): string => {
    const info = getOpenClawEngineManager().getGatewayConnectionInfo();
    if (!info.port) {
      throw new Error('OpenClaw gateway port is unavailable.');
    }
    return `http://127.0.0.1:${info.port + 2}`;
  };

  const fetchBrowserControlJson = async <T,>(
    path: string,
    options: RequestInit & { timeoutMs?: number } = {},
  ): Promise<T> => {
    const { timeoutMs = 5000, ...requestOptions } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${getBrowserControlBaseUrl()}${path}`, {
        ...requestOptions,
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: unknown = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { error: text };
        }
      }
      if (!response.ok) {
        const errorMessage = payload && typeof payload === 'object' && 'error' in payload
          ? String((payload as { error?: unknown }).error)
          : `HTTP ${response.status}`;
        throw new Error(errorMessage);
      }
      return payload as T;
    } finally {
      clearTimeout(timer);
    }
  };

  const buildBrowserProfileQuery = (profile?: string): string => (
    profile ? `?profile=${encodeURIComponent(profile)}` : ''
  );

  ipcMain.handle(BrowserIpc.GetStatus, async (_event, options?: { profile?: BrowserRuntimeProfile }) => {
    try {
      const status = await fetchBrowserControlJson<Record<string, unknown>>(
        `/${buildBrowserProfileQuery(options?.profile)}`,
        { timeoutMs: 3000 },
      );
      return { success: true, status };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get browser status',
      };
    }
  });

  ipcMain.handle(BrowserIpc.ListProfiles, async () => {
    try {
      const result = await fetchBrowserControlJson<{ profiles?: unknown[] }>(
        '/profiles',
        { timeoutMs: 5000 },
      );
      return { success: true, profiles: result.profiles ?? [] };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list browser profiles',
      };
    }
  });

  ipcMain.handle(BrowserIpc.ResetProfile, async (_event, options?: { profile?: BrowserRuntimeProfile }) => {
    try {
      const profile = options?.profile || BrowserRuntimeProfile.Managed;
      const result = await fetchBrowserControlJson<Record<string, unknown>>(
        `/reset-profile${buildBrowserProfileQuery(profile)}`,
        { method: 'POST', timeoutMs: 20000 },
      );
      return { success: true, result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to reset browser profile',
      };
    }
  });

  ipcMain.handle(BrowserIpc.Test, async (_event, options?: { profile?: BrowserRuntimeProfile }) => {
    const steps: BrowserDiagnosticResultStep[] = [];
    const addStep = (step: BrowserDiagnosticStep, status: BrowserDiagnosticStatus, message: string, details?: string) => {
      steps.push({
        step,
        status,
        message,
        ...(details ? { details } : {}),
      });
    };
    const profile = options?.profile;

    try {
      const engineStatus = getOpenClawEngineManager().getStatus();
      if (engineStatus.phase !== 'running') {
        addStep(BrowserDiagnosticStep.GatewayStatus, BrowserDiagnosticStatus.Error, 'browserDiagnosticGatewayNotRunning', engineStatus.message);
        return { success: false, steps, error: engineStatus.message || 'OpenClaw gateway is not running.' };
      }
      addStep(BrowserDiagnosticStep.GatewayStatus, BrowserDiagnosticStatus.Success, 'browserDiagnosticGatewayReady');

      try {
        const profiles = await fetchBrowserControlJson<{ profiles?: unknown[] }>(
          '/profiles',
          { timeoutMs: 5000 },
        );
        addStep(BrowserDiagnosticStep.Profiles, BrowserDiagnosticStatus.Success, 'browserDiagnosticProfilesReady', `${profiles.profiles?.length ?? 0}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addStep(BrowserDiagnosticStep.Profiles, BrowserDiagnosticStatus.Error, 'browserDiagnosticProfilesFailed', message);
        return { success: false, steps, error: message };
      }

      try {
        await fetchBrowserControlJson<Record<string, unknown>>(
          `/${buildBrowserProfileQuery(profile)}`,
          { timeoutMs: 5000 },
        );
        addStep(BrowserDiagnosticStep.BrowserStatus, BrowserDiagnosticStatus.Success, 'browserDiagnosticStatusReady');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addStep(BrowserDiagnosticStep.BrowserStatus, BrowserDiagnosticStatus.Warning, 'browserDiagnosticStatusWarning', message);
      }

      try {
        await fetchBrowserControlJson<Record<string, unknown>>(
          `/start${buildBrowserProfileQuery(profile)}`,
          { method: 'POST', timeoutMs: 20000 },
        );
        addStep(BrowserDiagnosticStep.BrowserStart, BrowserDiagnosticStatus.Success, 'browserDiagnosticStartReady');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addStep(BrowserDiagnosticStep.BrowserStart, BrowserDiagnosticStatus.Error, 'browserDiagnosticStartFailed', message);
        return { success: false, steps, error: message };
      }

      try {
        await fetchBrowserControlJson<Record<string, unknown>>(
          `/tabs/open${buildBrowserProfileQuery(profile)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://example.com' }),
            timeoutMs: 20000,
          },
        );
        addStep(BrowserDiagnosticStep.OpenTestPage, BrowserDiagnosticStatus.Success, 'browserDiagnosticOpenPageReady');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addStep(BrowserDiagnosticStep.OpenTestPage, BrowserDiagnosticStatus.Error, 'browserDiagnosticOpenPageFailed', message);
        return { success: false, steps, error: message };
      }

      return { success: true, steps };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Browser diagnostic failed';
      if (steps.length === 0) {
        addStep(BrowserDiagnosticStep.GatewayStatus, BrowserDiagnosticStatus.Error, 'browserDiagnosticGatewayFailed', message);
      }
      return { success: false, steps, error: message };
    }
  });

  registerMcpHandlers({ getMcpRuntime, syncOpenClawConfig });

  registerDshHandlers({
    getStore: () => getStore(),
    getProviders: () => {
      const appConfig = getStore().get<{ providers?: Record<string, ProviderConfig> }>('app_config');
      const providers = { ...(appConfig?.providers ?? {}) };
      // The billed built-in provider authenticates through the token proxy;
      // syncing its raw key/baseUrl into dsh would produce a dead route.
      delete providers[ProviderName.LobsteraiServer];
      return providers;
    },
    getPlanProvider: () => {
      // The billed plan has no user-supplied key: requests go to the local
      // token proxy, which swaps in the account's access token. Without a
      // running proxy there is nothing usable to hand dsh.
      const proxyPort = getOpenClawTokenProxyPort();
      if (!proxyPort) return null;
      const planModels = getAllServerModelMetadata();
      if (planModels.length === 0) return null;
      return {
        baseUrl: `http://127.0.0.1:${proxyPort}/v1`,
        displayName: t('dshPlanProviderName'),
        models: planModels.map(model => ({
          modelId: model.modelId,
          modelName: model.modelName,
          apiFormat: model.apiFormat,
          supportsImage: model.supportsImage,
          // Thinking capability flows into dsh's reasoning-effort control.
          supportsThinking: model.supportsThinking,
          thinkingConfig: model.thinkingConfig,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        })),
      };
    },
    getDefaultCwd: () => {
      try {
        const workingDirectory = getCoworkStore().getConfig().workingDirectory?.trim();
        if (workingDirectory) return workingDirectory;
      } catch {
        // Cowork store may not be ready yet; fall through to the home dir.
      }
      return app.getPath('home');
    },
    getWorkbenchTitle: () => t('dshWorkbenchTitle'),
    syncOpenClawConfig,
  });


  // Cowork IPC handlers
  ipcMain.handle(
    'cowork:session:start',
    async (
      _event,
      options: {
        prompt: string;
        cwd?: string;
        systemPrompt?: string;
        title?: string;
        activeSkillIds?: string[];
        runtimeSkillIds?: string[];
        kitIds?: string[];
        kitReferences?: KitReference[];
        resolvedKitCapabilities?: ResolvedKitCapabilities;
        imageAttachments?: CoworkImageAttachmentMain[];
        agentId?: string;
        modelOverride?: string;
        thinkingLevel?: string;
        mediaSelection?: {
          mode: 'auto' | 'image' | 'video' | 'none';
          modelId?: string;
          modelName?: string;
          imageModelId?: string;
          videoModelId?: string;
        };
        mediaReferences?: MediaAttachmentRefMain[];
        selectedTextSnippets?: CoworkSelectedTextSnippet[];
        browserAnnotations?: CoworkBrowserAnnotationMessageBatch[];
      },
    ) => {
      try {
        const ipcStartedAtMs = Date.now();
        const requestAccountScope = getCurrentMediaAccountScope();
        console.log(
          '[CoworkFirstResponseTiming] start IPC received.',
          `Prompt length ${options.prompt.length}.`,
          `Image attachments ${options.imageAttachments?.length ?? 0}.`,
          `Agent ${options.agentId || 'main'}.`,
        );
        const modelRunGate = await ensureServerModelReadyForRun(
          resolveCoworkRunModelRef({
            modelOverride: options.modelOverride,
            agentId: options.agentId,
          }),
        );
        if (modelRunGate.allowed === false) {
          return { success: false, error: modelRunGate.error };
        }
        const engineStatus = await ensureOpenClawRunningForCowork();
        if (engineStatus.phase !== 'running') {
          return getEngineNotReadyResponse(engineStatus);
        }
        if (!isMediaAccountScopeSnapshotCurrent(
          requestAccountScope,
          getCurrentMediaAccountScope(),
        )) {
          return {
            success: false,
            error: t('authAccountChanged'),
          };
        }

        const coworkStoreInstance = getCoworkStore();
        const config = coworkStoreInstance.getConfig();
        const systemPrompt = mergeCoworkSystemPrompt(options.systemPrompt ?? config.systemPrompt);
        const persistedSystemPrompt = containsPlanModePrompt(systemPrompt)
          ? mergeCoworkSystemPrompt(config.systemPrompt)
          : systemPrompt;
        const selectedTaskDirectory = resolveSessionWorkingDirectory({
          cwd: options.cwd,
          agentId: options.agentId,
        });

        if (!selectedTaskDirectory) {
          return {
            success: false,
            error: 'Please select a task folder before submitting.',
          };
        }
        const imageAttachmentValidation = validateCoworkImageAttachmentsForRuntime(options.imageAttachments);
        if (imageAttachmentValidation.ok === false) {
          return {
            success: false,
            error: imageAttachmentValidation.error,
          };
        }

        // Strip NUL before this handler persists the message itself; the
        // runtime adapter sanitizes again at the outbound boundary.
        const prompt = stripNullChars(options.prompt);
        const fallbackTitle = buildSessionTitleFromInput(
          prompt,
          t('coworkDefaultSessionTitle'),
        );
        const title = options.title?.trim() || fallbackTitle;
        const taskWorkingDirectory = resolveTaskWorkingDirectory(selectedTaskDirectory);
        const runtimeSkillIds = options.runtimeSkillIds ?? options.activeSkillIds;
        const selectedTextSnippets = normalizeSelectedTextSnippetsForIpc(options.selectedTextSnippets);
        const browserAnnotations = normalizeBrowserAnnotationBatches(options.browserAnnotations);
        const thinkingLevel = options.thinkingLevel === undefined
          ? ''
          : parseModelThinkingLevel(options.thinkingLevel);
        if (options.thinkingLevel !== undefined && !thinkingLevel) {
          return { success: false, error: 'Unsupported session thinking level.' };
        }
        if (selectedTextSnippets.length > 0) {
          console.log(
            `[CoworkSelectedText] accepted ${selectedTextSnippets.length} excerpts with `
            + `${selectedTextSnippets.reduce((total, snippet) => total + snippet.text.length, 0)} characters for a new session`,
          );
        }

        const session = coworkStoreInstance.createSession(
          title,
          taskWorkingDirectory,
          persistedSystemPrompt,
          config.executionMode || 'local',
          runtimeSkillIds || [],
          options.agentId || 'main',
          options.modelOverride || '',
          { thinkingLevel: thinkingLevel || '' },
        );

        if (options.modelOverride) {
          console.log(
            '[Cowork:StartSession] session created with modelOverride:',
            session.id,
            options.modelOverride,
          );
        }

        const skinTurn = getSkinRuntimeController().prepareTurn({
          sessionId: session.id,
          kitIds: options.kitIds,
          mediaSelection: normalizeMediaSelectionState(options.mediaSelection),
          mediaGenerationEntitled: cachedMediaGenerationEntitled,
        });
        const { workflowKind, mediaSelection: normalizedMediaSelection } = skinTurn;
        if (requestAccountScope) {
          mediaTurnAccountScopeBySession.set(session.id, requestAccountScope);
        } else {
          mediaTurnAccountScopeBySession.delete(session.id);
        }
        if (
          requestAccountScope
          && normalizedMediaSelection
          && normalizedMediaSelection.mode !== 'none'
        ) {
          mediaSelectionBySession.set(
            session.id,
            bindAccountValue(normalizedMediaSelection, requestAccountScope),
          );
        } else {
          mediaSelectionBySession.delete(session.id);
        }

        if (options.mediaReferences?.length) {
          mediaReferencesBySession.set(session.id, options.mediaReferences);
        } else {
          mediaReferencesBySession.delete(session.id);
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
        }
        const imageAttachmentPreviews = buildCoworkImageAttachmentPreviews(options.imageAttachments);
        const messageMetadata = buildCoworkUserSelectionMetadata({
          prompt,
          skillIds: options.activeSkillIds,
          kitIds: options.kitIds,
          kitReferences: options.kitReferences,
          resolvedKitCapabilities: options.resolvedKitCapabilities,
          selectedTextSnippets,
          browserAnnotations,
          imageAttachmentPreviews,
        });
        coworkStoreInstance.addMessage(session.id, {
          type: 'user',
          content: prompt,
          metadata: messageMetadata,
        });

        coworkStoreInstance.updateSession(session.id, { status: 'running' });

        const runtime = getCoworkEngineRouter();
        console.log(
          '[CoworkFirstResponseTiming] start IPC dispatched to runtime.',
          `Session ${session.id}.`,
          `Elapsed ${Date.now() - ipcStartedAtMs}ms.`,
        );
        runtime
          .startSession(session.id, prompt, {
            skipInitialUserMessage: true,
            systemPrompt,
            skillIds: runtimeSkillIds,
            messageSkillIds: options.activeSkillIds,
            kitIds: options.kitIds,
            kitReferences: options.kitReferences,
            resolvedKitCapabilities: options.resolvedKitCapabilities,
            workspaceRoot: taskWorkingDirectory,
            confirmationMode: 'modal',
            imageAttachments: options.imageAttachments,
            agentId: options.agentId,
            mediaSelection: normalizedMediaSelection,
            workflowKind,
            mediaReferences: options.mediaReferences,
            selectedTextSnippets,
            browserAnnotations,
          })
          .catch(error => {
            console.error('[Cowork] session error:', error);
            try {
              const existing = coworkStoreInstance.getSession(session.id);
              if (existing?.status === 'error') return;
              const errorMessage = error instanceof Error ? error.message : String(error);
              const windows = BrowserWindow.getAllWindows();
              windows.forEach(win => {
                if (win.isDestroyed()) return;
                win.webContents.send('cowork:stream:error', {
                  sessionId: session.id,
                  error: errorMessage,
                });
              });
            } catch (handlerError) {
              console.error(
                '[Cowork] failed to send error notification to renderer:',
                handlerError,
              );
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
    },
  );

  ipcMain.handle(
    'cowork:session:continue',
    async (
      _event,
      options: {
        sessionId: string;
        prompt: string;
        systemPrompt?: string;
        activeSkillIds?: string[];
        runtimeSkillIds?: string[];
        kitIds?: string[];
        kitReferences?: KitReference[];
        resolvedKitCapabilities?: ResolvedKitCapabilities;
        imageAttachments?: CoworkImageAttachmentMain[];
        mediaSelection?: {
          mode: 'auto' | 'image' | 'video' | 'none';
          modelId?: string;
          modelName?: string;
          imageModelId?: string;
          videoModelId?: string;
        };
        mediaReferences?: MediaAttachmentRefMain[];
        selectedTextSnippets?: CoworkSelectedTextSnippet[];
        browserAnnotations?: CoworkBrowserAnnotationMessageBatch[];
      },
    ) => {
      try {
        const ipcStartedAtMs = Date.now();
        const requestAccountScope = getCurrentMediaAccountScope();
        console.log(
          '[CoworkFirstResponseTiming] continue IPC received.',
          `Session ${options.sessionId}.`,
          `Prompt length ${options.prompt.length}.`,
          `Image attachments ${options.imageAttachments?.length ?? 0}.`,
        );
        const modelRunGate = await ensureServerModelReadyForRun(
          resolveCoworkRunModelRef({ sessionId: options.sessionId }),
        );
        if (modelRunGate.allowed === false) {
          return { success: false, error: modelRunGate.error };
        }
        const engineStatus = await ensureOpenClawRunningForCowork();
        if (engineStatus.phase !== 'running') {
          return getEngineNotReadyResponse(engineStatus);
        }
        if (!isMediaAccountScopeSnapshotCurrent(
          requestAccountScope,
          getCurrentMediaAccountScope(),
        )) {
          return {
            success: false,
            error: t('authAccountChanged'),
          };
        }

        const runtime = getCoworkEngineRouter();
        const coworkStoreInstance = getCoworkStore();
        const existingSession = coworkStoreInstance.getSession(options.sessionId);
        const config = coworkStoreInstance.getConfig();
        const hasLegacyPersistedPlanMode = containsPlanModePrompt(existingSession?.systemPrompt);
        const continuationSystemPrompt = mergeCoworkSystemPrompt(
          options.systemPrompt
            ?? (hasLegacyPersistedPlanMode ? config.systemPrompt : existingSession?.systemPrompt),
        );
        if (hasLegacyPersistedPlanMode) {
          coworkStoreInstance.updateSession(options.sessionId, {
            systemPrompt: mergeCoworkSystemPrompt(config.systemPrompt) ?? '',
          });
          console.log(
            `[Cowork] removed a legacy persisted plan mode prompt from session ${options.sessionId}.`,
          );
        }
        const selectedTextSnippets = normalizeSelectedTextSnippetsForIpc(options.selectedTextSnippets);
        const browserAnnotations = normalizeBrowserAnnotationBatches(options.browserAnnotations);
        if (selectedTextSnippets.length > 0) {
          console.log(
            `[CoworkSelectedText] accepted ${selectedTextSnippets.length} excerpts with `
            + `${selectedTextSnippets.reduce((total, snippet) => total + snippet.text.length, 0)} characters for session ${options.sessionId}`,
          );
        }
        const imageAttachmentValidation = validateCoworkImageAttachmentsForRuntime(options.imageAttachments);
        if (imageAttachmentValidation.ok === false) {
          return {
            success: false,
            error: imageAttachmentValidation.error,
          };
        }

        const skinTurn = getSkinRuntimeController().prepareTurn({
          sessionId: options.sessionId,
          kitIds: options.kitIds,
          mediaSelection: normalizeMediaSelectionState(options.mediaSelection),
          mediaGenerationEntitled: cachedMediaGenerationEntitled,
        });
        const { workflowKind, mediaSelection: normalizedMediaSelection } = skinTurn;
        if (requestAccountScope) {
          mediaTurnAccountScopeBySession.set(options.sessionId, requestAccountScope);
        } else {
          mediaTurnAccountScopeBySession.delete(options.sessionId);
        }
        if (
          requestAccountScope
          && normalizedMediaSelection
          && normalizedMediaSelection.mode !== 'none'
        ) {
          mediaSelectionBySession.set(
            options.sessionId,
            bindAccountValue(normalizedMediaSelection, requestAccountScope),
          );
        } else {
          mediaSelectionBySession.delete(options.sessionId);
        }

        if (options.mediaReferences?.length) {
          mediaReferencesBySession.set(options.sessionId, options.mediaReferences);
        } else {
          mediaReferencesBySession.delete(options.sessionId);
        }

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

        console.log(
          '[CoworkFirstResponseTiming] continue IPC dispatched to runtime.',
          `Session ${options.sessionId}.`,
          `Elapsed ${Date.now() - ipcStartedAtMs}ms.`,
        );
        runtime
          .continueSession(options.sessionId, options.prompt, {
            systemPrompt: continuationSystemPrompt,
            skillIds: options.runtimeSkillIds ?? options.activeSkillIds,
            messageSkillIds: options.activeSkillIds,
            kitIds: options.kitIds,
            kitReferences: options.kitReferences,
            resolvedKitCapabilities: options.resolvedKitCapabilities,
            imageAttachments: options.imageAttachments,
            mediaSelection: normalizedMediaSelection,
            workflowKind,
            mediaReferences: options.mediaReferences,
            selectedTextSnippets,
            browserAnnotations,
          })
          .catch(error => {
            console.error('[Cowork] continue error:', error);
            try {
              const existing = getCoworkStore().getSession(options.sessionId);
              if (existing?.status === 'error') return;
              const errorMessage = error instanceof Error ? error.message : String(error);
              const windows = BrowserWindow.getAllWindows();
              windows.forEach(win => {
                if (win.isDestroyed()) return;
                win.webContents.send('cowork:stream:error', {
                  sessionId: options.sessionId,
                  error: errorMessage,
                });
              });
            } catch (handlerError) {
              console.error(
                '[Cowork] failed to send error notification to renderer:',
                handlerError,
              );
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
    },
  );

  ipcMain.handle(CoworkIpcChannel.SubmitBtw, async (
    _event,
    options: CoworkBtwSubmitRequest,
  ): Promise<CoworkBtwSubmitResponse> => {
    const sessionId = typeof options?.sessionId === 'string' ? options.sessionId.trim() : '';
    const question = typeof options?.question === 'string'
      ? normalizeCoworkBtwQuestion(options.question)
      : '';
    const runId = typeof options?.runId === 'string' ? options.runId.trim() : '';
    if (!sessionId || !question || !runId) {
      return {
        success: false,
        runId,
        error: t('coworkBtwRequestRequired'),
      };
    }
    if (
      sessionId.length > COWORK_BTW_IDENTIFIER_MAX_CHARS
      || runId.length > COWORK_BTW_IDENTIFIER_MAX_CHARS
    ) {
      return {
        success: false,
        runId: runId.slice(0, COWORK_BTW_IDENTIFIER_MAX_CHARS),
        error: t('coworkBtwInvalidIdentifier'),
      };
    }
    if (/[\r\n]/.test(question)) {
      return {
        success: false,
        runId,
        error: t('coworkBtwSingleLine'),
      };
    }
    try {
      console.debug(
        '[CoworkBtw] side-question IPC received.',
        `Session ${sessionId}.`,
        `Run ${runId}.`,
        `Question chars ${question.length}.`,
      );
      const engineStatus = await ensureOpenClawRunningForCowork();
      if (engineStatus.phase !== 'running') {
        return {
          ...getEngineNotReadyResponse(engineStatus),
          runId,
        };
      }
      const runtime = getCoworkEngineRouter();
      if (!runtime.submitBtw) {
        return {
          success: false,
          runId,
          error: t('coworkBtwUnavailable'),
        };
      }
      const result = await runtime.submitBtw(sessionId, question, runId);
      console.debug(
        '[CoworkBtw] side-question IPC completed.',
        `Session ${sessionId}.`,
        `Run ${runId}.`,
        `Success ${result.success ? 'yes' : 'no'}.`,
      );
      return result;
    } catch (error) {
      console.error(
        '[CoworkBtw] side-question IPC failed.',
        `Session ${sessionId}.`,
        `Run ${runId}.`,
        error,
      );
      return {
        success: false,
        runId,
        error: error instanceof Error ? error.message : t('coworkBtwSubmitFailed'),
      };
    }
  });

  ipcMain.handle(CoworkIpcChannel.AbortBtw, async (
    _event,
    options: CoworkBtwAbortRequest,
  ): Promise<CoworkBtwAbortResponse> => {
    const sessionId = typeof options?.sessionId === 'string' ? options.sessionId.trim() : '';
    const runId = typeof options?.runId === 'string' ? options.runId.trim() : '';
    if (
      !sessionId
      || !runId
      || sessionId.length > COWORK_BTW_IDENTIFIER_MAX_CHARS
      || runId.length > COWORK_BTW_IDENTIFIER_MAX_CHARS
    ) {
      return {
        success: false,
        aborted: false,
        runId: runId.slice(0, COWORK_BTW_IDENTIFIER_MAX_CHARS),
        error: t('coworkBtwInvalidIdentifier'),
      };
    }

    try {
      console.debug(
        '[CoworkBtw] side-question stop IPC received.',
        `Session ${sessionId}.`,
        `Run ${runId}.`,
      );
      const runtime = getCoworkEngineRouter();
      if (!runtime.abortBtw) {
        return {
          success: false,
          aborted: false,
          runId,
          error: t('coworkBtwUnavailable'),
        };
      }
      const result = await runtime.abortBtw(sessionId, runId);
      console.debug(
        '[CoworkBtw] side-question stop IPC completed.',
        `Session ${sessionId}.`,
        `Run ${runId}.`,
        `Aborted ${result.aborted ? 'yes' : 'no'}.`,
      );
      return result;
    } catch (error) {
      console.error(
        '[CoworkBtw] side-question stop IPC failed.',
        `Session ${sessionId}.`,
        `Run ${runId}.`,
        error,
      );
      return {
        success: false,
        aborted: false,
        runId,
        error: t('coworkBtwStopFailed'),
      };
    }
  });

  ipcMain.handle(CoworkIpcChannel.SubmitSteer, async (
    _event,
    options: { sessionId: string; text: string; clientSteerId: string },
  ) => {
    const clientSteerId = typeof options?.clientSteerId === 'string' && options.clientSteerId.trim()
      ? options.clientSteerId.trim()
      : `steer-${Date.now()}`;
    try {
      const requestAccountScope = getCurrentMediaAccountScope();
      const sessionId = typeof options?.sessionId === 'string' ? options.sessionId.trim() : '';
      const text = typeof options?.text === 'string' ? options.text.trim() : '';
      if (!sessionId || !text) {
        return {
          success: false,
          status: CoworkSteerStatus.Rejected,
          clientSteerId,
          reason: CoworkSteerRejectReason.EmptyInput,
          error: 'Session id and steer input are required.',
        };
      }
      const requestTurnAccountScope = resolveMediaTurnAccountScopeForSession(sessionId);
      if (!isMediaAccountScopeSnapshotCurrent(
        requestAccountScope,
        requestTurnAccountScope,
      )) {
        return {
          success: false,
          status: CoworkSteerStatus.Rejected,
          clientSteerId,
          reason: CoworkSteerRejectReason.RuntimeRejected,
          error: t('mediaTaskAccountMismatch'),
        };
      }
      console.debug(
        '[CoworkSteer] steer IPC received.',
        `Session ${sessionId}.`,
        `Client steer ${clientSteerId}.`,
        `Chars ${text.length}.`,
      );

      const engineStatus = await ensureOpenClawRunningForCowork();
      if (engineStatus.phase !== 'running') {
        return {
          ...getEngineNotReadyResponse(engineStatus),
          status: CoworkSteerStatus.Rejected,
          clientSteerId,
          reason: CoworkSteerRejectReason.RuntimeRejected,
        };
      }
      if (
        !isMediaAccountScopeSnapshotCurrent(
          requestAccountScope,
          getCurrentMediaAccountScope(),
        )
        || !isMediaAccountScopeSnapshotCurrent(
          requestTurnAccountScope,
          resolveMediaTurnAccountScopeForSession(sessionId),
        )
      ) {
        return {
          success: false,
          status: CoworkSteerStatus.Rejected,
          clientSteerId,
          reason: CoworkSteerRejectReason.RuntimeRejected,
          error: t('authAccountChanged'),
        };
      }

      const runtime = getCoworkEngineRouter();
      if (!runtime.submitSteer) {
        return {
          success: false,
          status: CoworkSteerStatus.Rejected,
          clientSteerId,
          reason: CoworkSteerRejectReason.RuntimeUnsupported,
          error: 'Steer is not supported by the current runtime.',
        };
      }

      const result = await runtime.submitSteer(sessionId, text, clientSteerId);
      if (!isMediaAccountScopeSnapshotCurrent(
        requestAccountScope,
        getCurrentMediaAccountScope(),
      )) {
        return {
          success: false,
          status: CoworkSteerStatus.Rejected,
          clientSteerId,
          reason: CoworkSteerRejectReason.RuntimeRejected,
          error: t('authAccountChanged'),
        };
      }
      console.debug(
        '[CoworkSteer] steer IPC completed.',
        `Session ${sessionId}.`,
        `Client steer ${clientSteerId}.`,
        `Status ${result.status}.`,
        `Reason ${result.reason ?? 'none'}.`,
      );
      return result;
    } catch (error) {
      console.error('[CoworkSteer] steer IPC failed:', error);
      return {
        success: false,
        status: CoworkSteerStatus.Rejected,
        clientSteerId,
        reason: CoworkSteerRejectReason.Unknown,
        error: error instanceof Error ? error.message : 'Failed to submit steer input',
      };
    }
  });

  ipcMain.handle(CoworkIpcChannel.GoalCommand, async (
    _event,
    options: { sessionId: string; command: string },
  ) => {
    try {
      const engineStatus = await ensureOpenClawRunningForCowork();
      if (engineStatus.phase !== 'running') {
        return getEngineNotReadyResponse(engineStatus);
      }
      const sessionId = typeof options?.sessionId === 'string' ? options.sessionId.trim() : '';
      const command = typeof options?.command === 'string' ? options.command.trim() : '';
      if (!sessionId || !command) {
        return {
          success: false,
          error: 'Session id and goal command are required.',
        };
      }
      const runtime = getCoworkEngineRouter();
      if (!runtime.runGoalCommand) {
        return {
          success: false,
          error: 'Goal commands are not supported by the current runtime.',
        };
      }
      const action = command.split(/\s+/, 2)[1] ?? 'status';
      console.debug(
        '[CoworkGoal] goal command IPC received.',
        `Session ${sessionId}.`,
        `Action ${action}.`,
      );
      const goal = await runtime.runGoalCommand(sessionId, command);
      return { success: true, goal };
    } catch (error) {
      console.error('[CoworkGoal] goal command IPC failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to run goal command',
      };
    }
  });

  ipcMain.handle(CoworkIpcChannel.StopSession, async (_event, sessionId: string) => {
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

  ipcMain.handle(CoworkIpcChannel.MarkSessionViewed, async (_event, sessionId: string) => {
    try {
      getDesktopNotificationManager().markSessionViewed(sessionId);
      return { success: true };
    } catch (error) {
      console.warn(`[DesktopNotification] failed to mark session ${sessionId} viewed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to mark session viewed',
      };
    }
  });

  ipcMain.handle(CoworkIpcChannel.SetActiveSession, async (event, sessionId: string | null) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) {
      return { success: false, error: 'Unknown renderer' };
    }
    try {
      getDesktopNotificationManager().setActiveSession(
        typeof sessionId === 'string' && sessionId ? sessionId : null,
      );
      return { success: true };
    } catch (error) {
      console.warn('[DesktopNotification] failed to update active session:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update active session',
      };
    }
  });

  ipcMain.handle(CoworkIpcChannel.OpenSessionFromNotificationReady, async event => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) {
      console.warn('[DesktopNotification] ignored notification open readiness from an unknown renderer');
      return { success: false, error: 'Unknown renderer' };
    }

    isOpenSessionFromNotificationReady = true;
    console.log('[DesktopNotification] renderer is ready to open sessions from notifications');
    flushOpenSessionFromNotification();
    return { success: true };
  });

  ipcMain.handle('cowork:session:delete', async (_event, sessionId: string) => {
    try {
      getCoworkEngineRouter().stopSession(sessionId);
      const coworkStoreInstance = getCoworkStore();
      const affectedArtifactIds = coworkStoreInstance.deleteSession(sessionId);
      if (affectedArtifactIds.length > 0) {
        libraryIndexService?.notifyChange({
          reason: LibraryChangeReason.SessionDeleted,
          itemIds: affectedArtifactIds,
        });
      }
      mediaSelectionBySession.delete(sessionId);
      mediaTurnAccountScopeBySession.delete(sessionId);
      skinRuntimeController?.handleSessionDeleted(sessionId);
      mediaReferencesBySession.delete(sessionId);
      getDesktopNotificationManager().handleSessionDeleted(sessionId);
      // Remove any pending media tasks for this session
      for (const [taskId, tracker] of pendingMediaTasks) {
        if (tracker.sessionId === sessionId) pendingMediaTasks.delete(taskId);
      }
      clearHandledMediaTasksForSession(sessionId);
      clearMediaStatusPollCountsForSession(sessionId);
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
      sessionIds.forEach(sessionId => {
        runtime.stopSession(sessionId);
      });
      const coworkStoreInstance = getCoworkStore();
      const affectedArtifactIds = coworkStoreInstance.deleteSessions(sessionIds);
      if (affectedArtifactIds.length > 0) {
        libraryIndexService?.notifyChange({
          reason: LibraryChangeReason.SessionDeleted,
          itemIds: affectedArtifactIds,
        });
      }
      const router = getCoworkEngineRouter();
      for (const sessionId of sessionIds) {
        skinRuntimeController?.handleSessionDeleted(sessionId);
        getDesktopNotificationManager().handleSessionDeleted(sessionId);
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

  ipcMain.handle(
    'cowork:session:pin',
    async (_event, options: { sessionId: string; pinned: boolean }) => {
      try {
        const coworkStoreInstance = getCoworkStore();
        const pinOrder = coworkStoreInstance.setSessionPinned(options.sessionId, options.pinned);
        return { success: true, pinOrder };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update session pin',
        };
      }
    },
  );

  ipcMain.handle(
    'cowork:session:rename',
    async (_event, options: { sessionId: string; title: string }) => {
      try {
        const title = options.title.trim();
        if (!title) {
          return { success: false, error: 'Title is required' };
        }
        const coworkStoreInstance = getCoworkStore();
        coworkStoreInstance.updateSession(options.sessionId, { title }, { touchUpdatedAt: false });
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to rename session',
        };
      }
    },
  );

  ipcMain.handle(
    CoworkIpcChannel.ForkSession,
    async (
      _event,
      options?: {
        sessionId: string;
        forkedFromMessageId?: string | null;
        title?: string;
      },
    ) => {
      try {
        const sessionId = options?.sessionId?.trim();
        if (!sessionId) {
          return { success: false, error: 'Session id is required' };
        }

        const runtime = getCoworkEngineRouter();
        const coworkStoreInstance = getCoworkStore();
        const sourceSession = coworkStoreInstance.getSession(sessionId);
        if (!sourceSession) {
          console.warn('[CoworkFork] fork request referenced a missing session');
          return { success: false, error: 'Session not found' };
        }
        if (sourceSession.status === 'running' || runtime.isSessionActive(sessionId)) {
          console.warn('[CoworkFork] fork request was rejected because the session is still running');
          return { success: false, error: 'Please stop the current task before forking it.' };
        }

        const forkedFromMessageId = options?.forkedFromMessageId?.trim() || null;
        const forkedFromTimestamp = forkedFromMessageId
          ? coworkStoreInstance.getMessageTimestamp(sessionId, forkedFromMessageId)
          : null;
        const forkContextMessages: CoworkForkContextMessage[] = [];
        const compactionSummary = await runtime.getForkCompactionSummary(
          sessionId,
          forkedFromTimestamp ?? undefined,
        );
        if (compactionSummary) {
          forkContextMessages.push({
            content: compactionSummary.summary,
            metadata: {
              kind: CoworkSystemMessageKind.ForkCompactionSummary,
              sourceSessionId: sessionId,
              sourceSessionKey: compactionSummary.sessionKey,
              checkpointId: compactionSummary.checkpointId ?? null,
              checkpointReason: compactionSummary.reason ?? null,
              checkpointCreatedAt: compactionSummary.createdAt ?? null,
              tokensBefore: compactionSummary.tokensBefore ?? null,
              tokensAfter: compactionSummary.tokensAfter ?? null,
              truncated: compactionSummary.truncated === true,
            },
          });
          console.log(`[CoworkFork] attached a compaction summary bridge from source session ${sessionId}`);
        }

        console.log(`[CoworkFork] creating a local conversation fork from session ${sessionId}`);
        const session = coworkStoreInstance.forkSession({
          sourceSessionId: sessionId,
          forkMode: CoworkForkMode.Conversation,
          forkedFromMessageId,
          title: options?.title,
          contextMessages: forkContextMessages,
        });
        console.log(`[CoworkFork] created local conversation fork ${session.id} successfully`);
        return { success: true, session };
      } catch (error) {
        console.error('[CoworkFork] failed to fork session:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fork session',
        };
      }
    },
  );

  ipcMain.handle('cowork:session:get', async (_event, sessionId: string) => {
    try {
      const session = getCoworkStore().getSession(sessionId);
      if (session) {
        console.log(
          `[CoworkIPC] loaded session ${sessionId}; returned ${session.messages.length} of ${session.totalMessages} messages from offset ${session.messagesOffset}.`,
        );
      } else {
        console.warn(`[CoworkIPC] session ${sessionId} was not found during load.`);
      }
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
      const mapping = getIMGatewayManager()
        ?.getIMStore()
        ?.getSessionMappingByCoworkSessionId(sessionId);
      return { success: true, remoteManaged: !!mapping };
    } catch (error) {
      return {
        success: false,
        remoteManaged: false,
        error: error instanceof Error ? error.message : 'Failed to check remote managed session',
      };
    }
  });

  ipcMain.handle(
    'cowork:session:list',
    async (_event, options?: { limit?: number; offset?: number; agentId?: string; searchQuery?: string }) => {
      try {
        const limit = options?.limit ?? COWORK_SESSION_PAGE_SIZE;
        const offset = options?.offset ?? 0;
        const agentId = options?.agentId;
        const searchQuery = options?.searchQuery?.trim() ?? '';
        const store = getCoworkStore();
        const startedAt = searchQuery ? Date.now() : 0;
        const sessions = searchQuery
          ? store.searchSessions({ query: searchQuery, limit, offset, agentId })
          : store.listSessions(limit, offset, agentId);
        const total = searchQuery
          ? store.countSearchSessions({ query: searchQuery, agentId })
          : store.countSessions(agentId);
        if (searchQuery) {
          console.debug(
            `[CoworkIPC] searched sessions; query length ${searchQuery.length}, returned ${sessions.length} of ${total} from offset ${offset} in ${Date.now() - startedAt}ms.`,
          );
        }
        return { success: true, sessions, hasMore: offset + sessions.length < total };
      } catch (error) {
        console.error('[CoworkIPC] failed to list sessions:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list sessions',
        };
      }
    },
  );

  ipcMain.handle(
    'cowork:session:getMessages',
    async (_event, options: {
      sessionId: string;
      limit?: number;
      offset?: number;
    }) => {
      try {
        const { sessionId, limit = COWORK_MESSAGE_PAGE_SIZE, offset = 0 } = options;
        const store = getCoworkStore();
        const total = store.countSessionMessages(sessionId);
        const messages = store.getPagedSessionMessages(sessionId, limit, offset);
        console.log(
          `[CoworkIPC] loaded message page for session ${sessionId}; returned ${messages.length} of ${total} messages from offset ${offset} with limit ${limit}.`,
        );
        return { success: true, messages, offset, total };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get session messages',
        };
      }
    },
  );

  ipcMain.handle(
    CoworkIpcChannel.GetSessionSearchMessages,
    async (_event, options: {
      sessionId: string;
      limit?: number;
      offset?: number;
      cursor?: CoworkSearchMessageCursor;
      knownTotal?: number;
    }) => {
      try {
        const requestedLimit = options?.limit ?? COWORK_SEARCH_MESSAGE_PAGE_SIZE;
        const limit = Number.isFinite(requestedLimit)
          ? Math.max(1, Math.min(COWORK_SEARCH_MESSAGE_PAGE_MAX_SIZE, Math.floor(requestedLimit)))
          : COWORK_SEARCH_MESSAGE_PAGE_SIZE;
        const requestedOffset = options?.offset ?? 0;
        const offset = Number.isFinite(requestedOffset)
          ? Math.max(0, Math.floor(requestedOffset))
          : 0;
        const page = getCoworkStore().getSessionSearchMessagePage(
          options.sessionId,
          limit,
          offset,
          options.cursor,
          options.knownTotal,
        );
        console.debug(
          `[CoworkIPC] loaded lightweight search page for session ${options.sessionId}; `
          + `returned ${page.messages.length} searchable messages while advancing `
          + `from offset ${page.offset} to ${page.nextOffset} of ${page.total}.`,
        );
        return { success: true, ...page };
      } catch (error) {
        console.error('[CoworkIPC] failed to load lightweight conversation search page:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get conversation search messages',
        };
      }
    },
  );

  ipcMain.handle(CoworkIpcChannel.GetSessionMessageRailIndex, async (_event, sessionId: string) => {
    try {
      const store = getCoworkStore();
      const items = store.getSessionMessageRailIndex(sessionId);
      console.log(
        `[CoworkIPC] loaded message rail index for session ${sessionId}; returned ${items.length} items.`,
      );
      return { success: true, items };
    } catch (error) {
      console.error('[CoworkIPC] failed to load message rail index:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get session message rail index',
      };
    }
  });

  ipcMain.handle('cowork:session:contextUsage', async (_event, sessionId: string) => {
    try {
      const usage = await getCoworkEngineRouter().getContextUsage(sessionId);
      return {
        success: true,
        usage,
        source: usage ? CoworkContextUsageSource.Live : CoworkContextUsageSource.Unavailable,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get context usage',
        reason: CoworkContextUsageFailureReason.GatewayError,
      };
    }
  });

  ipcMain.handle('cowork:session:compactContext', async (_event, sessionId: string) => {
    try {
      const result = await getCoworkEngineRouter().compactContext(sessionId);
      return { success: true, ...result };
    } catch (error) {
      console.warn(`[CoworkIPC] manual context compaction failed for session ${sessionId}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to compact context',
      };
    }
  });

  const resolveAgentWorkspacePath = (agentId: string): string => {
    const stateDir = getOpenClawEngineManager().getStateDir();
    return agentId === AgentId.Main
      ? getMainAgentWorkspacePath(stateDir)
      : path.join(stateDir, `workspace-${agentId}`);
  };

  const resolveExistingAgentWorkspacePath = (agentId?: string): string => {
    const normalizedAgentId = agentId?.trim() || AgentId.Main;
    if (normalizedAgentId !== AgentId.Main && getAgentManager().getAgent(normalizedAgentId) === null) {
      throw new Error(`Agent ${normalizedAgentId} not found`);
    }
    return resolveAgentWorkspacePath(normalizedAgentId);
  };

  registerAgentHandlers({
    getAgentManager,
    getCoworkStore,
    getCoworkEngineRouter,
    getIMGatewayManager,
    refreshImSessionWorkingDirectoriesForAgent,
    resolveAgentWorkspacePath,
    resolveDefaultAgentModelRef,
    syncOpenClawConfig,
  });

  ipcMain.handle(
    'cowork:session:exportResultImage',
    async (
      event,
      options: {
        rect: { x: number; y: number; width: number; height: number };
        defaultFileName?: string;
      },
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
    },
  );

  ipcMain.handle(
    'cowork:session:captureImageChunk',
    async (
      event,
      options: {
        rect: { x: number; y: number; width: number; height: number };
      },
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
    },
  );

  ipcMain.handle(
    'cowork:session:saveResultImage',
    async (
      event,
      options: {
        pngBase64: string;
        defaultFileName?: string;
      },
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
    },
  );

  ipcMain.handle(
    'cowork:session:exportText',
    async (
      event,
      options: {
        content: string;
        defaultFileName?: string;
        fileExtension?: string;
      },
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
    },
  );

  // ── Session diagnostics IPC ────────────────────────────────────────────

  registerSessionDiagnosticsHandlers({
    getDatabase: () => getStore().getDatabase(),
    getAppVersion: () => app.getVersion(),
    getDownloadsPath: () => app.getPath('downloads'),
  });

  // ── Subagent tracking IPC ──────────────────────────────────────────────

  registerCoworkSubagentHandlers({
    getOpenClawRuntimeAdapter: () => openClawRuntimeAdapter,
    getCoworkEngineRouter,
  });

  ipcMain.handle(CoworkIpcChannel.CancelMediaTask, async (_event, taskId: string) => {
    try {
      const requestAccountScope = getCurrentMediaAccountScope();
      if (requestAccountScope === null) {
        return { success: false, message: t('authLoginRequired') };
      }
      const taskOwnerAccountKey = resolveMediaTaskOwner(taskId);
      if (!canAccessTrackedMediaTask(taskOwnerAccountKey, requestAccountScope)) {
        return { success: false, message: t('mediaTaskAccountMismatch') };
      }
      const serverBaseUrl = getServerApiBaseUrl();
      const resp = await fetchWithAuth(`${serverBaseUrl}/api/media/videos/tasks/${taskId}/cancel`, { method: 'POST' });
      const body = await resp.json() as { code: number; message?: string };
      if (!isMediaAccountScopeCurrent(requestAccountScope, getCurrentMediaAccountScope())) {
        return { success: false, message: t('authAccountChanged') };
      }
      if (handleEnterpriseAccountContextMismatch(body.code, requestAccountScope)) {
        return { success: false, message: t('enterpriseAccountContextMismatchMessage') };
      }
      if (body.code === 0) {
        return { success: true };
      }
      const msg = body.message || '';
      if (msg.includes('409') || msg.includes('running') || msg.includes('Conflict')) {
        return { success: false, message: 'Task is already running and cannot be cancelled.' };
      }
      return { success: false, message: msg || 'Cancel failed' };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : 'Cancel failed' };
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
        if (options.requestId) {
          const result = options.result;
          const askUserResponse: AskUserResponse = {
            behavior: result.behavior === 'allow' ? 'allow' : 'deny',
            answers:
              result.behavior === 'allow' &&
              result.updatedInput &&
              typeof result.updatedInput === 'object'
                ? ((result.updatedInput as Record<string, unknown>).answers as
                    | Record<string, string>
                    | undefined)
                : undefined,
          };
          getMcpRuntime().resolveAskUser(options.requestId, askUserResponse);
        }

        const runtime = getCoworkEngineRouter();
        runtime.respondToPermission(options.requestId, options.result);
        // Close the desktop notification for this request regardless of which
        // subsystem handled it (runtime approvals emit permissionResolved on
        // their own; AskUserQuestion bridge requests do not).
        getDesktopNotificationManager().handlePermissionResolved(options.requestId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to respond to permission',
        };
      }
    },
  );

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

  ipcMain.handle(CoworkIpcChannel.TempStorageUsage, async () => {
    try {
      const preview = await getCoworkTempJanitor().preview();
      return { success: true, ...preview };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to measure temp storage',
      };
    }
  });

  ipcMain.handle(
    CoworkIpcChannel.TempStorageClean,
    async (_event, options?: { cwds?: string[] }) => {
      try {
        const selectedCwds = Array.isArray(options?.cwds)
          ? options.cwds.filter((cwd): cwd is string => typeof cwd === 'string' && cwd.trim() !== '')
          : undefined;
        const summary = await getCoworkTempJanitor().clean(selectedCwds);
        return { success: true, ...summary };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to clean temp storage',
        };
      }
    },
  );

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
      await syncOpenClawConfig({
        reason: 'session-policy-updated',
        restartGatewayIfRunning: false,
      });
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
      if (patch.model) {
        patch.model = normalizeOpenClawModelRef(patch.model);
      }
      const runtime = getCoworkEngineRouter();
      const patchResult = await runtime.patchSession(sessionId, patch);

      if (patch.model !== undefined || patch.thinkingLevel !== undefined) {
        const sessionUpdates: {
          modelOverride?: string;
          thinkingLevel?: ReturnType<typeof parseModelThinkingLevel> | '';
        } = {};
        if (patch.model !== undefined) {
          sessionUpdates.modelOverride =
            patchResult && typeof patchResult.modelOverride === 'string'
              ? patchResult.modelOverride
              : patch.model ?? '';
        }
        if (patch.thinkingLevel !== undefined) {
          sessionUpdates.thinkingLevel = patch.thinkingLevel
            ? parseModelThinkingLevel(patch.thinkingLevel) ?? ''
            : '';
        }
        getCoworkStore().updateSession(sessionId, sessionUpdates, { touchUpdatedAt: false });
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

  ipcMain.handle(
    'cowork:memory:listEntries',
    async (
      _event,
      input: {
        query?: string;
        status?: 'created' | 'stale' | 'deleted' | 'all';
        includeDeleted?: boolean;
        limit?: number;
        offset?: number;
      },
    ) => {
      try {
        const filePath = resolveMemoryFilePath(
          getMainAgentWorkspacePath(getOpenClawEngineManager().getStateDir()),
        );

        // Lazy migration: SQLite → MEMORY.md (one-time, cached in memory)
        if (!memoryMigrationDone) {
          migrateSqliteToMemoryMd(filePath, {
            isMigrationDone: () =>
              getStore().get<string>('openclawMemory.migration.v1.completed') === '1',
            markMigrationDone: () => {
              getStore().set('openclawMemory.migration.v1.completed', '1');
              memoryMigrationDone = true;
            },
            getActiveMemoryTexts: () => {
              return getCoworkStore()
                .listUserMemories({ status: 'all', includeDeleted: false, limit: 200 })
                .map(m => m.text);
            },
          });
          // Even if migration found nothing, skip future checks this session
          memoryMigrationDone = true;
        }

        const query = input?.query?.trim() || '';
        const entries = query ? searchMemoryEntries(filePath, query) : readMemoryEntries(filePath);
        return { success: true, entries };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list memory entries',
        };
      }
    },
  );
  ipcMain.handle(
    'cowork:memory:createEntry',
    async (
      _event,
      input: {
        text: string;
        confidence?: number;
        isExplicit?: boolean;
      },
    ) => {
      try {
        const filePath = resolveMemoryFilePath(
          getMainAgentWorkspacePath(getOpenClawEngineManager().getStateDir()),
        );
        const entry = addMemoryEntry(filePath, input.text);
        return { success: true, entry };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create memory entry',
        };
      }
    },
  );
  ipcMain.handle(
    'cowork:memory:updateEntry',
    async (
      _event,
      input: {
        id: string;
        text?: string;
        confidence?: number;
        status?: 'created' | 'stale' | 'deleted';
        isExplicit?: boolean;
      },
    ) => {
      try {
        const filePath = resolveMemoryFilePath(
          getMainAgentWorkspacePath(getOpenClawEngineManager().getStateDir()),
        );
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
    },
  );
  ipcMain.handle(
    'cowork:memory:deleteEntry',
    async (
      _event,
      input: {
        id: string;
      },
    ) => {
      try {
        const filePath = resolveMemoryFilePath(
          getMainAgentWorkspacePath(getOpenClawEngineManager().getStateDir()),
        );
        const success = deleteMemoryEntry(filePath, input.id);
        return success ? { success: true } : { success: false, error: 'Memory entry not found' };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to delete memory entry',
        };
      }
    },
  );
  ipcMain.handle(CoworkIpcChannel.MemoryReadRaw, async () => {
    try {
      const filePath = resolveMemoryFilePath(
        getMainAgentWorkspacePath(getOpenClawEngineManager().getStateDir()),
      );
      return { success: true, content: readMemoryFileRaw(filePath) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read memory file',
      };
    }
  });
  ipcMain.handle(CoworkIpcChannel.MemoryWriteRaw, async (_event, input: { content: string }) => {
    try {
      if (typeof input?.content !== 'string') {
        return { success: false, error: 'Memory content is required' };
      }
      const filePath = resolveMemoryFilePath(
        getMainAgentWorkspacePath(getOpenClawEngineManager().getStateDir()),
      );
      writeMemoryFileRaw(filePath, input.content);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to write memory file',
      };
    }
  });
  ipcMain.handle('cowork:memory:getStats', async () => {
    try {
      const filePath = resolveMemoryFilePath(
        getMainAgentWorkspacePath(getOpenClawEngineManager().getStateDir()),
      );
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
  // ── Dreaming content display ──────────────────────────────────────────
  ipcMain.handle('cowork:dreaming:status', async () => {
    try {
      const gwClient = openClawRuntimeAdapter?.getGatewayClient();
      if (!gwClient) {
        return { success: false, error: 'Gateway client not available' };
      }
      const result = await gwClient.request<Record<string, unknown>>(
        'doctor.memory.status',
        {},
        { timeoutMs: 10_000 },
      );
      const dreaming = (result as any)?.dreaming;
      if (!dreaming) {
        return { success: true, data: null };
      }
      return { success: true, data: dreaming };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch dreaming status',
      };
    }
  });
  ipcMain.handle('cowork:dreaming:diary', async () => {
    try {
      const gwClient = openClawRuntimeAdapter?.getGatewayClient();
      if (!gwClient) {
        return { success: false, error: 'Gateway client not available' };
      }
      const result = await gwClient.request<Record<string, unknown>>(
        'doctor.memory.dreamDiary',
        {},
        { timeoutMs: 10_000 },
      );
      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch dream diary',
      };
    }
  });

  ipcMain.handle(CoworkIpcChannel.BootstrapRead, async (
    _event,
    filename: string,
    options?: { agentId?: string },
  ) => {
    try {
      const workspace = resolveExistingAgentWorkspacePath(options?.agentId);
      const content = readBootstrapFile(workspace, filename);
      return { success: true, content };
    } catch (error) {
      return {
        success: false,
        content: '',
        error: error instanceof Error ? error.message : 'Failed to read bootstrap file',
      };
    }
  });
  ipcMain.handle(CoworkIpcChannel.BootstrapWrite, async (
    _event,
    filename: string,
    content: string,
    options?: { agentId?: string },
  ) => {
    try {
      const workspace = resolveExistingAgentWorkspacePath(options?.agentId);
      writeBootstrapFile(workspace, filename, content);
      syncOpenClawConfig({ reason: 'bootstrap-updated' }).catch(err => {
        console.error('[OpenClaw] config sync after bootstrap-updated failed:', err);
      });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to write bootstrap file',
      };
    }
  });

  const VALID_EMBEDDING_PROVIDERS = [
    'local',
    'openai',
    'gemini',
    'voyage',
    'mistral',
    'ollama',
  ] as const;

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
      embeddingEnabled:
        typeof config.embeddingEnabled === 'boolean' ? config.embeddingEnabled : undefined,
      embeddingProvider:
        typeof config.embeddingProvider === 'string' &&
        (VALID_EMBEDDING_PROVIDERS as readonly string[]).includes(config.embeddingProvider)
          ? config.embeddingProvider
          : undefined,
      embeddingModel:
        typeof config.embeddingModel === 'string' ? config.embeddingModel.trim() : undefined,
      embeddingLocalModelPath:
        typeof config.embeddingLocalModelPath === 'string'
          ? config.embeddingLocalModelPath.trim()
          : undefined,
      embeddingVectorWeight:
        typeof config.embeddingVectorWeight === 'number' &&
        Number.isFinite(config.embeddingVectorWeight)
          ? Math.max(0, Math.min(1, config.embeddingVectorWeight))
          : undefined,
      embeddingRemoteBaseUrl:
        typeof config.embeddingRemoteBaseUrl === 'string'
          ? config.embeddingRemoteBaseUrl.trim()
          : undefined,
      embeddingRemoteApiKey:
        typeof config.embeddingRemoteApiKey === 'string'
          ? config.embeddingRemoteApiKey.trim()
          : undefined,
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
    openClawHeartbeatEnabled?: boolean;
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
            Math.min(MAX_MEMORY_USER_MEMORIES_MAX_ITEMS, Math.floor(config.memoryUserMemoriesMaxItems)),
          )
          : undefined;
      const normalizedSkipMissedJobs = typeof config.skipMissedJobs === 'boolean'
        ? config.skipMissedJobs
        : undefined;
      const normalizedOpenClawHeartbeatEnabled = typeof config.openClawHeartbeatEnabled === 'boolean'
        ? config.openClawHeartbeatEnabled
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
        openClawHeartbeatEnabled: normalizedOpenClawHeartbeatEnabled,
        ...normalizedEmbedding,
      };
      const previousConfig = getCoworkStore().getConfig();
      const previousWorkingDir = previousConfig.workingDirectory;
      getCoworkStore().setConfig(normalizedConfig);
      if (normalizedConfig.workingDirectory !== undefined && normalizedConfig.workingDirectory !== previousWorkingDir) {
        getSkillManager().handleWorkingDirectoryChange();
        // Main agent workspace is decoupled from workingDirectory — no MEMORY.md
        // or IDENTITY.md sync needed here. The workspace is always at
        // {STATE_DIR}/workspace-main/ regardless of the user's working directory.
      }

      const nextConfig = getCoworkStore().getConfig();
      const impactDecision = classifyCoworkConfigChange(previousConfig, nextConfig);
      if (
        normalizedConfig.openClawHeartbeatEnabled !== undefined
        && previousConfig.openClawHeartbeatEnabled !== nextConfig.openClawHeartbeatEnabled
      ) {
        console.log(
          `[Cowork] OpenClaw heartbeat setting changed: enabled=${nextConfig.openClawHeartbeatEnabled}, previous=${previousConfig.openClawHeartbeatEnabled}, impact=${impactDecision.impact}`,
        );
      }
      if (impactDecision.impact !== OpenClawConfigImpact.None) {
        const syncResult = await syncOpenClawConfig({
          reason: 'cowork-config-change',
          restartGatewayIfRunning: impactDecision.impact === OpenClawConfigImpact.Restart,
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

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set config',
      };
    }
  });

  // ==================== Plugin Management IPC Handlers ====================

  registerPluginHandlers({ getCoworkStore, syncOpenClawConfig });

  // ==================== Scheduled Task IPC Handlers (OpenClaw) ====================

  initCronJobServiceManager({
    getOpenClawRuntimeAdapter: () => openClawRuntimeAdapter,
  });
  initScheduledTaskHelpers({
    getIMGatewayManager: () => ({
      getConfig: () => getIMGatewayManager().getConfig() as unknown as Record<string, unknown>,
    }),
  });
  const scheduledTaskHandlerDeps = {
    getCronJobService,
    getIMGatewayManager: () => ({
      getIMStore: () => ({
        getSessionMapping: (conversationId: string, platform: string) =>
          getIMGatewayManager()
            .getIMStore()
            .getSessionMapping(conversationId, platform as Platform),
        getIMSettings: () => getIMGatewayManager().getIMStore().getIMSettings(),
        listSessionMappings: (platform: string, accountId?: string) =>
          getIMGatewayManager()
            .getIMStore()
            .listSessionMappings(platform as Platform, accountId)
            .map(mapping => ({
              ...mapping,
              lastActiveAt: String(mapping.lastActiveAt),
            })),
      }),
      primeConversationReplyRoute: (
        platform: string,
        conversationId: string,
        coworkSessionId: string,
      ) =>
        getIMGatewayManager().primeConversationReplyRoute(
          platform as Platform,
          conversationId,
          coworkSessionId,
        ),
    }),
    getOpenClawRuntimeAdapter: () => openClawRuntimeAdapter,
    getCoworkSessionTitle: (sessionId: string) =>
      getCoworkStore().getSession(sessionId, 0)?.title ?? null,
  };
  registerScheduledTaskHandlers(scheduledTaskHandlerDeps);

  registerNimQrLoginHandlers({
    startNimQrLogin,
    pollNimQrLogin,
  });

  registerPermissionIpcHandlers({ ipcMain, isDev });

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

  // Debounce + serialization for IM config sync requests.
  // A single Settings Save can include many IM edits; they are coalesced into
  // one OpenClaw config sync and at most one gateway restart.
  // The running/pending flags prevent concurrent sync operations from racing:
  // if a sync is in progress when new changes arrive, they are queued and
  // a follow-up sync runs after the current one completes.
  let imConfigSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let imConfigSyncRunning = false;
  let imConfigSyncPending = false;
  let imConfigSyncRestartGatewayIfRunning = false;
  let lastSyncedImOpenClawConfigFingerprint: string | null = null;
  const IM_CONFIG_SYNC_DEBOUNCE_MS = 600;
  type IMConfigSyncOptions = {
    restartGatewayIfRunning?: boolean;
  };
  type IMConfigSetOptions = IMConfigSyncOptions & {
    syncGateway?: boolean;
    markRestartOnSave?: boolean;
  };
  type IMConfigSyncResult = {
    success: boolean;
    error?: string;
    pending?: boolean;
  };
  let imConfigRestartOnNextSettingsSave = false;

  const getCurrentImOpenClawConfigFingerprint = () => {
    return createStableConfigFingerprint(getIMGatewayManager().getConfig());
  };

  const ensureLastSyncedImOpenClawConfigFingerprint = (fallbackFingerprint?: string) => {
    if (lastSyncedImOpenClawConfigFingerprint === null) {
      lastSyncedImOpenClawConfigFingerprint = fallbackFingerprint ?? getCurrentImOpenClawConfigFingerprint();
    }
    return lastSyncedImOpenClawConfigFingerprint;
  };

  const doImConfigSync = async (): Promise<IMConfigSyncResult> => {
    imConfigSyncRunning = true;
    const restartGatewayIfRunning = imConfigSyncRestartGatewayIfRunning;
    imConfigSyncRestartGatewayIfRunning = false;
    try {
      const syncResult = await syncOpenClawConfig({
        reason: 'im-config-change',
        restartGatewayIfRunning,
      });
      if (!syncResult.success) {
        throw new Error(syncResult.error || 'OpenClaw config sync failed.');
      }
      lastSyncedImOpenClawConfigFingerprint = getCurrentImOpenClawConfigFingerprint();
      imConfigRestartOnNextSettingsSave = false;
      // After config sync, ensure the runtime adapter's WebSocket client
      // is connected so channel events are received.
      if (openClawRuntimeAdapter) {
        try {
          await openClawRuntimeAdapter.connectGatewayIfNeeded();
        } catch (connectError) {
          console.error('[IM] Failed to connect gateway client after config sync:', connectError);
        }
      }
      return { success: true };
    } catch (error) {
      console.error('[IM] Config sync failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'OpenClaw config sync failed.',
      };
    } finally {
      imConfigSyncRunning = false;
      if (imConfigSyncPending) {
        const restartPendingGatewayIfRunning = imConfigSyncRestartGatewayIfRunning;
        imConfigSyncPending = false;
        scheduleImConfigSync({
          restartGatewayIfRunning: restartPendingGatewayIfRunning,
        });
      }
    }
  };

  const scheduleImConfigSync = (options: IMConfigSyncOptions = {}) => {
    if (options.restartGatewayIfRunning) {
      imConfigSyncRestartGatewayIfRunning = true;
    }
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

  const runImConfigSyncNow = async (options: IMConfigSyncOptions = {}): Promise<IMConfigSyncResult> => {
    if (options.restartGatewayIfRunning) {
      imConfigSyncRestartGatewayIfRunning = true;
    }
    if (imConfigSyncTimer) {
      clearTimeout(imConfigSyncTimer);
      imConfigSyncTimer = null;
    }
    if (imConfigSyncRunning) {
      imConfigSyncPending = true;
      return { success: true, pending: true };
    }
    return await doImConfigSync();
  };

  const recordImOpenClawConfigMutation = (
    previousFingerprint: string,
    nextFingerprint: string,
    options: IMConfigSetOptions = {},
  ) => {
    ensureLastSyncedImOpenClawConfigFingerprint(previousFingerprint);
    if (options.markRestartOnSave) {
      imConfigRestartOnNextSettingsSave = true;
    }
    const impactDecision = classifyImOpenClawConfigChange(previousFingerprint, nextFingerprint, {
      forceRestart: options.restartGatewayIfRunning === true,
    });
    if (impactDecision.impact === OpenClawConfigImpact.None) {
      return;
    }

    if (options.syncGateway) {
      scheduleImConfigSync({
        restartGatewayIfRunning:
          options.restartGatewayIfRunning === true
          || impactDecision.impact === OpenClawConfigImpact.Restart,
      });
    }
  };

  const mutateImOpenClawConfig = (
    mutate: () => void,
    options: IMConfigSetOptions = {},
  ) => {
    const previousFingerprint = getCurrentImOpenClawConfigFingerprint();
    mutate();
    const nextFingerprint = getCurrentImOpenClawConfigFingerprint();
    recordImOpenClawConfigMutation(previousFingerprint, nextFingerprint, options);
  };

  ipcMain.handle('im:config:set', async (_event, config: Partial<IMGatewayConfig>, options?: IMConfigSetOptions) => {
    try {
      mutateImOpenClawConfig(() => {
        getIMGatewayManager().setConfig(config, {
          syncGateway: false,
          restartGatewayIfRunning: false,
        });
      }, {
        syncGateway: options?.syncGateway,
        restartGatewayIfRunning: options?.restartGatewayIfRunning,
        markRestartOnSave: options?.markRestartOnSave,
      });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set IM config',
      };
    }
  });

  // Explicitly apply IM settings to OpenClaw.
  // Called from the global Settings Save button after IM fields have been
  // persisted locally without gateway sync.
  ipcMain.handle('im:config:sync', async () => {
    try {
      const nextFingerprint = getCurrentImOpenClawConfigFingerprint();
      const previousFingerprint = ensureLastSyncedImOpenClawConfigFingerprint(nextFingerprint);
      const impactDecision = classifyImOpenClawConfigChange(previousFingerprint, nextFingerprint, {
        forceRestart: imConfigRestartOnNextSettingsSave,
      });
      if (impactDecision.impact === OpenClawConfigImpact.None) {
        lastSyncedImOpenClawConfigFingerprint = nextFingerprint;
        return { success: true, skipped: true };
      }
      const syncResult = await runImConfigSyncNow({
        restartGatewayIfRunning: impactDecision.impact === OpenClawConfigImpact.Restart,
      });
      if (!syncResult.success) {
        return { success: false, error: syncResult.error };
      }
      return { success: true, skipped: false };
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

  ipcMain.handle(
    'im:gateway:test',
    async (_event, platform: Platform, configOverride?: Partial<IMGatewayConfig>) => {
      try {
        const result = await getIMGatewayManager().testGateway(platform, configOverride);
        return { success: true, result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to test gateway connectivity',
        };
      }
    },
  );

  // Weixin QR login
  ipcMain.handle('im:weixin:qr-login-start', async () => {
    try {
      const result = await getIMGatewayManager().weixinQrLoginStart();
      return { success: true, ...result };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to start Weixin QR login',
      };
    }
  });

  ipcMain.handle('im:weixin:qr-login-wait', async (_event, sessionKey?: string) => {
    try {
      const previousFingerprint = getCurrentImOpenClawConfigFingerprint();
      const result = await getIMGatewayManager().weixinQrLoginWait(sessionKey);
      const nextFingerprint = getCurrentImOpenClawConfigFingerprint();
      recordImOpenClawConfigMutation(previousFingerprint, nextFingerprint, {
        syncGateway: false,
        restartGatewayIfRunning: false,
        markRestartOnSave: result.connected === true || result.alreadyConnected === true,
      });
      return { success: true, ...result };
    } catch (error) {
      return {
        success: false,
        connected: false,
        message: error instanceof Error ? error.message : 'Weixin QR login failed',
      };
    }
  });

  // POPO QR login
  ipcMain.handle('im:popo:qr-login-start', async () => {
    try {
      const result = getIMGatewayManager().popoQrLoginStart();
      return { success: true, ...result };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to start POPO QR login',
      };
    }
  });

  ipcMain.handle('im:popo:qr-login-poll', async (_event, taskToken: string) => {
    try {
      const result = await getIMGatewayManager().popoQrLoginPoll(taskToken);
      return result;
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'POPO QR login poll failed',
      };
    }
  });

  ipcMain.handle('im:popo:instance:add', async (_event, name: string) => {
    try {
      const instanceId = crypto.randomUUID();
      const { DEFAULT_POPO_CONFIG: defaults } = await import('./im/types');
      const instance = {
        ...defaults,
        instanceId,
        instanceName: name || 'POPO Bot',
      };
      getIMGatewayManager().getIMStore().setPopoInstanceConfig(instanceId, instance);
      return { success: true, instance };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add POPO instance',
      };
    }
  });

  ipcMain.handle('im:popo:instance:delete', async (_event, instanceId: string, options?: IMConfigSetOptions) => {
    try {
      mutateImOpenClawConfig(
        () => getIMGatewayManager().getIMStore().deletePopoInstance(instanceId),
        {
          syncGateway: options?.syncGateway,
          restartGatewayIfRunning: options?.restartGatewayIfRunning,
          markRestartOnSave: options?.markRestartOnSave,
        },
      );
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete POPO instance',
      };
    }
  });

  ipcMain.handle('im:popo:instance:config:set', async (_event, instanceId: string, config: Record<string, unknown>, options?: IMConfigSetOptions) => {
    try {
      mutateImOpenClawConfig(
        () => getIMGatewayManager().getIMStore().setPopoInstanceConfig(instanceId, config),
        {
          syncGateway: options?.syncGateway,
          restartGatewayIfRunning: options?.restartGatewayIfRunning,
          markRestartOnSave: options?.markRestartOnSave,
        },
      );
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set POPO instance config',
      };
    }
  });

  ipcMain.handle('im:status:get', async () => {
    try {
      const status = await getIMGatewayManager().getStatusWithOpenClawRuntime();
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
        let fetchIMToken: (
          apiKey: string,
          email: string,
          logger: typeof console,
        ) => Promise<unknown>;
        try {
          ({ fetchIMToken } = require('@clawemail/node-sdk'));
        } catch {
          throw new Error(
            'Email SDK not installed. Please install the @clawemail/node-sdk package.',
          );
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

  ipcMain.handle('im:dingtalk:instance:delete', async (_event, instanceId: string, options?: IMConfigSetOptions) => {
    try {
      mutateImOpenClawConfig(
        () => getIMGatewayManager().getIMStore().deleteDingTalkInstance(instanceId),
        {
          syncGateway: options?.syncGateway,
          restartGatewayIfRunning: options?.restartGatewayIfRunning,
          markRestartOnSave: options?.markRestartOnSave,
        },
      );
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete DingTalk instance',
      };
    }
  });

  ipcMain.handle('im:dingtalk:instance:config:set', async (_event, instanceId: string, config: Partial<DingTalkInstanceConfig>, options?: IMConfigSetOptions) => {
    try {
      mutateImOpenClawConfig(
        () => getIMGatewayManager().getIMStore().setDingTalkInstanceConfig(instanceId, config),
        {
          syncGateway: options?.syncGateway,
          restartGatewayIfRunning: options?.restartGatewayIfRunning,
          markRestartOnSave: options?.markRestartOnSave,
        },
      );
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

  ipcMain.handle('im:nim:instance:delete', async (_event, instanceId: string, options?: IMConfigSetOptions) => {
    try {
      mutateImOpenClawConfig(
        () => getIMGatewayManager().getIMStore().deleteNimInstance(instanceId),
        {
          syncGateway: options?.syncGateway,
          restartGatewayIfRunning: options?.restartGatewayIfRunning,
          markRestartOnSave: options?.markRestartOnSave,
        },
      );
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete NIM instance',
      };
    }
  });

  ipcMain.handle('im:nim:instance:config:set', async (_event, instanceId: string, config: Partial<NimInstanceConfig>, options?: IMConfigSetOptions) => {
    try {
      mutateImOpenClawConfig(
        () => getIMGatewayManager().getIMStore().setNimInstanceConfig(instanceId, config),
        {
          syncGateway: options?.syncGateway,
          restartGatewayIfRunning: options?.restartGatewayIfRunning,
          markRestartOnSave: options?.markRestartOnSave,
        },
      );
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

  ipcMain.handle('im:qq:instance:delete', async (_event, instanceId: string, options?: IMConfigSetOptions) => {
    try {
      mutateImOpenClawConfig(
        () => getIMGatewayManager().getIMStore().deleteQQInstance(instanceId),
        {
          syncGateway: options?.syncGateway,
          restartGatewayIfRunning: options?.restartGatewayIfRunning,
          markRestartOnSave: options?.markRestartOnSave,
        },
      );
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete QQ instance',
      };
    }
  });

  ipcMain.handle('im:qq:instance:config:set', async (_event, instanceId: string, config: Partial<QQInstanceConfig>, options?: IMConfigSetOptions) => {
    try {
      mutateImOpenClawConfig(
        () => getIMGatewayManager().getIMStore().setQQInstanceConfig(instanceId, config),
        {
          syncGateway: options?.syncGateway,
          restartGatewayIfRunning: options?.restartGatewayIfRunning,
          markRestartOnSave: options?.markRestartOnSave,
        },
      );
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

  ipcMain.handle('im:feishu:instance:delete', async (_event, instanceId: string, options?: IMConfigSetOptions) => {
    try {
      mutateImOpenClawConfig(
        () => getIMGatewayManager().getIMStore().deleteFeishuInstance(instanceId),
        {
          syncGateway: options?.syncGateway,
          restartGatewayIfRunning: options?.restartGatewayIfRunning,
          markRestartOnSave: options?.markRestartOnSave,
        },
      );
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete Feishu instance',
      };
    }
  });

  ipcMain.handle('im:feishu:instance:config:set', async (_event, instanceId: string, config: Partial<FeishuInstanceConfig>, options?: IMConfigSetOptions) => {
    try {
      mutateImOpenClawConfig(
        () => getIMGatewayManager().getIMStore().setFeishuInstanceConfig(instanceId, config),
        {
          syncGateway: options?.syncGateway,
          restartGatewayIfRunning: options?.restartGatewayIfRunning,
          markRestartOnSave: options?.markRestartOnSave,
        },
      );
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

  ipcMain.handle('im:email:instance:delete', async (_event, instanceId: string, options?: IMConfigSetOptions) => {
    try {
      mutateImOpenClawConfig(
        () => getIMGatewayManager().getIMStore().deleteEmailInstance(instanceId),
        {
          syncGateway: options?.syncGateway,
          restartGatewayIfRunning: options?.restartGatewayIfRunning,
          markRestartOnSave: options?.markRestartOnSave,
        },
      );
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete email instance',
      };
    }
  });

  ipcMain.handle('im:wecom:instance:delete', async (_event, instanceId: string, options?: IMConfigSetOptions) => {
    try {
      mutateImOpenClawConfig(
        () => getIMGatewayManager().getIMStore().deleteWecomInstance(instanceId),
        {
          syncGateway: options?.syncGateway,
          restartGatewayIfRunning: options?.restartGatewayIfRunning,
          markRestartOnSave: options?.markRestartOnSave,
        },
      );
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete WeCom instance',
      };
    }
  });

  ipcMain.handle('im:email:instance:config:set', async (_event, instanceId: string, config: Partial<EmailMultiInstanceConfig['instances'][number]>, options?: IMConfigSetOptions) => {
    try {
      mutateImOpenClawConfig(
        () => getIMGatewayManager().getIMStore().setEmailInstanceConfig(instanceId, config),
        {
          syncGateway: options?.syncGateway,
          restartGatewayIfRunning: options?.restartGatewayIfRunning,
          markRestartOnSave: options?.markRestartOnSave,
        },
      );
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set email instance config',
      };
    }
  });

  ipcMain.handle('im:wecom:instance:config:set', async (_event, instanceId: string, config: Partial<WecomInstanceConfig>, options?: IMConfigSetOptions) => {
    try {
      mutateImOpenClawConfig(
        () => getIMGatewayManager().getIMStore().setWecomInstanceConfig(instanceId, config),
        {
          syncGateway: options?.syncGateway,
          restartGatewayIfRunning: options?.restartGatewayIfRunning,
          markRestartOnSave: options?.markRestartOnSave,
        },
      );
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

  ipcMain.handle('im:telegram:instance:delete', async (_event, instanceId: string, options?: IMConfigSetOptions) => {
    try {
      mutateImOpenClawConfig(
        () => getIMGatewayManager().getIMStore().deleteTelegramInstance(instanceId),
        {
          syncGateway: options?.syncGateway,
          restartGatewayIfRunning: options?.restartGatewayIfRunning,
          markRestartOnSave: options?.markRestartOnSave,
        },
      );
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete Telegram instance',
      };
    }
  });

  ipcMain.handle('im:telegram:instance:config:set', async (_event, instanceId: string, config: Partial<TelegramInstanceConfig>, options?: IMConfigSetOptions) => {
    try {
      mutateImOpenClawConfig(
        () => getIMGatewayManager().getIMStore().setTelegramInstanceConfig(instanceId, config),
        {
          syncGateway: options?.syncGateway,
          restartGatewayIfRunning: options?.restartGatewayIfRunning,
          markRestartOnSave: options?.markRestartOnSave,
        },
      );
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

  ipcMain.handle('im:discord:instance:delete', async (_event, instanceId: string, options?: IMConfigSetOptions) => {
    try {
      mutateImOpenClawConfig(
        () => getIMGatewayManager().getIMStore().deleteDiscordInstance(instanceId),
        {
          syncGateway: options?.syncGateway,
          restartGatewayIfRunning: options?.restartGatewayIfRunning,
          markRestartOnSave: options?.markRestartOnSave,
        },
      );
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete Discord instance',
      };
    }
  });

  ipcMain.handle('im:discord:instance:config:set', async (_event, instanceId: string, config: Partial<DiscordInstanceConfig>, options?: IMConfigSetOptions) => {
    try {
      mutateImOpenClawConfig(
        () => getIMGatewayManager().getIMStore().setDiscordInstanceConfig(instanceId, config),
        {
          syncGateway: options?.syncGateway,
          restartGatewayIfRunning: options?.restartGatewayIfRunning,
          markRestartOnSave: options?.markRestartOnSave,
        },
      );
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

  ipcMain.handle(
    'feishu:install:verify',
    async (_event, { appId, appSecret }: { appId: string; appSecret: string }) => {
      try {
        return await getIMGatewayManager().verifyFeishuCredentials(appId, appSecret);
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : '验证失败' };
      }
    },
  );

  // DingTalk bot install helpers
  ipcMain.handle('dingtalk:install:qrcode', async () => {
    try {
      return await getIMGatewayManager().startDingTalkInstallQrcode();
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : '获取二维码失败');
    }
  });

  ipcMain.handle(
    'dingtalk:install:poll',
    async (_event, { deviceCode }: { deviceCode: string }) => {
      try {
        return await getIMGatewayManager().pollDingTalkInstall(deviceCode);
      } catch (error) {
        return { done: false, error: error instanceof Error ? error.message : '轮询失败' };
      }
    },
  );

  ipcMain.handle(
    'dingtalk:install:verify',
    async (_event, { clientId, clientSecret }: { clientId: string; clientSecret: string }) => {
      try {
        return await getIMGatewayManager().verifyDingTalkCredentials(clientId, clientSecret);
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : '验证失败' };
      }
    },
  );

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

  ipcMain.handle(
    'github-copilot:poll-for-token',
    async (
      _event,
      {
        deviceCode,
        interval,
        expiresIn,
      }: { deviceCode: string; interval: number; expiresIn: number },
    ) => {
      const { pollForAccessToken, getCopilotToken, getGitHubUser } =
        await import('./libs/githubCopilotAuth');
      try {
        const githubAccessToken = await pollForAccessToken(deviceCode, interval, expiresIn);
        const githubUser = await getGitHubUser(githubAccessToken);
        const {
          token: copilotToken,
          expiresAt,
          baseUrl,
        } = await getCopilotToken(githubAccessToken);
        // Store the GitHub access token for later token refresh
        getStore().set('github_copilot_github_token', githubAccessToken);
        // Register with the token manager for automatic refresh
        setCopilotTokenState({ copilotToken, baseUrl, expiresAt, githubToken: githubAccessToken });
        return { success: true, token: copilotToken, githubUser, baseUrl };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Authentication failed',
        };
      }
    },
  );

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
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Token refresh failed',
      };
    }
  });

  // OpenAI ChatGPT (Codex) OAuth handlers — see src/main/libs/openaiCodexAuth.ts.
  // The login flow opens a browser to https://auth.openai.com/oauth/authorize
  // and listens on http://127.0.0.1:1455/auth/callback for the redirect, then
  // writes <CODEX_HOME>/auth.json so the OpenClaw runtime can pick it up.
  ipcMain.handle('openai-codex-oauth:start', async () => {
    const { startOpenAICodexLogin } = await import('./libs/openaiCodexAuth');
    try {
      const tokens = await startOpenAICodexLogin();
      return {
        success: true as const,
        email: tokens.email ?? null,
        accountId: tokens.accountId ?? null,
        expiresAt: tokens.expiresAt,
      };
    } catch (error) {
      return {
        success: false as const,
        error: error instanceof Error ? error.message : 'ChatGPT login failed',
      };
    }
  });

  ipcMain.handle('openai-codex-oauth:cancel', async () => {
    const { cancelOpenAICodexLogin } = await import('./libs/openaiCodexAuth');
    cancelOpenAICodexLogin();
  });

  ipcMain.handle('openai-codex-oauth:logout', async () => {
    const { logoutOpenAICodex } = await import('./libs/openaiCodexAuth');
    logoutOpenAICodex();
  });

  ipcMain.handle('openai-codex-oauth:status', async () => {
    const { readOpenAICodexAuthFile } = await import('./libs/openaiCodexAuth');
    const tokens = readOpenAICodexAuthFile();
    if (!tokens) return { loggedIn: false as const };
    return {
      loggedIn: true as const,
      email: tokens.email ?? null,
      accountId: tokens.accountId ?? null,
      expiresAt: tokens.expiresAt,
    };
  });

  // xAI (Grok) OAuth handlers — see src/main/libs/xaiAuth.ts.
  // Browser PKCE against https://auth.x.ai with a loopback callback on
  // http://127.0.0.1:56121/callback; when that fixed port is taken (e.g. an
  // OpenClaw CLI login), falls back to the device-code flow and streams the
  // user code to the renderer via 'xai-oauth:device-code'. The credential is
  // written into the OpenClaw auth-profiles store, where the runtime's xai
  // plugin injects and auto-refreshes the Bearer token.
  ipcMain.handle('xai-oauth:start', async (event) => {
    const xaiAuth = await import('./libs/xaiAuth');
    try {
      let result;
      try {
        result = await xaiAuth.startXaiOAuthLogin();
      } catch (err) {
        if (!(err instanceof xaiAuth.XaiCallbackPortBusyError)) throw err;
        result = await xaiAuth.startXaiDeviceCodeLogin((info) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('xai-oauth:device-code', info);
          }
        });
      }
      // The xai provider entry is only emitted into openclaw.json once a
      // credential exists — sync now so the change takes effect immediately.
      void syncOpenClawConfig({ reason: 'xai-oauth-login' });
      return {
        success: true as const,
        email: result.email ?? null,
        flow: result.flow,
      };
    } catch (error) {
      return {
        success: false as const,
        error: error instanceof Error ? error.message : 'xAI login failed',
      };
    }
  });

  ipcMain.handle('xai-oauth:cancel', async () => {
    const { cancelXaiLogin } = await import('./libs/xaiAuth');
    cancelXaiLogin();
  });

  ipcMain.handle('xai-oauth:logout', async () => {
    const { logoutXai } = await import('./libs/xaiAuth');
    await logoutXai();
    void syncOpenClawConfig({ reason: 'xai-oauth-logout' });
  });

  ipcMain.handle('xai-oauth:status', async () => {
    const { getXaiOAuthStatus } = await import('./libs/xaiAuth');
    return getXaiOAuthStatus();
  });

  ipcMain.handle('generate-session-title', async (_event, userInput: string | null) => {
    return generateSessionTitle(userInput, t('coworkDefaultSessionTitle'));
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

  ipcMain.handle(
    'save-api-config',
    async (
      _event,
      config: {
        apiKey: string;
        baseURL: string;
        model: string;
        apiType?: 'anthropic' | 'openai';
      },
    ) => {
      try {
        saveCoworkApiConfig(config);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to save API config',
        };
      }
    },
  );

  // Dialog handlers
  ipcMain.handle('dialog:selectDirectory', async event => {
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

  ipcMain.handle(
    'dialog:selectFile',
    async (
      event,
      options?: { title?: string; filters?: { name: string; extensions: string[] }[] },
    ) => {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const dialogOptions = {
        properties: ['openFile'] as 'openFile'[],
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
    },
  );

  ipcMain.handle(
    'dialog:selectFiles',
    async (
      event,
      options?: { title?: string; filters?: { name: string; extensions: string[] }[] },
    ) => {
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
    },
  );

  ipcMain.handle(
    'dialog:showMessageBox',
    async (
      event,
      options: {
        message: string;
        type?: 'none' | 'info' | 'error' | 'question' | 'warning';
        title?: string;
      },
    ) => {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const { dialog } = await import('electron');
      return dialog.showMessageBox(ownerWindow!, {
        type: options.type || 'warning',
        title: options.title || '',
        message: options.message,
        buttons: ['OK'],
      });
    },
  );

  ipcMain.handle(
    'dialog:saveInlineFile',
    async (
      _event,
      options?: { dataBase64?: string; fileName?: string; mimeType?: string; cwd?: string },
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
        const coworkTempRoot = findCoworkTempRoot(dir);
        if (coworkTempRoot) {
          ensureCoworkTempGitignore(coworkTempRoot);
        }

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
    },
  );

  // Read a local file as a data URL (data:<mime>;base64,...)
  const MAX_READ_AS_DATA_URL_BYTES = 100 * 1024 * 1024;
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
    async (
      _event,
      filePath?: string,
    ): Promise<{ success: boolean; dataUrl?: string; error?: string }> => {
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
        console.warn('[Dialog] failed to read file as data URL:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to read file',
        };
      }
    },
  );

  ipcMain.handle(
    DialogIpc.StatFile,
    async (_event, filePath?: string): Promise<{ success: boolean; isFile?: boolean; isDirectory?: boolean; size?: number; mtimeMs?: number; error?: string }> => {
      try {
        if (typeof filePath !== 'string' || !filePath.trim()) {
          return { success: false, error: 'Missing file path' };
        }
        const stat = await fs.promises.stat(path.resolve(filePath.trim()));
        return {
          success: true,
          isFile: stat.isFile(),
          isDirectory: stat.isDirectory(),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to stat file',
        };
      }
    }
  );

  const MAX_READ_TEXT_FILE_BYTES = 2 * 1024 * 1024;
  ipcMain.handle(
    DialogIpc.ReadTextFile,
    async (_event, filePath?: string): Promise<{ success: boolean; content?: string; size?: number; readBytes?: number; truncated?: boolean; error?: string }> => {
      try {
        if (typeof filePath !== 'string' || !filePath.trim()) {
          return { success: false, error: 'Missing file path' };
        }
        const resolvedPath = path.resolve(filePath.trim());
        const stat = await fs.promises.stat(resolvedPath);
        if (!stat.isFile()) {
          return { success: false, error: 'Not a file' };
        }

        const truncated = stat.size > MAX_READ_TEXT_FILE_BYTES;
        const handle = await fs.promises.open(resolvedPath, 'r');
        try {
          const bytesToRead = Math.min(stat.size, MAX_READ_TEXT_FILE_BYTES);
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
          return {
            success: true,
            content: buffer.subarray(0, bytesRead).toString('utf8'),
            size: stat.size,
            readBytes: bytesRead,
            truncated,
          };
        } finally {
          await handle.close();
        }
      } catch (error) {
        console.warn('[Dialog] failed to read text file:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to read file',
        };
      }
    }
  );

  ipcMain.handle(
    DialogIpc.SaveFileCopy,
    async (
      event,
      filePath?: string,
    ): Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }> => {
      try {
        if (typeof filePath !== 'string' || !filePath.trim()) {
          return { success: false, error: 'Missing file path' };
        }
        const resolvedPath = path.resolve(filePath.trim());
        const stat = await fs.promises.stat(resolvedPath);
        if (!stat.isFile()) {
          return { success: false, error: 'Not a file' };
        }
        const ownerWindow = BrowserWindow.fromWebContents(event.sender);
        const saveOptions = {
          defaultPath: path.join(app.getPath('downloads'), path.basename(resolvedPath)),
        };
        const saveResult = ownerWindow
          ? await dialog.showSaveDialog(ownerWindow, saveOptions)
          : await dialog.showSaveDialog(saveOptions);
        if (saveResult.canceled || !saveResult.filePath) {
          return { success: true, canceled: true };
        }
        await fs.promises.copyFile(resolvedPath, saveResult.filePath);
        return { success: true, canceled: false, path: saveResult.filePath };
      } catch (error) {
        console.warn('[Dialog] failed to save file copy:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to save file copy',
        };
      }
    },
  );

  const libraryThumbnailRenderer = new LibraryThumbnailRenderer({
    developmentServerUrl: isDev ? DEV_SERVER_URL : undefined,
    productionHtmlPath: path.join(__dirname, '../dist/library-thumbnail.html'),
  });
  const libraryThumbnailService = new LibraryThumbnailService({
    createThumbnail: async (filePath, size) => {
      try {
        return await libraryThumbnailRenderer.render(filePath, size);
      } catch (rendererError) {
        const extension = path.extname(filePath).toLowerCase();
        console.warn('[LibraryThumbnail] Renderer failed; using native fallback', {
          extension,
          errorType: rendererError instanceof Error ? rendererError.name : 'UnknownError',
        });
        try {
          const image = await nativeImage.createThumbnailFromPath(filePath, size);
          if (image.isEmpty()) throw new Error('Thumbnail is empty');
          if (
            process.platform === 'win32'
            && extension === '.pptx'
            && isLikelyBlankThumbnailBitmap(image.toBitmap())
          ) {
            throw new Error('Native PPTX thumbnail is visually blank');
          }
          return image.toPNG();
        } catch (nativeError) {
          console.error('[LibraryThumbnail] Renderer and native fallback failed', {
            extension,
            errorType: nativeError instanceof Error ? nativeError.name : 'UnknownError',
          });
          const rendererMessage = rendererError instanceof Error
            ? rendererError.message
            : 'Unknown renderer error';
          const nativeMessage = nativeError instanceof Error
            ? nativeError.message
            : 'Unknown native thumbnail error';
          throw new Error(
            `Failed to generate thumbnail (renderer: ${rendererMessage}; native: ${nativeMessage})`,
          );
        }
      }
    },
    getCacheDirectory: () => path.join(app.getPath('userData'), 'library', 'thumbnails'),
    maxConcurrency: 3,
  });

  ipcMain.handle(
    DialogIpc.GenerateThumbnail,
    async (
      _event,
      filePath?: string,
    ): Promise<{ success: boolean; dataUrl?: string; error?: string }> => {
      try {
        if (typeof filePath !== 'string' || !filePath.trim()) {
          return { success: false, error: 'Missing file path' };
        }
        const dataUrl = await libraryThumbnailService.generate(filePath);
        return { success: true, dataUrl };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to generate thumbnail',
        };
      }
    },
  );

  const getFileAccessFailureReason = (error: unknown): ShellOpenFailureReasonType => {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return ShellOpenFailureReason.NotFound;
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return ShellOpenFailureReason.PermissionDenied;
    }
    return ShellOpenFailureReason.Unknown;
  };

  const getFailedShellPathStatus = async (
    operation: string,
    normalizedPath: string,
    fallbackError: string,
  ): Promise<{ success: false; error: string; reason: ShellOpenFailureReasonType }> => {
    try {
      await fs.promises.stat(normalizedPath);
      const status = {
        success: false,
        error: fallbackError,
        reason: ShellOpenFailureReason.OpenFailed,
      } as const;
      console.warn(`[Shell] failed to ${operation} because the system could not open the existing path:`, normalizedPath);
      return status;
    } catch (error) {
      const status = {
        success: false,
        error: fallbackError,
        reason: getFileAccessFailureReason(error),
      } as const;
      console.warn(`[Shell] failed to ${operation} because the path is not accessible:`, normalizedPath, error);
      return status;
    }
  };

  // Shell handlers - 打开文件/文件夹
  ipcMain.handle(ShellIpc.OpenPath, async (_event, filePath: string) => {
    try {
      const normalizedPath = normalizeWindowsShellPath(filePath);
      const result = await shell.openPath(normalizedPath);
      if (result) {
        return await getFailedShellPathStatus('open local path', normalizedPath, result);
      }
      return { success: true };
    } catch (error) {
      const normalizedPath = normalizeWindowsShellPath(filePath);
      return await getFailedShellPathStatus(
        'open local path',
        normalizedPath,
        error instanceof Error ? error.message : 'Unknown error',
      );
    }
  });

  ipcMain.handle(ShellIpc.ShowItemInFolder, async (_event, filePath: string) => {
    try {
      const normalizedPath = normalizeWindowsShellPath(filePath);
      try {
        await fs.promises.stat(normalizedPath);
      } catch (error) {
        console.warn('[Shell] failed to reveal local path because the path is not accessible:', normalizedPath, error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          reason: getFileAccessFailureReason(error),
        };
      }
      shell.showItemInFolder(normalizedPath);
      return { success: true };
    } catch (error) {
      console.warn('[Shell] failed to reveal local path because the system request failed:', filePath, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        reason: ShellOpenFailureReason.Unknown,
      };
    }
  });

  ipcMain.handle(ShellIpc.OpenExternal, async (_event, url: string) => {
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle(ShellIpc.OpenHtmlInBrowser, async (_event, htmlContent: string) => {
    try {
      const tmpDir = path.join(os.tmpdir(), 'lobsterai-preview');
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, `preview-${Date.now()}.html`);
      fs.writeFileSync(tmpFile, htmlContent, 'utf-8');
      await shell.openPath(tmpFile);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle(ShellIpc.GetAppsForFile, async (_event, filePath: string) => {
    try {
      const { getAppsForFile } = await import('./shellApps');
      const apps = await getAppsForFile(filePath);
      return { success: true, apps };
    } catch (error) {
      return {
        success: false,
        apps: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  ipcMain.handle(ShellIpc.GetBrowserApps, async (_event, input: unknown) => {
    try {
      const options = sanitizeShellGetBrowserAppsInput(input);
      const { getBrowserApps } = await import('./shellApps');
      const apps = await getBrowserApps(options);
      return { success: true, apps };
    } catch (error) {
      return {
        success: false,
        apps: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  ipcMain.handle(ShellIpc.OpenPathWithApp, async (_event, filePath: string, appPath: string) => {
    const normalizedPath = normalizeWindowsShellPath(filePath);
    try {
      const { openFileWithApp } = await import('./shellApps');
      await openFileWithApp(normalizedPath, appPath);
      return { success: true };
    } catch (error) {
      return await getFailedShellPathStatus(
        'open local path with selected app',
        normalizedPath,
        error instanceof Error ? error.message : 'Unknown error',
      );
    }
  });

  ipcMain.handle(ShellIpc.OpenUrlWithApp, async (_event, url: string, appPath: string) => {
    try {
      const { openUrlWithApp } = await import('./shellApps');
      await openUrlWithApp(url, appPath);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.warn('[Shell] failed to open URL with selected app:', url, appPath, error);
      return {
        success: false,
        error: message,
        reason: ShellOpenFailureReason.OpenFailed,
      };
    }
  });

  ipcMain.handle(ClipboardIpc.WriteText, async (_event, text: string) => {
    try {
      clipboard.writeText(text);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle(ClipboardIpc.WriteImageFromFile, async (_event, filePath: string) => {
    try {
      const image = nativeImage.createFromPath(filePath);
      if (image.isEmpty()) {
        return { success: false, error: 'Failed to read image file' };
      }
      clipboard.writeImage(image);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle(ClipboardIpc.WriteImageFromDataUrl, async (_event, dataUrl: string) => {
    try {
      const image = nativeImage.createFromDataURL(dataUrl);
      if (image.isEmpty()) {
        return { success: false, error: 'Failed to read image data' };
      }
      clipboard.writeImage(image);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  registerAsrIpcHandlers({
    getAuthTokens,
    fetchWithAuth,
    getServerApiBaseUrl,
  });

  registerSiteIpcHandlers({
    fetchWithAuth: (url, options) => {
      const { scopedFetch } = capturePublishingRequest();
      return scopedFetch(url, options);
    },
    getServerApiBaseUrl,
  });

  // ---- artifact file watching ----
  const fileWatchers = new Map<
    string,
    { watcher: fs.FSWatcher; debounceTimer: ReturnType<typeof setTimeout> | null }
  >();

  ipcMain.handle('artifact:watchFile', (_event, filePath: string) => {
    if (fileWatchers.has(filePath)) return;
    try {
      const watcher = fs.watch(filePath, eventType => {
        if (eventType !== 'change') return;
        const entry = fileWatchers.get(filePath);
        if (!entry) return;
        if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
        entry.debounceTimer = setTimeout(() => {
          entry.debounceTimer = null;
          const windows = BrowserWindow.getAllWindows();
          windows.forEach(win => {
            if (!win.isDestroyed()) {
              try {
                win.webContents.send('artifact:file:changed', { filePath });
              } catch {
                /* */
              }
            }
          });
        }, 300);
      });
      watcher.on('error', () => {
        fileWatchers.delete(filePath);
        watcher.close();
      });
      fileWatchers.set(filePath, { watcher, debounceTimer: null });
    } catch {
      /* file can't be watched */
    }
  });

  ipcMain.handle('artifact:unwatchFile', (_event, filePath: string) => {
    const entry = fileWatchers.get(filePath);
    if (entry) {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      entry.watcher.close();
      fileWatchers.delete(filePath);
    }
  });

  ipcMain.handle(ArtifactPreviewIpc.CreateSession, async (_event, filePath: string) => {
    try {
      const result = await createPreviewSession(filePath);
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle(ArtifactPreviewIpc.CreateOfficeSession, async (_event, filePath: string) => {
    try {
      const result = await createOfficePreviewSession(filePath);
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle(ArtifactPreviewIpc.DestroySession, async (_event, sessionId: string) => {
    destroyPreviewSession(sessionId);
    return { success: true };
  });

  ipcMain.handle(ArtifactPreviewIpc.ClearBrowserCookies, async () => {
    try {
      await session.fromPartition(ArtifactBrowserPartition.Default).clearStorageData({
        storages: ['cookies'],
      });
      return { success: true };
    } catch (error) {
      console.error('[ArtifactBrowser] failed to clear browser cookies:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle(ArtifactPreviewIpc.ClearBrowserCache, async () => {
    try {
      await session.fromPartition(ArtifactBrowserPartition.Default).clearCache();
      return { success: true };
    } catch (error) {
      console.error('[ArtifactBrowser] failed to clear browser cache:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  const browserAnnotationAssetStore = new BrowserAnnotationAssetStore(
    path.join(app.getPath('userData'), 'browser-annotation-assets'),
  );
  ipcMain.handle(
    ArtifactPreviewIpc.SaveBrowserAnnotationAsset,
    (_event, input: SaveBrowserAnnotationAssetInput) => {
      try {
        return { success: true, asset: browserAnnotationAssetStore.save(input) };
      } catch (error) {
        console.error('[BrowserAnnotation] failed to save screenshot asset:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    },
  );
  ipcMain.handle(
    ArtifactPreviewIpc.ReadBrowserAnnotationAsset,
    (_event, input: BrowserAnnotationAssetIdentity) => {
      try {
        return { success: true, ...browserAnnotationAssetStore.read(input) };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    },
  );
  ipcMain.handle(
    ArtifactPreviewIpc.DeleteBrowserAnnotationAsset,
    (_event, input: BrowserAnnotationAssetIdentity) => {
      try {
        browserAnnotationAssetStore.delete(input);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    },
  );
  ipcMain.handle(
    ArtifactPreviewIpc.DeleteBrowserAnnotationBatchAssets,
    (_event, input: Pick<BrowserAnnotationAssetIdentity, 'draftKey' | 'batchId'>) => {
      try {
        browserAnnotationAssetStore.deleteBatch(input);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    },
  );

  ipcMain.handle(
    LocalWebServicesIpc.List,
    async (_event, options?: ListLocalWebServicesOptions) => {
      const preferredPorts = sanitizeLocalWebServicePorts(options?.preferredPorts);
      const ports = Array.from(new Set([...preferredPorts, ...LOCAL_WEB_SERVICE_PORTS])).sort(
        (a, b) => a - b,
      );
      const results = await Promise.all(ports.map(port => probeLocalWebService(port)));
      return results.filter((service): service is LocalWebService => service !== null);
    },
  );

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

  ipcMain.handle(AppUpdateIpc.GetCompletedUpdate, async () => {
    return { version: getAppUpdateCoordinator().consumeCompletedUpdateVersion() };
  });

  // Helper: detect if a URL belongs to GitHub Copilot and apply token refresh on 401.
  const isCopilotUrl = (url: string) => url.includes('githubcopilot.com');
  const retryCopilotWithRefreshedToken = async (opts: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<{ headers: Record<string, string>; retried: boolean }> => {
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
  ipcMain.handle(
    'api:fetch',
    async (
      _event,
      options: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body?: string;
      },
    ) => {
      const sanitizedUrl = sanitizeUrlForLog(options.url);
      // Analytics beacons are traced by the reporter itself ([LogReporter]
      // lines); logging them here again would only add noise.
      const logTraffic = !isAnalyticsEndpointUrl(options.url);
      if (logTraffic) {
        console.log(
          `[api:fetch] ${options.method} ${sanitizedUrl}, headers: ${serializeForLog(options.headers)}, body: ${options.body}`,
        );
      }

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
        if (logTraffic) {
          console.log(
            `[api:fetch] ${options.method} ${sanitizedUrl} -> ${result.status} ${result.statusText}`,
            typeof result.data === 'object' ? JSON.stringify(result.data) : result.data,
          );
        }

        // Auto-retry once for Copilot 401/403
        if (
          !result.ok &&
          (result.status === 401 || result.status === 403) &&
          isCopilotUrl(options.url)
        ) {
          console.log('[api:fetch] Copilot auth error, attempting token refresh and retry');
          const { headers: refreshedHeaders, retried } =
            await retryCopilotWithRefreshedToken(options);
          if (retried) {
            result = await doFetch(refreshedHeaders);
            console.log(`[api:fetch] retry -> ${result.status} ${result.statusText}`);
          }
        }

        return result;
      } catch (error) {
        console.error(
          `[api:fetch] ${options.method} ${sanitizedUrl} -> ERROR:`,
          error instanceof Error ? error.message : error,
        );
        return {
          ok: false,
          status: 0,
          statusText: error instanceof Error ? error.message : 'Network error',
          headers: {},
          data: null,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  );

  // SSE 流式 API 代理
  ipcMain.handle(
    'api:stream',
    async (
      event,
      options: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body?: string;
        requestId: string;
      },
    ) => {
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
        if (
          !response.ok &&
          (response.status === 401 || response.status === 403) &&
          isCopilotUrl(options.url)
        ) {
          console.log('[api:stream] Copilot auth error, attempting token refresh and retry');
          const { headers: refreshedHeaders, retried } =
            await retryCopilotWithRefreshedToken(options);
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
              event.sender.send(
                `api:stream:${options.requestId}:error`,
                error instanceof Error ? error.message : 'Stream error',
              );
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
    },
  );

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

  const isArtifactSandboxUrl = (url: string): boolean => {
    try {
      const pathname = new URL(url).pathname;
      return (
        pathname.endsWith('/artifact-react-sandbox.html') ||
        pathname.includes('/vendor/react.production.min.js') ||
        pathname.includes('/vendor/react-dom.production.min.js') ||
        pathname.includes('/vendor/babel.min.js')
      );
    } catch {
      return false;
    }
  };

  // 设置 Content Security Policy
  const sanitizeResponseHeaders = (
    headers: Record<string, string[]> | undefined
  ): Record<string, string[]> => {
    if (!headers) return {};
    const result: Record<string, string[]> = {};
    for (const [key, values] of Object.entries(headers)) {
      const safe = values.filter(v => {
        for (let i = 0; i < v.length; i++) {
          if (v.charCodeAt(i) > 255) return false;
        }
        return true;
      });
      if (safe.length > 0) {
        result[key] = safe;
      }
    }
    return result;
  };

  const setContentSecurityPolicy = () => {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      // 跳过企微授权页面，让其使用自身的 CSP（否则外部脚本被阻止导致空白页）
      if (isWecomAuthUrl(details.url)) {
        callback({ responseHeaders: sanitizeResponseHeaders(details.responseHeaders) });
        return;
      }

      // 跳过 artifact 沙箱及其 vendor 脚本的 CSP（iframe sandbox="allow-scripts" 隔离）
      if (isArtifactSandboxUrl(details.url)) {
        callback({ responseHeaders: sanitizeResponseHeaders(details.responseHeaders) });
        return;
      }

      // 跳过 HTML 预览服务器的 CSP（本地 HTTP Server 提供文件类 HTML 预览）
      if (isPreviewServerUrl(details.url)) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }

      const devPort = process.env.ELECTRON_START_URL?.match(/:(\d+)/)?.[1] || '5175';
      const cspDirectives = [
        "default-src 'self'",
        isDev
          ? `script-src 'self' 'unsafe-inline' http://localhost:${devPort} ws://localhost:${devPort}`
          : "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https:",
        `img-src 'self' data: blob: https: http: ${ArtifactPreviewProtocol.LocalFile}: ${SKIN_PRIVILEGED_SCHEME.scheme}:`,
        // 允许连接到所有域名，不做限制
        'connect-src *',
        "font-src 'self' data: blob: https:",
        `media-src 'self' data: blob: file: https: http: ${ArtifactPreviewProtocol.LocalFile}:`,
        "worker-src 'self' blob:",
        "frame-src 'self' file: http://127.0.0.1:*",
      ];

      callback({
        responseHeaders: {
          ...sanitizeResponseHeaders(details.responseHeaders),
          'Content-Security-Policy': cspDirectives.join('; '),
        },
      });
    });
  };

  // 创建主窗口
  const createWindow = () => {
    // 如果窗口已经存在，就不再创建新窗口
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      if (!mainWindow.isFocused()) mainWindow.focus();
      return;
    }
    mainWindow = null;
    isOpenSessionFromNotificationReady = false;
    hasRenderedFirstFrame = false;
    pendingShowOnFirstFrame = false;

    const initialWindowState = resolveInitialAppWindowState(
      getStore().get(AppWindowStoreKey.State),
      windowStatePersist.getDisplayWorkAreas(),
    );
    const { isMaximized: shouldRestoreMaximized, ...initialWindowBounds } = initialWindowState;

    mainWindow = new BrowserWindow({
      ...initialWindowBounds,
      minWidth: MIN_APP_WINDOW_WIDTH,
      minHeight: MIN_APP_WINDOW_HEIGHT,
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
        webviewTag: true,
        enableWebSQL: false,
        autoplayPolicy: 'document-user-activation-required',
        disableDialogs: true,
        navigateOnDragDrop: false,
      },
      backgroundColor: getInitialTheme() === 'dark' ? '#0F1117' : '#F8F9FB',
      show: false,
      autoHideMenuBar: true,
      enableLargerThanScreen: false,
    });

    // 设置 macOS Dock 图标（开发模式下 Electron 默认图标不是应用 Logo）
    if (isMac && isDev) {
      const iconPath = getNotificationIconPath();
      if (iconPath) {
        app.dock.setIcon(nativeImage.createFromPath(iconPath));
      }
    }

    // 禁用窗口菜单
    mainWindow.setMenu(null);
    installEditContextMenu(mainWindow.webContents);

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

    mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.webSecurity = true;
      webPreferences.plugins = false;
      webPreferences.devTools = isDev;
      webPreferences.partition = ArtifactBrowserPartition.Default;
      delete webPreferences.preload;
      webPreferences.preload = BROWSER_ANNOTATION_PRELOAD_PATH;

      params.partition = ArtifactBrowserPartition.Default;
      params.allowpopups = 'false';

      const src = params.src ?? '';
      if (src.startsWith('javascript:')) {
        event.preventDefault();
      }
    });

    // 监听子窗口创建事件（企微授权弹窗安全限制）
    mainWindow.webContents.on('did-create-window', childWindow => {
      // 限制子窗口只能导航到企微域名，防止被劫持到其他站点
      childWindow.webContents.on('will-navigate', (event, navUrl) => {
        if (!isWecomAuthUrl(navUrl)) {
          event.preventDefault();
        }
      });
    });

    // 设置窗口的最小尺寸
    mainWindow.setMinimumSize(MIN_APP_WINDOW_WIDTH, MIN_APP_WINDOW_HEIGHT);
    if (shouldRestoreMaximized) {
      mainWindow.maximize();
    }

    const markFirstFrameRendered = (source: string) => {
      hasRenderedFirstFrame = true;
      if (pendingShowOnFirstFrame && mainWindow && !mainWindow.isDestroyed()) {
        pendingShowOnFirstFrame = false;
        focusMainWindow(`deferred activation (${source})`);
      }
    };

    // 窗口加载看门狗。一次性 30s 超时救不回被杀软扫描拖慢的首启动(现场案例:
    // 首次加载超 30s,唯一一次 reload 后再无人接管,窗口永久空白),改为按退避
    // 重试,封顶后停手保留现场。
    const LOAD_WATCHDOG_DELAYS_MS = [30_000, 45_000, 60_000, 90_000];
    let loadRecoveryAttempts = 0;
    let loadWatchdogTimer: ReturnType<typeof setTimeout> | null = null;

    const clearLoadWatchdog = () => {
      if (loadWatchdogTimer) {
        clearTimeout(loadWatchdogTimer);
        loadWatchdogTimer = null;
      }
    };

    const scheduleLoadWatchdog = () => {
      clearLoadWatchdog();
      const delay = LOAD_WATCHDOG_DELAYS_MS[
        Math.min(loadRecoveryAttempts, LOAD_WATCHDOG_DELAYS_MS.length - 1)
      ];
      loadWatchdogTimer = setTimeout(() => {
        loadWatchdogTimer = null;
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (!mainWindow.webContents.isLoadingMainFrame()) return;
        if (loadRecoveryAttempts >= LOAD_WATCHDOG_DELAYS_MS.length) {
          console.error(
            `[Main] window still not loaded after ${loadRecoveryAttempts} reload attempts, giving up`,
          );
          return;
        }
        loadRecoveryAttempts++;
        console.warn(
          `[Main] window load watchdog: still loading after ${delay}ms, reload attempt ${loadRecoveryAttempts}/${LOAD_WATCHDOG_DELAYS_MS.length}`,
        );
        scheduleReload('load-watchdog');
        scheduleLoadWatchdog();
      }, delay);
    };
    scheduleLoadWatchdog();

    // 兜底显示:首帧迟迟不来时,宁可让用户看到纯背景色的窗口,也不能看起来
    // "应用没打开"。开机自启保持仅托盘,不弹窗。
    const SHOW_FALLBACK_DELAY_MS = 10_000;
    const showFallbackTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isVisible() || hasRenderedFirstFrame) return;
      if (isAutoLaunched()) return;
      console.warn(
        `[Main] window not ready after ${SHOW_FALLBACK_DELAY_MS}ms, showing it before first paint`,
      );
      pendingShowOnFirstFrame = false;
      mainWindow.show();
    }, SHOW_FALLBACK_DELAY_MS);

    mainWindow.webContents.on('did-finish-load', () => {
      clearLoadWatchdog();
      loadRecoveryAttempts = 0;
      markFirstFrameRendered('did-finish-load');
      windowStatePersist.emitState();
      if (openClawEngineManager && !mainWindow?.isDestroyed()) {
        mainWindow.webContents.send(
          OpenClawEngineIpc.OnProgress,
          openClawEngineManager.getStatus(),
        );
      }
    });

    // 处理窗口关闭
    mainWindow.on('close', (e) => {
      windowStatePersist.cleanup();
      windowStatePersist.persist();
      console.log(`[Main] main window close event, isQuitting=${isQuitting}, isDev=${isDev}, platform=${process.platform}, fullscreen=${mainWindow?.isFullScreen() ?? false}, visible=${mainWindow?.isVisible() ?? false}`);

      // In development, close should actually quit so `npm run electron:dev`
      // restarts from a clean process. In production we keep tray behavior.
      if (mainWindow && !isQuitting && !isDev) {
        e.preventDefault();
        hideMainWindowForClose(mainWindow);
      }
    });

    mainWindow.on('focus', () => {
      getDesktopNotificationManager().handleWindowFocused();
    });

    // 处理渲染进程崩溃或退出
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      authCallbackRouter.markRendererUnavailable();
      console.error('Window render process gone:', details);
      scheduleReload('webContents-crashed');
    });

    if (isDev) {
      // 开发环境
      const maxRetries = 3;
      let retryCount = 0;

      const tryLoadURL = () => {
        mainWindow?.loadURL(DEV_SERVER_URL).catch(err => {
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
    mainWindow.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        console.error('Page failed to load:', errorCode, errorDescription);
        // 如果加载失败，尝试重新加载
        if (isDev) {
          setTimeout(() => {
            scheduleReload('did-fail-load');
          }, 3000);
        } else if (loadRecoveryAttempts < LOAD_WATCHDOG_DELAYS_MS.length) {
          loadRecoveryAttempts++;
          console.warn(
            `[Main] retrying window load after failure (attempt ${loadRecoveryAttempts}/${LOAD_WATCHDOG_DELAYS_MS.length})`,
          );
          setTimeout(() => {
            scheduleReload('did-fail-load');
            scheduleLoadWatchdog();
          }, 3_000);
        }
      },
    );
    mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) {
        isOpenSessionFromNotificationReady = false;
      }
      authCallbackRouter.handleNavigationStarted({ isMainFrame, isInPlace });
    });

    // 当窗口关闭时，清除引用
    mainWindow.on('closed', () => {
      clearLoadWatchdog();
      clearTimeout(showFallbackTimer);
      windowStatePersist.cleanup();
      authCallbackRouter.markRendererUnavailable();
      isOpenSessionFromNotificationReady = false;
      mainWindow = null;
    });

    windowStatePersist.bindWindowEvents(initialWindowBounds, shouldRestoreMaximized);

    // 等待内容加载完成后再显示窗口
    mainWindow.once('ready-to-show', () => {
      clearTimeout(showFallbackTimer);
      // 开机自启时不显示窗口，仅显示托盘图标
      if (!isAutoLaunched()) {
        mainWindow?.show();
      }
      markFirstFrameRendered('ready-to-show');
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
          console.warn(
            '[Main] CronJobService not available yet, will start polling when OpenClaw is ready:',
            err,
          );
        }

        // One-time migration: move tasks from legacy SQLite tables to OpenClaw gateway.
        migrateScheduledTasksToOpenclaw({
          db: getStore().getDatabase(),
          getKv: key => getStore().get(key),
          setKv: (key, value) => getStore().set(key, value),
          cronJobService: getCronJobService(),
        }).catch(err => {
          console.warn('[Main] Scheduled tasks migration failed:', err);
        });

        // One-time migration: copy legacy run history to OpenClaw cron/runs/ JSONL files.
        migrateScheduledTaskRunsToOpenclaw({
          db: getStore().getDatabase(),
          getKv: key => getStore().get(key),
          setKv: (key, value) => getStore().set(key, value),
          openclawStateDir: getOpenClawEngineManager().getStateDir(),
        }).catch(err => {
          console.warn('[Main] Scheduled task run history migration failed:', err);
        });
      })();
    });
  };

  ensureMainWindowForReason = (reason: string): BrowserWindow | null => {
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
    console.log(`[Main] recreating main window after ${reason}`);
    createWindow();
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  };

  let isCleanupFinished = false;
  let isCleanupInProgress = false;

  const escapeDataMigrationHtml = (value: string): string => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const showDataMigrationRestoreProgressWindow = async (): Promise<void> => {
    if (dataMigrationRestoreWindow && !dataMigrationRestoreWindow.isDestroyed()) {
      dataMigrationRestoreWindow.show();
      dataMigrationRestoreWindow.focus();
      return;
    }

    const dark = nativeTheme.shouldUseDarkColors;
    const windowTitle = t('dataMigrationRestoreProgressTitle');
    const title = escapeDataMigrationHtml(windowTitle);
    const desc = escapeDataMigrationHtml(t('dataMigrationRestoreProgressDesc'));
    const warning = escapeDataMigrationHtml(t('dataMigrationRestoreProgressWarning'));
    const background = dark ? '#111827' : '#f8fafc';
    const surface = dark ? '#1f2937' : '#ffffff';
    const foreground = dark ? '#f9fafb' : '#111827';
    const secondary = dark ? '#d1d5db' : '#4b5563';
    const border = dark ? '#374151' : '#e5e7eb';
    const primary = '#2563eb';
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: ${background};
      color: ${foreground};
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .panel {
      width: min(360px, calc(100vw - 40px));
      border: 1px solid ${border};
      border-radius: 14px;
      background: ${surface};
      padding: 28px 24px;
      text-align: center;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.18);
    }
    .spinner {
      width: 42px;
      height: 42px;
      margin: 0 auto 18px;
      border-radius: 999px;
      border: 4px solid rgba(37, 99, 235, 0.18);
      border-top-color: ${primary};
      animation: spin 0.9s linear infinite;
    }
    h1 {
      margin: 0;
      font-size: 17px;
      line-height: 1.4;
      font-weight: 650;
    }
    p {
      margin: 12px 0 0;
      color: ${secondary};
      font-size: 13px;
      line-height: 1.65;
    }
    .warning {
      margin-top: 18px;
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(245, 158, 11, 0.12);
      color: ${dark ? '#fde68a' : '#92400e'};
      text-align: left;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <main class="panel">
    <div class="spinner" aria-hidden="true"></div>
    <h1>${title}</h1>
    <p>${desc}</p>
    <p class="warning">${warning}</p>
  </main>
</body>
</html>`;

    const progressWindow = new BrowserWindow({
      width: 440,
      height: 300,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      title: windowTitle,
      autoHideMenuBar: true,
      backgroundColor: background,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: `data-migration-restore-${Date.now()}`,
      },
    });
    dataMigrationRestoreWindow = progressWindow;
    progressWindow.setMenu(null);
    progressWindow.on('closed', () => {
      if (dataMigrationRestoreWindow === progressWindow) {
        dataMigrationRestoreWindow = null;
      }
    });

    try {
      await progressWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    } catch (error) {
      console.warn('[DataMigration] failed to load restore progress window:', error);
    }
    if (!progressWindow.isDestroyed()) {
      progressWindow.show();
      progressWindow.focus();
    }
  };

  const releaseRendererWindowsForDataMigrationRestore = async (): Promise<void> => {
    const windows = BrowserWindow.getAllWindows()
      .filter(win => !win.isDestroyed() && win !== dataMigrationRestoreWindow);
    if (windows.length === 0) {
      return;
    }

    console.log(`[DataMigration] closing ${windows.length} renderer window(s) before restore.`);
    await Promise.all(windows.map(win => new Promise<void>(resolve => {
      let resolved = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        if (timeout) clearTimeout(timeout);
        resolve();
      };
      timeout = setTimeout(finish, 3_000);
      win.once('closed', finish);
      try {
        win.destroy();
      } catch (error) {
        console.warn('[DataMigration] failed to destroy renderer window before restore:', error);
        finish();
      }
    })));

    // Give Chromium a short window to release LevelDB handles such as Local Storage on Windows.
    await new Promise(resolve => { setTimeout(resolve, 500); });
  };

  // Read by the quit watchdog to report which cleanup step was in flight when
  // it had to force-exit.
  let currentAppCleanupStep = 'not-started';

  const runAppCleanup = async (reason = 'quit'): Promise<void> => {
    const cleanupStartedAt = Date.now();
    console.log(`[Main] App cleanup started for ${reason}`);
    currentAppCleanupStep = 'sync-teardown';
    skillManager?.stopWatching();
    stopMediaPollTimer();
    pendingMediaTasks.clear();
    mediaTaskOwnerById.clear();
    mediaSelectionBySession.clear();
    mediaTurnAccountScopeBySession.clear();
    mediaTasksHandledByStatusPolling.clear();
    mediaStatusPollCounts.clear();

    // Stop Cowork sessions without blocking shutdown.
    if (coworkEngineRouter) {
      console.log('[Main] Stopping cowork sessions...');
      coworkEngineRouter.stopAllSessions();
    }
    if (openClawRuntimeAdapter) {
      openClawRuntimeAdapter.disconnectGatewayClient();
    }

    // Stop skill services.
    currentAppCleanupStep = 'skill-services';
    const skillServices = getSkillServiceManager();
    await skillServices.stopAll();

    // Stop all IM gateways gracefully.
    if (imGatewayManager) {
      currentAppCleanupStep = 'im-gateways';
      await imGatewayManager.stopAll().catch(err => {
        console.error('[IM Gateway] Error stopping gateways on quit:', err);
      });
    }

    // Stop the gateway before closing the local HTTP proxies below: the
    // gateway is their client, and closing a server first would leave it
    // draining the gateway's keep-alive sockets.
    if (openClawEngineManager) {
      currentAppCleanupStep = 'openclaw-gateway';
      await openClawEngineManager.stopGateway().catch(error => {
        console.error('[OpenClaw] Failed to stop gateway on quit:', error);
      });
    }

    currentAppCleanupStep = 'openai-compat-proxy';
    await stopCoworkOpenAICompatProxy().catch(error => {
      console.error('Failed to stop OpenAI compatibility proxy:', error);
    });

    currentAppCleanupStep = 'html-preview-server';
    await stopHtmlPreviewServer().catch(error => {
      console.error('[HtmlPreviewServer] Failed to stop:', error);
    });

    stopOpenClawTokenProxy();

    // Stop the cron job polling
    currentAppCleanupStep = 'cron-and-store';
    try {
      getCronJobService().stopPolling();
    } catch {
      // CronJobService may not have been initialized — safe to ignore.
    }

    sqliteBackupManager?.stopPeriodicBackupLoop();
    libraryIndexService?.stop();
    libraryThumbnailRenderer.dispose();

    // Close the SQLite database to flush the WAL and release the file lock.
    try {
      getStore().close();
    } catch {
      // Store may not have been initialized — safe to ignore.
    }

    // Destroyed last so the tray icon keeps reflecting that the process is
    // still alive while cleanup runs; destroying it first made a hung cleanup
    // look like a finished exit while the process lived on invisibly.
    destroyTray();
    currentAppCleanupStep = 'done';
    console.log(`[Main] App cleanup finished for ${reason} in ${Date.now() - cleanupStartedAt}ms`);
  };

  // Hard ceiling for graceful cleanup. Past this the process force-exits and
  // logs the step that was still in flight: a hung await here used to leave an
  // invisible zombie (tray destroyed, no window) that only Task Manager could
  // kill — and that zombie is what the installer later has to hunt down.
  const APP_CLEANUP_WATCHDOG_MS = 10_000;

  const runAppCleanupAndExit = (trigger: string) => {
    isCleanupInProgress = true;
    isQuitting = true;

    const watchdog = setTimeout(() => {
      console.error(
        `[Main] App cleanup did not finish within ${APP_CLEANUP_WATCHDOG_MS}ms (trigger=${trigger}, stuck at step: ${currentAppCleanupStep}), forcing exit`,
      );
      app.exit(1);
    }, APP_CLEANUP_WATCHDOG_MS);

    void runAppCleanup()
      .catch(error => {
        console.error(`[Main] Cleanup error (trigger=${trigger}):`, error);
      })
      .finally(() => {
        clearTimeout(watchdog);
        isCleanupFinished = true;
        isCleanupInProgress = false;
        app.exit(0);
      });
  };

  app.on('before-quit', e => {
    if (isCleanupFinished) return;

    e.preventDefault();
    if (isCleanupInProgress) {
      return;
    }

    runAppCleanupAndExit('before-quit');
  });

  const handleTerminationSignal = (signal: NodeJS.Signals) => {
    if (isCleanupFinished || isCleanupInProgress) {
      return;
    }
    console.log(`[Main] Received ${signal}, running cleanup before exit...`);
    runAppCleanupAndExit(signal);
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

    // 注册 localfile:// 自定义协议，用于安全加载本地媒体文件。
    protocol.handle(ArtifactPreviewProtocol.LocalFile, createLocalFileProtocolResponse);
    registerSkinElectronIntegration(getSkinRuntimeController().store);

    profiler.mark('initStore');
    console.log('[Main] initApp: starting initStore()');
    store = await initStore();
    profiler.measure('initStore');
    console.log('[Main] initApp: store initialized');
    const libraryLocalStore = new LibraryLocalStore(store.getDatabase());
    const emitLibraryChanged = (payload: LibraryChangedPayload): void => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(LibraryIpc.Changed, payload);
      }
    };
    libraryIndexService = new LibraryIndexService({
      store: libraryLocalStore,
      userDataPath: app.getPath('userData'),
      onChanged: emitLibraryChanged,
      getMetadata: key => store?.get(key),
      setMetadata: (key, value) => store?.set(key, value),
    });
    registerLibraryIpcHandlers({
      localStore: libraryLocalStore,
      indexService: libraryIndexService,
      getServerApiBaseUrl,
      fetchWithAuth: (url, options) => {
        const { scopedFetch } = capturePublishingRequest();
        return scopedFetch(url, options);
      },
    });
    libraryIndexService.start();

    // Dev/E2E convenience: boot the dsh engine once the app is ready and the
    // store can answer provider queries, so app-level checks can assert
    // readiness from logs without driving the settings UI.
    if (process.env.LOBSTERAI_DSH_AUTOSTART === '1') {
      ensureDshEngineReady()
        .then(url => console.log(`[DSH] Autostart ready at ${url}`))
        .catch(error => console.error('[DSH] Autostart failed', error));
    }

    initializeKeyfromAttribution(store);
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
      await startSqliteBackupLoop().catch(error => {
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

    setAuthTokensGetter(() => {
      const tokens = getAuthTokens();
      if (!tokens) return null;
      // Check if accessToken is close to expiry and trigger background refresh
      try {
        const payload = JSON.parse(
          Buffer.from(tokens.accessToken.split('.')[1], 'base64').toString(),
        );
        const expiresAt = payload.exp * 1000;
        if (expiresAt - Date.now() < 5 * 60 * 1000) {
          void authSessionManager.refresh(AuthRefreshReason.Proactive); // fire-and-forget
        }
      } catch {
        /* unable to parse JWT, return token as-is */
      }
      return tokens;
    });
    setServerBaseUrlGetter(() => getServerApiBaseUrl());

    // Initialize Copilot token manager and restore token state if available
    initCopilotTokenManager(getStore);
    const storedGithubToken = getStore().get('github_copilot_github_token') as string | undefined;
    if (storedGithubToken) {
      import('./libs/githubCopilotAuth')
        .then(({ getCopilotToken }) =>
          getCopilotToken(storedGithubToken).then(({ token, expiresAt, baseUrl }) => {
            setCopilotTokenState({
              copilotToken: token,
              baseUrl,
              expiresAt,
              githubToken: storedGithubToken,
            });
            console.log('[Main] restored Copilot token state from stored GitHub token');
          }),
        )
        .catch(err => {
          console.warn('[Main] failed to restore Copilot token on startup:', err);
        });
    }

    registerProxyTokenRefresher(ProviderName.LobsteraiServer, async rejectedToken => {
      const latestAccessToken = getAuthTokens()?.accessToken;
      if (latestAccessToken && rejectedToken && latestAccessToken !== rejectedToken) {
        return {
          outcome: AuthRefreshOutcome.Success,
          accessToken: latestAccessToken,
        };
      }
      return authSessionManager.refresh(AuthRefreshReason.CompatProxy);
    });

    registerProxyTokenRefresher(ProviderName.Copilot, async () => {
      try {
        const { refreshCopilotTokenNow } = await import('./libs/copilotTokenManager');
        const refreshed = await refreshCopilotTokenNow();
        return {
          outcome: AuthRefreshOutcome.Success,
          accessToken: refreshed.copilotToken,
        };
      } catch (err) {
        console.warn('[Auth] Copilot proxy token refresh failed:', err);
        return { outcome: AuthRefreshOutcome.TransientFailure };
      }
    });

    // Start the lightweight token proxy before OpenClaw config sync so that
    // lobsterai-server provider can use the proxy URL in its config.
    profiler.mark('openClawTokenProxy');
    try {
      await startOpenClawTokenProxy({
        getAuthTokens,
        refreshToken: reason => authSessionManager.refresh(reason),
        getServerBaseUrl: getServerApiBaseUrl,
        getAccountContextHeaders: getEnterpriseAccountHeaders,
        getSessionKey: getAuthSessionKey,
        getClientVersion: () => app.getVersion(),
        getEnterpriseAuthSessionSnapshot: captureEnterpriseAuthSessionSnapshot,
        onEnterpriseMembershipRevoked: event => {
          handleEnterpriseMembershipRevocation({
            ...event,
            source: EnterpriseMembershipRevocationSource.LlmSse,
          });
        },
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
        const mcpStoreInstance = getMcpRuntime().getStore();
        syncEnterpriseConfig(
          enterpriseConfigPath,
          store,
          imStoreInstance,
          server => {
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
          config => {
            const cs = getCoworkStore();
            cs.setConfig(config);
          },
          () => {
            const cs = getCoworkStore();
            return cs.getConfig().workingDirectory;
          },
          agent => {
            const cs = getCoworkStore();
            const existing = cs.getAgent(agent.id);
            const updates = {
              name: agent.name,
              description: agent.description,
              systemPrompt: agent.systemPrompt,
              identity: agent.identity,
              model: agent.model,
              icon: agent.icon,
              skillIds: agent.skillIds,
              enabled: agent.enabled,
            };
            if (existing) {
              cs.updateAgent(agent.id, updates);
            } else {
              cs.createAgent({
                id: agent.id,
                name: agent.name,
                description: agent.description,
                systemPrompt: agent.systemPrompt,
                identity: agent.identity,
                model: agent.model,
                icon: agent.icon,
                skillIds: agent.skillIds,
                source: 'custom',
              });
              cs.updateAgent(agent.id, { enabled: agent.enabled });
            }
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
        console.log(
          '[Enterprise] config package removed, cleared enterprise mode and reset executionMode',
        );
      }
    }
    profiler.measure('enterpriseConfigSync');

    bindCoworkRuntimeForwarder();
    bindOpenClawStatusForwarder();

    // Start proxy BEFORE config sync so proxy-dependent providers (e.g. copilot)
    // get the correct baseURL on the first write, avoiding a mid-startup config
    // overwrite that triggers unnecessary gateway hot-reload.
    profiler.mark('applyProxyPreference');
    const appConfig = getStore().get<AppConfigSettings>('app_config');
    await applyProxyPreference(getUseSystemProxyFromConfig(appConfig));
    profiler.measure('applyProxyPreference');

    profiler.mark('coworkOpenAICompatProxy');
    await startCoworkOpenAICompatProxy().catch(error => {
      console.error('Failed to start OpenAI compatibility proxy:', error);
    });
    profiler.measure('coworkOpenAICompatProxy');

    // ── Pre-warm quota & model caches so provider resolution and config sync
    // see real server data instead of empty defaults ──
    if (getAuthTokens()) {
      profiler.mark('startupCacheWarmup');
      const warmupResult = await runStartupCacheWarmup({
        serverBaseUrl: getServerApiBaseUrl(),
        fetchWithAuth,
        appendKeyfromQuery,
        cachedSubscriptionStatus,
        clientVersion: app.getVersion(),
        t,
      });
      cachedSubscriptionStatus = warmupResult.subscriptionStatus;
      cachedMediaGenerationEntitled = warmupResult.mediaGenerationEntitled;
      profiler.measure('startupCacheWarmup');
    }

    // Agent model migration — runs after cache warmup so resolveMatchedProvider
    // can match lobsterai-server models without falling back.
    const defaultAgentModelRef = resolveDefaultAgentModelRef();
    const backfilledAgentModels = getCoworkStore().backfillEmptyAgentModels(defaultAgentModelRef);
    const qualifiedAgentModels = migrateAgentModelRefs({
      defaultModelRef: defaultAgentModelRef,
      availableProviders: buildAvailableOpenClawProviders(),
      agents: getAgentManager().listAgents(),
      updateAgent: (id, patch) => getCoworkStore().updateAgent(id, patch),
    });
    if (backfilledAgentModels > 0 || qualifiedAgentModels > 0) {
      console.log(
        `[Main] migrated agent model bindings: backfilled=${backfilledAgentModels}, qualified=${qualifiedAgentModels}`,
      );
    }

    // One-time migration: move main agent workspace files from the user's
    // working directory to the fixed {STATE_DIR}/workspace-main/ path.
    try {
      const engineManager = getOpenClawEngineManager();
      migrateMainAgentWorkspace(
        engineManager.getStateDir(),
        getCoworkStore().getConfig().workingDirectory,
        getStore(),
      );
    } catch (err) {
      console.warn('[OpenClaw] main agent workspace migration failed (non-fatal):', err);
    }

    // An interrupted Windows installer can leave an empty resources/cfmind
    // directory plus win-resources.tar. Recover it before config sync because
    // legacy plugins.installs migration needs the bundled OpenClaw CLI.
    profiler.mark('prepareOpenClawRuntime');
    await getOpenClawEngineManager().prepareRuntimeForStartupConfigSync();
    profiler.measure('prepareOpenClawRuntime');

    profiler.mark('syncOpenClawConfig');
    const startupSync = await syncOpenClawConfig({
      reason: 'startup',
      restartGatewayIfRunning: false,
    });
    if (!startupSync.success) {
      console.error('[OpenClaw] Startup config sync failed:', startupSync.error);
    }
    profiler.measure('syncOpenClawConfig');
    void ensureOpenClawRunningForCowork()
      .then(() => {
        // Start cron polling once the gateway is confirmed running.
        try {
          getCronJobService().startPolling();
        } catch (err) {
          console.warn('[Main] CronJobService not available after OpenClaw startup:', err);
        }
        void migrateScheduledTaskAnnounceJobs(scheduledTaskHandlerDeps).catch(err => {
          console.warn('[Main] Scheduled task IM announce job migration failed:', err);
        });
      })
      .catch(error => {
        console.error('[OpenClaw] Failed to auto-start gateway on app startup:', error);
      });

    // ── Step 1: Show window ASAP ──────────────────────────────────────
    // CSP + createWindow moved before skill initialisation so the user
    // sees the loading UI within ~1-2 s instead of waiting for the full
    // skill bootstrap (~6-8 s previously).
    setContentSecurityPolicy();
    registerVoiceInputPermissionHandler({
      session: session.defaultSession,
      getMainWindow: () => mainWindow,
      isDev,
      startUrl: process.env.ELECTRON_START_URL,
    });

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
      syncOpenClawConfig({ reason: 'skills-changed' }).catch(error => {
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
      void skillServices
        .startAll()
        .then(() => {
          console.log(
            `[Main] initApp: skill services started (background, ${(performance.now() - t0).toFixed(0)}ms)`,
          );
        })
        .catch(error => {
          console.error('[Main] initApp: skill services failed:', error);
        });
    } catch (error) {
      console.error('[Main] initApp: skill services init failed:', error);
    }
    profiler.measure('skillManager');

    console.log(profiler.summary());

    // Windows/Linux cold start: parse deep link from process.argv.
    // The router buffers it because the renderer is not ready yet after createWindow().
    const coldStartDeepLink = process.argv.find(arg => arg.startsWith('lobsterai://'));
    if (coldStartDeepLink) {
      handleDeepLink(coldStartDeepLink);
    }

    // Auto-reconnect IM bots that were enabled before restart
    getIMGatewayManager()
      .startAllEnabled()
      .catch(error => {
        console.error('[IM] Failed to auto-start enabled gateways:', error);
      });

    // Reconnect OpenClaw gateway WS after system wake from sleep/suspend
    powerMonitor.on('resume', () => {
      if (openClawRuntimeAdapter) {
        openClawRuntimeAdapter.onSystemResume();
      }
    });

    // 首次启动时默认开启开机自启动，并以系统登录项的实际状态回写本地标记。
    if (!getStore().get('auto_launch_initialized')) {
      getStore().set('auto_launch_initialized', true);
      try {
        setAutoLaunchEnabled(true);
        const status = getAutoLaunchStatus();
        getStore().set('auto_launch_enabled', status.enabled);
        if (!status.enabled) {
          console.warn(
            `[AutoLaunch] default enable did not take effect; ${formatAutoLaunchStatusForLog(status)}`,
          );
        }
      } catch (error) {
        getStore().set('auto_launch_enabled', false);
        console.error('[AutoLaunch] default enable failed:', error);
      }
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
    let lastUseSystemProxy = getUseSystemProxyFromConfig(
      getStore().get<AppConfigSettings>('app_config'),
    );
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
        console.log(
          `${gwDiagTs()} proxy setting changed: ${previousUseSystemProxy} -> ${currentUseSystemProxy}, will restart gateway if running`,
        );
        void applyProxyPreference(currentUseSystemProxy).then(() => {
          if (getOpenClawEngineManager().getStatus().phase === 'running') {
            void syncOpenClawConfig({
              reason: 'system-proxy-changed',
              restartGatewayIfRunning: true,
            }).then((result) => {
              if (!result.success) {
                console.error('[OpenClaw] Failed to sync config after system proxy change:', result.error);
              }
            });
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
          void startSqliteBackupLoop().catch(error => {
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
      if (isDataMigrationRestoreInProgress) {
        return;
      }
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
    if (isDataMigrationRestoreInProgress) {
      return;
    }
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
