// @ts-nocheck

import packageJson from '../../../package.json';
import { configService } from './config';
import { apiService } from './api';
import { DEFAULT_IM_CONFIG, DEFAULT_IM_STATUS } from '../types/im';
import type { ChatMessagePayload, ImageAttachment } from '../types/chat';
import type {
  CoworkConfig,
  CoworkConfigUpdate,
  CoworkContinueOptions,
  CoworkImageAttachment,
  CoworkMemoryStats,
  CoworkMessage,
  CoworkPermissionRequest,
  CoworkPermissionResult,
  CoworkSession,
  CoworkSessionSummary,
  CoworkStartOptions,
  CoworkUserMemoryEntry,
} from '../types/cowork';

const MOCK_FLAG = '__LOBSTER_WEB_SHIM__';
const STORAGE_PREFIX = 'lobsterai:web:';
const STORE_PREFIX = `${STORAGE_PREFIX}store:`;
const COWORK_SESSIONS_KEY = `${STORAGE_PREFIX}cowork:sessions`;
const COWORK_CONFIG_KEY = `${STORAGE_PREFIX}cowork:config`;
const COWORK_MEMORY_KEY = `${STORAGE_PREFIX}cowork:memory`;
const SKILLS_KEY = `${STORAGE_PREFIX}skills:list`;
const SKILL_CONFIGS_KEY = `${STORAGE_PREFIX}skills:configs`;
const MCP_SERVERS_KEY = `${STORAGE_PREFIX}mcp:servers`;
const SCHEDULED_TASKS_KEY = `${STORAGE_PREFIX}scheduled:tasks`;
const SCHEDULED_RUNS_KEY = `${STORAGE_PREFIX}scheduled:runs`;
const IM_CONFIG_KEY = `${STORAGE_PREFIX}im:config`;
const IM_STATUS_KEY = `${STORAGE_PREFIX}im:status`;

const DEFAULT_COWORK_CONFIG: CoworkConfig = {
  workingDirectory: '',
  systemPrompt: '',
  executionMode: 'local',
  memoryEnabled: true,
  memoryImplicitUpdateEnabled: true,
  memoryLlmJudgeEnabled: false,
  memoryGuardLevel: 'strict',
  memoryUserMemoriesMaxItems: 12,
};

const noop = () => {};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const readStorage = <T>(key: string, fallback: T): T => {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return clone(fallback);
    }
    return JSON.parse(raw) as T;
  } catch (error) {
    console.warn(`[web-shim] Failed to read ${key}:`, error);
    return clone(fallback);
  }
};

const writeStorage = (key: string, value: unknown): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`[web-shim] Failed to write ${key}:`, error);
  }
};

const removeStorage = (key: string): void => {
  try {
    window.localStorage.removeItem(key);
  } catch (error) {
    console.warn(`[web-shim] Failed to remove ${key}:`, error);
  }
};

const now = (): number => Date.now();
const makeId = (prefix: string): string => `${prefix}-${now()}-${Math.random().toString(36).slice(2, 10)}`;

const summarizePrompt = (prompt: string | null | undefined): string => {
  const normalized = (prompt || '').trim();
  if (!normalized) {
    return 'New Session';
  }
  const firstLine = normalized.split(/\r?\n/, 1)[0].trim();
  return firstLine.slice(0, 50) || 'New Session';
};

const createEmitter = <T>() => {
  const listeners = new Set<(payload: T) => void>();
  return {
    on(callback: (payload: T) => void): (() => void) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    emit(payload: T): void {
      listeners.forEach((listener) => listener(payload));
    },
  };
};

const createKeyedEmitter = <T>() => {
  const listeners = new Map<string, Set<(payload: T) => void>>();
  return {
    on(key: string, callback: (payload: T) => void): (() => void) {
      const bucket = listeners.get(key) ?? new Set<(payload: T) => void>();
      bucket.add(callback);
      listeners.set(key, bucket);
      return () => {
        const current = listeners.get(key);
        if (!current) return;
        current.delete(callback);
        if (current.size === 0) {
          listeners.delete(key);
        }
      };
    },
    emit(key: string, payload: T): void {
      listeners.get(key)?.forEach((listener) => listener(payload));
    },
  };
};

const streamDataEmitter = createKeyedEmitter<string>();
const streamDoneEmitter = createKeyedEmitter<void>();
const streamErrorEmitter = createKeyedEmitter<string>();
const streamAbortEmitter = createKeyedEmitter<void>();

const coworkMessageEmitter = createEmitter<{ sessionId: string; message: CoworkMessage }>();
const coworkMessageUpdateEmitter = createEmitter<{ sessionId: string; messageId: string; content: string }>();
const coworkPermissionEmitter = createEmitter<{ sessionId: string; request: CoworkPermissionRequest }>();
const coworkCompleteEmitter = createEmitter<{ sessionId: string; claudeSessionId: string | null }>();
const coworkErrorEmitter = createEmitter<{ sessionId: string; error: string }>();
const coworkSandboxProgressEmitter = createEmitter<{ stage: 'runtime' | 'image'; received: number; total?: number; percent?: number; url?: string }>();
const skillChangedEmitter = createEmitter<void>();
const scheduledStatusEmitter = createEmitter<any>();
const scheduledRunEmitter = createEmitter<any>();
const imStatusEmitter = createEmitter<any>();
const imMessageEmitter = createEmitter<any>();

