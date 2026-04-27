/* eslint-disable @typescript-eslint/no-explicit-any */
import type { OpenClawSessionPatch } from '../../common/openclawSession';
import type { AppUpdateCheckResult, AppUpdateRuntimeState } from '../../shared/appUpdate/constants';
interface ApiResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: any;
  error?: string;
}

interface ApiStreamResponse {
  ok: boolean;
  status: number;
  statusText: string;
  error?: string;
}

// Cowork types for IPC
interface CoworkSession {
  id: string;
  title: string;
  claudeSessionId: string | null;
  status: 'idle' | 'running' | 'completed' | 'error';
  pinned: boolean;
  cwd: string;
  systemPrompt: string;
  modelOverride: string;
  executionMode: 'auto' | 'local' | 'sandbox';
  activeSkillIds: string[];
  agentId: string;
  messages: CoworkMessage[];
  createdAt: number;
  updatedAt: number;
}

interface CoworkMessage {
  id: string;
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

interface CoworkSessionSummary {
  id: string;
  title: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  pinned: boolean;
  agentId?: string;
  createdAt: number;
  updatedAt: number;
}

interface CoworkConfig {
  workingDirectory: string;
  systemPrompt: string;
  executionMode: 'auto' | 'local' | 'sandbox';
  agentEngine: 'openclaw';
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: 'strict' | 'standard' | 'relaxed';
  memoryUserMemoriesMaxItems: number;
  skipMissedJobs: boolean;
  embeddingEnabled: boolean;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingLocalModelPath: string;
  embeddingVectorWeight: number;
  embeddingRemoteBaseUrl: string;
  embeddingRemoteApiKey: string;
  openClawSessionPolicy: OpenClawSessionPolicyConfig;
}

type CoworkConfigUpdate = Partial<Pick<
  CoworkConfig,
  | 'workingDirectory'
  | 'executionMode'
  | 'agentEngine'
  | 'memoryEnabled'
  | 'memoryImplicitUpdateEnabled'
  | 'memoryLlmJudgeEnabled'
  | 'memoryGuardLevel'
  | 'memoryUserMemoriesMaxItems'
  | 'skipMissedJobs'
  | 'embeddingEnabled'
  | 'embeddingProvider'
  | 'embeddingModel'
  | 'embeddingLocalModelPath'
  | 'embeddingVectorWeight'
  | 'embeddingRemoteBaseUrl'
  | 'embeddingRemoteApiKey'
>>;

interface CoworkUserMemoryEntry {
  id: string;
  text: string;
}

interface CoworkMemoryStats {
  total: number;
  created: number;
  stale: number;
  deleted: number;
  explicit: number;
  implicit: number;
}

interface CoworkPermissionRequest {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  requestId: string;
  toolUseId?: string | null;
}

interface CoworkApiConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  apiType?: 'anthropic' | 'openai';
}

type OpenClawEnginePhase =
  | 'not_installed'
  | 'installing'
  | 'ready'
  | 'starting'
  | 'running'
  | 'error';

interface OpenClawEngineStatus {
  phase: OpenClawEnginePhase;
  version: string | null;
  progressPercent?: number;
  message?: string;
  canRetry: boolean;
}

interface OpenClawSessionPolicyConfig {
  keepAlive: '1d' | '7d' | '30d' | '365d';
}

interface WindowState {
  isMaximized: boolean;
  isFullscreen: boolean;
  isFocused: boolean;
}

interface Skill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  isOfficial: boolean;
  isBuiltIn: boolean;
  updatedAt: number;
  prompt: string;
  skillPath: string;
}

type EmailConnectivityCheckCode = 'imap_connection' | 'smtp_connection';
type EmailConnectivityCheckLevel = 'pass' | 'fail';
type EmailConnectivityVerdict = 'pass' | 'fail';

interface EmailConnectivityCheck {
  code: EmailConnectivityCheckCode;
  level: EmailConnectivityCheckLevel;
  message: string;
  durationMs: number;
}

interface EmailConnectivityTestResult {
  testedAt: number;
  verdict: EmailConnectivityVerdict;
  checks: EmailConnectivityCheck[];
}

type CoworkPermissionResult =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: Record<string, unknown>[];
      toolUseID?: string;
    }
  | {
      behavior: 'deny';
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };

interface McpServerConfigIPC {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  transportType: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  isBuiltIn: boolean;
  githubUrl?: string;
  registryId?: string;
  createdAt: number;
  updatedAt: number;
}

interface McpMarketplaceServer {
  id: string;
  name: string;
  description_zh: string;
  description_en: string;
  category: string;
  transportType: 'stdio' | 'sse' | 'http';
  command: string;
  defaultArgs: string[];
  requiredEnvKeys?: string[];
  optionalEnvKeys?: string[];
}

interface McpMarketplaceCategory {
  id: string;
  name_zh: string;
  name_en: string;
}

interface McpMarketplaceData {
  categories: McpMarketplaceCategory[];
  servers: McpMarketplaceServer[];
}

import type { Platform } from '@shared/platform';

import type { Agent, PresetAgent } from './agent';

interface CreditItem {
  type: 'subscription' | 'boost' | 'free';
  label: string;
  labelEn: string;
  creditsRemaining: number;
  expiresAt: string | null;
}

