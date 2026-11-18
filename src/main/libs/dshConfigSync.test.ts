import { spawnSync } from 'child_process';
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
  DSH_WEB_PROFILE,
  mapApiFormatToDshProtocol,
  mergeDshProfilePatchText,
  renderDshManagedSettings,
  sanitizeDshRouteId,
  splitLegacyDshSettings,
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

  test('passes the loopback proxy token to dsh through the process env', () => {
    const managed = renderDshManagedSettings({}, { planProvider: { ...plan, apiKey: 'loopback-proxy-token' } });
    const route = managed.routes[DSH_PLAN_ROUTE_ID];
    expect(managed.envVars[route.apiKeyEnv]).toBe('loopback-proxy-token');
    expect(JSON.stringify(managed.routes)).not.toContain('loopback-proxy-token');
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

describe('mergeDshProfilePatchText', () => {
  const managed = renderDshManagedSettings(
    { gw: providerFixture() },
    { preferredDefault: { providerId: 'gw', modelId: 'model-a' } }
  );

  test('creates the patch from scratch and seeds the default model', () => {
    const { text, changed } = mergeDshProfilePatchText(null, managed, { seedDefaultModel: true });
    expect(changed).toBe(true);
    const rows = loadPatch(text);
    const piAi = findRow(rows, 'llm-pi-ai');
    expect(piAi?.name).toBe('@deepseek-ai/dsh-llm-pi-ai');
    expect(providersOf(rows)['lobsterai-gw']).toBeDefined();
    expect(findRow(rows, 'agent-default-model')).toEqual({
      id: 'agent-default-model',
      name: '@deepseek-ai/dsh-agent-default-model',
      config: { provider: 'lobsterai-gw', model: 'model-a' },
    });
  });

  test('preserves user routes, other rows, and !!js expressions; drops stale managed routes', () => {
    const existing = [
      '- insert:',
      '    - id: probe',
      '      name: probe-plugin',
      '      disabled: !!js "!ctx.get(\'profileContext\')"',
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      '      user-route: { apiKeyEnv: USER_KEY, api: openai-completions, baseURL: "https://u.example", models: [{ id: u }] }',
      '      lobsterai-stale: { apiKeyEnv: STALE, api: openai-completions, baseURL: "https://s.example", models: [{ id: s }] }',
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config: { provider: user-route, model: u }',
      '',
    ].join('\n');
    const { text } = mergeDshProfilePatchText(existing, managed);
    const providers = providersOf(loadPatch(text));
    expect(providers['user-route']).toBeDefined();
    expect(providers['lobsterai-stale']).toBeUndefined();
    expect(providers['lobsterai-gw']).toBeDefined();
    expect(text).toContain("disabled: !!js '!ctx.get(''profileContext'')'");
    // The user's default model pick must never be clobbered.
    expect(findRow(loadPatch(text), 'agent-default-model')?.config).toEqual({ provider: 'user-route', model: 'u' });
  });

  // The shipped default belongs to the user (and to any standalone dsh sharing
  // this home), so it is never rewritten.
  test('leaves a DeepSeek default the user picked alone', () => {
    const existing = yaml.dump([
      { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    ]);
    const rows = loadPatch(mergeDshProfilePatchText(existing, managed, { seedDefaultModel: true }).text);
    expect(findRow(rows, 'agent-default-model')?.config).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' });
  });

  test('does not seed a default into a profile that already exists', () => {
    const rows = loadPatch(mergeDshProfilePatchText('[]\n', managed).text);
    expect(findRow(rows, 'agent-default-model')).toBeUndefined();
  });

  test('repairs a default pinned to a managed route that no longer exists', () => {
    const existing = yaml.dump([{ id: 'agent-default-model', config: { provider: 'lobsterai-removed', model: 'gone' } }]);
    const rows = loadPatch(mergeDshProfilePatchText(existing, managed).text);
    expect(findRow(rows, 'agent-default-model')?.config).toEqual({ provider: 'lobsterai-gw', model: 'model-a' });
  });

  test('refuses to rewrite a patch it cannot read', () => {
    expect(() => mergeDshProfilePatchText('- [not yaml', managed)).toThrow();
    expect(() => mergeDshProfilePatchText('llm-pi-ai: {}\n', managed)).toThrow(/not a YAML sequence/);
  });

  test('reports no change, and returns the text untouched, when the managed rows already match', () => {
    const first = mergeDshProfilePatchText(null, managed, { seedDefaultModel: true }).text;
    const commented = `# my notes\n${first}# trailing note\n`;
    expect(mergeDshProfilePatchText(commented, managed)).toEqual({ text: commented, changed: false });
  });

  test('keeps the leading header comment when it rewrites the patch', () => {
    const existing = '# Your patch layer for this dsh profile.\n# Second line.\n[]\n';
    const { text } = mergeDshProfilePatchText(existing, managed);
    expect(text.startsWith('# Your patch layer for this dsh profile.\n# Second line.\n- ')).toBe(true);
  });

  test('clears our routes when nothing is managed, dropping a row left bare but keeping a customized one', () => {
    const none = renderDshManagedSettings({});
    const bare = yaml.dump([{ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { 'lobsterai-gw': {} } } }]);
    expect(loadPatch(mergeDshProfilePatchText(bare, none).text)).toEqual([]);

    const customized = yaml.dump([{ id: 'llm-pi-ai', disabled: true, config: { providers: { 'lobsterai-gw': {} } } }]);
    expect(loadPatch(mergeDshProfilePatchText(customized, none).text)).toEqual([{ id: 'llm-pi-ai', disabled: true }]);
  });

  test('writes nothing for an empty profile with nothing to manage', () => {
    expect(mergeDshProfilePatchText(null, renderDshManagedSettings({}), { seedDefaultModel: true }).changed).toBe(false);
  });

  test('folds legacy sections over the profile rows, minus stale managed routes', () => {
    const { text } = mergeDshProfilePatchText('[]\n', managed, {
      legacy: {
        'llm-pi-ai': {
          providers: {
            'user-route': { apiKeyEnv: 'USER_KEY', api: 'openai-completions', baseURL: 'https://u.example', models: [{ id: 'u' }] },
            'lobsterai-stale': { apiKeyEnv: 'STALE', api: 'openai-completions', baseURL: 'https://s.example', models: [{ id: 's' }] },
          },
        },
        'agent-default-model': { provider: 'user-route', model: 'u' },
      },
    });
    const rows = loadPatch(text);
    expect(Object.keys(providersOf(rows)).sort()).toEqual(['lobsterai-gw', 'user-route']);
    expect(findRow(rows, 'agent-default-model')?.config).toEqual({ provider: 'user-route', model: 'u' });
  });

  test('repairs a legacy default pinned to a managed route that no longer exists', () => {
    const { text } = mergeDshProfilePatchText(null, managed, {
      legacy: { 'agent-default-model': { provider: 'lobsterai-removed', model: 'gone' } },
    });
    expect(findRow(loadPatch(text), 'agent-default-model')?.config).toEqual({ provider: 'lobsterai-gw', model: 'model-a' });
  });
});

describe('splitLegacyDshSettings', () => {
  test('takes the owned sections and leaves the rest for dsh', () => {
    const split = splitLegacyDshSettings(
      yaml.dump({ 'llm-pi-ai': { providers: {} }, 'agent-default-model': { provider: 'p', model: 'm' }, locale: { preference: 'zh' } })
    );
    expect(split?.owned).toEqual({ 'llm-pi-ai': { providers: {} }, 'agent-default-model': { provider: 'p', model: 'm' } });
    expect(yaml.load(split?.remainder ?? '')).toEqual({ locale: { preference: 'zh' } });
  });

  test('has no remainder once only owned sections were present', () => {
    expect(splitLegacyDshSettings(yaml.dump({ 'llm-pi-ai': { providers: {} } }))?.remainder).toBeNull();
  });

  test('leaves a document without owned sections alone', () => {
    expect(splitLegacyDshSettings(yaml.dump({ locale: { preference: 'zh' } }))).toBeNull();
    expect(splitLegacyDshSettings('')).toBeNull();
  });

  test('throws on a document it cannot read', () => {
    expect(() => splitLegacyDshSettings('- a\n- b\n')).toThrow(/not a map/);
  });
});

describe('writeDshManagedSettings', () => {
  function makeHome(): string {
    const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-config-sync-'));
    tempDirs.push(dshHome);
    return dshHome;
  }

  test('writes the web profile patch with 0600 mode, seeds a fresh profile, and cleans up its lock', async () => {
    const dshHome = makeHome();
    const managed = renderDshManagedSettings({ gw: providerFixture() });

    const first = await writeDshManagedSettings(dshHome, managed);
    expect(first.warnings).toHaveLength(0);
    expect(first.patchPath).toBe(path.join(dshHome, 'profiles', DSH_WEB_PROFILE, 'cordis.patch.yml'));
    const rows = loadPatch(fs.readFileSync(first.patchPath, 'utf8'));
    expect(providersOf(rows)['lobsterai-gw']).toBeDefined();
    // A fresh profile is ours to initialize, so the default model is seeded.
    expect(findRow(rows, 'agent-default-model')?.config).toEqual({ provider: 'lobsterai-gw', model: 'model-a' });
    if (process.platform !== 'win32') {
      expect(fs.statSync(first.patchPath).mode & 0o777).toBe(0o600);
    }
    expect(fs.existsSync(path.join(dshHome, 'profiles', DSH_WEB_PROFILE, 'package.json.lock'))).toBe(false);
    // dsh scaffolds the rest of the profile itself; the retired document stays retired.
    expect(fs.existsSync(path.join(dshHome, 'profiles', DSH_WEB_PROFILE, 'package.json'))).toBe(false);
    expect(fs.existsSync(path.join(dshHome, 'settings.yaml'))).toBe(false);
  });

  test('a later sync merges into the patch and keeps the default the user picked', async () => {
    const dshHome = makeHome();
    const first = await writeDshManagedSettings(dshHome, renderDshManagedSettings({ gw: providerFixture() }));
    const rows = loadPatch(fs.readFileSync(first.patchPath, 'utf8')).map((row) =>
      row.id === 'agent-default-model' ? { ...row, config: { provider: 'deepseek-official', model: 'deepseek-flash' } } : row
    );
    rows.push({ id: 'locale', config: { preference: 'zh' } });
    fs.writeFileSync(first.patchPath, yaml.dump(rows));

    const second = await writeDshManagedSettings(dshHome, renderDshManagedSettings({ other: providerFixture() }));
    const merged = loadPatch(fs.readFileSync(second.patchPath, 'utf8'));
    expect(Object.keys(providersOf(merged))).toEqual(['lobsterai-other']);
    expect(findRow(merged, 'locale')?.config).toEqual({ preference: 'zh' });
    expect(findRow(merged, 'agent-default-model')?.config).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' });
  });

  test('leaves the file untouched when nothing changed', async () => {
    const dshHome = makeHome();
    const managed = renderDshManagedSettings({ gw: providerFixture() });
    const { patchPath } = await writeDshManagedSettings(dshHome, managed);
    const commented = `# kept\n${fs.readFileSync(patchPath, 'utf8')}`;
    fs.writeFileSync(patchPath, commented);
    await writeDshManagedSettings(dshHome, managed);
    expect(fs.readFileSync(patchPath, 'utf8')).toBe(commented);
  });

  test('folds a legacy settings.yaml in and leaves its other sections for dsh', async () => {
    const dshHome = makeHome();
    fs.writeFileSync(
      path.join(dshHome, 'settings.yaml'),
      yaml.dump({
        'ui-onboarding': { done: true },
        'llm-pi-ai': {
          providers: {
            'user-route': { apiKeyEnv: 'USER_KEY', api: 'openai-completions', baseURL: 'https://u.example', models: [{ id: 'u' }] },
            'lobsterai-stale': { apiKeyEnv: 'STALE', api: 'openai-completions', baseURL: 'https://s.example', models: [{ id: 's' }] },
          },
        },
        'agent-default-model': { provider: 'user-route', model: 'u' },
      })
    );
    const { patchPath } = await writeDshManagedSettings(dshHome, renderDshManagedSettings({ gw: providerFixture() }));
    const rows = loadPatch(fs.readFileSync(patchPath, 'utf8'));
    expect(Object.keys(providersOf(rows)).sort()).toEqual(['lobsterai-gw', 'user-route']);
    expect(findRow(rows, 'agent-default-model')?.config).toEqual({ provider: 'user-route', model: 'u' });
    expect(yaml.load(fs.readFileSync(path.join(dshHome, 'settings.yaml'), 'utf8'))).toEqual({ 'ui-onboarding': { done: true } });
  });

  test('retires a legacy settings.yaml once nothing else is left in it', async () => {
    const dshHome = makeHome();
    fs.writeFileSync(path.join(dshHome, 'settings.yaml'), yaml.dump({ 'llm-pi-ai': { providers: {} } }));
    await writeDshManagedSettings(dshHome, renderDshManagedSettings({ gw: providerFixture() }));
    expect(fs.existsSync(path.join(dshHome, 'settings.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(dshHome, 'settings.yaml.imported'))).toBe(true);
  });

  test('warns about, and keeps, a legacy settings.yaml it cannot read', async () => {
    const dshHome = makeHome();
    const legacyPath = path.join(dshHome, 'settings.yaml');
    fs.writeFileSync(legacyPath, '{not yaml: [');
    const { warnings } = await writeDshManagedSettings(dshHome, renderDshManagedSettings({ gw: providerFixture() }));
    expect(warnings).toHaveLength(1);
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe('{not yaml: [');
  });

  test('takes over a profile lock whose writer has exited', async () => {
    const dshHome = makeHome();
    const profileDir = path.join(dshHome, 'profiles', DSH_WEB_PROFILE);
    fs.mkdirSync(profileDir, { recursive: true });
    const exited = spawnSync(process.execPath, ['-e', '']);
    fs.writeFileSync(path.join(profileDir, 'package.json.lock'), `${exited.pid}\n`);
    const { patchPath } = await writeDshManagedSettings(dshHome, renderDshManagedSettings({ gw: providerFixture() }));
    expect(providersOf(loadPatch(fs.readFileSync(patchPath, 'utf8')))['lobsterai-gw']).toBeDefined();
    expect(fs.existsSync(path.join(profileDir, 'package.json.lock'))).toBe(false);
  });
});

type PatchRow = Record<string, unknown>;

// Reads a patch in dsh's dialect, where `!!js` marks an expression.
const PATCH_SCHEMA = yaml.JSON_SCHEMA.extend(
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (data: string) => ({ __jsExpr: data }) })
);

function loadPatch(text: string): PatchRow[] {
  return (yaml.load(text, { schema: PATCH_SCHEMA }) as PatchRow[] | undefined) ?? [];
}

function findRow(rows: PatchRow[], id: string): PatchRow | undefined {
  return rows.findLast((row) => row.id === id && !('insert' in row));
}

function providersOf(rows: PatchRow[]): Record<string, unknown> {
  const config = findRow(rows, 'llm-pi-ai')?.config as { providers?: Record<string, unknown> } | undefined;
  return config?.providers ?? {};
}
