import { app } from 'electron';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';

type OpenClawCatalogModel = {
  id?: unknown;
  maxTokens?: unknown;
};

type OpenClawCatalogProvider = {
  models?: unknown;
};

type OpenClawCatalogManifest = {
  providers?: unknown;
  providerAuthAliases?: Record<string, unknown>;
  modelCatalog?: {
    aliases?: Record<string, { provider?: unknown; model?: unknown }>;
    providers?: Record<string, OpenClawCatalogProvider>;
  };
  modelIdNormalization?: {
    providers?: Record<string, { aliases?: Record<string, unknown> }>;
  };
};

type OpenClawCatalogIndex = {
  maxTokensByKey: Map<string, number>;
  providerAliases: Map<string, string>;
  modelAliasesByProvider: Map<string, Map<string, string>>;
};

const runtimeRequire = createRequire(__filename);
let cachedCatalogIndex: OpenClawCatalogIndex | null | undefined;

const isPositiveNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const normalizeLookupPart = (value: string): string => value.trim().toLowerCase();

const compactLookupPart = (value: string): string =>
  normalizeLookupPart(value).replace(/[^a-z0-9]/g, '');

const catalogKey = (providerId: string, modelId: string): string =>
  `${normalizeLookupPart(providerId)}/${normalizeLookupPart(modelId)}`;

// The bundled OpenClaw catalog may be unavailable in CI or in a trimmed
// runtime, but LobsterAI still needs to write correct limits for known native
// Anthropic-format providers. Keep this fallback scoped to official provider
// IDs so custom providers do not inherit limits by model-name coincidence.
const BUILT_IN_MODEL_MAX_TOKENS = new Map<string, number>([
  ['anthropic/claude-sonnet-4-6', 64_000],
  ['anthropic/claude-sonnet-4.6', 64_000],
  ['minimax/minimax-m3', 131_072],
  ['minimax/minimax-m2.7', 131_072],
  ['minimax/minimax-m2.7-highspeed', 131_072],
  ['minimax/minimax-m2.5', 131_072],
  ['minimax/minimax-m2.5-highspeed', 131_072],
  ['minimax-portal/minimax-m3', 131_072],
  ['minimax-portal/minimax-m2.7', 131_072],
  ['minimax-portal/minimax-m2.7-highspeed', 131_072],
  ['minimax-portal/minimax-m2.5', 131_072],
  ['minimax-portal/minimax-m2.5-highspeed', 131_072],
]);

const BUILT_IN_PROVIDER_ALIASES = new Map<string, string>([
  ['minimax-cn', 'minimax'],
  ['minimax-portal-cn', 'minimax-portal'],
]);

const resolveBuiltInModelMaxTokens = (
  providerId: string,
  modelId: string,
): number | undefined => {
  const normalizedProvider = normalizeLookupPart(providerId);
  const providerCandidate = BUILT_IN_PROVIDER_ALIASES.get(normalizedProvider) ?? normalizedProvider;
  if (!providerCandidate) return undefined;

  const normalizedModel = normalizeLookupPart(modelId);
  const modelCandidates = [
    normalizedModel,
    normalizedModel.includes('/')
      ? normalizedModel.slice(normalizedModel.lastIndexOf('/') + 1)
      : '',
    normalizedModel.startsWith('claude-') && normalizedModel.includes('.')
      ? normalizedModel.replace(/\./g, '-')
      : '',
  ].filter(Boolean);

  for (const modelCandidate of Array.from(new Set(modelCandidates))) {
    const maxTokens = BUILT_IN_MODEL_MAX_TOKENS.get(catalogKey(providerCandidate, modelCandidate));
    if (isPositiveNumber(maxTokens)) {
      return maxTokens;
    }
  }
  return undefined;
};

const readJsonFile = <T>(filePath: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
};

const findExistingPath = (candidates: string[]): string | null => {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!fs.existsSync(candidate)) continue;
    try {
      return fs.realpathSync(candidate);
    } catch {
      return candidate;
    }
  }
  return null;
};

const resolveOpenClawRuntimeRoot = (): string | null => {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'cfmind')]
    : [
        path.join(app.getAppPath(), 'vendor', 'openclaw-runtime', 'current'),
        path.join(process.cwd(), 'vendor', 'openclaw-runtime', 'current'),
      ];
  return findExistingPath(candidates);
};