interface ProfileSummaryData {
  id: number;
  nickname: string;
  avatarUrl: string | null;
  totalCreditsRemaining: number;
  creditItems: CreditItem[];
}

interface IElectronAPI {
  platform: string;
  arch: string;
  store: {
    get: (key: string) => Promise<any>;
    set: (key: string, value: any) => Promise<void>;
    remove: (key: string) => Promise<void>;
  };
  skills: {
    list: () => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
    setEnabled: (options: { id: string; enabled: boolean }) => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
    delete: (id: string) => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
    download: (source: string) => Promise<{ success: boolean; skills?: Skill[]; error?: string; auditReport?: any; pendingInstallId?: string }>;
    upgrade: (skillId: string, downloadUrl: string) => Promise<{ success: boolean; skills?: Skill[]; error?: string; auditReport?: any; pendingInstallId?: string }>;
    confirmInstall: (pendingId: string, action: string) => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
    getRoot: () => Promise<{ success: boolean; path?: string; error?: string }>;
    autoRoutingPrompt: () => Promise<{ success: boolean; prompt?: string | null; error?: string }>;
    getConfig: (skillId: string) => Promise<{ success: boolean; config?: Record<string, string>; error?: string }>;
    setConfig: (skillId: string, config: Record<string, string>) => Promise<{ success: boolean; error?: string }>;
    testEmailConnectivity: (
      skillId: string,
      config: Record<string, string>
    ) => Promise<{ success: boolean; result?: EmailConnectivityTestResult; error?: string }>;
    fetchMarketplace: () => Promise<{ success: boolean; data?: string; error?: string }>;
    onChanged: (callback: () => void) => () => void;
  };
  mcp: {
    list: () => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    create: (data: any) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    update: (id: string, data: any) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    delete: (id: string) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    setEnabled: (options: { id: string; enabled: boolean }) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    fetchMarketplace: () => Promise<{ success: boolean; data?: McpMarketplaceData; error?: string }>;
    refreshBridge: () => Promise<{ success: boolean; tools: number; error?: string }>;
    onBridgeSyncStart: (callback: () => void) => () => void;
    onBridgeSyncDone: (callback: (data: { tools: number; error?: string }) => void) => () => void;
  };
  agents: {
    list: () => Promise<Agent[]>;
    get: (id: string) => Promise<Agent | null>;
    create: (request: { id?: string; name: string; description?: string; systemPrompt?: string; identity?: string; model?: string; icon?: string; skillIds?: string[]; source?: string; presetId?: string }) => Promise<Agent>;
    update: (id: string, updates: { name?: string; description?: string; systemPrompt?: string; identity?: string; model?: string; icon?: string; skillIds?: string[]; enabled?: boolean }) => Promise<Agent>;
    delete: (id: string) => Promise<void>;
    presets: () => Promise<PresetAgent[]>;
    addPreset: (presetId: string) => Promise<Agent>;
  };
  api: {
    fetch: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }) => Promise<ApiResponse>;
    stream: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
      requestId: string;
    }) => Promise<ApiStreamResponse>;
    cancelStream: (requestId: string) => Promise<boolean>;
    onStreamData: (requestId: string, callback: (chunk: string) => void) => () => void;
    onStreamDone: (requestId: string, callback: () => void) => () => void;
    onStreamError: (requestId: string, callback: (error: string) => void) => () => void;
    onStreamAbort: (requestId: string, callback: () => void) => () => void;
  };
  getApiConfig: () => Promise<CoworkApiConfig | null>;
  checkApiConfig: (options?: { probeModel?: boolean }) => Promise<{ hasConfig: boolean; config: CoworkApiConfig | null; error?: string }>;
  saveApiConfig: (config: CoworkApiConfig) => Promise<{ success: boolean; error?: string }>;
  generateSessionTitle: (userInput: string | null) => Promise<string>;
  getRecentCwds: (limit?: number) => Promise<string[]>;
  openclaw: {
    engine: {
      getStatus: () => Promise<{ success: boolean; status?: OpenClawEngineStatus; error?: string }>;
      install: () => Promise<{ success: boolean; status?: OpenClawEngineStatus; error?: string }>;
      retryInstall: () => Promise<{ success: boolean; status?: OpenClawEngineStatus; error?: string }>;
      restartGateway: () => Promise<{ success: boolean; status?: OpenClawEngineStatus; error?: string }>;
      onProgress: (callback: (status: OpenClawEngineStatus) => void) => () => void;
    };
    sessionPolicy: {
      get: () => Promise<{ success: boolean; config?: OpenClawSessionPolicyConfig; error?: string }>;
      set: (config: OpenClawSessionPolicyConfig) => Promise<{ success: boolean; config?: OpenClawSessionPolicyConfig; error?: string }>;
    };
    session: {
      patch: (options: {
        sessionId: string;
        patch: OpenClawSessionPatch;
      }) => Promise<{ success: boolean; session?: CoworkSession; error?: string }>;
    };
  };
  ipcRenderer: {
    send: (channel: string, ...args: any[]) => void;
    on: (channel: string, func: (...args: any[]) => void) => () => void;
  };
  window: {
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
    isMaximized: () => Promise<boolean>;
    showSystemMenu: (position: { x: number; y: number }) => void;
    onStateChanged: (callback: (state: WindowState) => void) => () => void;
  };
  cowork: {
    startSession: (options: { prompt: string; cwd?: string; systemPrompt?: string; title?: string; activeSkillIds?: string[]; agentId?: string; imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }> }) => Promise<{ success: boolean; session?: CoworkSession; error?: string; code?: string; engineStatus?: OpenClawEngineStatus }>;
    continueSession: (options: { sessionId: string; prompt: string; systemPrompt?: string; activeSkillIds?: string[]; imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }> }) => Promise<{ success: boolean; session?: CoworkSession; error?: string; code?: string; engineStatus?: OpenClawEngineStatus }>;
    stopSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    deleteSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    deleteSessions: (sessionIds: string[]) => Promise<{ success: boolean; error?: string }>;
    setSessionPinned: (options: { sessionId: string; pinned: boolean }) => Promise<{ success: boolean; error?: string }>;
    renameSession: (options: { sessionId: string; title: string }) => Promise<{ success: boolean; error?: string }>;
    getSession: (sessionId: string) => Promise<{ success: boolean; session?: CoworkSession; error?: string }>;
    remoteManaged: (sessionId: string) => Promise<{ success: boolean; remoteManaged: boolean; error?: string }>;
    listSessions: (agentId?: string) => Promise<{ success: boolean; sessions?: CoworkSessionSummary[]; error?: string }>;
    exportResultImage: (options: {
      rect: { x: number; y: number; width: number; height: number };
      defaultFileName?: string;
    }) => Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }>;
    captureImageChunk: (options: {
      rect: { x: number; y: number; width: number; height: number };
    }) => Promise<{ success: boolean; width?: number; height?: number; pngBase64?: string; error?: string }>;
    saveResultImage: (options: {
      pngBase64: string;
      defaultFileName?: string;
    }) => Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }>;
    exportSessionText: (options: {
      content: string;
      defaultFileName?: string;
      fileExtension?: string;
    }) => Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }>;
    respondToPermission: (options: { requestId: string; result: CoworkPermissionResult }) => Promise<{ success: boolean; error?: string }>;
    getConfig: () => Promise<{ success: boolean; config?: CoworkConfig; error?: string }>;
    setConfig: (config: CoworkConfigUpdate) => Promise<{ success: boolean; error?: string }>;
    listMemoryEntries: (input: {
      query?: string;
      limit?: number;
      offset?: number;
    }) => Promise<{ success: boolean; entries?: CoworkUserMemoryEntry[]; error?: string }>;
    createMemoryEntry: (input: {
      text: string;
    }) => Promise<{ success: boolean; entry?: CoworkUserMemoryEntry; error?: string }>;
    updateMemoryEntry: (input: {
      id: string;
      text: string;
    }) => Promise<{ success: boolean; entry?: CoworkUserMemoryEntry; error?: string }>;
    deleteMemoryEntry: (input: { id: string }) => Promise<{ success: boolean; error?: string }>;
    getMemoryStats: () => Promise<{ success: boolean; stats?: CoworkMemoryStats; error?: string }>;
    readBootstrapFile: (filename: string) => Promise<{ success: boolean; content: string; error?: string }>;
    writeBootstrapFile: (filename: string, content: string) => Promise<{ success: boolean; error?: string }>;
    onStreamMessage: (callback: (data: { sessionId: string; message: CoworkMessage }) => void) => () => void;
    onStreamMessageUpdate: (callback: (data: { sessionId: string; messageId: string; content: string }) => void) => () => void;
    onStreamPermission: (callback: (data: { sessionId: string; request: CoworkPermissionRequest }) => void) => () => void;
    onStreamPermissionDismiss: (callback: (data: { requestId: string }) => void) => () => void;
    onStreamComplete: (callback: (data: { sessionId: string; claudeSessionId: string | null }) => void) => () => void;
    onStreamError: (callback: (data: { sessionId: string; error: string }) => void) => () => void;
    onSessionsChanged: (callback: () => void) => () => void;
  };
  dialog: {
    selectDirectory: () => Promise<{ success: boolean; path: string | null }>;
    selectFile: (options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<{ success: boolean; path: string | null }>;
    selectFiles: (options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<{ success: boolean; paths: string[] }>;
    saveInlineFile: (options: { dataBase64: string; fileName?: string; mimeType?: string; cwd?: string }) => Promise<{ success: boolean; path: string | null; error?: string }>;
    readFileAsDataUrl: (filePath: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>;
    showMessageBox: (options: { message: string; type?: 'none' | 'info' | 'error' | 'question' | 'warning'; title?: string }) => Promise<{ response: number }>;
  };
  shell: {
    openPath: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    showItemInFolder: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
  };
  autoLaunch: {
    get: () => Promise<{ enabled: boolean }>;
    set: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  };
  preventSleep: {
    get: () => Promise<{ enabled: boolean }>;
    set: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  };
  appInfo: {
    getVersion: () => Promise<string>;
    getSystemLocale: () => Promise<string>;
  };
  appUpdate: {
    getState: () => Promise<AppUpdateRuntimeState>;
    checkNow: (options?: { manual?: boolean; userId?: string | null }) => Promise<AppUpdateCheckResult>;
    retryDownload: () => Promise<{ success: boolean; state: AppUpdateRuntimeState }>;
    cancelDownload: () => Promise<{ success: boolean; state: AppUpdateRuntimeState }>;
    installReady: () => Promise<{ success: boolean; state: AppUpdateRuntimeState; error?: string }>;
    onStateChanged: (callback: (data: AppUpdateRuntimeState) => void) => () => void;
  };
  log: {
    getPath: () => Promise<string>;
    openFolder: () => Promise<void>;
    exportZip: () => Promise<{
      success: boolean;
      canceled?: boolean;
      path?: string;
      missingEntries?: string[];
      error?: string;
    }>;
  };
  im: {
    getConfig: () => Promise<{ success: boolean; config?: IMGatewayConfig; error?: string }>;
    setConfig: (config: Partial<IMGatewayConfig>, options?: { syncGateway?: boolean }) => Promise<{ success: boolean; error?: string }>;
    syncConfig: () => Promise<{ success: boolean; error?: string }>;
    startGateway: (platform: Platform) => Promise<{ success: boolean; error?: string }>;
    stopGateway: (platform: Platform) => Promise<{ success: boolean; error?: string }>;
    testGateway: (
      platform: Platform,
      configOverride?: Partial<IMGatewayConfig>
    ) => Promise<{ success: boolean; result?: IMConnectivityTestResult; error?: string }>;
    getStatus: () => Promise<{ success: boolean; status?: IMGatewayStatus; error?: string }>;
    getLocalIp: () => Promise<string>;
    getOpenClawConfigSchema: () => Promise<{ success: boolean; result?: { schema: Record<string, unknown>; uiHints: Record<string, Record<string, unknown>> }; error?: string }>;
    weixinQrLoginStart: () => Promise<{ success: boolean; qrDataUrl?: string; message: string; sessionKey?: string }>;
    weixinQrLoginWait: (accountId?: string) => Promise<{ success: boolean; connected: boolean; message: string; accountId?: string }>;

    // POPO QR login
    popoQrLoginStart: () => Promise<{ success: boolean; qrUrl?: string; taskToken?: string; timeoutMs?: number; message?: string }>;
    popoQrLoginPoll: (taskToken: string) => Promise<{ success: boolean; appKey?: string; appSecret?: string; aesKey?: string; message: string }>;

    listPairingRequests: (platform: string) => Promise<{
      success: boolean;
      requests: Array<{ id: string; code: string; createdAt: string; lastSeenAt: string; meta?: Record<string, string> }>;
      allowFrom: string[];
      error?: string;
    }>;
    approvePairingCode: (platform: string, code: string) => Promise<{ success: boolean; error?: string }>;
    rejectPairingRequest: (platform: string, code: string) => Promise<{ success: boolean; error?: string }>;
    nimQrLoginStart: () => Promise<{
      uuid: string;
      qrValue: string;
      expiresIn: number;
      pollInterval: number;
      credentialKind: 'split';
      rawData: Record<string, unknown> | null;
    }>;
    nimQrLoginPoll: (uuid: string) => Promise<{
      status: 'pending' | 'success' | 'failed';
      credentials?: {
        appKey: string;
        account: string;
        token: string;
      };
      errorCode?: string;
      error?: string;
    }>;
    addNimInstance: (name: string) => Promise<{ success: boolean; instance?: NimInstanceConfig; error?: string }>;
    deleteNimInstance: (instanceId: string) => Promise<{ success: boolean; error?: string }>;
    setNimInstanceConfig: (instanceId: string, config: any, options?: { syncGateway?: boolean }) => Promise<{ success: boolean; error?: string }>;
    addQQInstance: (name: string) => Promise<{ success: boolean; instance?: QQInstanceConfig; error?: string }>;
    deleteQQInstance: (instanceId: string) => Promise<{ success: boolean; error?: string }>;
    setQQInstanceConfig: (instanceId: string, config: any, options?: { syncGateway?: boolean }) => Promise<{ success: boolean; error?: string }>;
    addFeishuInstance: (name: string) => Promise<{ success: boolean; instance?: FeishuInstanceConfig; error?: string }>;
    deleteFeishuInstance: (instanceId: string) => Promise<{ success: boolean; error?: string }>;
    setFeishuInstanceConfig: (instanceId: string, config: any, options?: { syncGateway?: boolean }) => Promise<{ success: boolean; error?: string }>;
    addDingTalkInstance: (name: string) => Promise<{ success: boolean; instance?: DingTalkInstanceConfig; error?: string }>;
    deleteDingTalkInstance: (instanceId: string) => Promise<{ success: boolean; error?: string }>;
    setDingTalkInstanceConfig: (instanceId: string, config: any, options?: { syncGateway?: boolean }) => Promise<{ success: boolean; error?: string }>;
    addEmailInstance: (name: string) => Promise<{ success: boolean; instance?: EmailInstanceConfig; error?: string }>;
    deleteEmailInstance: (instanceId: string) => Promise<{ success: boolean; error?: string }>;
    setEmailInstanceConfig: (instanceId: string, config: any, options?: { syncGateway?: boolean }) => Promise<{ success: boolean; error?: string }>;
    addWecomInstance: (name: string) => Promise<{ success: boolean; instance?: WecomInstanceConfig; error?: string }>;
    deleteWecomInstance: (instanceId: string) => Promise<{ success: boolean; error?: string }>;
    setWecomInstanceConfig: (instanceId: string, config: any, options?: { syncGateway?: boolean }) => Promise<{ success: boolean; error?: string }>;
    addTelegramInstance: (name: string) => Promise<{ success: boolean; instance?: TelegramInstanceConfig; error?: string }>;
    deleteTelegramInstance: (instanceId: string) => Promise<{ success: boolean; error?: string }>;
    setTelegramInstanceConfig: (instanceId: string, config: any, options?: { syncGateway?: boolean }) => Promise<{ success: boolean; error?: string }>;
    addDiscordInstance: (name: string) => Promise<{ success: boolean; instance?: DiscordInstanceConfig; error?: string }>;
    deleteDiscordInstance: (instanceId: string) => Promise<{ success: boolean; error?: string }>;
    setDiscordInstanceConfig: (instanceId: string, config: any, options?: { syncGateway?: boolean }) => Promise<{ success: boolean; error?: string }>;
    onStatusChange: (callback: (status: IMGatewayStatus) => void) => () => void;
    onMessageReceived: (callback: (message: IMMessage) => void) => () => void;
  };
  scheduledTasks: {
    list: () => Promise<{ success: boolean; tasks?: import('../../scheduledTask/types').ScheduledTask[]; error?: string }>;
    get: (id: string) => Promise<{ success: boolean; task?: import('../../scheduledTask/types').ScheduledTask; error?: string }>;
    create: (input: import('../../scheduledTask/types').ScheduledTaskInput) => Promise<{ success: boolean; task?: import('../../scheduledTask/types').ScheduledTask; error?: string }>;
    update: (id: string, input: Partial<import('../../scheduledTask/types').ScheduledTaskInput>) => Promise<{ success: boolean; task?: import('../../scheduledTask/types').ScheduledTask; error?: string }>;
    delete: (id: string) => Promise<{ success: boolean; error?: string }>;
    toggle: (id: string, enabled: boolean) => Promise<{ success: boolean; task?: import('../../scheduledTask/types').ScheduledTask; warning?: string; error?: string }>;
    runManually: (id: string) => Promise<{ success: boolean; error?: string }>;
    stop: (id: string) => Promise<{ success: boolean; error?: string }>;
    listRuns: (taskId: string, limit?: number, offset?: number) => Promise<{ success: boolean; runs?: import('../../scheduledTask/types').ScheduledTaskRun[]; error?: string }>;
    countRuns: (taskId: string) => Promise<{ success: boolean; count?: number; error?: string }>;
    listAllRuns: (limit?: number, offset?: number) => Promise<{ success: boolean; runs?: import('../../scheduledTask/types').ScheduledTaskRunWithName[]; error?: string }>;
    resolveSession: (sessionKey: string) => Promise<{
      success: boolean;
      session?: import('./cowork').CoworkSession | null;
      error?: string;
    }>;
    listChannels: () => Promise<{
      success: boolean;
      channels?: import('../../scheduledTask/types').ScheduledTaskChannelOption[];
      error?: string;
    }>;
    listChannelConversations?: (channel: string, accountId?: string, filterAccountId?: string) => Promise<{
      success: boolean;
      conversations?: import('../../scheduledTask/types').ScheduledTaskConversationOption[];
      error?: string;
    }>;
    onStatusUpdate: (callback: (data: import('../../scheduledTask/types').ScheduledTaskStatusEvent) => void) => () => void;
    onRunUpdate: (callback: (data: import('../../scheduledTask/types').ScheduledTaskRunEvent) => void) => () => void;
    onRefresh: (callback: () => void) => () => void;
  };
  permissions: {
    checkCalendar: () => Promise<{ success: boolean; status?: string; error?: string; autoRequested?: boolean }>;
    requestCalendar: () => Promise<{ success: boolean; granted?: boolean; status?: string; error?: string }>;
  };
  auth: {
    login: (loginUrl?: string) => Promise<{ success: boolean; error?: string }>;
    exchange: (code: string) => Promise<{ success: boolean; user?: any; quota?: any; error?: string }>;
    getUser: () => Promise<{ success: boolean; user?: any; quota?: any }>;
    getQuota: () => Promise<{ success: boolean; quota?: any }>;
    logout: () => Promise<{ success: boolean }>;
    refreshToken: () => Promise<{ success: boolean; accessToken?: string }>;
    getAccessToken: () => Promise<string | null>;
    getModels: () => Promise<{ success: boolean; models?: Array<{ modelId: string; modelName: string; provider: string; apiFormat: string }> }>;
    getProfileSummary: () => Promise<{ success: boolean; data?: ProfileSummaryData }>;
    onCallback: (callback: (data: { code: string }) => void) => () => void;
    onQuotaChanged: (callback: () => void) => () => void;
  }
  enterprise: {
    getConfig: () => Promise<{ ui?: Record<string, 'hide' | 'disable' | 'readonly'>; disableUpdate?: boolean; version: string; name: string } | null>;
  };
  networkStatus: {
    send: (status: 'online' | 'offline') => void;
  };
  auth: {
    login: (loginUrl?: string) => Promise<{ success: boolean; error?: string }>;
    exchange: (code: string) => Promise<{ success: boolean; user?: import('../store/slices/authSlice').UserProfile; quota?: { planName: string; subscriptionStatus: string; creditsLimit: number; creditsUsed: number; creditsRemaining: number }; error?: string }>;
    getUser: () => Promise<{ success: boolean; user?: import('../store/slices/authSlice').UserProfile; quota?: { planName: string; subscriptionStatus: string; creditsLimit: number; creditsUsed: number; creditsRemaining: number } }>;
    getQuota: () => Promise<{ success: boolean; quota?: { planName: string; subscriptionStatus: string; creditsLimit: number; creditsUsed: number; creditsRemaining: number } }>;
    logout: () => Promise<{ success: boolean }>;
    refreshToken: () => Promise<{ success: boolean; accessToken?: string }>;
    getAccessToken: () => Promise<string | null>;
    onCallback: (callback: (data: { code: string }) => void) => () => void;
  };
  qwen: Record<string, never>;
  feishu: {
    install: {
      qrcode: (isLark: boolean) => Promise<{
        url: string;
        deviceCode: string;
        interval: number;
        expireIn: number;
      }>;
      poll: (deviceCode: string) => Promise<{
        done: boolean;
        appId?: string;
        appSecret?: string;
        domain?: string;
        error?: string;
      }>;
      verify: (appId: string, appSecret: string) => Promise<{
        success: boolean;
        error?: string;
      }>;
    };
  };
  dingtalk: {
    install: {
      qrcode: () => Promise<{
        url: string;
        deviceCode: string;
        interval: number;
        expireIn: number;
      }>;
      poll: (deviceCode: string) => Promise<{
        done: boolean;
        clientId?: string;
        clientSecret?: string;
        error?: string;
      }>;
      verify: (clientId: string, clientSecret: string) => Promise<{
        success: boolean;
        error?: string;
      }>;
    };
  };
  githubCopilot: {
    requestDeviceCode: () => Promise<{
      userCode: string;
      verificationUri: string;
      deviceCode: string;
      interval: number;
      expiresIn: number;
    }>;
    pollForToken: (deviceCode: string, interval: number, expiresIn: number) => Promise<{
      success: boolean;
      token?: string;
      githubUser?: string;
      baseUrl?: string;
      error?: string;
    }>;
    cancelPolling: () => Promise<void>;
    signOut: () => Promise<void>;
    refreshToken: () => Promise<{
      success: boolean;
      token?: string;
      baseUrl?: string;
      error?: string;
    }>;
    onTokenUpdated: (callback: (data: { token: string; baseUrl: string }) => void) => () => void;
  };
}

// IM Gateway types
interface EmailInstanceConfig {
  instanceId: string;
  instanceName: string;
  enabled: boolean;
  transport: 'imap' | 'ws';
  email: string;
  password?: string;
  apiKey?: string;
  agentId: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
  allowFrom?: string[];
  replyMode?: 'immediate' | 'accumulated' | 'complete';
  replyTo?: 'sender' | 'all';
  a2aEnabled?: boolean;
  a2aAgentDomains?: string[];
  a2aMaxPingPongTurns?: number;
}

interface EmailMultiInstanceConfig {
  instances: EmailInstanceConfig[];
}

interface EmailInstanceStatus {
  instanceId: string;
  instanceName: string;
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  email: string | null;
  transport: 'imap' | 'ws' | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface EmailMultiInstanceStatus {
  instances: EmailInstanceStatus[];
}

interface IMGatewayConfig {
  dingtalk: DingTalkMultiInstanceConfig;
  feishu: FeishuMultiInstanceConfig;
  telegram: TelegramMultiInstanceConfig;
  qq: QQMultiInstanceConfig;
  discord: DiscordMultiInstanceConfig;
  nim: NimMultiInstanceConfig;
  'netease-bee': NeteaseBeeChanConfig;
  wecom: WecomMultiInstanceConfig;
  popo: PopoOpenClawConfig;
  weixin: WeixinOpenClawConfig;
  email: EmailMultiInstanceConfig;
  settings: IMSettings;
}

interface DingTalkOpenClawConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  dmPolicy: 'open' | 'pairing' | 'allowlist';
  allowFrom: string[];
  groupPolicy: 'open' | 'allowlist';
  sessionTimeout: number;
  separateSessionByConversation: boolean;
  groupSessionScope: 'group' | 'group_sender';
  sharedMemoryAcrossConversations: boolean;
  gatewayBaseUrl: string;
  debug: boolean;
}

interface DingTalkInstanceConfig extends DingTalkOpenClawConfig {
  instanceId: string;
  instanceName: string;
}

interface DingTalkInstanceStatus extends DingTalkGatewayStatus {
  instanceId: string;
  instanceName: string;
}

interface DingTalkMultiInstanceConfig {
  instances: DingTalkInstanceConfig[];
}

interface DingTalkMultiInstanceStatus {
  instances: DingTalkInstanceStatus[];
}

interface FeishuOpenClawGroupConfig {
  requireMention?: boolean;
  allowFrom?: string[];
  systemPrompt?: string;
}

interface FeishuOpenClawFooterConfig {
  status?: boolean;
  elapsed?: boolean;
}

interface FeishuOpenClawBlockStreamingCoalesceConfig {
  minChars?: number;
  maxChars?: number;
  idleMs?: number;
}

interface FeishuOpenClawConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark' | string;
  dmPolicy: 'pairing' | 'allowlist' | 'open' | 'disabled';
  allowFrom: string[];
  groupPolicy: 'allowlist' | 'open' | 'disabled';
  groupAllowFrom: string[];
  groups: Record<string, FeishuOpenClawGroupConfig>;
  historyLimit: number;
  streaming: boolean;
  replyMode: 'auto' | 'static' | 'streaming';
  blockStreaming: boolean;
  footer: FeishuOpenClawFooterConfig;
  blockStreamingCoalesce?: FeishuOpenClawBlockStreamingCoalesceConfig;
  mediaMaxMb: number;
  debug: boolean;
}

interface FeishuInstanceConfig extends FeishuOpenClawConfig {
  instanceId: string;
  instanceName: string;
}

interface FeishuInstanceStatus extends FeishuGatewayStatus {
  instanceId: string;
  instanceName: string;
}

interface FeishuMultiInstanceConfig {
  instances: FeishuInstanceConfig[];
}

interface FeishuMultiInstanceStatus {
  instances: FeishuInstanceStatus[];
}

interface TelegramOpenClawGroupConfig {
  requireMention?: boolean;
  allowFrom?: string[];
  systemPrompt?: string;
}

interface TelegramOpenClawConfig {
  enabled: boolean;
  botToken: string;
  dmPolicy: 'pairing' | 'allowlist' | 'open' | 'disabled';
  allowFrom: string[];
  groupPolicy: 'allowlist' | 'open' | 'disabled';
  groupAllowFrom: string[];
  groups: Record<string, TelegramOpenClawGroupConfig>;
  historyLimit: number;
  replyToMode: 'off' | 'first' | 'all';
  linkPreview: boolean;
  streaming: 'off' | 'partial' | 'block' | 'progress';
  mediaMaxMb: number;
  proxy: string;
  webhookUrl: string;
  webhookSecret: string;
  debug: boolean;
}

interface TelegramInstanceConfig extends TelegramOpenClawConfig {
  instanceId: string;
  instanceName: string;
}

interface TelegramInstanceStatus extends TelegramGatewayStatus {
  instanceId: string;
  instanceName: string;
}

interface TelegramMultiInstanceConfig {
  instances: TelegramInstanceConfig[];
}

interface TelegramMultiInstanceStatus {
  instances: TelegramInstanceStatus[];
}

interface DiscordOpenClawGuildConfig {
  requireMention?: boolean;
  allowFrom?: string[];
  systemPrompt?: string;
}

interface DiscordOpenClawConfig {
  enabled: boolean;
  botToken: string;
  dmPolicy: 'pairing' | 'allowlist' | 'open' | 'disabled';
  allowFrom: string[];
  groupPolicy: 'allowlist' | 'open' | 'disabled';
  groupAllowFrom: string[];
  guilds: Record<string, DiscordOpenClawGuildConfig>;
  historyLimit: number;
  streaming: 'off' | 'partial' | 'block' | 'progress';
  mediaMaxMb: number;
  proxy: string;
  debug: boolean;
}

interface NimP2pConfig {
  policy: 'open' | 'allowlist' | 'disabled';
  allowFrom?: (string | number)[];
}

interface NimTeamConfig {
  policy: 'open' | 'allowlist' | 'disabled';
  allowFrom?: (string | number)[];
}

interface NimQChatConfig {
  policy: 'open' | 'allowlist' | 'disabled';
  allowFrom?: (string | number)[];
}

interface NimAdvancedConfig {
  mediaMaxMb?: number;
  textChunkLimit?: number;
  debug?: boolean;
  legacyLogin?: boolean;
  weblbsUrl?: string;
  link_web?: string;
  nos_uploader?: string;
  nos_downloader_v2?: string;
  nosSsl?: boolean;
  nos_accelerate?: string;
  nos_accelerate_host?: string;
}

interface NimOpenClawConfig {
  enabled: boolean;
  nimToken?: string;
  appKey: string;
  account: string;
  token: string;
  antispamEnabled?: boolean;
  p2p?: NimP2pConfig;
  team?: NimTeamConfig;
  qchat?: NimQChatConfig;
  advanced?: NimAdvancedConfig;
}

interface NimInstanceConfig extends NimOpenClawConfig {
  instanceId: string;
  instanceName: string;
}

interface NimMultiInstanceConfig {
  instances: NimInstanceConfig[];
}

interface NeteaseBeeChanConfig {
  enabled: boolean;
  clientId: string;
  secret: string;
  debug?: boolean;
}

interface QQConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  dmPolicy: 'open' | 'pairing' | 'allowlist';
  allowFrom: string[];
  groupPolicy: 'open' | 'allowlist' | 'disabled';
  groupAllowFrom: string[];
  historyLimit: number;
  markdownSupport: boolean;
  imageServerBaseUrl: string;
  debug: boolean;
}

