import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const originalModuleLoad = Module._load;
let currentAppPath = process.cwd();
let currentHomeDir = os.tmpdir();

Module._load = function patchedModuleLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getAppPath: () => currentAppPath,
        getPath: (name) => {
          if (name === 'home' || name === 'userData') {
            return currentHomeDir;
          }
          return currentHomeDir;
        },
      },
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const { setStoreGetter } = require('../dist-electron/main/libs/claudeSettings.js');
const { OpenClawConfigSync } = require('../dist-electron/main/libs/openclawConfigSync.js');

const setElectronPaths = (homeDir) => {
  currentAppPath = process.cwd();
  currentHomeDir = homeDir;
};

const restoreElectronPaths = () => {
  currentAppPath = process.cwd();
  currentHomeDir = os.tmpdir();
};

const createAppConfig = ({ codingPlanEnabled = false } = {}) => ({
  model: {
    defaultModel: 'kimi-k2.5',
    defaultModelProvider: 'moonshot',
  },
  providers: {
    moonshot: {
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://api.moonshot.cn/anthropic',
      apiFormat: 'anthropic',
      codingPlanEnabled,
      models: [
        { id: 'kimi-k2.5' },
      ],
    },
  },
});

const createOpenAICompatAppConfig = () => ({
  model: {
    defaultModel: 'kimi-k2.5',
    defaultModelProvider: 'openai',
  },
  providers: {
    openai: {
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      apiFormat: 'openai',
      models: [
        { id: 'kimi-k2.5' },
      ],
    },
  },
});

const createSessionStore = () => ({
  'agent:main:lobsterai:current-session': {
    sessionId: 'session-current',
    modelProvider: 'lobster',
    model: 'kimi-k2.5',
    systemPromptReport: {
      provider: 'lobster',
      model: 'kimi-k2.5',
    },
  },
  'agent:main:lobsterai:old-claude-session': {
    sessionId: 'session-old-claude',
    modelProvider: 'lobster',
    model: 'claude-sonnet-4-5-20250929',
    systemPromptReport: {
      provider: 'lobster',
      model: 'claude-sonnet-4-5-20250929',
    },
  },
  'agent:main:wecom:direct:wangning': {
    sessionId: 'session-wecom',
    execSecurity: 'full',
    skillsSnapshot: {
      prompt: '<skill><name>feishu-cron-reminder</name></skill>',
      resolvedSkills: [
        { name: 'feishu-cron-reminder' },
      ],
    },
  },
  'agent:main:feishu:dm:ou_123': {
    sessionId: 'session-feishu',
    skillsSnapshot: {
      resolvedSkills: [
        { name: 'qqbot-cron' },
      ],
    },
  },
});

const createSync = (tmpDir, appConfig, options = {}) => {
  setStoreGetter(() => ({
    get: (key) => (key === 'app_config' ? appConfig : null),
  }));

  return new OpenClawConfigSync({
    engineManager: {
      getConfigPath: () => path.join(tmpDir, 'state', 'openclaw.json'),
      getStateDir: () => path.join(tmpDir, 'state'),
      getGatewayToken: () => null,
    },
    getCoworkConfig: () => ({
      workingDirectory: options.workingDirectory ?? '',
      systemPrompt: options.systemPrompt ?? '',
      executionMode: options.executionMode ?? 'auto',
    }),
    getDingTalkInstances: () => options.dingTalkInstances ?? [],
    getFeishuInstances: () => options.feishuInstances ?? [],
    getQQInstances: () => options.qqInstances ?? [],
    getWecomConfig: () => null,
    getPopoConfig: () => options.popoConfig ?? null,
    getNimConfig: () => options.nimConfig ?? null,
    getSkillsPrompt: () => null,
  });
};

test.after(() => {
  restoreElectronPaths();
  setStoreGetter(() => null);
  Module._load = originalModuleLoad;
});

