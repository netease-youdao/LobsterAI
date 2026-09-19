import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, test } from 'vitest';

import type { ProviderConfig } from '../../shared/providers/types';
import {
  deriveDshApiKeyEnvRef,
  DSH_MANAGED_LABEL_PREFIX,
  DSH_PLAN_ANTHROPIC_ROUTE_ID,
  DSH_PLAN_ROUTE_ID,
  mapApiFormatToDshProtocol,
  mergeDshSettingsText,
  renderDshManagedSettings,
  sanitizeDshRouteId,
  writeDshManagedSettings,
} from './dshConfigSync';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function providerFixture(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    enabled: true,
    apiKey: 'sk-test',
    baseUrl: 'https://api.example.com/v1',
    apiFormat: 'openai',
    displayName: 'Example',
    models: [{ id: 'model-a', name: 'Model A', contextWindow: 8192, maxTokens: 1024 }],
    ...overrides,
  };
}

describe('sanitizeDshRouteId', () => {
  test('lowercases, collapses separators, and prefixes', () => {
    expect(sanitizeDshRouteId('OpenAI')).toBe('lobsterai-openai');
    expect(sanitizeDshRouteId('My_Provider 1')).toBe('lobsterai-my-provider-1');
  });

  test('strips leading non-letters and never returns a bare prefix', () => {
    expect(sanitizeDshRouteId('123abc')).toBe('lobsterai-abc');
    expect(sanitizeDshRouteId('自定义')).toBe('lobsterai-provider');
  });
});

describe('deriveDshApiKeyEnvRef', () => {
  test('follows the dsh models UI convention', () => {
    expect(deriveDshApiKeyEnvRef('lobsterai-my-gateway')).toBe('LOBSTERAI_MY_GATEWAY_API_KEY');
  });
});

describe('mapApiFormatToDshProtocol', () => {
  test('maps known formats and rejects gemini', () => {
    expect(mapApiFormatToDshProtocol('openai')).toBe('openai-completions');
    expect(mapApiFormatToDshProtocol('anthropic')).toBe('anthropic-messages');
    expect(mapApiFormatToDshProtocol(undefined)).toBe('openai-completions');
    expect(mapApiFormatToDshProtocol('gemini')).toBeNull();
  });
});

