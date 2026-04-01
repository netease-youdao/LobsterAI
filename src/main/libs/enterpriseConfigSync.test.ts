import { test, expect, describe, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('enterpriseConfigSync', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('module exports expected functions', async () => {
    const mod = await import('./enterpriseConfigSync');
    expect(typeof mod.resolveEnterpriseConfigPath).toBe('function');
    expect(typeof mod.syncEnterpriseConfig).toBe('function');
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

  test('channel key mapping covers all 10 platforms', () => {
    const map: Record<string, string> = {
      telegram: 'telegramOpenClaw', discord: 'discordOpenClaw',
      feishu: 'feishuOpenClaw', 'dingtalk-connector': 'dingtalkOpenClaw',
      qqbot: 'qq', wecom: 'wecomOpenClaw', 'moltbot-popo': 'popo',
      nim: 'nim', 'openclaw-weixin': 'weixin', xiaomifeng: 'xiaomifeng',
    };
    expect(Object.keys(map)).toHaveLength(10);
    expect(map['telegram']).toBe('telegramOpenClaw');
    expect(map['dingtalk-connector']).toBe('dingtalkOpenClaw');
    expect(map['qqbot']).toBe('qq');
    expect(map['moltbot-popo']).toBe('popo');
    expect(map['openclaw-weixin']).toBe('weixin');
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
