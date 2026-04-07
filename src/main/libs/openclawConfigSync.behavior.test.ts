import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { OpenClawProviderId, ProviderName } from '../../shared/providers';
import type { Agent, CoworkConfig } from '../coworkStore';

let mockHomeDir = '';
let mockRawApiConfig: {
  config: { apiKey: string; baseURL: string; model: string; apiType: 'anthropic' | 'openai' };
  providerMetadata?: {
    providerName: string;
    codingPlanEnabled: boolean;
    supportsImage?: boolean;
    modelName?: string;
  };
} | { config: null; error?: string };
let mockEnabledProviders: Array<{
  providerName: string;
  baseURL: string;
  apiKey: string;
  apiType: 'anthropic' | 'openai';
  codingPlanEnabled: boolean;
  models: Array<{ id: string; name?: string; supportsImage?: boolean }>;
}> = [];

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => mockHomeDir,
    getAppPath: () => process.cwd(),
  },
}));

vi.mock('./claudeSettings', () => ({
  resolveRawApiConfig: () => mockRawApiConfig,
  resolveAllProviderApiKeys: () => ({}),
  resolveAllEnabledProviderConfigs: () => mockEnabledProviders,
  getAllServerModelMetadata: () => [],
}));

vi.mock('./openclawLocalExtensions', () => ({
  hasBundledOpenClawExtension: () => false,
}));

vi.mock('./openclawTokenProxy', () => ({
  getOpenClawTokenProxyPort: () => null,
}));

const { OpenClawConfigSync } = await import('./openclawConfigSync');

const createCoworkConfig = (workspaceDir: string): CoworkConfig => ({
  workingDirectory: workspaceDir,
  systemPrompt: '',
  executionMode: 'local',
  agentEngine: 'openclaw',
  memoryEnabled: true,
  memoryImplicitUpdateEnabled: true,
  memoryLlmJudgeEnabled: false,
  memoryGuardLevel: 'standard',
  memoryUserMemoriesMaxItems: 100,
});

const createSync = (tmpDir: string, agents: Agent[]) => {
  const workspaceDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  return new OpenClawConfigSync({
    engineManager: {
      getConfigPath: () => path.join(tmpDir, 'openclaw.json'),
      getStateDir: () => path.join(tmpDir, 'state'),
    } as any,
    getCoworkConfig: () => createCoworkConfig(workspaceDir),
    getTelegramOpenClawConfig: () => null,
    getDiscordOpenClawConfig: () => null,
    getDingTalkConfig: () => null,
    getFeishuConfig: () => null,
    getQQConfig: () => null,
    getWecomConfig: () => null,
    getPopoConfig: () => null,
    getNimConfig: () => null,
    getNeteaseBeeChanConfig: () => null,
    getWeixinConfig: () => null,
    getIMSettings: () => null,
    getMcpBridgeConfig: () => null,
    getSkillsList: () => [],
    getAgents: () => agents,
  });
};

const readJson = (filePath: string): any => JSON.parse(fs.readFileSync(filePath, 'utf8'));

describe('OpenClawConfigSync behavior', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-openclaw-sync-'));
    mockHomeDir = path.join(tmpDir, 'home');
    fs.mkdirSync(mockHomeDir, { recursive: true });
    mockRawApiConfig = {
      config: {
        apiKey: 'sk-default',
        baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
        model: 'doubao-seed-1-6-thinking',
        apiType: 'openai',
      },
      providerMetadata: {
        providerName: ProviderName.Volcengine,
        codingPlanEnabled: true,
      },
    };
    mockEnabledProviders = [
      {
        providerName: ProviderName.Volcengine,
        baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
        apiKey: 'sk-volc',
        apiType: 'openai',
        codingPlanEnabled: true,
        models: [{ id: 'doubao-seed-1-6-thinking', name: 'Doubao Thinking' }],
      },
      {
        providerName: ProviderName.Gemini,
        baseURL: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'sk-gemini',
        apiType: 'openai',
        codingPlanEnabled: false,
        models: [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }],
      },
    ];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test('writes per-agent model overrides into agents.list', () => {
    const sync = createSync(tmpDir, [{
      id: 'gemini-agent',
      name: 'Gemini Agent',
      description: '',
      systemPrompt: '',
      identity: '',
      model: 'gemini-2.5-flash',
      icon: '',
      skillIds: [],
      enabled: true,
      isDefault: false,
      source: 'custom',
      presetId: '',
      createdAt: 1,
      updatedAt: 1,
    }]);

    const result = sync.sync('test-agent-model');

    expect(result.ok).toBe(true);

    const config = readJson(path.join(tmpDir, 'openclaw.json'));
    const geminiAgent = config.agents.list.find((entry: { id: string }) => entry.id === 'gemini-agent');
    expect(geminiAgent?.model?.primary).toBe(`${OpenClawProviderId.Google}/gemini-2.5-flash`);
  });

  test('migrates managed session stores for every agent workspace', () => {
    const stateDir = path.join(tmpDir, 'state');
    const mainSessionsDir = path.join(stateDir, 'agents', 'main', 'sessions');
    const qaSessionsDir = path.join(stateDir, 'agents', 'qa-agent', 'sessions');
    fs.mkdirSync(mainSessionsDir, { recursive: true });
    fs.mkdirSync(qaSessionsDir, { recursive: true });

    const sessionStore = {
      'agent:main:lobsterai:session-1': {
        modelProvider: 'lobster',
        model: 'gemini-2.5-flash',
        systemPromptReport: {
          provider: 'lobster',
          model: 'gemini-2.5-flash',
        },
      },
    };
    fs.writeFileSync(path.join(mainSessionsDir, 'sessions.json'), `${JSON.stringify(sessionStore, null, 2)}\n`);
    fs.writeFileSync(path.join(qaSessionsDir, 'sessions.json'), `${JSON.stringify({
      'agent:qa-agent:lobsterai:session-2': {
        modelProvider: 'lobster',
        model: 'gemini-2.5-flash',
        systemPromptReport: {
          provider: 'lobster',
          model: 'gemini-2.5-flash',
        },
      },
    }, null, 2)}\n`);

    mockRawApiConfig = {
      config: {
        apiKey: 'sk-gemini',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta',
        model: 'gemini-2.5-flash',
        apiType: 'openai',
      },
      providerMetadata: {
        providerName: ProviderName.Gemini,
        codingPlanEnabled: false,
      },
    };

    const sync = createSync(tmpDir, [{
      id: 'qa-agent',
      name: 'QA Agent',
      description: '',
      systemPrompt: '',
      identity: '',
      model: '',
      icon: '',
      skillIds: [],
      enabled: true,
      isDefault: false,
      source: 'custom',
      presetId: '',
      createdAt: 1,
      updatedAt: 1,
    }]);

    const result = sync.sync('test-session-migration');

    expect(result.ok).toBe(true);

    const mainStore = readJson(path.join(mainSessionsDir, 'sessions.json'));
    const qaStore = readJson(path.join(qaSessionsDir, 'sessions.json'));

    expect(mainStore['agent:main:lobsterai:session-1'].modelProvider).toBe(OpenClawProviderId.Google);
    expect(qaStore['agent:qa-agent:lobsterai:session-2'].modelProvider).toBe(OpenClawProviderId.Google);
  });
});