interface QQInstanceConfig extends QQConfig {
  instanceId: string;
  instanceName: string;
}

interface QQMultiInstanceConfig {
  instances: QQInstanceConfig[];
}

interface QQInstanceStatus extends QQGatewayStatus {
  instanceId: string;
  instanceName: string;
}

interface QQMultiInstanceStatus {
  instances: QQInstanceStatus[];
}

interface WecomConfig {
  enabled: boolean;
  botId: string;
  secret: string;
  dmPolicy: 'open' | 'pairing' | 'allowlist' | 'disabled';
  allowFrom: string[];
  groupPolicy: 'open' | 'allowlist' | 'disabled';
  groupAllowFrom: string[];
  sendThinkingMessage: boolean;
  debug: boolean;
}

interface WecomInstanceConfig extends WecomConfig {
  instanceId: string;
  instanceName: string;
}

interface WecomMultiInstanceConfig {
  instances: WecomInstanceConfig[];
}

interface WecomInstanceStatus extends WecomGatewayStatus {
  instanceId: string;
  instanceName: string;
}

interface WecomMultiInstanceStatus {
  instances: WecomInstanceStatus[];
}

interface PopoOpenClawConfig {
  enabled: boolean;
  connectionMode: 'websocket' | 'webhook';
  appKey: string;
  appSecret: string;
  token: string;
  aesKey: string;
  webhookBaseUrl: string;
  webhookPath: string;
  webhookPort: number;
  dmPolicy: 'open' | 'pairing' | 'allowlist' | 'disabled';
  allowFrom: string[];
  groupPolicy: 'open' | 'allowlist' | 'disabled';
  groupAllowFrom: string[];
  textChunkLimit: number;
  richTextChunkLimit: number;
  debug: boolean;
}