describe('renderDshManagedSettings', () => {
  test('renders a full route with env-referenced credentials', () => {
    const managed = renderDshManagedSettings({ 'My GW': providerFixture() });
    const route = managed.routes['lobsterai-my-gw'];
    expect(route).toBeDefined();
    expect(route.apiKeyEnv).toBe('LOBSTERAI_MY_GW_API_KEY');
    expect(managed.envVars.LOBSTERAI_MY_GW_API_KEY).toBe('sk-test');
    expect(route.models[0]).toEqual({ id: 'model-a', name: 'Model A', contextWindow: 8192, maxTokens: 1024 });
    expect(managed.skipped).toHaveLength(0);
  });

  test('prefers the canonical provider label over the raw config key, marked as managed', () => {
    const managed = renderDshManagedSettings({ deepseek: providerFixture({ displayName: undefined }) });
    expect(managed.routes['lobsterai-deepseek'].displayName).toBe(`${DSH_MANAGED_LABEL_PREFIX}DeepSeek`);
  });

  test('an explicit displayName still wins over the canonical label', () => {
    const managed = renderDshManagedSettings({ deepseek: providerFixture({ displayName: 'My DeepSeek' }) });
    expect(managed.routes['lobsterai-deepseek'].displayName).toBe(`${DSH_MANAGED_LABEL_PREFIX}My DeepSeek`);
  });

  test('falls back to the config key for unknown providers', () => {
    const managed = renderDshManagedSettings({ 'my-gw': providerFixture({ displayName: undefined }) });
    expect(managed.routes['lobsterai-my-gw'].displayName).toBe(`${DSH_MANAGED_LABEL_PREFIX}my-gw`);
  });

  test('declares image input only when the model supports it', () => {
    const managed = renderDshManagedSettings({
      gw: providerFixture({ models: [{ id: 'm', name: 'M', supportsImage: true }] }),
    });
    expect(managed.routes['lobsterai-gw'].models[0].input).toEqual(['text', 'image']);
  });

  test('keeps models without thinking capability free of effort metadata', () => {
    const managed = renderDshManagedSettings({ gw: providerFixture() });
    const route = managed.routes['lobsterai-gw'];
    expect(route.models[0].reasoningEfforts).toBeUndefined();
    expect(route.compat).toBeUndefined();
  });

  test('declares default OpenAI efforts and route compat for a thinking model', () => {
    const managed = renderDshManagedSettings({
      gw: providerFixture({ models: [{ id: 'thinker', name: 'Thinker', supportsThinking: true }] }),
    });
    const route = managed.routes['lobsterai-gw'];
    expect(route.models[0].reasoningEfforts).toEqual({
      off: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      max: 'max',
    });
    expect(route.compat).toEqual({ thinkingFormat: 'openai', supportsReasoningEffort: true });
  });

  test('maps an explicit per-model thinkingLevelMap instead of the default', () => {
    const managed = renderDshManagedSettings({
      gw: providerFixture({
        models: [{
          id: 'deepseek-v4',
          name: 'DeepSeek V4',
          supportsThinking: true,
          customParams: { thinkingLevelMap: { off: 'off', high: 'high', xhigh: 'xhigh' } },
        }],
      }),
    });
    const route = managed.routes['lobsterai-gw'];
    expect(route.models[0].reasoningEfforts).toEqual({ off: null, high: 'high', xhigh: 'xhigh' });
    expect(route.compat).toEqual({ thinkingFormat: 'openai', supportsReasoningEffort: true });
  });

  test('leaves anthropic routes without reasoning compat', () => {
    const managed = renderDshManagedSettings({
      gw: providerFixture({
        apiFormat: 'anthropic',
        models: [{ id: 'claude', name: 'Claude', supportsThinking: true }],
      }),
    });
    const route = managed.routes['lobsterai-gw'];
    expect(route.api).toBe('anthropic-messages');
    expect(route.models[0].reasoningEfforts).toBeUndefined();
    expect(route.compat).toBeUndefined();
  });

  test('skips disabled, oauth, keyless, model-less, and gemini providers with reasons', () => {
    const managed = renderDshManagedSettings({
      off: providerFixture({ enabled: false }),
      oauth: providerFixture({ authType: 'oauth' }),
      nokey: providerFixture({ apiKey: '' }),
      nomodels: providerFixture({ models: [] }),
      gemini: providerFixture({ apiFormat: 'gemini' }),
    });
    expect(Object.keys(managed.routes)).toHaveLength(0);
    expect(managed.skipped.map((s) => s.reason).sort()).toEqual(
      ['disabled', 'missing-api-key', 'no-models', 'oauth-not-supported', 'unsupported-api-format:gemini'].sort()
    );
  });

  test('resolves the preferred default when it survived rendering', () => {
    expect(
      renderDshManagedSettings(
        { gw: providerFixture() },
        { preferredDefault: { providerId: 'gw', modelId: 'model-a' } }
      ).defaultModel
    ).toEqual({ provider: 'lobsterai-gw', model: 'model-a' });
  });

  test('falls back to a rendered route when the preferred one was skipped', () => {
    const managed = renderDshManagedSettings(
      { gemini: providerFixture({ apiFormat: 'gemini' }), gw: providerFixture() },
      { preferredDefault: { providerId: 'gemini', modelId: 'model-a' } }
    );
    expect(managed.defaultModel).toEqual({ provider: 'lobsterai-gw', model: 'model-a' });
  });

  test('has no default to offer when nothing rendered', () => {
    expect(renderDshManagedSettings({ gemini: providerFixture({ apiFormat: 'gemini' }) }).defaultModel).toBeNull();
  });
});

