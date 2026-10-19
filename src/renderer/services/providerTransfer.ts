import { ApiFormat, ProviderAuthType } from '../../shared/providers';
import {
  getEffectiveApiFormat,
  type Model,
  type ProviderConfig,
  providerKeys,
  type ProvidersConfig,
  type ProviderType,
  resolveBaseUrl,
  resolveModelSupportsImageForProvider,
} from '../components/settings/modelProviderUtils';
import { EXPORT_FORMAT_TYPE } from '../constants/app';
import { decryptLegacyProviderKey } from './legacyProviderImport';
import { decryptProviderTransfer, encryptProviderTransfer, validateEncryptedProvidersFile } from './providerTransferCrypto';
import {
  type EncryptedProvidersFile,
  isTransferRecord,
  parseTransferJson,
  ProviderTransferCrypto,
  ProviderTransferError,
  ProviderTransferErrorCode,
  ProviderTransferLimits,
  ProviderTransferMode,
  ProviderTransferVersion,
  requireTransfer,
} from './providerTransferTypes';

type TransferProvider = Partial<Pick<ProviderConfig,
  'enabled' | 'apiKey' | 'baseUrl' | 'apiFormat' | 'codingPlanEnabled' | 'models' | 'displayName'>>;
type TransferProviders = Record<string, TransferProvider>;

export type ParsedProvidersImport =
  | { mode: typeof ProviderTransferMode.Encrypted; file: EncryptedProvidersFile; legacy: false }
  | { mode: typeof ProviderTransferMode.Configuration; providers: TransferProviders; legacy: false }
  | { mode: typeof ProviderTransferMode.Configuration; providers: Record<string, Record<string, unknown>>; legacy: true; version: number };

const MODEL_FLAGS = ['supportsImage', 'supportsVideo', 'supportsThinking'] as const;
const MODEL_NUMBERS = ['contextWindow', 'maxTokens'] as const;
const MODEL_FIELDS = ['id', 'name', ...MODEL_FLAGS, ...MODEL_NUMBERS, 'customParams'];
const PROVIDER_FIELDS = ['enabled', 'apiKey', 'baseUrl', 'apiFormat', 'codingPlanEnabled', 'models', 'displayName'];
const knownProviders = new Set<string>(providerKeys);

const validateModels = (value: unknown, includeSecrets: boolean, strict: boolean): Model[] => {
  requireTransfer(Array.isArray(value) && value.length <= ProviderTransferLimits.Models);
  return value.map(model => {
    requireTransfer(isTransferRecord(model) && typeof model.id === 'string' && typeof model.name === 'string');
    if (strict) requireTransfer(Object.keys(model).every(key => MODEL_FIELDS.includes(key)));
    const result: Model = { id: model.id, name: model.name };
    for (const flag of MODEL_FLAGS) {
      if (model[flag] !== undefined) {
        requireTransfer(typeof model[flag] === 'boolean');
        result[flag] = model[flag];
      }
    }
    for (const field of MODEL_NUMBERS) {
      if (model[field] !== undefined) {
        requireTransfer(typeof model[field] === 'number' && Number.isFinite(model[field]) && model[field] > 0);
        result[field] = model[field];
      }
    }
    if (model.customParams !== undefined) {
      requireTransfer(includeSecrets && isTransferRecord(model.customParams));
      result.customParams = model.customParams;
    }
    return result;
  });
};

// Opaque model parameters and URL userinfo/query/fragment may contain credentials.
// Configuration-only exports omit them; encrypted exports retain the full values.
const configurationUrl = (value: string): string => {
  if (!value.trim()) return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderTransferError(ProviderTransferErrorCode.InvalidFile);
  }
  requireTransfer(url.protocol === 'https:' || url.protocol === 'http:');
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
};