interface WeixinOpenClawConfig {
  enabled: boolean;
  accountId: string;
  dmPolicy: 'open' | 'pairing' | 'allowlist' | 'disabled';
  allowFrom: string[];
  groupPolicy: 'open' | 'allowlist' | 'disabled';
  groupAllowFrom: string[];
  debug: boolean;
}

interface IMSettings {
  systemPrompt?: string;
  skillsEnabled: boolean;
}

interface IMGatewayStatus {
  dingtalk: DingTalkMultiInstanceStatus;
  feishu: FeishuMultiInstanceStatus;
  qq: QQMultiInstanceStatus;
  telegram: TelegramMultiInstanceStatus;
  discord: DiscordMultiInstanceStatus;
  nim: NimMultiInstanceStatus;
  'netease-bee': NeteaseBeeChanGatewayStatus;
  wecom: WecomMultiInstanceStatus;
  popo: PopoGatewayStatus;
  weixin: WeixinGatewayStatus;
  email: EmailMultiInstanceStatus;
}

interface NimInstanceStatus extends NimGatewayStatus {
  instanceId: string;
  instanceName: string;
}

interface NimMultiInstanceStatus {
  instances: NimInstanceStatus[];
}

type IMConnectivityVerdict = 'pass' | 'warn' | 'fail';