const apiControllers = new Map<string, AbortController>();
const webFiles = new Map<string, File>();
const activeSessionTurns = new Map<string, { stopped: boolean }>();

const readTextFileAsDataUrl = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
};

const ensureArray = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);

const getCoworkSessions = (): CoworkSession[] => readStorage<CoworkSession[]>(COWORK_SESSIONS_KEY, []);
const saveCoworkSessions = (sessions: CoworkSession[]): void => writeStorage(COWORK_SESSIONS_KEY, sessions);
const getCoworkConfig = (): CoworkConfig => readStorage<CoworkConfig>(COWORK_CONFIG_KEY, DEFAULT_COWORK_CONFIG);
const saveCoworkConfig = (config: CoworkConfig): void => writeStorage(COWORK_CONFIG_KEY, config);
const getCoworkMemory = (): CoworkUserMemoryEntry[] => readStorage<CoworkUserMemoryEntry[]>(COWORK_MEMORY_KEY, []);
const saveCoworkMemory = (entries: CoworkUserMemoryEntry[]): void => writeStorage(COWORK_MEMORY_KEY, entries);
const getSkills = (): Skill[] => readStorage<Skill[]>(SKILLS_KEY, []);
const saveSkills = (skills: Skill[]): void => writeStorage(SKILLS_KEY, skills);
const getSkillConfigs = (): Record<string, Record<string, string>> => readStorage(SKILL_CONFIGS_KEY, {} as Record<string, Record<string, string>>);
const saveSkillConfigs = (configs: Record<string, Record<string, string>>): void => writeStorage(SKILL_CONFIGS_KEY, configs);
const getMcpServers = (): McpServerConfigIPC[] => readStorage<McpServerConfigIPC[]>(MCP_SERVERS_KEY, []);
const saveMcpServers = (servers: McpServerConfigIPC[]): void => writeStorage(MCP_SERVERS_KEY, servers);
const getScheduledTasks = (): any[] => readStorage<any[]>(SCHEDULED_TASKS_KEY, []);
const saveScheduledTasks = (tasks: any[]): void => writeStorage(SCHEDULED_TASKS_KEY, tasks);
const getScheduledRuns = (): any[] => readStorage<any[]>(SCHEDULED_RUNS_KEY, []);
const saveScheduledRuns = (runs: any[]): void => writeStorage(SCHEDULED_RUNS_KEY, runs);
const getImConfig = (): IMGatewayConfig => readStorage<IMGatewayConfig>(IM_CONFIG_KEY, DEFAULT_IM_CONFIG);
const saveImConfig = (config: IMGatewayConfig): void => writeStorage(IM_CONFIG_KEY, config);
const getImStatus = (): IMGatewayStatus => readStorage<IMGatewayStatus>(IM_STATUS_KEY, DEFAULT_IM_STATUS);
const saveImStatus = (status: IMGatewayStatus): void => writeStorage(IM_STATUS_KEY, status);

const updateSession = (sessionId: string, updater: (session: CoworkSession) => CoworkSession): CoworkSession | null => {
  const sessions = getCoworkSessions();
  const index = sessions.findIndex((session) => session.id === sessionId);
  if (index === -1) {
    return null;
  }
  const updated = updater(sessions[index]);
  sessions[index] = updated;
  saveCoworkSessions(sessions);
  return updated;
};

const getSessionSummary = (session: CoworkSession): CoworkSessionSummary => ({
  id: session.id,
  title: session.title,
  status: session.status,
  pinned: session.pinned,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
});

const normalizeImageAttachments = (attachments?: CoworkImageAttachment[]): ImageAttachment[] | undefined => {
  const items = ensureArray(attachments).map((attachment) => ({
    id: makeId('img'),
    name: attachment.name,
    type: attachment.mimeType,
    size: Math.ceil((attachment.base64Data.length * 3) / 4),
    dataUrl: `data:${attachment.mimeType};base64,${attachment.base64Data}`,
  }));
  return items.length > 0 ? items : undefined;
};

const getMessageImages = (message: CoworkMessage): ImageAttachment[] | undefined => {
  const attachments = (message.metadata?.imageAttachments ?? []) as CoworkImageAttachment[];
  return normalizeImageAttachments(attachments);
};

