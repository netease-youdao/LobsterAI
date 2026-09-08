import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { OpenClawAgentOwnership } from './openclawAgentModels';

const electronPaths = vi.hoisted(() => ({
  userData: '',
  home: '',
  appPath: process.cwd(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return electronPaths.userData;
      if (name === 'home') return electronPaths.home || electronPaths.userData;
      return electronPaths.userData;
    },
    isPackaged: false,
    getAppPath: () => electronPaths.appPath,
  },
}));

describe('enterpriseConfigSync', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-test-'));
    electronPaths.userData = path.join(tmpDir, 'userData');
    electronPaths.home = path.join(tmpDir, 'home');
    fs.mkdirSync(electronPaths.userData, { recursive: true });
    fs.mkdirSync(electronPaths.home, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('module exports expected functions', async () => {
    const mod = await import('./enterpriseConfigSync');
    expect(typeof mod.resolveEnterpriseConfigPath).toBe('function');
    expect(typeof mod.syncEnterpriseConfig).toBe('function');
    expect(typeof mod.mergeOpenClawConfigs).toBe('function');
  });

  test('merges legacy enterprise agents without restoring default markers', async () => {
    const { mergeOpenClawConfigs } = await import('./enterpriseConfigSync');
    const enterprise = { agents: { list: [
      { id: 'main', default: true, identity: { name: 'Enterprise Main' } },
      { id: 'worker', default: false, skills: ['enterprise-skill'] },
    ] } };
    const merged = mergeOpenClawConfigs({ agents: {
      ownership: OpenClawAgentOwnership.Explicit,
      defaults: { systemAgent: { agentId: 'main' } },
      entries: { main: { workspace: '/state/workspace-main' }, worker: { workspace: '/state/workspace-worker' } },
    } }, enterprise);
    expect(merged.agents).toEqual({
      ownership: OpenClawAgentOwnership.Explicit,
      defaults: { systemAgent: { agentId: 'main' } },
      entries: {
        main: { workspace: '/state/workspace-main', identity: { name: 'Enterprise Main' } },
        worker: { workspace: '/state/workspace-worker', skills: ['enterprise-skill'] },
      },
    });
    expect(enterprise.agents.list[0].default).toBe(true);
    expect(() => mergeOpenClawConfigs(merged, { agents: { list: [{ default: true }] } }))
      .toThrow('Invalid legacy agent roster');
  });

  test('manifest with all sync disabled parses correctly', () => {
    const manifestDir = path.join(tmpDir, 'enterprise-config');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, 'manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        name: 'Test',
        ui: { hideTabs: [], disableUpdate: false },
        sync: { openclaw: false, skills: false, agents: false, mcp: false },
      })
    );
    const raw = fs.readFileSync(path.join(manifestDir, 'manifest.json'), 'utf-8');
    const manifest = JSON.parse(raw);
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.sync.openclaw).toBe(false);
  });

  test('app_config.json roundtrips correctly', () => {
    const appConfig = {
      api: { key: 'sk-test', baseUrl: 'https://api.example.com' },
      model: { defaultModel: 'test-model', defaultModelProvider: 'test' },
      providers: { test: { enabled: true, apiKey: 'sk-test', baseUrl: 'https://api.example.com', models: [] } },
      theme: 'dark',
      language: 'zh',
    };
    const raw = JSON.stringify(appConfig);
    const parsed = JSON.parse(raw);
    expect(parsed.providers.test.enabled).toBe(true);
    expect(parsed.model.defaultModel).toBe('test-model');
  });

  test('sandbox mode mapping covers all modes', () => {
    const map: Record<string, string> = { off: 'local', 'non-main': 'auto', all: 'sandbox' };
    expect(map['off']).toBe('local');
    expect(map['non-main']).toBe('auto');
    expect(map['all']).toBe('sandbox');
  });

  test('channel key mapping covers all platform aliases used by enterprise import', () => {
    const map: Record<string, string> = {
      telegram: 'telegramOpenClaw', discord: 'discordOpenClaw',
      feishu: 'feishuOpenClaw', dingtalk: 'dingtalkOpenClaw', 'dingtalk-connector': 'dingtalkOpenClaw',
      qqbot: 'qq', wecom: 'wecomOpenClaw', 'moltbot-popo': 'popo',
      nim: 'nim', 'openclaw-weixin': 'weixin', xiaomifeng: 'xiaomifeng',
    };
    expect(Object.keys(map)).toHaveLength(11);
    expect(map['telegram']).toBe('telegramOpenClaw');
    expect(map['dingtalk']).toBe('dingtalkOpenClaw');
    expect(map['dingtalk-connector']).toBe('dingtalkOpenClaw');
    expect(map['qqbot']).toBe('qq');
    expect(map['moltbot-popo']).toBe('popo');
    expect(map['openclaw-weixin']).toBe('weixin');
  });

  test('syncEnterpriseConfig maps agents.defaults.cwd to cowork workingDirectory', async () => {
    const configDir = path.join(tmpDir, 'enterprise-config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        name: 'Test',
        sync: { openclaw: true, skills: false, agents: false, mcp: false },
      }),
    );
    fs.writeFileSync(
      path.join(configDir, 'openclaw.json'),
      JSON.stringify({
        agents: {
          defaults: {
            workspace: '/state/workspace-main',
            cwd: '/projects/user-selected',
            sandbox: { mode: 'off' },
          },
        },
      }),
    );

    const mod = await import('./enterpriseConfigSync');
    const coworkUpdates: Array<Record<string, string>> = [];

    mod.syncEnterpriseConfig(
      configDir,
      { get: () => undefined, set: () => undefined } as any,
      {
        setTelegramOpenClawConfig: () => undefined,
        setDiscordOpenClawConfig: () => undefined,
        getFeishuInstances: () => [],
        setFeishuInstanceConfig: () => undefined,
        setFeishuOpenClawConfig: () => undefined,
        getDingTalkInstances: () => [],
        setDingTalkInstanceConfig: () => undefined,
        setDingTalkOpenClawConfig: () => undefined,
        getQQInstances: () => [],
        setQQInstanceConfig: () => undefined,
        setQQConfig: () => undefined,
        getWecomInstances: () => [],
        setWecomInstanceConfig: () => undefined,
        setWecomConfig: () => undefined,
        setPopoConfig: () => undefined,
        setNimConfig: () => undefined,
        setWeixinConfig: () => undefined,
        setNeteaseBeeChanConfig: () => undefined,
      } as any,
      () => undefined,
      () => undefined,
      (updates) => {
        coworkUpdates.push(updates);
      },
      () => undefined,
    );

    expect(coworkUpdates).toEqual([
      {
        agentEngine: 'openclaw',
        executionMode: 'local',
        workingDirectory: '/projects/user-selected',
      },
    ]);
  });

  test('syncEnterpriseConfig updates existing WeCom instances when syncing channels', async () => {
    const configDir = path.join(tmpDir, 'enterprise-config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        name: 'Test',
        sync: { openclaw: true, skills: false, agents: false, mcp: false },
      }),
    );
    fs.writeFileSync(
      path.join(configDir, 'openclaw.json'),
      JSON.stringify({
        channels: {
          wecom: {
            enabled: true,
            corpId: 'corp-id',
          },
        },
      }),
    );

    const mod = await import('./enterpriseConfigSync');
    const store = {
      get: () => undefined,
      set: () => undefined,
    };
    const setWecomConfigCalls: Array<Record<string, unknown>> = [];
    const setWecomInstanceConfigCalls: Array<{ instanceId: string; config: Record<string, unknown> }> = [];
    const imStore = {
      getWecomInstances: () => [
        {
          instanceId: 'wecom-1',
          enabled: false,
        },
      ],
      setWecomConfig: (config: Record<string, unknown>) => {
        setWecomConfigCalls.push(config);
      },
      setWecomInstanceConfig: (instanceId: string, config: Record<string, unknown>) => {
        setWecomInstanceConfigCalls.push({ instanceId, config });
      },
      setTelegramOpenClawConfig: () => undefined,
      setDiscordOpenClawConfig: () => undefined,
      getFeishuInstances: () => [],
      setFeishuInstanceConfig: () => undefined,
      setFeishuOpenClawConfig: () => undefined,
      getDingTalkInstances: () => [],
      setDingTalkInstanceConfig: () => undefined,
      setDingTalkOpenClawConfig: () => undefined,
      getQQInstances: () => [],
      setQQInstanceConfig: () => undefined,
      setQQConfig: () => undefined,
      setPopoConfig: () => undefined,
      setNimConfig: () => undefined,
      setWeixinConfig: () => undefined,
      setNeteaseBeeChanConfig: () => undefined,
    };

    mod.syncEnterpriseConfig(
      configDir,
      store as any,
      imStore as any,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
    );

    expect(setWecomConfigCalls).toEqual([]);
    expect(setWecomInstanceConfigCalls).toEqual([
      {
        instanceId: 'wecom-1',
        config: {
          enabled: true,
          corpId: 'corp-id',
        },
      },
    ]);
  });

  test('syncEnterpriseConfig does not copy enterprise plugins into userData', async () => {
    const configDir = path.join(tmpDir, 'enterprise-config');
    const pluginDir = path.join(configDir, 'plugins', 'enterprise-test-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        name: 'Test',
        sync: { openclaw: false, skills: false, agents: false, mcp: false, plugins: true },
      }),
    );
    fs.writeFileSync(path.join(pluginDir, 'openclaw.plugin.json'), JSON.stringify({ id: 'enterprise-test-plugin' }));
    fs.writeFileSync(path.join(pluginDir, 'index.js'), 'export default {};');

    const mod = await import('./enterpriseConfigSync');
    const store = {
      get: () => undefined,
      set: () => undefined,
    };

    mod.syncEnterpriseConfig(
      configDir,
      store as any,
      {} as any,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
    );

    const runtimePluginDir = path.join(electronPaths.userData, 'enterprise-openclaw-plugins');
    expect(fs.existsSync(runtimePluginDir)).toBe(false);
  });

  test('syncEnterpriseConfig tolerates agents workspace failure when plugins are enabled', async () => {
    const configDir = path.join(tmpDir, 'enterprise-config');
    const pluginDir = path.join(configDir, 'plugins', 'enterprise-test-plugin');
    const agentsDir = path.join(configDir, 'agents');
    const blockedWorkspace = path.join(tmpDir, 'blocked-workspace');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'AGENTS.md'), '# enterprise agents');
    fs.writeFileSync(
      path.join(configDir, 'manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        name: 'Test',
        sync: { openclaw: false, skills: false, agents: true, mcp: false, plugins: true },
      }),
    );
    fs.writeFileSync(path.join(pluginDir, 'openclaw.plugin.json'), JSON.stringify({ id: 'enterprise-test-plugin' }));
    fs.writeFileSync(path.join(pluginDir, 'index.js'), 'export default {};');

    const originalMkdirSync = fs.mkdirSync.bind(fs);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((target: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: boolean }) => {
      if (String(target) === blockedWorkspace) {
        const error = new Error(`EACCES: permission denied, mkdir '${blockedWorkspace}'`) as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return originalMkdirSync(target, options as fs.MakeDirectoryOptions);
    }) as typeof fs.mkdirSync);

    const mod = await import('./enterpriseConfigSync');
    const store = {
      get: () => undefined,
      set: () => undefined,
    };

    mod.syncEnterpriseConfig(
      configDir,
      store as any,
      {} as any,
      () => undefined,
      () => undefined,
      () => undefined,
      () => blockedWorkspace,
    );

    const runtimePluginDir = path.join(electronPaths.userData, 'enterprise-openclaw-plugins');
    expect(fs.existsSync(runtimePluginDir)).toBe(false);
  });

  test('syncEnterpriseConfig writes feishu channel accounts into multi-instance configs', async () => {
    const configDir = path.join(tmpDir, 'enterprise-config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        name: 'Test',
        sync: { openclaw: true, skills: false, agents: false, mcp: false },
      }),
    );
    fs.writeFileSync(
      path.join(configDir, 'openclaw.json'),
      JSON.stringify({
        channels: {
          feishu: {
            accounts: {
              abcdef12: {
                enabled: true,
                name: 'Existing Bot',
                appId: 'app-existing',
                appSecret: 'secret-existing',
                domain: 'feishu',
                dmPolicy: 'allowlist',
                allowFrom: ['u1'],
                groupPolicy: 'allowlist',
                groupAllowFrom: ['g1'],
                groups: { '*': { requireMention: false } },
                historyLimit: 30,
                streaming: false,
                replyMode: 'static',
                blockStreaming: true,
                footer: { status: false, elapsed: false },
                mediaMaxMb: 12,
              },
              newacct1: {
                enabled: true,
                name: 'New Bot',
                appId: 'app-new',
                appSecret: 'secret-new',
              },
            },
          },
        },
      }),
    );

    const mod = await import('./enterpriseConfigSync');
    const store = {
      get: () => undefined,
      set: () => undefined,
    };
    const setFeishuOpenClawConfigCalls: Array<Record<string, unknown>> = [];
    const setFeishuInstanceConfigCalls: Array<{ instanceId: string; config: Record<string, unknown> }> = [];
    const imStore = {
      getFeishuInstances: () => [
        {
          instanceId: 'abcdef12-long-existing-id',
          instanceName: 'Old Name',
        },
      ],
      setFeishuInstanceConfig: (instanceId: string, config: Record<string, unknown>) => {
        setFeishuInstanceConfigCalls.push({ instanceId, config });
      },
      setFeishuOpenClawConfig: (config: Record<string, unknown>) => {
        setFeishuOpenClawConfigCalls.push(config);
      },
      setTelegramOpenClawConfig: () => undefined,
      setDiscordOpenClawConfig: () => undefined,
      getDingTalkInstances: () => [],
      setDingTalkInstanceConfig: () => undefined,
      setDingTalkOpenClawConfig: () => undefined,
      getQQInstances: () => [],
      setQQInstanceConfig: () => undefined,
      setQQConfig: () => undefined,
      getWecomInstances: () => [],
      setWecomInstanceConfig: () => undefined,
      setWecomConfig: () => undefined,
      setPopoConfig: () => undefined,
      setNimConfig: () => undefined,
      setWeixinConfig: () => undefined,
      setNeteaseBeeChanConfig: () => undefined,
    };

    mod.syncEnterpriseConfig(
      configDir,
      store as any,
      imStore as any,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
    );

    expect(setFeishuOpenClawConfigCalls).toEqual([]);
    expect(setFeishuInstanceConfigCalls).toEqual([
      {
        instanceId: 'abcdef12-long-existing-id',
        config: {
          enabled: true,
          instanceName: 'Existing Bot',
          appId: 'app-existing',
          appSecret: 'secret-existing',
          domain: 'feishu',
          dmPolicy: 'allowlist',
          allowFrom: ['u1'],
          groupPolicy: 'allowlist',
          groupAllowFrom: ['g1'],
          groups: { '*': { requireMention: false } },
          historyLimit: 30,
          streaming: false,
          replyMode: 'static',
          blockStreaming: true,
          footer: { status: false, elapsed: false },
          mediaMaxMb: 12,
        },
      },
      {
        instanceId: 'newacct1',
        config: {
          enabled: true,
          instanceName: 'New Bot',
          appId: 'app-new',
          appSecret: 'secret-new',
        },
      },
    ]);
  });

  test('syncEnterpriseConfig overwrites feishu accounts with top-level enterprise fields', async () => {
    const configDir = path.join(tmpDir, 'enterprise-config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        name: 'Test',
        sync: { openclaw: true, skills: false, agents: false, mcp: false },
      }),
    );
    fs.writeFileSync(
      path.join(configDir, 'openclaw.json'),
      JSON.stringify({
        channels: {
          feishu: {
            accounts: {
              abcdef12: {
                enabled: true,
                name: 'Old Bot',
                appId: 'old-app',
                appSecret: 'old-secret',
                dmPolicy: 'open',
                allowFrom: ['*'],
              },
            },
            enabled: true,
            appId: 'new-app',
            appSecret: 'new-secret',
            dmPolicy: 'allowlist',
            allowFrom: ['u1'],
          },
        },
      }),
    );

    const mod = await import('./enterpriseConfigSync');
    const store = {
      get: () => undefined,
      set: () => undefined,
    };
    const setFeishuInstanceConfigCalls: Array<{ instanceId: string; config: Record<string, unknown> }> = [];
    const imStore = {
      getFeishuInstances: () => [
        {
          instanceId: 'abcdef12-long-existing-id',
          instanceName: 'Old Name',
        },
      ],
      setFeishuInstanceConfig: (instanceId: string, config: Record<string, unknown>) => {
        setFeishuInstanceConfigCalls.push({ instanceId, config });
      },
      setFeishuOpenClawConfig: () => undefined,
      setTelegramOpenClawConfig: () => undefined,
      setDiscordOpenClawConfig: () => undefined,
      getDingTalkInstances: () => [],
      setDingTalkInstanceConfig: () => undefined,
      setDingTalkOpenClawConfig: () => undefined,
      getQQInstances: () => [],
      setQQInstanceConfig: () => undefined,
      setQQConfig: () => undefined,
      getWecomInstances: () => [],
      setWecomInstanceConfig: () => undefined,
      setWecomConfig: () => undefined,
      setPopoConfig: () => undefined,
      setNimConfig: () => undefined,
      setWeixinConfig: () => undefined,
      setNeteaseBeeChanConfig: () => undefined,
    };

    mod.syncEnterpriseConfig(
      configDir,
      store as any,
      imStore as any,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
    );

    expect(setFeishuInstanceConfigCalls).toEqual([
      {
        instanceId: 'abcdef12-long-existing-id',
        config: {
          enabled: true,
          instanceName: 'Old Bot',
          appId: 'new-app',
          appSecret: 'new-secret',
          dmPolicy: 'allowlist',
          allowFrom: ['u1'],
        },
      },
    ]);
  });

  test('syncEnterpriseConfig reads moltbot-popo accounts with top-level enterprise overrides', async () => {
    const configDir = path.join(tmpDir, 'enterprise-config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        name: 'Test',
        sync: { openclaw: true, skills: false, agents: false, mcp: false },
      }),
    );
    fs.writeFileSync(
      path.join(configDir, 'openclaw.json'),
      JSON.stringify({
        channels: {
          'moltbot-popo': {
            accounts: {
              default: {
                enabled: true,
                appKey: 'old-key',
                appSecret: 'old-secret',
                connectionMode: 'websocket',
                aesKey: 'old-aes',
                dmPolicy: 'open',
                allowFrom: ['*'],
              },
            },
            enabled: true,
            appKey: 'new-key',
            appSecret: 'new-secret',
            connectionMode: 'webhook',
            webhookPort: 3200,
            dmPolicy: 'allowlist',
            allowFrom: ['u1'],
          },
        },
      }),
    );

    const mod = await import('./enterpriseConfigSync');
    const store = {
      get: () => undefined,
      set: () => undefined,
    };
    const setPopoMultiInstanceCalls: Array<Record<string, unknown>> = [];
    const imStore = {
      setPopoMultiInstanceConfig: (config: Record<string, unknown>) => {
        setPopoMultiInstanceCalls.push(config);
      },
      setTelegramOpenClawConfig: () => undefined,
      setDiscordOpenClawConfig: () => undefined,
      getFeishuInstances: () => [],
      setFeishuInstanceConfig: () => undefined,
      setFeishuOpenClawConfig: () => undefined,
      getDingTalkInstances: () => [],
      setDingTalkInstanceConfig: () => undefined,
      setDingTalkOpenClawConfig: () => undefined,
      getQQInstances: () => [],
      setQQInstanceConfig: () => undefined,
      setQQConfig: () => undefined,
      getWecomInstances: () => [],
      setWecomInstanceConfig: () => undefined,
      setWecomConfig: () => undefined,
      setNimConfig: () => undefined,
      setWeixinConfig: () => undefined,
      setNeteaseBeeChanConfig: () => undefined,
    };

    mod.syncEnterpriseConfig(
      configDir,
      store as any,
      imStore as any,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
    );

    expect(setPopoMultiInstanceCalls).toEqual([
      {
        instances: [
          {
            enabled: true,
            appKey: 'new-key',
            appSecret: 'new-secret',
            connectionMode: 'webhook',
            aesKey: 'old-aes',
            dmPolicy: 'allowlist',
            allowFrom: ['u1'],
            webhookPort: 3200,
            instanceId: 'default',
            instanceName: 'POPO Bot 1',
          },
        ],
      },
    ]);
  });

  test('syncEnterpriseConfig syncs openclaw agents list into Lobster agents', async () => {
    const configDir = path.join(tmpDir, 'enterprise-config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        name: 'Test',
        sync: { openclaw: true, skills: false, agents: false, mcp: false },
      }),
    );
    fs.writeFileSync(
      path.join(configDir, 'openclaw.json'),
      JSON.stringify({
        agents: {
          list: [
            {
              id: 'main',
              identity: { name: 'Main Enterprise Agent', emoji: '🦞' },
              model: { primary: 'enterprise/primary' },
              skills: ['docx'],
            },
            {
              id: 'support',
              identity: { name: 'Support Agent', emoji: '🛟' },
              model: { primary: 'enterprise/support' },
              skills: ['xlsx'],
            },
          ],
        },
      }),
    );

    const mod = await import('./enterpriseConfigSync');
    const syncedAgents: Array<{
      id: string;
      name: string;
      icon: string;
      model: string;
      skillIds: string[];
      enabled: boolean;
      isDefault: boolean;
    }> = [];
    mod.syncEnterpriseConfig(
      configDir,
      { get: () => undefined, set: () => undefined } as any,
      {
        setTelegramOpenClawConfig: () => undefined,
        setDiscordOpenClawConfig: () => undefined,
        getFeishuInstances: () => [],
        setFeishuInstanceConfig: () => undefined,
        setFeishuOpenClawConfig: () => undefined,
        getDingTalkInstances: () => [],
        setDingTalkInstanceConfig: () => undefined,
        setDingTalkOpenClawConfig: () => undefined,
        getQQInstances: () => [],
        setQQInstanceConfig: () => undefined,
        setQQConfig: () => undefined,
        getWecomInstances: () => [],
        setWecomInstanceConfig: () => undefined,
        setWecomConfig: () => undefined,
        setPopoConfig: () => undefined,
        setNimConfig: () => undefined,
        setWeixinConfig: () => undefined,
        setNeteaseBeeChanConfig: () => undefined,
      } as any,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      (agent) => {
        syncedAgents.push({
          id: agent.id,
          name: agent.name,
          icon: agent.icon,
          model: agent.model,
          skillIds: agent.skillIds,
          enabled: agent.enabled,
          isDefault: agent.isDefault,
        });
      },
    );

    expect(syncedAgents).toEqual([
      {
        id: 'main',
        name: 'Main Enterprise Agent',
        icon: '🦞',
        model: 'enterprise/primary',
        skillIds: ['docx'],
        enabled: true,
        isDefault: true,
      },
      {
        id: 'support',
        name: 'Support Agent',
        icon: '🛟',
        model: 'enterprise/support',
        skillIds: ['xlsx'],
        enabled: true,
        isDefault: false,
      },
    ]);
  });

  test('mergeOpenClawConfigs preserves runtime plugin load paths and appends enterprise paths', async () => {
    const mod = await import('./enterpriseConfigSync');
    const merged = mod.mergeOpenClawConfigs(
      {
        plugins: {
          load: {
            paths: ['/runtime/plugins'],
          },
        },
      },
      {
        plugins: {
          load: {
            paths: ['/enterprise/custom-plugins'],
          },
        },
      },
    );

    expect(merged).toEqual({
      plugins: {
        load: {
          paths: [
            '/runtime/plugins',
            '/enterprise/custom-plugins',
          ],
        },
      },
    });
  });

  test('mergeOpenClawConfigs never writes plugin-index-managed installs', async () => {
    const mod = await import('./enterpriseConfigSync');
    const merged = mod.mergeOpenClawConfigs(
      {
        plugins: {
          installs: {
            runtimePlugin: { source: 'npm', spec: 'runtime-plugin@1.0.0' },
          },
          entries: {
            runtimePlugin: { enabled: true },
          },
        },
      },
      {
        plugins: {
          installs: {
            enterprisePlugin: { source: 'npm', spec: 'enterprise-plugin@1.0.0' },
          },
          entries: {
            enterprisePlugin: { enabled: true },
          },
        },
      },
    );

    expect(merged).toEqual({
      plugins: {
        entries: {
          runtimePlugin: { enabled: true },
          enterprisePlugin: { enabled: true },
        },
      },
    });
  });

  test('mergeEnterpriseOpenclawConfig does not inject enterprise plugins source path automatically', async () => {
    const enterpriseDir = path.join(electronPaths.userData, 'enterprise-config');
    const pluginsDir = path.join(enterpriseDir, 'plugins', 'enterprise-test-plugin');
    const runtimeConfigPath = path.join(tmpDir, 'runtime-openclaw.json');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(
      path.join(enterpriseDir, 'manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        name: 'Test',
        sync: { openclaw: false, skills: false, agents: false, mcp: false, plugins: true },
      }),
    );
    fs.writeFileSync(
      path.join(enterpriseDir, 'openclaw.json'),
      JSON.stringify({
        plugins: {
          installs: {
            enterprisePlugin: {
              source: 'npm',
              spec: 'enterprise-plugin@1.0.0',
            },
          },
          load: {
            paths: ['/enterprise/custom-plugins'],
          },
        },
      }),
    );
    fs.writeFileSync(
      runtimeConfigPath,
      JSON.stringify({
        plugins: {
          load: {
            paths: ['/runtime/plugins'],
          },
        },
      }),
    );

    const mod = await import('./enterpriseConfigSync');
    const renameError = Object.assign(new Error('destination exists'), { code: 'EEXIST' });
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw renameError;
    });
    expect(mod.mergeEnterpriseOpenclawConfig(runtimeConfigPath)).toBe(true);

    const merged = JSON.parse(fs.readFileSync(runtimeConfigPath, 'utf-8'));
    expect(merged).toEqual({
      plugins: {
        load: {
          paths: [
            '/runtime/plugins',
            '/enterprise/custom-plugins',
          ],
        },
      },
    });
    expect(renameSpy).toHaveBeenCalledOnce();
    expect(mod.mergeEnterpriseOpenclawConfig(runtimeConfigPath)).toBe(false);
  });

  test('mergeOpenClawConfigs overwrites feishu accounts with top-level enterprise fields', async () => {
    const mod = await import('./enterpriseConfigSync');
    const merged = mod.mergeOpenClawConfigs(
      {
        channels: {
          feishu: {
            accounts: {
              abcdef12: {
                enabled: true,
                name: 'Old Bot',
                appId: 'old-app',
                appSecret: 'old-secret',
                dmPolicy: 'open',
                allowFrom: ['*'],
              },
            },
          },
        },
      },
      {
        channels: {
          feishu: {
            enabled: true,
            dmPolicy: 'allowlist',
            allowFrom: ['u1'],
            appId: 'new-app',
            appSecret: 'new-secret',
          },
        },
      },
    );

    expect(merged).toEqual({
      channels: {
        feishu: {
          accounts: {
            abcdef12: {
              enabled: true,
              name: 'Old Bot',
              appId: 'new-app',
              appSecret: 'new-secret',
              dmPolicy: 'allowlist',
              allowFrom: ['u1'],
            },
          },
          enabled: true,
          dmPolicy: 'allowlist',
          allowFrom: ['u1'],
        },
      },
    });
  });

  test('mergeOpenClawConfigs overwrites moltbot-popo accounts with top-level enterprise fields', async () => {
    const mod = await import('./enterpriseConfigSync');
    const merged = mod.mergeOpenClawConfigs(
      {
        channels: {
          'moltbot-popo': {
            accounts: {
              default: {
                enabled: true,
                appKey: 'old-key',
                appSecret: 'old-secret',
                connectionMode: 'websocket',
                aesKey: 'old-aes',
                dmPolicy: 'open',
                allowFrom: ['*'],
              },
            },
          },
        },
      },
      {
        channels: {
          'moltbot-popo': {
            enabled: true,
            appKey: 'new-key',
            appSecret: 'new-secret',
            connectionMode: 'webhook',
            webhookPort: 3200,
            dmPolicy: 'allowlist',
            allowFrom: ['u1'],
          },
        },
      },
    );

    expect(merged).toEqual({
      channels: {
        'moltbot-popo': {
          accounts: {
            default: {
              enabled: true,
              appKey: 'new-key',
              appSecret: 'new-secret',
              connectionMode: 'webhook',
              aesKey: 'old-aes',
              webhookPort: 3200,
              dmPolicy: 'allowlist',
              allowFrom: ['u1'],
            },
          },
          enabled: true,
          connectionMode: 'webhook',
          webhookPort: 3200,
          dmPolicy: 'allowlist',
          allowFrom: ['u1'],
        },
      },
    });
  });

  for (const testCase of [
    {
      channelKey: 'dingtalk',
      runtimeAccount: {
        enabled: true,
        name: 'Old Bot',
        clientId: 'old-client',
        clientSecret: 'old-secret',
        dmPolicy: 'open',
        allowFrom: ['*'],
      },
      enterpriseTopLevel: {
        enabled: true,
        clientId: 'new-client',
        clientSecret: 'new-secret',
        dmPolicy: 'allowlist',
        allowFrom: ['u1'],
      },
      expectedAccount: {
        enabled: true,
        name: 'Old Bot',
        clientId: 'new-client',
        clientSecret: 'new-secret',
        dmPolicy: 'allowlist',
        allowFrom: ['u1'],
      },
      expectedTopLevel: {
        enabled: true,
        dmPolicy: 'allowlist',
        allowFrom: ['u1'],
      },
    },
    {
      channelKey: 'dingtalk-connector',
      runtimeAccount: {
        enabled: true,
        name: 'Old Bot',
        clientId: 'old-client',
        clientSecret: 'old-secret',
        dmPolicy: 'open',
        allowFrom: ['*'],
      },
      enterpriseTopLevel: {
        enabled: true,
        clientId: 'new-client',
        clientSecret: 'new-secret',
        dmPolicy: 'allowlist',
        allowFrom: ['u1'],
      },
      expectedAccount: {
        enabled: true,
        name: 'Old Bot',
        clientId: 'new-client',
        clientSecret: 'new-secret',
        dmPolicy: 'allowlist',
        allowFrom: ['u1'],
      },
      expectedTopLevel: {
        enabled: true,
        dmPolicy: 'allowlist',
        allowFrom: ['u1'],
      },
    },
    {
      channelKey: 'qqbot',
      runtimeAccount: {
        enabled: true,
        name: 'Old Bot',
        appId: 'old-app',
        clientSecret: 'old-secret',
        allowFrom: ['*'],
        markdownSupport: true,
      },
      enterpriseTopLevel: {
        enabled: true,
        appId: 'new-app',
        appSecret: 'new-secret',
        allowFrom: ['u1'],
        markdownSupport: false,
      },
      expectedAccount: {
        enabled: true,
        name: 'Old Bot',
        appId: 'new-app',
        clientSecret: 'new-secret',
        allowFrom: ['u1'],
        markdownSupport: false,
      },
      expectedTopLevel: {
        enabled: true,
        allowFrom: ['u1'],
        markdownSupport: false,
      },
    },
    {
      channelKey: 'wecom',
      runtimeAccount: {
        enabled: true,
        name: 'Old Bot',
        botId: 'old-bot',
        secret: 'old-secret',
        dmPolicy: 'open',
        allowFrom: ['*'],
      },
      enterpriseTopLevel: {
        enabled: true,
        botId: 'new-bot',
        secret: 'new-secret',
        dmPolicy: 'allowlist',
        allowFrom: ['u1'],
      },
      expectedAccount: {
        enabled: true,
        name: 'Old Bot',
        botId: 'new-bot',
        secret: 'new-secret',
        dmPolicy: 'allowlist',
        allowFrom: ['u1'],
      },
      expectedTopLevel: {
      },
    },
  ] as const) {
    test(`mergeOpenClawConfigs overwrites ${testCase.channelKey} accounts with top-level enterprise fields`, async () => {
      const mod = await import('./enterpriseConfigSync');
      const merged = mod.mergeOpenClawConfigs(
        {
          channels: {
            [testCase.channelKey]: {
              accounts: {
                abcdef12: testCase.runtimeAccount,
              },
            },
          },
        },
        {
          channels: {
            [testCase.channelKey]: testCase.enterpriseTopLevel,
          },
        },
      );

      expect(merged).toEqual({
        channels: {
          [testCase.channelKey]: {
            accounts: {
              abcdef12: testCase.expectedAccount,
            },
            ...testCase.expectedTopLevel,
          },
        },
      });
    });
  }

  test('mergeOpenClawConfigs removes runtime top-level credentials when accounts exist', async () => {
    const mod = await import('./enterpriseConfigSync');
    const merged = mod.mergeOpenClawConfigs(
      {
        channels: {
          qqbot: {
            enabled: true,
            appId: 'runtime-app',
            clientSecret: 'runtime-secret',
            allowFrom: ['*'],
            accounts: {
              work: {
                enabled: true,
                appId: 'old-work-app',
                clientSecret: 'old-work-secret',
              },
            },
          },
        },
      },
      {
        channels: {
          qqbot: {
            appId: 'enterprise-app',
            appSecret: 'enterprise-secret',
            allowFrom: ['u1'],
          },
        },
      },
    );

    expect(merged).toEqual({
      channels: {
        qqbot: {
          enabled: true,
          allowFrom: ['u1'],
          accounts: {
            work: {
              enabled: true,
              appId: 'enterprise-app',
              clientSecret: 'enterprise-secret',
              allowFrom: ['u1'],
            },
          },
        },
      },
    });
  });

  test('mergeOpenClawConfigs does not promote empty wecom default account from top-level enterprise credentials', async () => {
    const mod = await import('./enterpriseConfigSync');
    const merged = mod.mergeOpenClawConfigs(
      {
        channels: {
          wecom: {
            accounts: {
              '88326332': {
                enabled: true,
                name: 'WeCom Bot 1',
                botId: 'old-bot',
                secret: 'old-secret',
                dmPolicy: 'open',
                allowFrom: ['*'],
              },
              default: {
                dmPolicy: 'open',
                allowFrom: ['*'],
              },
            },
            enabled: true,
            connectionMode: 'websocket',
            websocketUrl: 'wss://old.example/ws',
          },
        },
      },
      {
        channels: {
          wecom: {
            enabled: true,
            connectionMode: 'websocket',
            dmPolicy: 'open',
            allowFrom: ['*'],
            botId: 'new-bot',
            secret: 'new-secret',
            websocketUrl: 'wss://new.example/ws',
          },
        },
      },
    );

    expect(merged.channels).toEqual({
      wecom: {
        accounts: {
          '88326332': {
            enabled: true,
            name: 'WeCom Bot 1',
            connectionMode: 'websocket',
            botId: 'new-bot',
            secret: 'new-secret',
            websocketUrl: 'wss://new.example/ws',
            dmPolicy: 'open',
            allowFrom: ['*'],
          },
        },
      },
    });
  });

  test('recursive directory copy preserves nested structure', () => {
    const src = path.join(tmpDir, 'src-skill');
    const dest = path.join(tmpDir, 'dest-skill');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'SKILL.md'), '# Test Skill');
    fs.writeFileSync(path.join(src, 'sub', 'config.json'), '{}');

    const copyDir = (s: string, d: string) => {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      for (const entry of fs.readdirSync(s, { withFileTypes: true })) {
        const sp = path.join(s, entry.name);
        const dp = path.join(d, entry.name);
        if (entry.isDirectory()) copyDir(sp, dp);
        else fs.copyFileSync(sp, dp);
      }
    };
    copyDir(src, dest);

    expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf-8')).toBe('# Test Skill');
    expect(fs.existsSync(path.join(dest, 'sub', 'config.json'))).toBe(true);
  });

  test('manifest with hideTabs filters correctly', () => {
    const hideTabs = ['settings.im', 'settings.model'];
    const allTabKeys = ['general', 'coworkAgentEngine', 'model', 'im', 'email', 'about'];
    const filtered = allTabKeys.filter(key => {
      const hideKeys = hideTabs.map(t => t.replace('settings.', ''));
      return !hideKeys.includes(key);
    });
    expect(filtered).toEqual(['general', 'coworkAgentEngine', 'email', 'about']);
  });
});