const listExtensionDirs = (runtimeRoot: string): string[] => {
  const extensionsRoot = path.join(runtimeRoot, 'dist', 'extensions');
  try {
    return fs.readdirSync(extensionsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(extensionsRoot, entry.name));
  } catch {
    return [];
  }
};

const addProviderAlias = (
  index: OpenClawCatalogIndex,
  alias: unknown,
  provider: unknown,
): void => {
  if (typeof alias !== 'string' || typeof provider !== 'string') return;
  const normalizedAlias = normalizeLookupPart(alias);
  const normalizedProvider = normalizeLookupPart(provider);
  if (normalizedAlias && normalizedProvider) {
    index.providerAliases.set(normalizedAlias, normalizedProvider);
  }
};

const addModelAlias = (
  index: OpenClawCatalogIndex,
  providerId: string,
  alias: unknown,
  modelId: unknown,
): void => {
  if (typeof alias !== 'string' || typeof modelId !== 'string') return;
  const normalizedProvider = normalizeLookupPart(providerId);
  const normalizedAlias = normalizeLookupPart(alias);
  const normalizedModelId = normalizeLookupPart(modelId);
  if (!normalizedProvider || !normalizedAlias || !normalizedModelId) return;
  const aliases = index.modelAliasesByProvider.get(normalizedProvider) ?? new Map<string, string>();
  aliases.set(normalizedAlias, normalizedModelId);
  index.modelAliasesByProvider.set(normalizedProvider, aliases);
};

const indexProviderModels = (
  index: OpenClawCatalogIndex,
  providerId: string,
  providerConfig: OpenClawCatalogProvider | undefined,
): void => {
  const normalizedProvider = normalizeLookupPart(providerId);
  if (!normalizedProvider || !Array.isArray(providerConfig?.models)) return;
  for (const rawModel of providerConfig.models) {
    const model = rawModel as OpenClawCatalogModel;
    if (typeof model.id !== 'string' || !isPositiveNumber(model.maxTokens)) continue;
    index.maxTokensByKey.set(catalogKey(normalizedProvider, model.id), model.maxTokens);
  }
};

const readManifestProviderIds = (manifest: OpenClawCatalogManifest): string[] => {
  if (!Array.isArray(manifest.providers)) return [];
  return manifest.providers
    .filter((providerId): providerId is string => typeof providerId === 'string' && providerId.trim().length > 0);
};

const indexManifestCatalog = (
  index: OpenClawCatalogIndex,
  manifest: OpenClawCatalogManifest,
): void => {
  for (const [providerId, providerConfig] of Object.entries(manifest.modelCatalog?.providers ?? {})) {
    indexProviderModels(index, providerId, providerConfig);
  }

  for (const [alias, target] of Object.entries(manifest.modelCatalog?.aliases ?? {})) {
    addProviderAlias(index, alias, target.provider);
  }
  for (const [alias, provider] of Object.entries(manifest.providerAuthAliases ?? {})) {
    addProviderAlias(index, alias, provider);
  }

  for (const [providerId, config] of Object.entries(manifest.modelIdNormalization?.providers ?? {})) {
    for (const [alias, modelId] of Object.entries(config.aliases ?? {})) {
      addModelAlias(index, providerId, alias, modelId);
    }
  }
};

const selectProviderIdsForBuilder = (
  builderName: string,
  providerIds: string[],
): string[] => {
  const strippedName = builderName
    .replace(/^build/i, '')
    .replace(/Provider$/i, '')
    .replace(/StaticCatalog$/i, '')
    .replace(/Catalog$/i, '');
  const builderKey = compactLookupPart(strippedName);
  if (!builderKey) return [];
  const matches = providerIds
    .map(providerId => ({ providerId, key: compactLookupPart(providerId) }))
    .filter(({ key }) => key && builderKey.includes(key));
  if (matches.length === 0) return providerIds.length === 1 ? [providerIds[0]] : [];
  const longest = Math.max(...matches.map(match => match.key.length));
  return matches
    .filter(match => match.key.length === longest)
    .map(match => match.providerId);
};

