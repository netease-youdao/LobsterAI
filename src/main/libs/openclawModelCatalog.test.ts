import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { OpenClawApi, OpenClawProviderId, ProviderName } from '../../shared/providers';
import { buildProviderSelection } from './openclawConfigSync';
import {
  resetOpenClawCatalogMaxTokensCacheForTest,
  resolveOpenClawCatalogModelMaxTokens,
} from './openclawModelCatalog';

const mockState = vi.hoisted(() => ({ appPath: '' }));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => mockState.appPath,
    getPath: () => os.tmpdir(),
  },
}));

vi.mock('./claudeSettings', () => ({
  getAllServerModelMetadata: () => [],
  listProviderSourceEntries: () => [],
  resolveAllEnabledProviderConfigs: () => [],
  resolveAllProviderApiKeys: () => ({}),
  resolveRawApiConfig: () => null,
}));

vi.mock('./openclawTokenProxy', () => ({
  getOpenClawTokenProxyPort: () => null,
}));

type CatalogRow = [modelId: string, maxTokens: number];

const RUNTIME_SEGMENTS = ['vendor', 'openclaw-runtime', 'current'];
const DEFAULT_MAX_TOKENS = 8192;

const writeManifest = (extensionDir: string, manifest: Record<string, unknown>): void => {
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.writeFileSync(path.join(extensionDir, 'openclaw.plugin.json'), JSON.stringify(manifest));
};

const catalogProvider = (rows: CatalogRow[]) => ({
  models: rows.map(([id, maxTokens]) => ({ id, maxTokens })),
});

const createFakeRuntimeAppPath = (): string => {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-model-catalog-'));
  const runtimeRoot = path.join(appPath, ...RUNTIME_SEGMENTS);
  // A stale bundled copy must lose to the pinned external plugin.
  writeManifest(path.join(runtimeRoot, 'dist', 'extensions', 'volcengine'), {
    id: 'volcengine',
    modelCatalog: {
      providers: {
        [OpenClawProviderId.VolcenginePlan]: catalogProvider([['glm-5.2', 4096]]),
      },
    },
  });
  writeManifest(path.join(runtimeRoot, 'third-party-extensions', 'volcengine'), {
    id: 'volcengine',
    providers: [OpenClawProviderId.Volcengine, OpenClawProviderId.VolcenginePlan],
    providerAuthAliases: { [OpenClawProviderId.VolcenginePlan]: OpenClawProviderId.Volcengine },
    modelCatalog: {
      providers: {
        [OpenClawProviderId.Volcengine]: catalogProvider([['glm-5-2-260617', 128_000]]),
        [OpenClawProviderId.VolcenginePlan]: catalogProvider([
          ['glm-5.2', 128_000],
          ['ark-code-latest', 4096],
          ['deepseek-v4-flash', 384_000],
        ]),
      },
    },
  });
  writeManifest(path.join(runtimeRoot, 'third-party-extensions', 'zai'), {
    id: 'zai',
    providers: [OpenClawProviderId.Zai],
    modelCatalog: {
      providers: {
        [OpenClawProviderId.Zai]: catalogProvider([['glm-5.3', 131_072]]),
      },
    },
  });
  return appPath;
};

type SelectionOptions = Parameters<typeof buildProviderSelection>[0];

const selectModelMaxTokens = (overrides: Partial<SelectionOptions>): number | undefined => (
  buildProviderSelection({
    apiKey: 'fixture-key',
    baseURL: 'https://ark.cn-beijing.volces.com/api/coding',
    modelId: 'glm-5.3',
    apiType: 'anthropic',
    providerName: ProviderName.Volcengine,
    authType: 'apikey',
    codingPlanEnabled: true,
    supportsImage: false,
    supportsThinking: true,
    modelName: 'GLM 5.3',
    ...overrides,
  }).providerConfig.models[0].maxTokens
);