const buildChatHistory = (messages: CoworkMessage[], systemPrompt?: string): ChatMessagePayload[] => {
  const history: ChatMessagePayload[] = [];
  if (systemPrompt?.trim()) {
    history.push({ role: 'system', content: systemPrompt.trim() });
  }
  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant' && message.type !== 'system') {
      continue;
    }
    history.push({
      role: message.type === 'system' ? 'system' : message.type,
      content: message.content,
      images: message.type === 'user' ? getMessageImages(message) : undefined,
    });
  }
  return history;
};
const getEnabledProviderEntries = () => {
  const config = configService.getConfig();
  return Object.entries(config.providers ?? {}).filter(([, providerConfig]) => providerConfig.enabled);
};

const getPrimaryApiConfig = (): CoworkApiConfig | null => {
  const config = configService.getConfig();
  const enabledProviders = getEnabledProviderEntries();
  const preferredProvider = enabledProviders.find(([providerKey]) => providerKey === config.model.defaultModelProvider) ?? enabledProviders[0];

  if (preferredProvider) {
    const [providerKey, providerConfig] = preferredProvider;
    const selectedModel = providerConfig.models?.find((model) => model.id === config.model.defaultModel) ?? providerConfig.models?.[0];
    return {
      apiKey: providerConfig.apiKey || config.api.key,
      baseURL: providerConfig.baseUrl || config.api.baseUrl,
      model: selectedModel?.id || config.model.defaultModel,
      apiType: providerConfig.apiFormat,
    };
  }

  if (config.api.key && config.api.baseUrl) {
    return {
      apiKey: config.api.key,
      baseURL: config.api.baseUrl,
      model: config.model.defaultModel,
    };
  }

  return null;
};

const checkApiConfig = async (): Promise<{ hasConfig: boolean; config: CoworkApiConfig | null; error?: string }> => {
  const config = configService.getConfig();
  const enabledProviders = getEnabledProviderEntries();
  const apiConfig = getPrimaryApiConfig();

  if (enabledProviders.length === 0 && !config.api.key) {
    return {
      hasConfig: false,
      config: null,
      error: 'No available model configured in enabled providers.',
    };
  }

  if (!apiConfig?.model) {
    return {
      hasConfig: false,
      config: null,
      error: 'No enabled provider found for model: unknown',
    };
  }

  if (!apiConfig.apiKey && !apiConfig.baseURL.includes('localhost') && !apiConfig.baseURL.includes('127.0.0.1')) {
    return {
      hasConfig: false,
      config: apiConfig,
      error: 'API key is not configured.',
    };
  }

  return { hasConfig: true, config: apiConfig };
};

const saveApiConfig = async (nextConfig: CoworkApiConfig): Promise<{ success: boolean; error?: string }> => {
  const currentConfig = configService.getConfig();
  const providerKey = currentConfig.model.defaultModelProvider || 'openai';
  const existingProvider = currentConfig.providers?.[providerKey];
  const updatedProviders = {
    ...(currentConfig.providers ?? {}),
    [providerKey]: {
      enabled: true,
      apiKey: nextConfig.apiKey,
      baseUrl: nextConfig.baseURL,
      apiFormat: nextConfig.apiType ?? existingProvider?.apiFormat ?? 'openai',
      openaiApiType: existingProvider?.openaiApiType,
      codingPlanEnabled: existingProvider?.codingPlanEnabled,
      models: existingProvider?.models ?? [{ id: nextConfig.model, name: nextConfig.model, supportsImage: true }],
    },
  };

  await configService.updateConfig({
    api: {
      ...currentConfig.api,
      key: nextConfig.apiKey,
      baseUrl: nextConfig.baseURL,
    },
    providers: updatedProviders,
    model: {
      ...currentConfig.model,
      defaultModel: nextConfig.model,
      defaultModelProvider: providerKey,
    },
  });

  return { success: true };
};

const updateSessionMessage = (sessionId: string, messageId: string, updater: (message: CoworkMessage) => CoworkMessage): CoworkSession | null => {
  return updateSession(sessionId, (session) => ({
    ...session,
    updatedAt: now(),
    messages: session.messages.map((message) => {
      if (message.id !== messageId) {
        return message;
      }
      return updater(message);
    }),
  }));
};

const appendMessage = (sessionId: string, message: CoworkMessage): CoworkSession | null => {
  return updateSession(sessionId, (session) => ({
    ...session,
    updatedAt: now(),
    messages: [...session.messages, message],
  }));
};