describe('plan provider (token proxy)', () => {
  const plan = {
    baseUrl: 'http://127.0.0.1:5555/v1',
    displayName: '套餐',
    models: [
      { modelId: 'plan-chat', modelName: 'Plan Chat', contextWindow: 128000, maxTokens: 8192 },
      { modelId: 'plan-vision', modelName: 'Plan Vision', supportsImage: true },
    ],
  };

  test('routes plan models through the proxy with a placeholder credential', () => {
    const managed = renderDshManagedSettings({}, { planProvider: plan });
    const route = managed.routes[DSH_PLAN_ROUTE_ID];
    expect(route.baseURL).toBe('http://127.0.0.1:5555/v1');
    expect(route.api).toBe('openai-completions');
    expect(route.models.map((model) => model.id)).toEqual(['plan-chat', 'plan-vision']);
    // The proxy overwrites Authorization, so the key only has to be non-empty.
    expect(managed.envVars[route.apiKeyEnv]).toBeTruthy();
  });

  test('declares plan reasoning efforts from server thinking config', () => {
    const managed = renderDshManagedSettings(
      {},
      {
        planProvider: {
          ...plan,
          models: [
            {
              modelId: 'plan-chat',
              supportsThinking: true,
              thinkingConfig: {
                options: [
                  { level: 'off', openclawLevel: 'off' },
                  { level: 'high', openclawLevel: 'high' },
                  { level: 'xhigh', openclawLevel: 'xhigh' },
                ],
                defaultLevel: 'high',
              },
            },
            { modelId: 'plan-vision' },
          ],
        },
      }
    );
    const route = managed.routes[DSH_PLAN_ROUTE_ID];
    expect(route.models[0].reasoningEfforts).toEqual({ off: null, high: 'high', xhigh: 'xhigh' });
    expect(route.compat).toEqual({ thinkingFormat: 'openai', supportsReasoningEffort: true });
    // Models without thinking capability stay untouched.
    expect(route.models[1].reasoningEfforts).toBeUndefined();
  });

  test('plan models without thinking capability leave the route bare', () => {
    const managed = renderDshManagedSettings({}, { planProvider: plan });
    const route = managed.routes[DSH_PLAN_ROUTE_ID];
    expect(route.compat).toBeUndefined();
    expect(route.models.every((model) => model.reasoningEfforts === undefined)).toBe(true);
  });

  test('marks the plan as LobsterAI-managed in the picker', () => {
    const managed = renderDshManagedSettings({}, { planProvider: plan });
    expect(managed.routes[DSH_PLAN_ROUTE_ID].displayName).toBe(`${DSH_MANAGED_LABEL_PREFIX}套餐`);
  });

  test('splits anthropic-format plan models into their own route', () => {
    const managed = renderDshManagedSettings(
      {},
      {
        planProvider: {
          ...plan,
          models: [
            { modelId: 'plan-chat' },
            { modelId: 'plan-claude', apiFormat: 'anthropic' },
          ],
        },
      }
    );
    expect(managed.routes[DSH_PLAN_ROUTE_ID].models.map((m) => m.id)).toEqual(['plan-chat']);
    expect(managed.routes[DSH_PLAN_ANTHROPIC_ROUTE_ID].api).toBe('anthropic-messages');
    expect(managed.routes[DSH_PLAN_ANTHROPIC_ROUTE_ID].models.map((m) => m.id)).toEqual(['plan-claude']);
    // dsh groups the picker by display name; the two routes must not collide.
    expect(managed.routes[DSH_PLAN_ANTHROPIC_ROUTE_ID].displayName).not.toBe(
      managed.routes[DSH_PLAN_ROUTE_ID].displayName
    );
  });

  test('an anthropic-only plan keeps the plain display name', () => {
    const managed = renderDshManagedSettings(
      {},
      { planProvider: { ...plan, models: [{ modelId: 'plan-claude', apiFormat: 'anthropic' }] } }
    );
    expect(managed.routes[DSH_PLAN_ANTHROPIC_ROUTE_ID].displayName).toBe(`${DSH_MANAGED_LABEL_PREFIX}套餐`);
    expect(DSH_PLAN_ROUTE_ID in managed.routes).toBe(false);
  });

  test('omits the anthropic route when no such model exists', () => {
    const managed = renderDshManagedSettings({}, { planProvider: plan });
    expect(DSH_PLAN_ANTHROPIC_ROUTE_ID in managed.routes).toBe(false);
  });

  test('defaults to the plan, which needs no user key', () => {
    const managed = renderDshManagedSettings({ gw: providerFixture() }, { planProvider: plan });
    expect(managed.defaultModel).toEqual({ provider: DSH_PLAN_ROUTE_ID, model: 'plan-chat' });
  });

  test('an explicit preferred default still wins over the plan', () => {
    const managed = renderDshManagedSettings(
      { gw: providerFixture() },
      { planProvider: plan, preferredDefault: { providerId: 'gw', modelId: 'model-a' } }
    );
    expect(managed.defaultModel).toEqual({ provider: 'lobsterai-gw', model: 'model-a' });
  });

  test('skips the plan with a reason when the proxy is down or it has no models', () => {
    expect(renderDshManagedSettings({}, { planProvider: { ...plan, baseUrl: '' } }).skipped).toContainEqual({
      providerId: DSH_PLAN_ROUTE_ID,
      reason: 'proxy-not-running',
    });
    expect(renderDshManagedSettings({}, { planProvider: { ...plan, models: [] } }).skipped).toContainEqual({
      providerId: DSH_PLAN_ROUTE_ID,
      reason: 'no-models',
    });
  });
});

