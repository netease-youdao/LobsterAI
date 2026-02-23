const envApiBase = (import.meta as any).env?.VITE_LOBSTER_WEB_API_BASE as string | undefined;

const resolveApiBase = (): string => {
  if (envApiBase && envApiBase.trim()) {
    return envApiBase.replace(/\/+$/, '');
  }
  if (window.location.port === '5680') {
    return '/api';
  }
  return 'http://127.0.0.1:5680/api';
};

const API_BASE = resolveApiBase();

type EventHandler = (...args: any[]) => void;

const channelSubscribers = new Map<string, Set<EventHandler>>();
let eventSource: EventSource | null = null;

const dispatchEvent = (channel: string, args: any[]): void => {
  const handlers = channelSubscribers.get(channel);
  if (!handlers || handlers.size === 0) return;
  handlers.forEach((handler) => {
    handler(...args);
  });
};

const ensureEventSource = (): void => {
  if (eventSource) return;
  eventSource = new EventSource(`${API_BASE}/events`);
  eventSource.addEventListener('ipc', (evt) => {
    try {
      const parsed = JSON.parse((evt as MessageEvent<string>).data) as { channel: string; args: any[] };
      dispatchEvent(parsed.channel, Array.isArray(parsed.args) ? parsed.args : []);
    } catch (error) {
      console.error('[WebBridge] Failed to parse event payload:', error);
    }
  });
  eventSource.onerror = () => {
    // Browsers auto-reconnect EventSource, so keep this quiet.
  };
};

const subscribeChannel = (channel: string, handler: EventHandler): (() => void) => {
  ensureEventSource();
  const handlers = channelSubscribers.get(channel) ?? new Set<EventHandler>();
  handlers.add(handler);
  channelSubscribers.set(channel, handlers);
  return () => {
    const current = channelSubscribers.get(channel);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) {
      channelSubscribers.delete(channel);
    }
  };
};

const invoke = async <T>(channel: string, ...args: any[]): Promise<T> => {
  const response = await fetch(`${API_BASE}/rpc/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, args }),
  });

  const payload = await response.json() as { ok: boolean; result?: T; error?: string };
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `RPC invoke failed: ${channel}`);
  }
  return payload.result as T;
};

const send = async (channel: string, ...args: any[]): Promise<void> => {
  await fetch(`${API_BASE}/rpc/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, args }),
  });
};

const noop = () => {};

type ElectronApi = Window['electron'];