const indexProviderCatalogBuilders = (
  index: OpenClawCatalogIndex,
  extensionDir: string,
  providerIds: string[],
): void => {
  const providerCatalogPath = path.join(extensionDir, 'provider-catalog.js');
  if (!providerIds.length || !fs.existsSync(providerCatalogPath)) return;

  let providerCatalogModule: Record<string, unknown>;
  try {
    providerCatalogModule = runtimeRequire(providerCatalogPath) as Record<string, unknown>;
  } catch {
    return;
  }

  for (const [exportName, exported] of Object.entries(providerCatalogModule)) {
    if (typeof exported !== 'function' || !/^build.*Provider$/.test(exportName)) continue;
    const matchedProviderIds = selectProviderIdsForBuilder(exportName, providerIds);
    if (matchedProviderIds.length === 0) continue;

    let providerConfig: OpenClawCatalogProvider | undefined;
    try {
      providerConfig = exported(process.env) as OpenClawCatalogProvider;
    } catch {
      continue;
    }
    for (const providerId of matchedProviderIds) {
      indexProviderModels(index, providerId, providerConfig);
    }
  }
};

const buildOpenClawCatalogIndex = (): OpenClawCatalogIndex | null => {
  const runtimeRoot = resolveOpenClawRuntimeRoot();
  if (!runtimeRoot) return null;

  const index: OpenClawCatalogIndex = {
    maxTokensByKey: new Map<string, number>(),
    providerAliases: new Map<string, string>(),
    modelAliasesByProvider: new Map<string, Map<string, string>>(),
  };

  for (const extensionDir of listExtensionDirs(runtimeRoot)) {
    const manifest = readJsonFile<OpenClawCatalogManifest>(path.join(extensionDir, 'openclaw.plugin.json'));
    if (!manifest) continue;
    indexManifestCatalog(index, manifest);
    indexProviderCatalogBuilders(index, extensionDir, readManifestProviderIds(manifest));
  }

  return index;
};

const getOpenClawCatalogIndex = (): OpenClawCatalogIndex | null => {
  if (cachedCatalogIndex !== undefined) {
    return cachedCatalogIndex;
  }
  cachedCatalogIndex = buildOpenClawCatalogIndex();
  return cachedCatalogIndex;
};

const resolveProviderCandidates = (
  index: OpenClawCatalogIndex,
  providerId: string,
): string[] => {
  const normalized = normalizeLookupPart(providerId);
  if (!normalized) return [];
  const canonical = index.providerAliases.get(normalized);
  return Array.from(new Set([normalized, ...(canonical ? [canonical] : [])]));
};

const resolveModelCandidates = (
  index: OpenClawCatalogIndex,
  providerId: string,
  modelId: string,
): string[] => {
  const normalized = normalizeLookupPart(modelId);
  if (!normalized) return [];
  const candidates = [normalized];
  const aliases = index.modelAliasesByProvider.get(providerId);
  const aliasTarget = aliases?.get(normalized);
  if (aliasTarget) candidates.push(aliasTarget);
  if (normalized.includes('/')) {
    candidates.push(normalized.slice(normalized.lastIndexOf('/') + 1));
  }
  if (normalized.startsWith('claude-') && normalized.includes('.')) {
    candidates.push(normalized.replace(/\./g, '-'));
  }
  return Array.from(new Set(candidates.filter(Boolean)));
};

export const resolveOpenClawCatalogModelMaxTokens = (
  providerId: string,
  modelId: string,
): number | undefined => {
  const index = getOpenClawCatalogIndex();
  if (!index) return resolveBuiltInModelMaxTokens(providerId, modelId);

  for (const providerCandidate of resolveProviderCandidates(index, providerId)) {
    for (const modelCandidate of resolveModelCandidates(index, providerCandidate, modelId)) {
      const maxTokens = index.maxTokensByKey.get(catalogKey(providerCandidate, modelCandidate));
      if (isPositiveNumber(maxTokens)) {
        return maxTokens;
      }
    }
  }
  return resolveBuiltInModelMaxTokens(providerId, modelId);
};

export const resetOpenClawCatalogMaxTokensCacheForTest = (): void => {
  cachedCatalogIndex = undefined;
};