const runAssistantTurn = async (
  session: CoworkSession,
  prompt: string,
  imageAttachments?: CoworkImageAttachment[],
): Promise<void> => {
  const turnState = activeSessionTurns.get(session.id);
  if (!turnState || turnState.stopped) {
    return;
  }

  const assistantMessageId = makeId('assistant');
  const assistantMessage: CoworkMessage = {
    id: assistantMessageId,
    type: 'assistant',
    content: '',
    timestamp: now(),
    metadata: { isStreaming: true },
  };
  appendMessage(session.id, assistantMessage);
  coworkMessageEmitter.emit({ sessionId: session.id, message: assistantMessage });

  try {
    const history = buildChatHistory(session.messages, session.systemPrompt);
    const result = await apiService.chat(
      {
        content: prompt,
        images: normalizeImageAttachments(imageAttachments),
      },
      (content, reasoning) => {
        if (turnState.stopped) {
          return;
        }
        updateSessionMessage(session.id, assistantMessageId, (message) => ({
          ...message,
          content,
          metadata: {
            ...message.metadata,
            reasoning,
            isStreaming: true,
          },
        }));
        coworkMessageUpdateEmitter.emit({
          sessionId: session.id,
          messageId: assistantMessageId,
          content,
        });
      },
      history,
    );

    if (turnState.stopped) {
      return;
    }

    updateSession(session.id, (current) => ({
      ...current,
      status: 'completed',
      updatedAt: now(),
      messages: current.messages.map((message) => {
        if (message.id !== assistantMessageId) {
          return message;
        }
        return {
          ...message,
          content: result.content,
          metadata: {
            ...message.metadata,
            reasoning: result.reasoning,
            isStreaming: false,
            isFinal: true,
          },
        };
      }),
    }));
    coworkCompleteEmitter.emit({ sessionId: session.id, claudeSessionId: null });
  } catch (error) {
    if (turnState.stopped) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    updateSession(session.id, (current) => ({
      ...current,
      status: 'error',
      updatedAt: now(),
      messages: [
        ...current.messages.map((item) => {
          if (item.id !== assistantMessageId) {
            return item;
          }
          return {
            ...item,
            metadata: {
              ...item.metadata,
              isStreaming: false,
              isError: true,
            },
          };
        }),
        {
          id: makeId('system'),
          type: 'system',
          content: message,
          timestamp: now(),
          metadata: { isError: true },
        },
      ],
    }));
    coworkErrorEmitter.emit({ sessionId: session.id, error: message });
  } finally {
    activeSessionTurns.delete(session.id);
  }
};

const startTurn = (sessionId: string): { stopped: boolean } => {
  const turnState = { stopped: false };
  activeSessionTurns.set(sessionId, turnState);
  return turnState;
};