describe('mergeDshSettingsText', () => {
  const managed = renderDshManagedSettings(
    { gw: providerFixture() },
    { preferredDefault: { providerId: 'gw', modelId: 'model-a' } }
  );

  test('creates the document from scratch and seeds the default model', () => {
    const { text, warnings } = mergeDshSettingsText(null, managed, { seedDefaultModel: true });
    const doc = yaml.load(text) as Record<string, Record<string, unknown>>;
    expect(warnings).toHaveLength(0);
    expect((doc['llm-pi-ai'].providers as Record<string, unknown>)['lobsterai-gw']).toBeDefined();
    expect(doc['agent-default-model']).toEqual({ provider: 'lobsterai-gw', model: 'model-a' });
  });

  test('preserves user routes and foreign namespaces, replaces stale managed routes', () => {
    const existing = yaml.dump({
      'ui-onboarding': { done: true },
      'llm-pi-ai': {
        providers: {
          'user-route': { apiKeyEnv: 'USER_KEY', api: 'openai-completions', baseURL: 'https://u.example', models: [{ id: 'u' }] },
          'lobsterai-stale': { apiKeyEnv: 'STALE', api: 'openai-completions', baseURL: 'https://s.example', models: [{ id: 's' }] },
        },
      },
      'agent-default-model': { provider: 'user-route', model: 'u' },
    });
    const { text } = mergeDshSettingsText(existing, managed);
    const doc = yaml.load(text) as Record<string, Record<string, unknown>>;
    const providers = doc['llm-pi-ai'].providers as Record<string, unknown>;
    expect(providers['user-route']).toBeDefined();
    expect(providers['lobsterai-stale']).toBeUndefined();
    expect(providers['lobsterai-gw']).toBeDefined();
    expect(doc['ui-onboarding']).toEqual({ done: true });
    // The user's default model pick must never be clobbered.
    expect(doc['agent-default-model']).toEqual({ provider: 'user-route', model: 'u' });
  });

  // dsh's own default belongs to the machine (and to any standalone dsh
  // sharing this home), so it is never rewritten.
  test('leaves the shipped DeepSeek default alone', () => {
    const existing = yaml.dump({ 'agent-default-model': { provider: 'deepseek-official', model: 'deepseek-v4-flash' } });
    const doc = yaml.load(mergeDshSettingsText(existing, managed).text) as Record<string, unknown>;
    expect(doc['agent-default-model']).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' });
  });

  test('does not seed a default into a home that already has settings', () => {
    const existing = yaml.dump({ locale: { preference: 'zh' } });
    const doc = yaml.load(mergeDshSettingsText(existing, managed).text) as Record<string, unknown>;
    expect('agent-default-model' in doc).toBe(false);
  });

  test('repairs a default pinned to a managed route that no longer exists', () => {
    const existing = yaml.dump({ 'agent-default-model': { provider: 'lobsterai-removed', model: 'gone' } });
    const doc = yaml.load(mergeDshSettingsText(existing, managed).text) as Record<string, unknown>;
    expect(doc['agent-default-model']).toEqual({ provider: 'lobsterai-gw', model: 'model-a' });
  });

  test('replaces unparseable content with a warning', () => {
    const { text, warnings } = mergeDshSettingsText('{not yaml: [', managed);
    expect(warnings).toHaveLength(1);
    expect((yaml.load(text) as Record<string, unknown>)['llm-pi-ai']).toBeDefined();
  });
});

describe('writeDshManagedSettings', () => {
  test('round-trips to disk with 0600 mode and cleans up its lock', async () => {
    const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-config-sync-'));
    tempDirs.push(dshHome);
    const managed = renderDshManagedSettings({ gw: providerFixture() });

    const first = await writeDshManagedSettings(dshHome, managed);
    expect(first.warnings).toHaveLength(0);
    // A fresh home is ours to initialize, so the default model is seeded.
    expect(
      (yaml.load(fs.readFileSync(first.settingsPath, 'utf8')) as Record<string, unknown>)['agent-default-model']
    ).toBeDefined();
    const doc = yaml.load(fs.readFileSync(first.settingsPath, 'utf8')) as Record<string, Record<string, unknown>>;
    expect((doc['llm-pi-ai'].providers as Record<string, unknown>)['lobsterai-gw']).toBeDefined();
    if (process.platform !== 'win32') {
      expect(fs.statSync(first.settingsPath).mode & 0o777).toBe(0o600);
    }
    expect(fs.existsSync(`${first.settingsPath}.lock`)).toBe(false);

    // Second write is a merge, not a clobber.
    fs.writeFileSync(
      first.settingsPath,
      yaml.dump({ ...(yaml.load(fs.readFileSync(first.settingsPath, 'utf8')) as object), locale: { preference: 'zh' } })
    );
    const second = await writeDshManagedSettings(dshHome, managed);
    const merged = yaml.load(fs.readFileSync(second.settingsPath, 'utf8')) as Record<string, unknown>;
    expect(merged.locale).toEqual({ preference: 'zh' });

    // The composition layer must stay untouched: a stock dsh home keeps every
    // shipped provider, tool, and plugin exactly as dsh ships it.
    expect(fs.existsSync(path.join(dshHome, 'cordis.patch.yml'))).toBe(false);
  });
});