test('sync writes native moonshot provider config and migrates matching managed sessions', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-config-sync-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  setElectronPaths(tmpDir);

  const sessionsDir = path.join(tmpDir, 'state', 'agents', 'main', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, 'sessions.json'),
    `${JSON.stringify(createSessionStore(), null, 2)}\n`,
    'utf8',
  );

  const sync = createSync(tmpDir, createAppConfig());
  const result = sync.sync('test');

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);

  const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'state', 'openclaw.json'), 'utf8'));
  assert.equal(config.models.providers.moonshot.baseUrl, 'https://api.moonshot.cn/v1');
  assert.equal(config.models.providers.moonshot.api, 'openai-completions');
  assert.equal(config.agents.defaults.model.primary, 'moonshot/kimi-k2.5');
  assert.deepEqual(config.commands.ownerAllowFrom, ['gateway-client', '*']);
  assert.deepEqual(config.tools.deny, ['web_search']);
  assert.equal(config.tools.web.search.enabled, false);
  assert.equal(config.browser.enabled, true);

  const sessionStore = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'sessions.json'), 'utf8'));
  assert.equal(sessionStore['agent:main:lobsterai:current-session'].modelProvider, 'moonshot');
  assert.equal(sessionStore['agent:main:lobsterai:current-session'].model, 'kimi-k2.5');
  assert.equal(sessionStore['agent:main:lobsterai:current-session'].systemPromptReport.provider, 'moonshot');
  assert.equal(sessionStore['agent:main:lobsterai:old-claude-session'].modelProvider, 'lobster');
  assert.equal(sessionStore['agent:main:lobsterai:old-claude-session'].model, 'claude-sonnet-4-5-20250929');
  assert.equal(sessionStore['agent:main:wecom:direct:wangning'].execSecurity, 'deny');
  assert.equal(sessionStore['agent:main:feishu:dm:ou_123'].execSecurity, 'deny');
  assert.equal('skillsSnapshot' in sessionStore['agent:main:wecom:direct:wangning'], false);
  assert.equal('skillsSnapshot' in sessionStore['agent:main:feishu:dm:ou_123'], false);
});

test('sync maps moonshot coding plan sessions to kimi-coding model refs', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-config-sync-coding-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  setElectronPaths(tmpDir);

  const sessionsDir = path.join(tmpDir, 'state', 'agents', 'main', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, 'sessions.json'),
    `${JSON.stringify(createSessionStore(), null, 2)}\n`,
    'utf8',
  );

  const sync = createSync(tmpDir, createAppConfig({ codingPlanEnabled: true }));
  const result = sync.sync('test-coding-plan');

  assert.equal(result.ok, true);

  const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'state', 'openclaw.json'), 'utf8'));
  assert.equal(config.models.providers['kimi-coding'].baseUrl, 'https://api.kimi.com/coding');
  assert.equal(config.models.providers['kimi-coding'].api, 'anthropic-messages');
  assert.equal(config.agents.defaults.model.primary, 'kimi-coding/k2p5');
  assert.deepEqual(config.commands.ownerAllowFrom, ['gateway-client', '*']);

  const sessionStore = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'sessions.json'), 'utf8'));
  assert.equal(sessionStore['agent:main:lobsterai:current-session'].modelProvider, 'kimi-coding');
  assert.equal(sessionStore['agent:main:lobsterai:current-session'].model, 'k2p5');
  assert.equal(sessionStore['agent:main:lobsterai:current-session'].systemPromptReport.provider, 'kimi-coding');
  assert.equal(sessionStore['agent:main:lobsterai:current-session'].systemPromptReport.model, 'k2p5');
  assert.equal(sessionStore['agent:main:wecom:direct:wangning'].execSecurity, 'deny');
  assert.equal(sessionStore['agent:main:feishu:dm:ou_123'].execSecurity, 'deny');
  assert.equal('skillsSnapshot' in sessionStore['agent:main:wecom:direct:wangning'], false);
  assert.equal('skillsSnapshot' in sessionStore['agent:main:feishu:dm:ou_123'], false);
});