const validateProvider = (entry: Record<string, unknown>, includeSecrets: boolean, strict: boolean): TransferProvider => {
  if (strict) requireTransfer(Object.keys(entry).every(key => PROVIDER_FIELDS.includes(key)));
  const result: TransferProvider = {};
  for (const flag of ['enabled', 'codingPlanEnabled'] as const) {
    if (entry[flag] !== undefined) {
      requireTransfer(typeof entry[flag] === 'boolean');
      result[flag] = entry[flag];
    }
  }
  for (const field of ['baseUrl', 'displayName'] as const) {
    if (entry[field] !== undefined) {
      requireTransfer(typeof entry[field] === 'string');
      result[field] = entry[field];
    }
  }
  if (entry.apiFormat !== undefined) {
    // v1/v2 accepted "native" as the historical Anthropic format alias.
    const format = !strict && entry.apiFormat === 'native' ? ApiFormat.Anthropic : entry.apiFormat;
    requireTransfer(Object.values(ApiFormat).includes(format as ApiFormat));
    result.apiFormat = format as ApiFormat;
  }
  if (entry.apiKey !== undefined) {
    requireTransfer(includeSecrets && typeof entry.apiKey === 'string');
    result.apiKey = entry.apiKey;
  }
  if (entry.models !== undefined) result.models = validateModels(entry.models, includeSecrets, strict);
  if (strict) {
    requireTransfer(typeof result.enabled === 'boolean' && typeof result.baseUrl === 'string');
    if (includeSecrets) requireTransfer(typeof result.apiKey === 'string');
    else requireTransfer(configurationUrl(result.baseUrl) === result.baseUrl.trim().replace(/\/$/, ''));
  }
  return result;
};

const providerEntries = (value: unknown): Array<[string, Record<string, unknown>]> => {
  requireTransfer(isTransferRecord(value));
  const entries = Object.entries(value);
  requireTransfer(entries.length > 0 && entries.length <= ProviderTransferLimits.Providers);
  requireTransfer(entries.some(([key]) => knownProviders.has(key)));
  return entries.map(([key, entry]) => {
    requireTransfer(isTransferRecord(entry));
    return [key, entry];
  });
};

const validateProviders = (value: unknown, includeSecrets: boolean, strict: boolean): TransferProviders => (
  Object.fromEntries(providerEntries(value).map(([key, entry]) => [key, validateProvider(entry, includeSecrets, strict)]))
);

export const buildProvidersExport = async (
  providers: ProvidersConfig,
  options: { includeApiKeys?: boolean; password?: string } = {},
): Promise<string> => {
  const includeSecrets = options.includeApiKeys === true;
  const entries = Object.entries(providers).filter(([key]) => knownProviders.has(key)).map(([key, provider]) => {
    const apiFormat = getEffectiveApiFormat(key, provider.apiFormat);
    const baseUrl = resolveBaseUrl(key as ProviderType, provider.baseUrl, apiFormat);
    return [key, {
      enabled: provider.enabled,
      baseUrl: includeSecrets ? baseUrl : configurationUrl(baseUrl),
      apiFormat,
      codingPlanEnabled: provider.codingPlanEnabled,
      displayName: provider.displayName,
      ...(includeSecrets ? { apiKey: provider.apiKey } : {}),
      models: provider.models?.map(model => ({
        id: model.id,
        name: model.name,
        supportsImage: resolveModelSupportsImageForProvider(key, model),
        supportsVideo: model.supportsVideo,
        supportsThinking: model.supportsThinking,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        ...(includeSecrets ? { customParams: model.customParams } : {}),
      })),
    }];
  });
  const transferProviders = validateProviders(parseTransferJson(JSON.stringify(Object.fromEntries(entries))), includeSecrets, true);
  const file = includeSecrets
    ? await encryptProviderTransfer(JSON.stringify(transferProviders), options.password ?? '')
    : {
      type: EXPORT_FORMAT_TYPE,
      version: ProviderTransferVersion.Current,
      mode: ProviderTransferMode.Configuration,
      exportedAt: new Date().toISOString(),
      providers: transferProviders,
    };
  const json = JSON.stringify(file, null, 2);
  if (new TextEncoder().encode(json).byteLength > ProviderTransferLimits.FileBytes) {
    throw new ProviderTransferError(ProviderTransferErrorCode.TooLarge);
  }
  return json;
};