type IMConnectivityCheckLevel = 'pass' | 'info' | 'warn' | 'fail';

type IMConnectivityCheckCode =
  | 'missing_credentials'
  | 'auth_check'
  | 'gateway_running'
  | 'inbound_activity'
  | 'outbound_activity'
  | 'platform_last_error'
  | 'feishu_group_requires_mention'
  | 'feishu_event_subscription_required'
  | 'discord_group_requires_mention'
  | 'telegram_privacy_mode_hint'
  | 'dingtalk_bot_membership_hint'
  | 'nim_p2p_only_hint'
  | 'qq_guild_mention_hint';

interface IMConnectivityCheck {
  code: IMConnectivityCheckCode;
  level: IMConnectivityCheckLevel;
  message: string;
  suggestion?: string;
}

interface IMConnectivityTestResult {
  platform: Platform;
  testedAt: number;
  verdict: IMConnectivityVerdict;
  checks: IMConnectivityCheck[];
}

interface DingTalkGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface FeishuGatewayStatus {
  connected: boolean;
  startedAt: string | null;
  botOpenId: string | null;
  error: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface TelegramGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botUsername: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface DiscordGatewayStatus {
  connected: boolean;
  starting: boolean;
  startedAt: number | null;
  lastError: string | null;
  botUsername: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface DiscordInstanceConfig extends DiscordOpenClawConfig {
  instanceId: string;
  instanceName: string;
}

interface DiscordInstanceStatus extends DiscordGatewayStatus {
  instanceId: string;
  instanceName: string;
}

interface DiscordMultiInstanceConfig {
  instances: DiscordInstanceConfig[];
}

interface DiscordMultiInstanceStatus {
  instances: DiscordInstanceStatus[];
}

interface NimGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botAccount: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface NeteaseBeeChanGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botAccount: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface QQGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface WecomGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botId: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface PopoGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface WeixinGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface IMMessage {
  platform: Platform;
  messageId: string;
  conversationId: string;
  senderId: string;
  senderName?: string;
  content: string;
  chatType: 'direct' | 'group';
  timestamp: number;
}

declare global {
  interface Window {
    electron: IElectronAPI;
  }
}

export {}; 