test('sync denies exec for native channel sessions even without provider migration', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-config-sync-native-session-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  setElectronPaths(tmpDir);

  const sessionsDir = path.join(tmpDir, 'state', 'agents', 'main', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, 'sessions.json'),
    `${JSON.stringify(createSessionStore(), null, 2)}\n`,
    'utf8',
  );

  const sync = createSync(tmpDir, createOpenAICompatAppConfig());
  const result = sync.sync('test-native-channel-session-policy');

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);

  const sessionStore = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'sessions.json'), 'utf8'));
  assert.equal(sessionStore['agent:main:lobsterai:current-session'].modelProvider, 'lobster');
  assert.equal(sessionStore['agent:main:lobsterai:current-session'].model, 'kimi-k2.5');
  assert.equal(sessionStore['agent:main:wecom:direct:wangning'].execSecurity, 'deny');
  assert.equal(sessionStore['agent:main:feishu:dm:ou_123'].execSecurity, 'deny');
  assert.equal('skillsSnapshot' in sessionStore['agent:main:wecom:direct:wangning'], false);
  assert.equal('skillsSnapshot' in sessionStore['agent:main:feishu:dm:ou_123'], false);
});

test('sync writes scheduled-task policy into managed AGENTS.md for native channel sessions', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-config-sync-agents-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  setElectronPaths(tmpDir);

  const workspaceDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const sync = createSync(tmpDir, createAppConfig(), {
    workingDirectory: workspaceDir,
    systemPrompt: 'Always answer in Chinese.',
  });
  const result = sync.sync('test-agents');

  assert.equal(result.ok, true);

  const agentsMd = fs.readFileSync(path.join(workspaceDir, 'AGENTS.md'), 'utf8');
  assert.match(agentsMd, /# AGENTS\.md - Your Workspace/);
  assert.match(agentsMd, /## Every Session/);
  assert.match(agentsMd, /Read `SOUL\.md`/);
  assert.match(agentsMd, /Read `USER\.md`/);
  assert.match(agentsMd, /main session.*read `MEMORY\.md`/is);
  assert.match(agentsMd, /## Scheduled Tasks/);
  assert.match(agentsMd, /## Web Search/);
  assert.match(agentsMd, /Built-in `web_search` is disabled in this workspace\./);
  assert.match(agentsMd, /use `web_fetch`/);
  assert.match(agentsMd, /use the built-in `browser` tool/);
  assert.match(agentsMd, /Native channel sessions may deny `exec`/);
  assert.match(agentsMd, /native `cron` tool/i);
  assert.match(agentsMd, /action: "add".*cron\.add/i);
  assert.match(agentsMd, /follow the native `cron` tool schema/i);
  assert.match(agentsMd, /plugins provide session context and outbound delivery; they do not own scheduling logic/i);
  assert.match(agentsMd, /ignore channel-specific reminder helpers or reminder skills/i);
  assert.match(agentsMd, /QQBOT_PAYLOAD/);
  assert.match(agentsMd, /QQBOT_CRON/);
  assert.match(agentsMd, /do not use `sessions_spawn`, `subagents`, or ad-hoc background workflows as a substitute for `cron\.add`/i);
  assert.match(agentsMd, /## System Prompt/);
  assert.match(agentsMd, /Always answer in Chinese\./);
});

test('sync preserves existing AGENTS.md content above the Lobster managed marker', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-config-sync-agents-preserve-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  setElectronPaths(tmpDir);

  const workspaceDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, 'AGENTS.md'),
    '# Custom Workspace Notes\n\nKeep this line.\n',
    'utf8',
  );

  const sync = createSync(tmpDir, createAppConfig(), {
    workingDirectory: workspaceDir,
  });
  const result = sync.sync('test-agents-preserve');

  assert.equal(result.ok, true);

  const agentsMd = fs.readFileSync(path.join(workspaceDir, 'AGENTS.md'), 'utf8');
  assert.match(agentsMd, /^# Custom Workspace Notes\n\nKeep this line\./);
  assert.match(agentsMd, /<!-- LobsterAI managed: do not edit below this line -->/);
  assert.doesNotMatch(agentsMd, /^# AGENTS\.md - Your Workspace/m);
});

test('sync backfills the default OpenClaw AGENTS template when an old workspace only has Lobster managed content', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-config-sync-agents-backfill-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  setElectronPaths(tmpDir);

  const workspaceDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, 'AGENTS.md'),
    [
      '<!-- LobsterAI managed: do not edit below this line -->',
      '',
      '## System Prompt',
      '',
      'Old managed-only content.',
      '',
    ].join('\n'),
    'utf8',
  );

  const sync = createSync(tmpDir, createAppConfig(), {
    workingDirectory: workspaceDir,
  });
  const result = sync.sync('test-agents-backfill');

  assert.equal(result.ok, true);

  const agentsMd = fs.readFileSync(path.join(workspaceDir, 'AGENTS.md'), 'utf8');
  assert.match(agentsMd, /^# AGENTS\.md - Your Workspace/m);
  assert.match(agentsMd, /## Every Session/);
  assert.match(agentsMd, /<!-- LobsterAI managed: do not edit below this line -->/);
  assert.match(agentsMd, /## Scheduled Tasks/);
  assert.doesNotMatch(agentsMd, /Old managed-only content\./);
});

test('sync disables legacy qqbot-cron skill so QQ reminders use native cron', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-config-sync-qq-skill-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  setElectronPaths(tmpDir);

  const sync = createSync(tmpDir, createAppConfig(), {
    qqInstances: [{
      instanceId: 'default',
      instanceName: 'Default',
      enabled: true,
      appId: 'qq-app-id',
      appSecret: 'qq-app-secret',
      dmPolicy: 'open',
      allowFrom: [],
      groupPolicy: 'open',
      groupAllowFrom: [],
      historyLimit: 50,
      markdownSupport: true,
      imageServerBaseUrl: '',
      debug: false,
    }],
  });
  const result = sync.sync('test-qq-native-cron');

  assert.equal(result.ok, true);

  const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'state', 'openclaw.json'), 'utf8'));
  assert.equal(config.channels.qqbot.enabled, true);
  assert.equal(config.skills.entries['qqbot-cron'].enabled, false);
  assert.equal(config.skills.entries['feishu-cron-reminder'].enabled, false);
  assert.equal(config.cron.enabled, true);
});