export const parseProvidersImport = (raw: string): ParsedProvidersImport => {
  const file = parseTransferJson(raw);
  requireTransfer(isTransferRecord(file) && file.type === EXPORT_FORMAT_TYPE);
  if (file.version === ProviderTransferVersion.Current) {
    if (file.mode === ProviderTransferMode.Encrypted) {
      return { mode: ProviderTransferMode.Encrypted, file: validateEncryptedProvidersFile(file), legacy: false };
    }
    requireTransfer(file.mode === ProviderTransferMode.Configuration
      && typeof file.exportedAt === 'string' && Number.isFinite(Date.parse(file.exportedAt))
      && Object.keys(file).every(key => ['type', 'version', 'mode', 'exportedAt', 'providers'].includes(key)));
    return { mode: ProviderTransferMode.Configuration, providers: validateProviders(file.providers, false, true), legacy: false };
  }
  requireTransfer(file.version === ProviderTransferVersion.LocalKey || file.version === ProviderTransferVersion.LegacyPassword);
  if (file.version === ProviderTransferVersion.LegacyPassword) {
    requireTransfer(isTransferRecord(file.encryption) && file.encryption.keySource === ProviderTransferCrypto.KeySource);
  }
  return {
    mode: ProviderTransferMode.Configuration,
    providers: Object.fromEntries(providerEntries(file.providers)),
    version: file.version,
    legacy: true,
  };
};

const normalizedEndpoint = (providerKey: string, config: TransferProvider): string => {
  const format = getEffectiveApiFormat(providerKey, config.apiFormat);
  const baseUrl = resolveBaseUrl(providerKey as ProviderType, config.baseUrl ?? '', format).trim().replace(/\/+$/, '');
  // Include the path, protocol and coding-plan mode: each can change credential routing.
  return JSON.stringify([baseUrl, format, config.codingPlanEnabled ?? false]);
};

export const importProviders = async (
  parsed: ParsedProvidersImport,
  existing: ProvidersConfig,
  password = '',
): Promise<ProvidersConfig> => {
  let imported: TransferProviders;
  if (parsed.mode === ProviderTransferMode.Encrypted) {
    imported = validateProviders(parseTransferJson(await decryptProviderTransfer(parsed.file, password)), true, true);
  } else if (parsed.legacy) {
    const entries: Array<[string, TransferProvider]> = [];
    for (const [key, entry] of Object.entries(parsed.providers)) {
      const apiKey = await decryptLegacyProviderKey(entry, parsed.version);
      entries.push([key, validateProvider({ ...entry, apiKey }, true, false)]);
    }
    imported = Object.fromEntries(entries);
  } else {
    imported = parsed.providers;
  }

  // Build the complete result before the caller updates React state or persistence.
  const next = { ...existing };
  for (const [key, entry] of Object.entries(imported)) {
    if (!knownProviders.has(key)) continue;
    const current: ProviderConfig | undefined = existing[key];
    const updated: ProviderConfig = {
      ...current,
      ...entry,
      enabled: entry.enabled ?? current?.enabled ?? false,
      apiKey: entry.apiKey ?? current?.apiKey ?? '',
      baseUrl: entry.baseUrl ?? current?.baseUrl ?? '',
      apiFormat: getEffectiveApiFormat(key, entry.apiFormat ?? current?.apiFormat),
      ...(entry.models ? { models: entry.models.map(model => ({
        ...model, supportsImage: resolveModelSupportsImageForProvider(key, model),
      })) } : {}),
    };
    const endpointChanged = current && normalizedEndpoint(key, current) !== normalizedEndpoint(key, updated);
    const reusesApiKey = entry.apiKey === undefined && current?.apiKey;
    const hasOAuth = current?.oauthAccessToken || current?.oauthRefreshToken || current?.authType === ProviderAuthType.OAuth;
    // Partial imports may retain opaque model parameters containing credentials.
    const reusesCustomParams = entry.models === undefined && current?.models?.some(
      model => model.customParams && Object.keys(model.customParams).length > 0,
    );
    if (endpointChanged && (reusesApiKey || hasOAuth || reusesCustomParams)) {
      throw new ProviderTransferError(ProviderTransferErrorCode.EndpointConflict);
    }
    next[key] = updated;
  }
  return next;
};