describe('with a fake OpenClaw runtime', () => {
  let fakeAppPath = '';

  beforeEach(() => {
    fakeAppPath = createFakeRuntimeAppPath();
    mockState.appPath = fakeAppPath;
    resetOpenClawCatalogMaxTokensCacheForTest();
  });

  afterEach(() => {
    fs.rmSync(fakeAppPath, { recursive: true, force: true });
    resetOpenClawCatalogMaxTokensCacheForTest();
  });

  describe('resolveOpenClawCatalogModelMaxTokens', () => {
    test('indexes provider plugins preinstalled under third-party-extensions', () => {
      expect(resolveOpenClawCatalogModelMaxTokens(OpenClawProviderId.Zai, 'glm-5.3')).toBe(131_072);
      expect(resolveOpenClawCatalogModelMaxTokens(OpenClawProviderId.VolcenginePlan, 'deepseek-v4-flash'))
        .toBe(384_000);
    });

    test('prefers the pinned external plugin over a bundled copy', () => {
      expect(resolveOpenClawCatalogModelMaxTokens(OpenClawProviderId.VolcenginePlan, 'glm-5.2')).toBe(128_000);
    });

    test('falls back from the plan catalog to the base provider catalog', () => {
      expect(resolveOpenClawCatalogModelMaxTokens(OpenClawProviderId.VolcenginePlan, 'glm-5-2-260617'))
        .toBe(128_000);
    });

    test('fills catalog gaps from the built-in table', () => {
      expect(resolveOpenClawCatalogModelMaxTokens(OpenClawProviderId.VolcenginePlan, 'glm-5.3')).toBe(128_000);
    });
  });

  describe('buildProviderSelection max tokens', () => {
    test('uses the Volcengine plan catalog when the Coding Plan is enabled', () => {
      expect(selectModelMaxTokens({ modelId: 'glm-5.2' })).toBe(128_000);
      expect(selectModelMaxTokens({ modelId: 'glm-5.3' })).toBe(128_000);
      expect(selectModelMaxTokens({ modelId: 'deepseek-v4-flash' })).toBe(384_000);
    });

    test('keeps plan-only rows away from the general Volcengine endpoint', () => {
      expect(selectModelMaxTokens({
        modelId: 'glm-5.2',
        codingPlanEnabled: false,
        baseURL: 'https://ark.cn-beijing.volces.com/api/compatible',
      })).toBe(DEFAULT_MAX_TOKENS);
    });

    test('does not lower the default for placeholder catalog rows', () => {
      expect(selectModelMaxTokens({ modelId: 'ark-code-latest' })).toBe(DEFAULT_MAX_TOKENS);
    });

    test('prefers a user-configured output cap over catalog rows', () => {
      expect(selectModelMaxTokens({ modelId: 'glm-5.2', maxTokens: 65_536 })).toBe(65_536);
    });

    test('leaves OpenAI-format caps to OpenClaw', () => {
      const selection = buildProviderSelection({
        apiKey: 'fixture-key',
        baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3',
        modelId: 'glm-5.2',
        apiType: 'openai',
        providerName: ProviderName.Volcengine,
        authType: 'apikey',
        codingPlanEnabled: true,
        supportsImage: false,
        modelName: 'GLM 5.2',
      });
      expect(selection.providerConfig.api).toBe(OpenClawApi.OpenAICompletions);
      expect(selection.providerConfig.models[0].maxTokens).toBeUndefined();
    });

    test('resolves Zhipu GLM limits from the external zai plugin', () => {
      expect(selectModelMaxTokens({
        providerName: ProviderName.Zhipu,
        baseURL: 'https://open.bigmodel.cn/api/anthropic',
        codingPlanEnabled: false,
      })).toBe(131_072);
    });

    test('does not let custom providers inherit official limits by model id', () => {
      expect(selectModelMaxTokens({
        providerName: 'custom_0',
        baseURL: 'https://proxy.example.com/anthropic',
        codingPlanEnabled: false,
      })).toBe(DEFAULT_MAX_TOKENS);
    });
  });
});

const realThirdPartyExtensionsDir = path.join(process.cwd(), ...RUNTIME_SEGMENTS, 'third-party-extensions');

const listRealCatalogRows = (): Array<{ providerId: string; modelId: string; maxTokens: number }> => (
  fs.readdirSync(realThirdPartyExtensionsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap((entry) => {
      const manifestPath = path.join(realThirdPartyExtensionsDir, entry.name, 'openclaw.plugin.json');
      if (!fs.existsSync(manifestPath)) return [];
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        modelCatalog?: { providers?: Record<string, { models?: Array<{ id?: unknown; maxTokens?: unknown }> }> };
      };
      return Object.entries(manifest.modelCatalog?.providers ?? {}).flatMap(([providerId, provider]) => (
        (provider.models ?? []).flatMap(model => (
          typeof model.id === 'string' && typeof model.maxTokens === 'number' && model.maxTokens > 0
            ? [{ providerId, modelId: model.id, maxTokens: model.maxTokens }]
            : []
        ))
      ));
    })
);

// Guards the runtime layout itself: a provider plugin that moves out of the
// indexed directories silently drops every Anthropic-format model to 8192.
describe.skipIf(!fs.existsSync(realThirdPartyExtensionsDir))('local OpenClaw runtime', () => {
  beforeEach(() => {
    mockState.appPath = process.cwd();
    resetOpenClawCatalogMaxTokensCacheForTest();
  });

  afterEach(() => {
    resetOpenClawCatalogMaxTokensCacheForTest();
  });

  test('indexes every catalog row of the preinstalled provider plugins', () => {
    const rows = listRealCatalogRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(
        resolveOpenClawCatalogModelMaxTokens(row.providerId, row.modelId),
        `${row.providerId}/${row.modelId}`,
      ).toBe(row.maxTokens);
    }
  });
});