const createWebElectronApi = (): ElectronApi => ({
  platform: 'web',
  store: {
    get: (key: string) => invoke('store:get', key),
    set: (key: string, value: any) => invoke('store:set', key, value),
    remove: (key: string) => invoke('store:remove', key),
  },
  skills: {
    list: () => invoke('skills:list'),
    setEnabled: (options) => invoke('skills:setEnabled', options),
    delete: (id) => invoke('skills:delete', id),
    download: (source) => invoke('skills:download', source),
    getRoot: () => invoke('skills:getRoot'),
    autoRoutingPrompt: () => invoke('skills:autoRoutingPrompt'),
    getConfig: (skillId) => invoke('skills:getConfig', skillId),
    setConfig: (skillId, config) => invoke('skills:setConfig', skillId, config),
    testEmailConnectivity: (skillId, config) => invoke('skills:testEmailConnectivity', skillId, config),
    onChanged: (callback) => subscribeChannel('skills:changed', callback),
  },
  permissions: {
    checkCalendar: () => invoke('permissions:checkCalendar'),
    requestCalendar: () => invoke('permissions:requestCalendar'),
  },
  api: {
    fetch: (options) => invoke('api:fetch', options),
    stream: (options) => invoke('api:stream', options),
    cancelStream: (requestId) => invoke('api:stream:cancel', requestId),
    onStreamData: (requestId, callback) => subscribeChannel(`api:stream:${requestId}:data`, callback),
    onStreamDone: (requestId, callback) => subscribeChannel(`api:stream:${requestId}:done`, callback),
    onStreamError: (requestId, callback) => subscribeChannel(`api:stream:${requestId}:error`, callback),
    onStreamAbort: (requestId, callback) => subscribeChannel(`api:stream:${requestId}:abort`, callback),
  },
  ipcRenderer: {
    send: (channel: string, ...args: any[]) => {
      void send(channel, ...args);
    },
    on: (channel: string, func: (...args: any[]) => void) => subscribeChannel(channel, func),
  },
  window: {
    minimize: noop,
    toggleMaximize: noop,
    close: noop,
    isMaximized: async () => false,
    showSystemMenu: noop,
    onStateChanged: (callback) => {
      callback({ isMaximized: false, isFullscreen: false, isFocused: true });
      return () => {};
    },
  },
  getApiConfig: () => invoke('get-api-config'),
  checkApiConfig: () => invoke('check-api-config'),
  saveApiConfig: (config) => invoke('save-api-config', config),
  generateSessionTitle: (userInput) => invoke('generate-session-title', userInput),
  getRecentCwds: (limit?: number) => invoke('get-recent-cwds', limit),
  cowork: {
    startSession: (options) => invoke('cowork:session:start', options),
    continueSession: (options) => invoke('cowork:session:continue', options),
    stopSession: (sessionId) => invoke('cowork:session:stop', sessionId),
    deleteSession: (sessionId) => invoke('cowork:session:delete', sessionId),
    setSessionPinned: (options) => invoke('cowork:session:pin', options),
    renameSession: (options) => invoke('cowork:session:rename', options),
    getSession: (sessionId) => invoke('cowork:session:get', sessionId),
    listSessions: () => invoke('cowork:session:list'),
    exportResultImage: (options) => invoke('cowork:session:exportResultImage', options),
    captureImageChunk: (options) => invoke('cowork:session:captureImageChunk', options),
    saveResultImage: (options) => invoke('cowork:session:saveResultImage', options),
    respondToPermission: (options) => invoke('cowork:permission:respond', options),
    getConfig: () => invoke('cowork:config:get'),
    setConfig: (config) => invoke('cowork:config:set', config),
    listMemoryEntries: (input) => invoke('cowork:memory:listEntries', input),
    createMemoryEntry: (input) => invoke('cowork:memory:createEntry', input),
    updateMemoryEntry: (input) => invoke('cowork:memory:updateEntry', input),
    deleteMemoryEntry: (input) => invoke('cowork:memory:deleteEntry', input),
    getMemoryStats: () => invoke('cowork:memory:getStats'),
    getSandboxStatus: () => invoke('cowork:sandbox:status'),
    installSandbox: () => invoke('cowork:sandbox:install'),
    onSandboxDownloadProgress: (callback) => subscribeChannel('cowork:sandbox:downloadProgress', callback),
    onStreamMessage: (callback) => subscribeChannel('cowork:stream:message', callback),
    onStreamMessageUpdate: (callback) => subscribeChannel('cowork:stream:messageUpdate', callback),
    onStreamPermission: (callback) => subscribeChannel('cowork:stream:permission', callback),
    onStreamComplete: (callback) => subscribeChannel('cowork:stream:complete', callback),
    onStreamError: (callback) => subscribeChannel('cowork:stream:error', callback),
  },
  dialog: {
    selectDirectory: () => invoke('dialog:selectDirectory'),
    selectFile: (options) => invoke('dialog:selectFile', options),
    saveInlineFile: (options) => invoke('dialog:saveInlineFile', options),
  },
  shell: {
    openPath: (filePath: string) => invoke('shell:openPath', filePath),
    showItemInFolder: (filePath: string) => invoke('shell:showItemInFolder', filePath),
    openExternal: (url: string) => invoke('shell:openExternal', url),
  },
  autoLaunch: {
    get: () => invoke('app:getAutoLaunch'),
    set: (enabled: boolean) => invoke('app:setAutoLaunch', enabled),
  },
  appInfo: {
    getVersion: () => invoke('app:getVersion'),
    getSystemLocale: () => invoke('app:getSystemLocale'),
  },
  im: {
    getConfig: () => invoke('im:config:get'),
    setConfig: (config: any) => invoke('im:config:set', config),
    startGateway: (platform) => invoke('im:gateway:start', platform),
    stopGateway: (platform) => invoke('im:gateway:stop', platform),
    testGateway: (platform, configOverride) => invoke('im:gateway:test', platform, configOverride),
    getStatus: () => invoke('im:status:get'),
    onStatusChange: (callback) => subscribeChannel('im:status:change', callback),
    onMessageReceived: (callback) => subscribeChannel('im:message:received', callback),
  },
  scheduledTasks: {
    list: () => invoke('scheduledTask:list'),
    get: (id: string) => invoke('scheduledTask:get', id),
    create: (input: any) => invoke('scheduledTask:create', input),
    update: (id: string, input: any) => invoke('scheduledTask:update', id, input),
    delete: (id: string) => invoke('scheduledTask:delete', id),
    toggle: (id: string, enabled: boolean) => invoke('scheduledTask:toggle', id, enabled),
    runManually: (id: string) => invoke('scheduledTask:runManually', id),
    stop: (id: string) => invoke('scheduledTask:stop', id),
    listRuns: (taskId: string, limit?: number, offset?: number) => invoke('scheduledTask:listRuns', taskId, limit, offset),
    countRuns: (taskId: string) => invoke('scheduledTask:countRuns', taskId),
    listAllRuns: (limit?: number, offset?: number) => invoke('scheduledTask:listAllRuns', limit, offset),
    onStatusUpdate: (callback) => subscribeChannel('scheduledTask:statusUpdate', callback),
    onRunUpdate: (callback) => subscribeChannel('scheduledTask:runUpdate', callback),
  },
  networkStatus: {
    send: (status) => {
      void send('network:status-change', status);
    },
  },
});

export const ensureElectronBridge = (): void => {
  if ((window as any).electron) {
    return;
  }

  (window as any).electron = createWebElectronApi();

  fetch(`${API_BASE}/meta`)
    .then((response) => response.json())
    .then((payload) => {
      if (payload?.platform && (window as any).electron) {
        (window as any).electron.platform = payload.platform;
      }
    })
    .catch(() => {
      // Keep fallback platform="web" when server metadata is not available.
    });
};