test('sync disables legacy reminder skills so native IM sessions use built-in cron', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-config-sync-reminder-skills-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  setElectronPaths(tmpDir);

  const sync = createSync(tmpDir, createAppConfig());
  const result = sync.sync('test-native-im-reminder-skills');

  assert.equal(result.ok, true);

  const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'state', 'openclaw.json'), 'utf8'));
  assert.equal(config.skills.entries['qqbot-cron'].enabled, false);
  assert.equal(config.skills.entries['feishu-cron-reminder'].enabled, false);
});

test('sync writes non-empty placeholder apiKey for providers that do not require auth (e.g. Ollama)', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-config-sync-empty-key-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  setElectronPaths(tmpDir);

  const ollamaAppConfig = {
    model: {
      defaultModel: 'llama3',
      defaultModelProvider: 'ollama',
    },
    providers: {
      ollama: {
        enabled: true,
        apiKey: '',
        baseUrl: 'http://localhost:11434/v1',
        apiFormat: 'openai',
        models: [
          { id: 'llama3' },
        ],
      },
    },
  };

  const sync = createSync(tmpDir, ollamaAppConfig);
  const result = sync.sync('test-empty-key');

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);

  const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'state', 'openclaw.json'), 'utf8'));
  const providerConfig = config.models.providers.lobster;
  assert.ok(providerConfig, 'lobster provider should exist in config');
  assert.ok(providerConfig.apiKey, 'apiKey must be a non-empty string');
  assert.equal(providerConfig.apiKey, 'sk-lobsterai-local');
});
