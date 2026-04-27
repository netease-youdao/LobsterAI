/* eslint-disable @typescript-eslint/no-explicit-any */
import { contextBridge, ipcRenderer } from 'electron';

import { IpcChannel as ScheduledTaskIpc } from '../scheduledTask/constants';
import { AppUpdateIpc } from '../shared/appUpdate/constants';
import type { Platform } from '../shared/platform';
import { NimQrLoginIpc } from './ipcHandlers/nimQrLogin';
import { OpenClawSessionIpc } from './openclawSession/constants';
import { OpenClawSessionPolicyIpc } from './openclawSessionPolicy/constants';

// 暴露安全的 API 到渲染进程
contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  arch: process.arch,
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('store:set', key, value),
    remove: (key: string) => ipcRenderer.invoke('store:remove', key),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    setEnabled: (options: { id: string; enabled: boolean }) => ipcRenderer.invoke('skills:setEnabled', options),
    delete: (id: string) => ipcRenderer.invoke('skills:delete', id),
    download: (source: string) => ipcRenderer.invoke('skills:download', source),
    upgrade: (skillId: string, downloadUrl: string) => ipcRenderer.invoke('skills:upgrade', skillId, downloadUrl),
    confirmInstall: (pendingId: string, action: string) =>
      ipcRenderer.invoke('skills:confirmInstall', pendingId, action),
    getRoot: () => ipcRenderer.invoke('skills:getRoot'),
    autoRoutingPrompt: () => ipcRenderer.invoke('skills:autoRoutingPrompt'),
    getConfig: (skillId: string) => ipcRenderer.invoke('skills:getConfig', skillId),
    setConfig: (skillId: string, config: Record<string, string>) => ipcRenderer.invoke('skills:setConfig', skillId, config),
    testEmailConnectivity: (skillId: string, config: Record<string, string>) =>
      ipcRenderer.invoke('skills:testEmailConnectivity', skillId, config),
    fetchMarketplace: () => ipcRenderer.invoke('skills:fetchMarketplace'),
    onChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('skills:changed', handler);
      return () => ipcRenderer.removeListener('skills:changed', handler);
    },
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    create: (data: any) => ipcRenderer.invoke('mcp:create', data),
    update: (id: string, data: any) => ipcRenderer.invoke('mcp:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('mcp:delete', id),
    setEnabled: (options: { id: string; enabled: boolean }) => ipcRenderer.invoke('mcp:setEnabled', options),
    fetchMarketplace: () => ipcRenderer.invoke('mcp:fetchMarketplace'),
    refreshBridge: () => ipcRenderer.invoke('mcp:refreshBridge'),
    onBridgeSyncStart: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('mcp:bridge:syncStart', handler);
      return () => ipcRenderer.removeListener('mcp:bridge:syncStart', handler);
    },
    onBridgeSyncDone: (callback: (data: { tools: number; error?: string }) => void) => {
      const handler = (_event: any, data: { tools: number; error?: string }) => callback(data);
      ipcRenderer.on('mcp:bridge:syncDone', handler);
      return () => ipcRenderer.removeListener('mcp:bridge:syncDone', handler);
    },
  },
  permissions: {
    checkCalendar: () => ipcRenderer.invoke('permissions:checkCalendar'),
    requestCalendar: () => ipcRenderer.invoke('permissions:requestCalendar'),
  },
  enterprise: {
    getConfig: () => ipcRenderer.invoke('enterprise:getConfig'),
  },
  api: {
    // 普通 API 请求（非流式）
    fetch: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }) => ipcRenderer.invoke('api:fetch', options),

    // 流式 API 请求
    stream: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
      requestId: string;
    }) => ipcRenderer.invoke('api:stream', options),

    // 取消流式请求
    cancelStream: (requestId: string) => ipcRenderer.invoke('api:stream:cancel', requestId),

    // 监听流式数据
    onStreamData: (requestId: string, callback: (chunk: string) => void) => {
      const handler = (_event: any, chunk: string) => callback(chunk);
      ipcRenderer.on(`api:stream:${requestId}:data`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:data`, handler);
    },

    // 监听流式完成
    onStreamDone: (requestId: string, callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(`api:stream:${requestId}:done`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:done`, handler);
    },

    // 监听流式错误
    onStreamError: (requestId: string, callback: (error: string) => void) => {
      const handler = (_event: any, error: string) => callback(error);
      ipcRenderer.on(`api:stream:${requestId}:error`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:error`, handler);
    },

    // 监听流式取消
    onStreamAbort: (requestId: string, callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(`api:stream:${requestId}:abort`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:abort`, handler);
    },
  },
  ipcRenderer: {
    send: (channel: string, ...args: any[]) => {
      ipcRenderer.send(channel, ...args);
    },
    on: (channel: string, func: (...args: any[]) => void) => {
      const handler = (_event: any, ...args: any[]) => func(...args);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },
  window: {
    minimize: () => ipcRenderer.send('window-minimize'),
    toggleMaximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    showSystemMenu: (position: { x: number; y: number }) => ipcRenderer.send('window:showSystemMenu', position),
    onStateChanged: (callback: (state: { isMaximized: boolean; isFullscreen: boolean; isFocused: boolean }) => void) => {
      const handler = (_event: any, state: { isMaximized: boolean; isFullscreen: boolean; isFocused: boolean }) => callback(state);
      ipcRenderer.on('window:state-changed', handler);
      return () => ipcRenderer.removeListener('window:state-changed', handler);
    },
  },
  getApiConfig: () => ipcRenderer.invoke('get-api-config'),
  checkApiConfig: (options?: { probeModel?: boolean }) => ipcRenderer.invoke('check-api-config', options),
  saveApiConfig: (config: { apiKey: string; baseURL: string; model: string; apiType?: 'anthropic' | 'openai' }) =>
    ipcRenderer.invoke('save-api-config', config),
  generateSessionTitle: (userInput: string | null) =>
    ipcRenderer.invoke('generate-session-title', userInput),
  getRecentCwds: (limit?: number) =>
    ipcRenderer.invoke('get-recent-cwds', limit),
  openclaw: {
    engine: {
      getStatus: () => ipcRenderer.invoke('openclaw:engine:getStatus'),
      install: () => ipcRenderer.invoke('openclaw:engine:install'),
      retryInstall: () => ipcRenderer.invoke('openclaw:engine:retryInstall'),
      restartGateway: () => ipcRenderer.invoke('openclaw:engine:restartGateway'),
      onProgress: (callback: (status: any) => void) => {
        const handler = (_event: any, status: any) => callback(status);
        ipcRenderer.on('openclaw:engine:onProgress', handler);
        return () => ipcRenderer.removeListener('openclaw:engine:onProgress', handler);
      },
    },
    sessionPolicy: {
      get: () => ipcRenderer.invoke(OpenClawSessionPolicyIpc.Get),
      set: (config: { keepAlive: '1d' | '7d' | '30d' | '365d' }) =>
        ipcRenderer.invoke(OpenClawSessionPolicyIpc.Set, config),
    },
    session: {
      patch: (options: {
        sessionId: string;
        patch: {
          model?: string | null;
          thinkingLevel?: string | null;
          reasoningLevel?: string | null;
          elevatedLevel?: string | null;
          responseUsage?: 'off' | 'tokens' | 'full' | null;
          sendPolicy?: 'allow' | 'deny' | null;
        };
      }) => ipcRenderer.invoke(OpenClawSessionIpc.Patch, options),
    },
  },
  agents: {
    list: async () => {
      const result = await ipcRenderer.invoke('agents:list');
      return result?.success ? result.agents : [];
    },
    get: async (id: string) => {
      const result = await ipcRenderer.invoke('agents:get', id);
      return result?.success ? result.agent : null;
    },
    create: async (request: { id?: string; name: string; description?: string; systemPrompt?: string; identity?: string; model?: string; icon?: string; skillIds?: string[]; source?: string; presetId?: string }) => {
      const result = await ipcRenderer.invoke('agents:create', request);
      return result?.success ? result.agent : null;
    },
    update: async (id: string, updates: { name?: string; description?: string; systemPrompt?: string; identity?: string; model?: string; icon?: string; skillIds?: string[]; enabled?: boolean }) => {
      const result = await ipcRenderer.invoke('agents:update', id, updates);
      return result?.success ? result.agent : null;
    },
    delete: async (id: string) => {
      const result = await ipcRenderer.invoke('agents:delete', id);
      return result?.success ? result.deleted : false;
    },
    presets: async () => {
      const result = await ipcRenderer.invoke('agents:presets');
      return result?.success ? result.presets : [];
    },
    addPreset: async (presetId: string) => {
      const result = await ipcRenderer.invoke('agents:addPreset', presetId);
      return result?.success ? result.agent : null;
    },
  },
  cowork: {
    // Session management
    startSession: (options: { prompt: string; cwd?: string; systemPrompt?: string; activeSkillIds?: string[]; agentId?: string; imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }> }) =>
      ipcRenderer.invoke('cowork:session:start', options),
    continueSession: (options: { sessionId: string; prompt: string; systemPrompt?: string; activeSkillIds?: string[]; imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }> }) =>
      ipcRenderer.invoke('cowork:session:continue', options),
    stopSession: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:stop', sessionId),
    deleteSession: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:delete', sessionId),
    deleteSessions: (sessionIds: string[]) =>
      ipcRenderer.invoke('cowork:session:deleteBatch', sessionIds),
    setSessionPinned: (options: { sessionId: string; pinned: boolean }) =>
      ipcRenderer.invoke('cowork:session:pin', options),
    renameSession: (options: { sessionId: string; title: string }) =>
      ipcRenderer.invoke('cowork:session:rename', options),
    getSession: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:get', sessionId),
    remoteManaged: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:remoteManaged', sessionId),
    listSessions: (agentId?: string) =>
      ipcRenderer.invoke('cowork:session:list', agentId),
    exportResultImage: (options: { rect: { x: number; y: number; width: number; height: number }; defaultFileName?: string }) =>
      ipcRenderer.invoke('cowork:session:exportResultImage', options),
    captureImageChunk: (options: { rect: { x: number; y: number; width: number; height: number } }) =>
      ipcRenderer.invoke('cowork:session:captureImageChunk', options),
    saveResultImage: (options: { pngBase64: string; defaultFileName?: string }) =>
      ipcRenderer.invoke('cowork:session:saveResultImage', options),
    exportSessionText: (options: { content: string; defaultFileName?: string; fileExtension?: string }) =>
      ipcRenderer.invoke('cowork:session:exportText', options),

    // Permission handling
    respondToPermission: (options: { requestId: string; result: any }) =>
      ipcRenderer.invoke('cowork:permission:respond', options),

    // Configuration
    getConfig: () =>
      ipcRenderer.invoke('cowork:config:get'),
    setConfig: (config: {
      workingDirectory?: string;
      executionMode?: 'auto' | 'local' | 'sandbox';
      agentEngine?: 'openclaw';
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
    }) =>
      ipcRenderer.invoke('cowork:config:set', config),
    listMemoryEntries: (input: {
      query?: string;
      status?: 'created' | 'stale' | 'deleted' | 'all';
      includeDeleted?: boolean;
      limit?: number;
      offset?: number;
    }) =>
      ipcRenderer.invoke('cowork:memory:listEntries', input),
    createMemoryEntry: (input: {
      text: string;
      confidence?: number;
      isExplicit?: boolean;
    }) =>
      ipcRenderer.invoke('cowork:memory:createEntry', input),
    updateMemoryEntry: (input: {
      id: string;
      text?: string;
      confidence?: number;
      status?: 'created' | 'stale' | 'deleted';
      isExplicit?: boolean;
    }) =>
      ipcRenderer.invoke('cowork:memory:updateEntry', input),
    deleteMemoryEntry: (input: { id: string }) =>
      ipcRenderer.invoke('cowork:memory:deleteEntry', input),
    getMemoryStats: () =>
      ipcRenderer.invoke('cowork:memory:getStats'),
    readBootstrapFile: (filename: string) =>
      ipcRenderer.invoke('cowork:bootstrap:read', filename),
    writeBootstrapFile: (filename: string, content: string) =>
      ipcRenderer.invoke('cowork:bootstrap:write', filename, content),
    // Stream event listeners
    onStreamMessage: (callback: (data: { sessionId: string; message: any }) => void) => {
      const handler = (_event: any, data: { sessionId: string; message: any }) => callback(data);
      ipcRenderer.on('cowork:stream:message', handler);
      return () => ipcRenderer.removeListener('cowork:stream:message', handler);
    },
    onStreamMessageUpdate: (callback: (data: { sessionId: string; messageId: string; content: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string; messageId: string; content: string }) => callback(data);
      ipcRenderer.on('cowork:stream:messageUpdate', handler);
      return () => ipcRenderer.removeListener('cowork:stream:messageUpdate', handler);
    },
    onStreamPermission: (callback: (data: { sessionId: string; request: any }) => void) => {
      const handler = (_event: any, data: { sessionId: string; request: any }) => callback(data);
      ipcRenderer.on('cowork:stream:permission', handler);
      return () => ipcRenderer.removeListener('cowork:stream:permission', handler);
    },
    onStreamPermissionDismiss: (callback: (data: { requestId: string }) => void) => {
      const handler = (_event: any, data: { requestId: string }) => callback(data);
      ipcRenderer.on('cowork:stream:permissionDismiss', handler);
      return () => ipcRenderer.removeListener('cowork:stream:permissionDismiss', handler);
    },
    onStreamComplete: (callback: (data: { sessionId: string; claudeSessionId: string | null }) => void) => {
      const handler = (_event: any, data: { sessionId: string; claudeSessionId: string | null }) => callback(data);
      ipcRenderer.on('cowork:stream:complete', handler);
      return () => ipcRenderer.removeListener('cowork:stream:complete', handler);
    },
    onStreamError: (callback: (data: { sessionId: string; error: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string; error: string }) => callback(data);
      ipcRenderer.on('cowork:stream:error', handler);
      return () => ipcRenderer.removeListener('cowork:stream:error', handler);
    },
    onSessionsChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('cowork:sessions:changed', handler);
      return () => ipcRenderer.removeListener('cowork:sessions:changed', handler);
    },
  },
  dialog: {
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
    selectFile: (options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) =>
      ipcRenderer.invoke('dialog:selectFile', options),
    selectFiles: (options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) =>
      ipcRenderer.invoke('dialog:selectFiles', options),
    saveInlineFile: (options: { dataBase64: string; fileName?: string; mimeType?: string; cwd?: string }) =>
      ipcRenderer.invoke('dialog:saveInlineFile', options),
    readFileAsDataUrl: (filePath: string) =>
      ipcRenderer.invoke('dialog:readFileAsDataUrl', filePath),
    showMessageBox: (options: { message: string; type?: 'none' | 'info' | 'error' | 'question' | 'warning'; title?: string }) =>
      ipcRenderer.invoke('dialog:showMessageBox', options),
  },
  shell: {
    openPath: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath),
    showItemInFolder: (filePath: string) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  },
  autoLaunch: {
    get: () => ipcRenderer.invoke('app:getAutoLaunch'),
    set: (enabled: boolean) => ipcRenderer.invoke('app:setAutoLaunch', enabled),
  },
  preventSleep: {
    get: () => ipcRenderer.invoke('app:getPreventSleep'),
    set: (enabled: boolean) => ipcRenderer.invoke('app:setPreventSleep', enabled),
  },
  appInfo: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getSystemLocale: () => ipcRenderer.invoke('app:getSystemLocale'),
  },
  appUpdate: {
    getState: () => ipcRenderer.invoke(AppUpdateIpc.GetState),
    checkNow: (options?: { manual?: boolean; userId?: string | null }) => ipcRenderer.invoke(AppUpdateIpc.CheckNow, options),
    retryDownload: () => ipcRenderer.invoke(AppUpdateIpc.RetryDownload),
    cancelDownload: () => ipcRenderer.invoke(AppUpdateIpc.CancelDownload),
    installReady: () => ipcRenderer.invoke(AppUpdateIpc.InstallReady),
    onStateChanged: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(AppUpdateIpc.StateChanged, handler);
      return () => ipcRenderer.removeListener(AppUpdateIpc.StateChanged, handler);
    },
  },
  log: {
    getPath: () => ipcRenderer.invoke('log:getPath'),
    openFolder: () => ipcRenderer.invoke('log:openFolder'),
    exportZip: () => ipcRenderer.invoke('log:exportZip'),
  },
  im: {
    // Configuration
    getConfig: () => ipcRenderer.invoke('im:config:get'),
    setConfig: (config: any, options?: { syncGateway?: boolean }) => ipcRenderer.invoke('im:config:set', config, options),
    syncConfig: () => ipcRenderer.invoke('im:config:sync'),

    // Gateway control
    startGateway: (platform: Platform) => ipcRenderer.invoke('im:gateway:start', platform),
    stopGateway: (platform: Platform) => ipcRenderer.invoke('im:gateway:stop', platform),
    testGateway: (
      platform: Platform,
      configOverride?: any
    ) => ipcRenderer.invoke('im:gateway:test', platform, configOverride),

    // Status
    getStatus: () => ipcRenderer.invoke('im:status:get'),
    getLocalIp: () => ipcRenderer.invoke('im:getLocalIp') as Promise<string>,
    // OpenClaw config schema
    getOpenClawConfigSchema: () => ipcRenderer.invoke('im:openclaw:config-schema'),


    // Weixin QR login
    weixinQrLoginStart: () => ipcRenderer.invoke('im:weixin:qr-login-start'),
    weixinQrLoginWait: (accountId?: string) => ipcRenderer.invoke('im:weixin:qr-login-wait', accountId),

    // POPO QR login
    popoQrLoginStart: () => ipcRenderer.invoke('im:popo:qr-login-start'),
    popoQrLoginPoll: (taskToken: string) => ipcRenderer.invoke('im:popo:qr-login-poll', taskToken),

    // Pairing
    listPairingRequests: (platform: string) => ipcRenderer.invoke('im:pairing:list', platform),
    approvePairingCode: (platform: string, code: string) => ipcRenderer.invoke('im:pairing:approve', platform, code),
    rejectPairingRequest: (platform: string, code: string) => ipcRenderer.invoke('im:pairing:reject', platform, code),

    // DingTalk Multi-Instance
    addDingTalkInstance: (name: string) => ipcRenderer.invoke('im:dingtalk:instance:add', name),
    deleteDingTalkInstance: (instanceId: string) => ipcRenderer.invoke('im:dingtalk:instance:delete', instanceId),
    setDingTalkInstanceConfig: (instanceId: string, config: any, options?: { syncGateway?: boolean }) =>
      ipcRenderer.invoke('im:dingtalk:instance:config:set', instanceId, config, options),

    // NIM Multi-Instance
    addNimInstance: (name: string) => ipcRenderer.invoke('im:nim:instance:add', name),
    deleteNimInstance: (instanceId: string) => ipcRenderer.invoke('im:nim:instance:delete', instanceId),
    setNimInstanceConfig: (instanceId: string, config: any, options?: { syncGateway?: boolean }) =>
      ipcRenderer.invoke('im:nim:instance:config:set', instanceId, config, options),
    nimQrLoginStart: () => ipcRenderer.invoke(NimQrLoginIpc.Start),
    nimQrLoginPoll: (uuid: string) => ipcRenderer.invoke(NimQrLoginIpc.Poll, uuid),

    // QQ Multi-Instance
    addQQInstance: (name: string) => ipcRenderer.invoke('im:qq:instance:add', name),
    deleteQQInstance: (instanceId: string) => ipcRenderer.invoke('im:qq:instance:delete', instanceId),
    setQQInstanceConfig: (instanceId: string, config: any, options?: { syncGateway?: boolean }) =>
      ipcRenderer.invoke('im:qq:instance:config:set', instanceId, config, options),

    // Feishu Multi-Instance
    addFeishuInstance: (name: string) => ipcRenderer.invoke('im:feishu:instance:add', name),
    deleteFeishuInstance: (instanceId: string) => ipcRenderer.invoke('im:feishu:instance:delete', instanceId),
    setFeishuInstanceConfig: (instanceId: string, config: any, options?: { syncGateway?: boolean }) =>
      ipcRenderer.invoke('im:feishu:instance:config:set', instanceId, config, options),

    // Email Multi-Instance
    addEmailInstance: (name: string) => ipcRenderer.invoke('im:email:instance:add', name),
    deleteEmailInstance: (instanceId: string) => ipcRenderer.invoke('im:email:instance:delete', instanceId),
    setEmailInstanceConfig: (instanceId: string, config: any, options?: { syncGateway?: boolean }) =>
      ipcRenderer.invoke('im:email:instance:config:set', instanceId, config, options),

    // WeCom Multi-Instance
    addWecomInstance: (name: string) => ipcRenderer.invoke('im:wecom:instance:add', name),
    deleteWecomInstance: (instanceId: string) => ipcRenderer.invoke('im:wecom:instance:delete', instanceId),
    setWecomInstanceConfig: (instanceId: string, config: any, options?: { syncGateway?: boolean }) =>
      ipcRenderer.invoke('im:wecom:instance:config:set', instanceId, config, options),

    // Telegram Multi-Instance
    addTelegramInstance: (name: string) => ipcRenderer.invoke('im:telegram:instance:add', name),
    deleteTelegramInstance: (instanceId: string) => ipcRenderer.invoke('im:telegram:instance:delete', instanceId),
    setTelegramInstanceConfig: (instanceId: string, config: any, options?: { syncGateway?: boolean }) =>
      ipcRenderer.invoke('im:telegram:instance:config:set', instanceId, config, options),

    // Discord Multi-Instance
    addDiscordInstance: (name: string) => ipcRenderer.invoke('im:discord:instance:add', name),
    deleteDiscordInstance: (instanceId: string) => ipcRenderer.invoke('im:discord:instance:delete', instanceId),
    setDiscordInstanceConfig: (instanceId: string, config: any, options?: { syncGateway?: boolean }) =>
      ipcRenderer.invoke('im:discord:instance:config:set', instanceId, config, options),

    // Event listeners
    onStatusChange: (callback: (status: any) => void) => {
      const handler = (_event: any, status: any) => callback(status);
      ipcRenderer.on('im:status:change', handler);
      return () => ipcRenderer.removeListener('im:status:change', handler);
    },
    onMessageReceived: (callback: (message: any) => void) => {
      const handler = (_event: any, message: any) => callback(message);
      ipcRenderer.on('im:message:received', handler);
      return () => ipcRenderer.removeListener('im:message:received', handler);
    },
  },
  scheduledTasks: {
    // Task CRUD
    list: () => ipcRenderer.invoke(ScheduledTaskIpc.List),
    get: (id: string) => ipcRenderer.invoke(ScheduledTaskIpc.Get, id),
    create: (input: any) => ipcRenderer.invoke(ScheduledTaskIpc.Create, input),
    update: (id: string, input: any) => ipcRenderer.invoke(ScheduledTaskIpc.Update, id, input),
    delete: (id: string) => ipcRenderer.invoke(ScheduledTaskIpc.Delete, id),
    toggle: (id: string, enabled: boolean) => ipcRenderer.invoke(ScheduledTaskIpc.Toggle, id, enabled),

    // Execution
    runManually: (id: string) => ipcRenderer.invoke(ScheduledTaskIpc.RunManually, id),
    stop: (id: string) => ipcRenderer.invoke(ScheduledTaskIpc.Stop, id),

    // Run history
    listRuns: (taskId: string, limit?: number, offset?: number) =>
      ipcRenderer.invoke(ScheduledTaskIpc.ListRuns, taskId, limit, offset),
    countRuns: (taskId: string) => ipcRenderer.invoke(ScheduledTaskIpc.CountRuns, taskId),
    listAllRuns: (limit?: number, offset?: number) =>
      ipcRenderer.invoke(ScheduledTaskIpc.ListAllRuns, limit, offset),
    resolveSession: (sessionKey: string) =>
      ipcRenderer.invoke(ScheduledTaskIpc.ResolveSession, sessionKey),

    // Delivery channels
    listChannels: () => ipcRenderer.invoke(ScheduledTaskIpc.ListChannels),
    listChannelConversations: (channel: string, accountId?: string, filterAccountId?: string) => ipcRenderer.invoke(
      ScheduledTaskIpc.ListChannelConversations,
      channel,
      accountId,
      filterAccountId,
    ),

    // Stream event listeners
    onStatusUpdate: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(ScheduledTaskIpc.StatusUpdate, handler);
      return () => ipcRenderer.removeListener(ScheduledTaskIpc.StatusUpdate, handler);
    },
    onRunUpdate: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(ScheduledTaskIpc.RunUpdate, handler);
      return () => ipcRenderer.removeListener(ScheduledTaskIpc.RunUpdate, handler);
    },
    onRefresh: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(ScheduledTaskIpc.Refresh, handler);
      return () => ipcRenderer.removeListener(ScheduledTaskIpc.Refresh, handler);
    },
  },
  networkStatus: {
    send: (status: 'online' | 'offline') => ipcRenderer.send('network:status-change', status),
  },
  auth: {
    login: (loginUrl?: string) => ipcRenderer.invoke('auth:login', { loginUrl }),
    exchange: (code: string) => ipcRenderer.invoke('auth:exchange', { code }),
    getUser: () => ipcRenderer.invoke('auth:getUser'),
    getQuota: () => ipcRenderer.invoke('auth:getQuota'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    refreshToken: () => ipcRenderer.invoke('auth:refreshToken'),
    getAccessToken: () => ipcRenderer.invoke('auth:getAccessToken'),
    getModels: () => ipcRenderer.invoke('auth:getModels'),
    getProfileSummary: () => ipcRenderer.invoke('auth:getProfileSummary'),
    onCallback: (callback: (data: { code: string }) => void) => {
      const handler = (_event: any, data: { code: string }) => callback(data);
      ipcRenderer.on('auth:callback', handler);
      return () => ipcRenderer.removeListener('auth:callback', handler);
    },
    onQuotaChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('auth:quotaChanged', handler);
      return () => ipcRenderer.removeListener('auth:quotaChanged', handler);
    },
  },
  feishu: {
    install: {
      qrcode: (isLark: boolean) =>
        ipcRenderer.invoke('feishu:install:qrcode', { isLark }) as Promise<{
          url: string;
          deviceCode: string;
          interval: number;
          expireIn: number;
        }>,
      poll: (deviceCode: string) =>
        ipcRenderer.invoke('feishu:install:poll', { deviceCode }) as Promise<{
          done: boolean;
          appId?: string;
          appSecret?: string;
          domain?: string;
          error?: string;
        }>,
      verify: (appId: string, appSecret: string) =>
        ipcRenderer.invoke('feishu:install:verify', { appId, appSecret }) as Promise<{
          success: boolean;
          error?: string;
        }>,
    },
  },
  dingtalk: {
    install: {
      qrcode: () =>
        ipcRenderer.invoke('dingtalk:install:qrcode') as Promise<{
          url: string;
          deviceCode: string;
          interval: number;
          expireIn: number;
        }>,
      poll: (deviceCode: string) =>
        ipcRenderer.invoke('dingtalk:install:poll', { deviceCode }) as Promise<{
          done: boolean;
          clientId?: string;
          clientSecret?: string;
          error?: string;
        }>,
      verify: (clientId: string, clientSecret: string) =>
        ipcRenderer.invoke('dingtalk:install:verify', { clientId, clientSecret }) as Promise<{
          success: boolean;
          error?: string;
        }>,
    },
  },
  githubCopilot: {
    requestDeviceCode: () =>
      ipcRenderer.invoke('github-copilot:request-device-code') as Promise<{
        userCode: string;
        verificationUri: string;
        deviceCode: string;
        interval: number;
        expiresIn: number;
      }>,
    pollForToken: (deviceCode: string, interval: number, expiresIn: number) =>
      ipcRenderer.invoke('github-copilot:poll-for-token', { deviceCode, interval, expiresIn }) as Promise<{
        success: boolean;
        token?: string;
        githubUser?: string;
        baseUrl?: string;
        error?: string;
      }>,
    cancelPolling: () => ipcRenderer.invoke('github-copilot:cancel-polling') as Promise<void>,
    signOut: () => ipcRenderer.invoke('github-copilot:sign-out') as Promise<void>,
    refreshToken: () =>
      ipcRenderer.invoke('github-copilot:refresh-token') as Promise<{
        success: boolean;
        token?: string;
        baseUrl?: string;
        error?: string;
      }>,
    onTokenUpdated: (callback: (data: { token: string; baseUrl: string }) => void) => {
      const handler = (_event: unknown, data: { token: string; baseUrl: string }) => callback(data);
      ipcRenderer.on('github-copilot:token-updated', handler);
      return () => ipcRenderer.removeListener('github-copilot:token-updated', handler);
    },
  },
});