const parseResponseBody = async (response: Response): Promise<{ data: any; text: string }> => {
  const text = await response.text();
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      return { data: JSON.parse(text), text };
    } catch {
      return { data: text, text };
    }
  }
  try {
    return { data: JSON.parse(text), text };
  } catch {
    return { data: text, text };
  }
};
const mockApi: IElectronAPI & { [MOCK_FLAG]: true } = {
  [MOCK_FLAG]: true,
  platform: 'web',
  arch: 'web',
  store: {
    async get(key: string) {
      return readStorage(`${STORE_PREFIX}${key}`, null);
    },
    async set(key: string, value: any) {
      writeStorage(`${STORE_PREFIX}${key}`, value);
    },
    async remove(key: string) {
      removeStorage(`${STORE_PREFIX}${key}`);
    },
  },
  skills: {
    async list() {
      return { success: true, skills: getSkills() };
    },
    async setEnabled({ id, enabled }) {
      const skills = getSkills().map((skill) => (skill.id === id ? { ...skill, enabled, updatedAt: now() } : skill));
      saveSkills(skills);
      skillChangedEmitter.emit();
      return { success: true, skills };
    },
    async delete(id) {
      const skills = getSkills().filter((skill) => skill.id !== id);
      saveSkills(skills);
      skillChangedEmitter.emit();
      return { success: true, skills };
    },
    async download(source) {
      return { success: false, error: `Skill download is not available in browser mode: ${source}` };
    },
    async getRoot() {
      return { success: true, path: '/browser/skills' };
    },
    async autoRoutingPrompt() {
      return { success: true, prompt: null };
    },
    async getConfig(skillId) {
      const configs = getSkillConfigs();
      return { success: true, config: configs[skillId] ?? {} };
    },
    async setConfig(skillId, config) {
      const configs = getSkillConfigs();
      configs[skillId] = config;
      saveSkillConfigs(configs);
      return { success: true };
    },
    async testEmailConnectivity() {
      return {
        success: true,
        result: {
          testedAt: now(),
          verdict: 'fail',
          checks: [{ code: 'imap_connection', level: 'fail', message: 'Browser mode cannot access local email transports.', durationMs: 0 }],
        },
      };
    },
    onChanged(callback) {
      return skillChangedEmitter.on(callback);
    },
  },
  mcp: {
    async list() {
      return { success: true, servers: getMcpServers() };
    },
    async create(data) {
      const servers = getMcpServers();
      const nextServer: McpServerConfigIPC = {
        id: makeId('mcp'),
        name: data.name ?? 'New MCP Server',
        description: data.description ?? '',
        enabled: data.enabled ?? true,
        transportType: data.transportType ?? 'stdio',
        command: data.command,
        args: data.args,
        env: data.env,
        url: data.url,
        headers: data.headers,
        isBuiltIn: false,
        githubUrl: data.githubUrl,
        registryId: data.registryId,
        createdAt: now(),
        updatedAt: now(),
      };
      const nextServers = [...servers, nextServer];
      saveMcpServers(nextServers);
      return { success: true, servers: nextServers };
    },
    async update(id, data) {
      const servers = getMcpServers().map((server) => (server.id === id ? { ...server, ...data, updatedAt: now() } : server));
      saveMcpServers(servers);
      return { success: true, servers };
    },
    async delete(id) {
      const servers = getMcpServers().filter((server) => server.id !== id);
      saveMcpServers(servers);
      return { success: true, servers };
    },
    async setEnabled({ id, enabled }) {
      const servers = getMcpServers().map((server) => (server.id === id ? { ...server, enabled, updatedAt: now() } : server));
      saveMcpServers(servers);
      return { success: true, servers };
    },
    async fetchMarketplace() {
      return { success: true, data: { categories: [], servers: [] } };
    },
  },
  api: {
    async fetch(options) {
      try {
        const response = await fetch(options.url, {
          method: options.method,
          headers: options.headers,
          body: options.body,
        });
        const { data, text } = await parseResponseBody(response);
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          data,
          error: response.ok ? undefined : text,
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          statusText: 'Network Error',
          headers: {},
          data: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async stream(options) {
      const controller = new AbortController();
      apiControllers.set(options.requestId, controller);
      try {
        const response = await fetch(options.url, {
          method: options.method,
          headers: options.headers,
          body: options.body,
          signal: controller.signal,
        });

        if (!response.ok) {
          const { text } = await parseResponseBody(response);
          apiControllers.delete(options.requestId);
          return {
            ok: false,
            status: response.status,
            statusText: response.statusText,
            error: text,
          };
        }

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        void (async () => {
          try {
            if (!reader) {
              streamDoneEmitter.emit(options.requestId, undefined);
              return;
            }
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              const chunk = decoder.decode(value, { stream: true });
              if (chunk) {
                streamDataEmitter.emit(options.requestId, chunk);
              }
            }
            streamDoneEmitter.emit(options.requestId, undefined);
          } catch (error) {
            if (controller.signal.aborted) {
              streamAbortEmitter.emit(options.requestId, undefined);
            } else {
              streamErrorEmitter.emit(options.requestId, error instanceof Error ? error.message : String(error));
            }
          } finally {
            apiControllers.delete(options.requestId);
          }
        })();

        return {
          ok: true,
          status: response.status,
          statusText: response.statusText,
        };
      } catch (error) {
        apiControllers.delete(options.requestId);
        if (controller.signal.aborted) {
          streamAbortEmitter.emit(options.requestId, undefined);
          return { ok: false, status: 0, statusText: 'Aborted', error: 'Aborted' };
        }
        return {
          ok: false,
          status: 0,
          statusText: 'Network Error',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async cancelStream(requestId) {
      const controller = apiControllers.get(requestId);
      if (!controller) {
        return false;
      }
      controller.abort();
      apiControllers.delete(requestId);
      return true;
    },
    onStreamData(requestId, callback) {
      return streamDataEmitter.on(requestId, callback);
    },
    onStreamDone(requestId, callback) {
      return streamDoneEmitter.on(requestId, callback);
    },
    onStreamError(requestId, callback) {
      return streamErrorEmitter.on(requestId, callback);
    },
    onStreamAbort(requestId, callback) {
      return streamAbortEmitter.on(requestId, callback);
    },
  },
  async getApiConfig() {
    return getPrimaryApiConfig();
  },
  async checkApiConfig() {
    return checkApiConfig();
  },
  async saveApiConfig(config) {
    return saveApiConfig(config);
  },
  async generateSessionTitle(userInput) {
    return summarizePrompt(userInput);
  },
  async getRecentCwds() {
    const config = getCoworkConfig();
    return config.workingDirectory ? [config.workingDirectory] : [];
  },
  ipcRenderer: {
    send() {
      noop();
    },
    on() {
      return noop;
    },
  },
  window: {
    minimize() {
      noop();
    },
    toggleMaximize() {
      noop();
    },
    close() {
      window.close();
    },
    async isMaximized() {
      return false;
    },
    showSystemMenu() {
      noop();
    },
    onStateChanged() {
      return noop;
    },
  },
  cowork: {
    async startSession(options: CoworkStartOptions) {
      const configCheck = await checkApiConfig();
      if (!configCheck.hasConfig) {
        return { success: false, error: configCheck.error || 'API is not configured.' };
      }

      const timestamp = now();
      const session: CoworkSession = {
        id: makeId('session'),
        title: options.title?.trim() || summarizePrompt(options.prompt),
        claudeSessionId: null,
        status: 'running',
        pinned: false,
        cwd: options.cwd ?? getCoworkConfig().workingDirectory,
        systemPrompt: options.systemPrompt ?? '',
        executionMode: getCoworkConfig().executionMode,
        activeSkillIds: ensureArray(options.activeSkillIds),
        messages: [{
          id: makeId('user'),
          type: 'user',
          content: options.prompt,
          timestamp,
          metadata: {
            ...(ensureArray(options.activeSkillIds).length > 0 ? { skillIds: ensureArray(options.activeSkillIds) } : {}),
            ...(ensureArray(options.imageAttachments).length > 0 ? { imageAttachments: options.imageAttachments } : {}),
          },
        }],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      saveCoworkSessions([session, ...getCoworkSessions()]);
      startTurn(session.id);
      void runAssistantTurn(session, options.prompt, options.imageAttachments);
      return { success: true, session };
    },
    async continueSession(options: CoworkContinueOptions) {
      const configCheck = await checkApiConfig();
      if (!configCheck.hasConfig) {
        return { success: false, error: configCheck.error || 'API is not configured.' };
      }

      const userMessage: CoworkMessage = {
        id: makeId('user'),
        type: 'user',
        content: options.prompt,
        timestamp: now(),
        metadata: {
          ...(ensureArray(options.activeSkillIds).length > 0 ? { skillIds: ensureArray(options.activeSkillIds) } : {}),
          ...(ensureArray(options.imageAttachments).length > 0 ? { imageAttachments: options.imageAttachments } : {}),
        },
      };
      const existingSession = appendMessage(options.sessionId, userMessage);
      if (!existingSession) {
        return { success: false, error: 'Session not found.' };
      }
      const runningSession = updateSession(options.sessionId, (session) => ({
        ...session,
        status: 'running',
        updatedAt: now(),
        systemPrompt: options.systemPrompt ?? session.systemPrompt,
        activeSkillIds: ensureArray(options.activeSkillIds).length > 0 ? ensureArray(options.activeSkillIds) : session.activeSkillIds,
      }));
      if (!runningSession) {
        return { success: false, error: 'Session not found.' };
      }
      coworkMessageEmitter.emit({ sessionId: options.sessionId, message: userMessage });
      startTurn(options.sessionId);
      void runAssistantTurn(runningSession, options.prompt, options.imageAttachments);
      return { success: true, session: runningSession };
    },
    async stopSession(sessionId) {
      const turnState = activeSessionTurns.get(sessionId);
      if (turnState) {
        turnState.stopped = true;
        apiService.cancelOngoingRequest();
      }
      const updated = updateSession(sessionId, (session) => ({ ...session, status: 'idle', updatedAt: now() }));
      return updated ? { success: true } : { success: false, error: 'Session not found.' };
    },
    async deleteSession(sessionId) {
      const sessions = getCoworkSessions().filter((session) => session.id !== sessionId);
      saveCoworkSessions(sessions);
      return { success: true };
    },
    async deleteSessions(sessionIds) {
      const ids = new Set(sessionIds);
      const sessions = getCoworkSessions().filter((session) => !ids.has(session.id));
      saveCoworkSessions(sessions);
      return { success: true };
    },
    async setSessionPinned({ sessionId, pinned }) {
      const updated = updateSession(sessionId, (session) => ({ ...session, pinned, updatedAt: now() }));
      return updated ? { success: true } : { success: false, error: 'Session not found.' };
    },
    async renameSession({ sessionId, title }) {
      const updated = updateSession(sessionId, (session) => ({ ...session, title, updatedAt: now() }));
      return updated ? { success: true } : { success: false, error: 'Session not found.' };
    },
    async getSession(sessionId) {
      const session = getCoworkSessions().find((item) => item.id === sessionId);
      return session ? { success: true, session } : { success: false, error: 'Session not found.' };
    },
    async listSessions() {
      const sessions = getCoworkSessions()
        .map(getSessionSummary)
        .sort((left, right) => right.updatedAt - left.updatedAt);
      return { success: true, sessions };
    },
    async exportResultImage() {
      return { success: false, error: 'Image export is not available in browser mode.' };
    },
    async captureImageChunk() {
      return { success: false, error: 'Image capture is not available in browser mode.' };
    },
    async saveResultImage() {
      return { success: false, error: 'Image save is not available in browser mode.' };
    },
    async respondToPermission(_options: { requestId: string; result: CoworkPermissionResult }) {
      return { success: true };
    },
    async getConfig() {
      return { success: true, config: getCoworkConfig() };
    },
    async setConfig(config: CoworkConfigUpdate) {
      saveCoworkConfig({ ...getCoworkConfig(), ...config });
      return { success: true };
    },
    async listMemoryEntries(input) {
      let entries = getCoworkMemory();
      if (input.query?.trim()) {
        const query = input.query.trim().toLowerCase();
        entries = entries.filter((entry) => entry.text.toLowerCase().includes(query));
      }
      if (input.status && input.status !== 'all') {
        entries = entries.filter((entry) => entry.status === input.status);
      }
      if (!input.includeDeleted) {
        entries = entries.filter((entry) => entry.status !== 'deleted');
      }
      const offset = input.offset ?? 0;
      const limit = input.limit ?? entries.length;
      return { success: true, entries: entries.slice(offset, offset + limit) };
    },
    async createMemoryEntry(input) {
      const entry: CoworkUserMemoryEntry = {
        id: makeId('memory'),
        text: input.text,
        confidence: input.confidence ?? 1,
        isExplicit: input.isExplicit ?? false,
        status: 'created',
        createdAt: now(),
        updatedAt: now(),
        lastUsedAt: null,
      };
      const entries = [entry, ...getCoworkMemory()];
      saveCoworkMemory(entries);
      return { success: true, entry };
    },
    async updateMemoryEntry(input) {
      const entries = getCoworkMemory();
      const index = entries.findIndex((entry) => entry.id === input.id);
      if (index === -1) {
        return { success: false, error: 'Memory entry not found.' };
      }
      const entry = {
        ...entries[index],
        ...input,
        updatedAt: now(),
      };
      entries[index] = entry;
      saveCoworkMemory(entries);
      return { success: true, entry };
    },
    async deleteMemoryEntry(input) {
      const entries = getCoworkMemory().map((entry) => (entry.id === input.id ? { ...entry, status: 'deleted', updatedAt: now() } : entry));
      saveCoworkMemory(entries);
      return { success: true };
    },
    async getMemoryStats() {
      const entries = getCoworkMemory();
      const stats: CoworkMemoryStats = {
        total: entries.length,
        created: entries.filter((entry) => entry.status === 'created').length,
        stale: entries.filter((entry) => entry.status === 'stale').length,
        deleted: entries.filter((entry) => entry.status === 'deleted').length,
        explicit: entries.filter((entry) => entry.isExplicit).length,
        implicit: entries.filter((entry) => !entry.isExplicit).length,
      };
      return { success: true, stats };
    },
    async getSandboxStatus() {
      return { supported: false, runtimeReady: false, imageReady: false, downloading: false, error: 'Sandbox is not available in browser mode.' };
    },
    async installSandbox() {
      return {
        success: false,
        status: { supported: false, runtimeReady: false, imageReady: false, downloading: false, error: 'Sandbox is not available in browser mode.' },
        error: 'Sandbox is not available in browser mode.',
      };
    },
    onSandboxDownloadProgress(callback) {
      return coworkSandboxProgressEmitter.on(callback);
    },
    onStreamMessage(callback) {
      return coworkMessageEmitter.on(callback);
    },
    onStreamMessageUpdate(callback) {
      return coworkMessageUpdateEmitter.on(callback);
    },
    onStreamPermission(callback) {
      return coworkPermissionEmitter.on(callback);
    },
    onStreamComplete(callback) {
      return coworkCompleteEmitter.on(callback);
    },
    onStreamError(callback) {
      return coworkErrorEmitter.on(callback);
    },
  },
  dialog: {
    async selectDirectory() {
      return new Promise<{ success: boolean; path: string | null }>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.setAttribute('webkitdirectory', '');
        input.addEventListener('change', () => {
          const firstFile = input.files?.[0];
          if (!firstFile) {
            resolve({ success: false, path: null });
            return;
          }
          const relativePath = (firstFile as File & { webkitRelativePath?: string }).webkitRelativePath || '';
          const rootName = relativePath.split('/')[0] || firstFile.name || 'workspace';
          resolve({ success: true, path: `/browser/${rootName}` });
        }, { once: true });
        input.click();
      });
    },
    async selectFile(options) {
      return new Promise<{ success: boolean; path: string | null }>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        const extensions = options?.filters?.flatMap((filter) => filter.extensions).filter(Boolean) ?? [];
        if (extensions.length > 0) {
          input.accept = extensions.map((extension) => `.${extension}`).join(',');
        }
        input.addEventListener('change', () => {
          const file = input.files?.[0];
          if (!file) {
            resolve({ success: false, path: null });
            return;
          }
          const pseudoPath = `browser://${makeId('file')}/${file.name}`;
          webFiles.set(pseudoPath, file);
          resolve({ success: true, path: pseudoPath });
        }, { once: true });
        input.click();
      });
    },
    async saveInlineFile(options) {
      try {
        const byteString = atob(options.dataBase64);
        const bytes = Uint8Array.from(byteString, (character) => character.charCodeAt(0));
        const blob = new Blob([bytes], { type: options.mimeType || 'application/octet-stream' });
        const fileName = options.fileName || 'download';
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        return { success: true, path: fileName };
      } catch (error) {
        return { success: false, path: null, error: error instanceof Error ? error.message : String(error) };
      }
    },
    async readFileAsDataUrl(filePath) {
      const file = webFiles.get(filePath);
      if (!file) {
        return { success: false, error: 'Selected file is no longer available in browser memory.' };
      }
      try {
        const dataUrl = await readTextFileAsDataUrl(file);
        return { success: true, dataUrl };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  },
  shell: {
    async openPath(filePath) {
      if (/^https?:\/\//.test(filePath)) {
        window.open(filePath, '_blank', 'noopener,noreferrer');
        return { success: true };
      }
      return { success: false, error: 'Opening local paths is not available in browser mode.' };
    },
    async showItemInFolder(filePath) {
      return this.openPath(filePath);
    },
    async openExternal(url) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return { success: true };
    },
  },
  autoLaunch: {
    async get() {
      return { enabled: false };
    },
    async set() {
      return { success: false, error: 'Auto launch is not available in browser mode.' };
    },
  },
  appInfo: {
    async getVersion() {
      return `${packageJson.version}-web`;
    },
    async getSystemLocale() {
      return navigator.language || 'en-US';
    },
  },
  appUpdate: {
    async download(url) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return { success: false, error: 'Download is handled by the browser in web mode.' };
    },
    async cancelDownload() {
      return { success: true };
    },
    async install() {
      return { success: false, error: 'Install is not available in browser mode.' };
    },
    onDownloadProgress() {
      return noop;
    },
  },
  log: {
    async getPath() {
      return '/browser/logs';
    },
    async openFolder() {
      noop();
    },
    async exportZip() {
      return { success: false, error: 'Log export is not available in browser mode.' };
    },
  },
  im: {
    async getConfig() {
      return { success: true, config: getImConfig() };
    },
    async setConfig(config) {
      saveImConfig({ ...getImConfig(), ...config });
      return { success: true };
    },
    async startGateway() {
      return { success: false, error: 'IM gateways are not available in browser mode.' };
    },
    async stopGateway() {
      return { success: false, error: 'IM gateways are not available in browser mode.' };
    },
    async testGateway() {
      return { success: false, error: 'IM gateways are not available in browser mode.' };
    },
    async getStatus() {
      return { success: true, status: getImStatus() };
    },
    onStatusChange(callback) {
      return imStatusEmitter.on(callback);
    },
    onMessageReceived(callback) {
      return imMessageEmitter.on(callback);
    },
  },
  scheduledTasks: {
    async list() {
      return { success: true, tasks: getScheduledTasks() };
    },
    async get(id) {
      const task = getScheduledTasks().find((item) => item.id === id);
      return task ? { success: true, task } : { success: false, error: 'Task not found.' };
    },
    async create(input) {
      const task = {
        id: makeId('task'),
        ...input,
        enabled: input.enabled ?? true,
        state: 'idle',
        createdAt: now(),
        updatedAt: now(),
      };
      const tasks = [task, ...getScheduledTasks()];
      saveScheduledTasks(tasks);
      scheduledStatusEmitter.emit({ taskId: task.id, state: task.state });
      return { success: true, task };
    },
    async update(id, input) {
      let nextTask: any = null;
      const tasks = getScheduledTasks().map((task) => {
        if (task.id !== id) {
          return task;
        }
        nextTask = { ...task, ...input, updatedAt: now() };
        return nextTask;
      });
      saveScheduledTasks(tasks);
      return nextTask ? { success: true, task: nextTask } : { success: false, error: 'Task not found.' };
    },
    async delete(id) {
      const tasks = getScheduledTasks().filter((task) => task.id !== id);
      saveScheduledTasks(tasks);
      return { success: true };
    },
    async toggle(id, enabled) {
      let nextTask: any = null;
      const tasks = getScheduledTasks().map((task) => {
        if (task.id !== id) {
          return task;
        }
        nextTask = { ...task, enabled, updatedAt: now() };
        return nextTask;
      });
      saveScheduledTasks(tasks);
      return nextTask ? { success: true, task: nextTask } : { success: false, error: 'Task not found.' };
    },
    async runManually(id) {
      const run = { id: makeId('run'), taskId: id, status: 'completed', startedAt: now(), finishedAt: now(), output: 'Browser mode manual run.' };
      const runs = [run, ...getScheduledRuns()];
      saveScheduledRuns(runs);
      scheduledRunEmitter.emit({ run });
      return { success: true, run };
    },
    async stop() {
      return { success: true };
    },
    async listRuns(taskId, limit, offset) {
      const runs = getScheduledRuns().filter((run) => run.taskId === taskId);
      const start = offset ?? 0;
      const end = limit ? start + limit : undefined;
      return { success: true, runs: runs.slice(start, end) };
    },
    async countRuns(taskId) {
      return { success: true, count: getScheduledRuns().filter((run) => run.taskId === taskId).length };
    },
    async listAllRuns(limit, offset) {
      const runs = getScheduledRuns();
      const start = offset ?? 0;
      const end = limit ? start + limit : undefined;
      return { success: true, runs: runs.slice(start, end) };
    },
    onStatusUpdate(callback) {
      return scheduledStatusEmitter.on(callback);
    },
    onRunUpdate(callback) {
      return scheduledRunEmitter.on(callback);
    },
  },
  permissions: {
    async checkCalendar() {
      return { success: true, status: 'denied' };
    },
    async requestCalendar() {
      return { success: true, granted: false, status: 'denied' };
    },
  },
  networkStatus: {
    send() {
      noop();
    },
  },
};

if (!window.electron) {
  window.electron = mockApi;
}

export const electronApi = window.electron as IElectronAPI & { [MOCK_FLAG]?: true };
export const isWebMode = Boolean((window.electron as { [MOCK_FLAG]?: true } | undefined)?.[MOCK_FLAG]);

