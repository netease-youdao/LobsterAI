import type { OAuthModel } from '../types';

const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';
const DEFAULT_USER_AGENT = 'antigravity/1.15.8 darwin/arm64';
const GOOGLE_API_CLIENT = 'google-cloud-sdk vscode_cloudshelleditor/0.1';

const CODE_ASSIST_ENDPOINTS = [
  'https://cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
] as const;

const MODEL_ALIASES: Record<string, string> = {
  'gemini-3-pro': 'gemini-3.1-pro-low',
  'gemini-3-pro-low': 'gemini-3.1-pro-low',
  'gemini-3-pro-high': 'gemini-3.1-pro-high',
  'gemini-3-pro-image': 'gemini-3.1-pro-low',
  'claude-opus-4-5-thinking': 'claude-opus-4-6-thinking',
  'claude-opus-4.5-thinking': 'claude-opus-4-6-thinking',
  'claude-opus-4-5': 'claude-opus-4-6',
  'claude-opus-4.5': 'claude-opus-4-6',
};

export const ANTIGRAVITY_PROVIDER_KEY = 'antigravity' as const;
export const ANTIGRAVITY_OAUTH_PROVIDER_ID = 'google-antigravity' as const;
export const ANTIGRAVITY_DEFAULT_BASE_URL = 'https://daily-cloudcode-pa.sandbox.googleapis.com';

export const DEFAULT_ANTIGRAVITY_MODELS: OAuthModel[] = [
  { id: 'google-antigravity/claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)', supportsImage: true },
  { id: 'google-antigravity/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', supportsImage: true },
  { id: 'google-antigravity/claude-sonnet-4-5-thinking', name: 'Claude Sonnet 4.5 Thinking', supportsImage: true },
  { id: 'google-antigravity/gemini-3-flash', name: 'Gemini 3 Flash', supportsImage: true },
  { id: 'google-antigravity/gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low)', supportsImage: true },
  { id: 'google-antigravity/gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)', supportsImage: true },
  { id: 'google-antigravity/gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', supportsImage: false },
];

type OAuthApiKeyPayload = {
  token: string;
  projectId: string;
};

const toOptionalRecord = (value: unknown): Record<string, unknown> | null => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
};

const toOptionalString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

const toOptionalNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

const supportsImageByModelId = (modelId: string): boolean => {
  const normalized = modelId.toLowerCase();
  if (normalized.includes('gpt-oss')) {
    return false;
  }
  if (normalized.includes('text-only')) {
    return false;
  }
  return true;
};

export const normalizeAntigravityModelId = (modelId: string): string => {
  const trimmed = modelId.trim().toLowerCase();
  if (!trimmed) {
    return trimmed;
  }
  const withoutPrefix = trimmed.startsWith('google-antigravity/')
    ? trimmed.slice('google-antigravity/'.length)
    : trimmed;
  return MODEL_ALIASES[withoutPrefix] || withoutPrefix;
};

const ensureAntigravityModelPrefix = (modelId: string): string => {
  const normalized = normalizeAntigravityModelId(modelId);
  if (!normalized) {
    return '';
  }
  return `google-antigravity/${normalized}`;
};

const sanitizeModelDisplayName = (modelId: string, displayName?: string): string => {
  const trimmedDisplayName = displayName?.trim();
  if (trimmedDisplayName) {
    return trimmedDisplayName;
  }
  const normalized = normalizeAntigravityModelId(modelId);
  return normalized
    .split('-')
    .map((chunk) => (chunk ? chunk[0].toUpperCase() + chunk.slice(1) : chunk))
    .join(' ');
};

const buildCodeAssistHeaders = (accessToken: string): Record<string, string> => ({
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
  'User-Agent': DEFAULT_USER_AGENT,
  'X-Goog-Api-Client': GOOGLE_API_CLIENT,
});

const parseModelList = (payload: unknown): OAuthModel[] => {
  const record = toOptionalRecord(payload);
  if (!record) {
    return [];
  }

  const parsedModels: OAuthModel[] = [];
  const models = record.models;
  if (models && typeof models === 'object' && !Array.isArray(models)) {
    for (const [rawId, rawInfo] of Object.entries(models as Record<string, unknown>)) {
      const normalizedId = ensureAntigravityModelPrefix(rawId);
      if (!normalizedId) {
        continue;
      }
      const info = toOptionalRecord(rawInfo) || {};
      parsedModels.push({
        id: normalizedId,
        name: sanitizeModelDisplayName(rawId, toOptionalString(info.displayName)),
        supportsImage: supportsImageByModelId(rawId),
      });
    }
  } else if (Array.isArray(models)) {
    for (const item of models) {
      const entry = toOptionalRecord(item);
      if (!entry) continue;
      const rawId = toOptionalString(entry.id) || toOptionalString(entry.modelId);
      if (!rawId) continue;
      const normalizedId = ensureAntigravityModelPrefix(rawId);
      if (!normalizedId) continue;
      parsedModels.push({
        id: normalizedId,
        name: sanitizeModelDisplayName(rawId, toOptionalString(entry.displayName) || toOptionalString(entry.name)),
        supportsImage: supportsImageByModelId(rawId),
      });
    }
  }

  const deduped = new Map<string, OAuthModel>();
  for (const model of parsedModels) {
    if (!model.id) continue;
    if (!deduped.has(model.id)) {
      deduped.set(model.id, model);
    }
  }
  return Array.from(deduped.values()).slice(0, 120);
};

export async function fetchAntigravityModels(params: {
  accessToken: string;
  projectId?: string;
}): Promise<OAuthModel[]> {
  const headers = buildCodeAssistHeaders(params.accessToken);
  let lastError: Error | null = null;
  const requestedProjectId = toOptionalString(params.projectId);
  const bodyCandidates: Array<Record<string, string>> = [];

  if (requestedProjectId) {
    bodyCandidates.push({ project: requestedProjectId });
  }
  bodyCandidates.push({});
  if (!requestedProjectId || requestedProjectId !== DEFAULT_PROJECT_ID) {
    bodyCandidates.push({ project: DEFAULT_PROJECT_ID });
  }

  const dedupedBodyCandidates = bodyCandidates.filter((candidate, index, list) => {
    const serialized = JSON.stringify(candidate);
    return list.findIndex((item) => JSON.stringify(item) === serialized) === index;
  });

  for (const endpoint of CODE_ASSIST_ENDPOINTS) {
    for (const requestBody of dedupedBodyCandidates) {
      try {
        const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(
            `fetchAvailableModels failed (${response.status}) [endpoint=${endpoint}, body=${JSON.stringify(requestBody)}]: ${text}`
          );
        }
        const payload = await response.json();
        return parseModelList(payload);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error('fetchAvailableModels failed');
}

export const toOAuthApiKeyPayload = (payload: OAuthApiKeyPayload): string => {
  return JSON.stringify({
    token: payload.token,
    projectId: payload.projectId || DEFAULT_PROJECT_ID,
  });
};

export const parseOAuthApiKeyPayload = (raw: string): OAuthApiKeyPayload => {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('OAuth API key payload is empty.');
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const token = toOptionalString(parsed.token);
    const projectId = toOptionalString(parsed.projectId) || DEFAULT_PROJECT_ID;
    if (!token) {
      throw new Error('OAuth API key payload missing token.');
    }
    return { token, projectId };
  } catch {
    return { token: trimmed, projectId: DEFAULT_PROJECT_ID };
  }
};

export const mergeAntigravityModels = (
  preferred: OAuthModel[] | null | undefined,
  fallback?: OAuthModel[] | null
): OAuthModel[] => {
  const merged = new Map<string, OAuthModel>();

  const push = (items?: OAuthModel[] | null) => {
    if (!items || items.length === 0) {
      return;
    }
    for (const item of items) {
      const normalizedId = ensureAntigravityModelPrefix(item.id || '');
      if (!normalizedId) {
        continue;
      }
      if (!merged.has(normalizedId)) {
        merged.set(normalizedId, {
          id: normalizedId,
          name: item.name?.trim() || sanitizeModelDisplayName(normalizedId),
          supportsImage: item.supportsImage ?? supportsImageByModelId(normalizedId),
        });
      }
    }
  };

  push(preferred);
  push(fallback);
  push(DEFAULT_ANTIGRAVITY_MODELS);

  return Array.from(merged.values()).slice(0, 120);
};

export const normalizeAntigravityModelList = (models: OAuthModel[]): OAuthModel[] => {
  return mergeAntigravityModels(models, null).map((model) => ({
    id: ensureAntigravityModelPrefix(model.id),
    name: model.name.slice(0, 120),
    supportsImage: model.supportsImage ?? supportsImageByModelId(model.id),
  }));
};

export const getAntigravityProjectId = (rawProjectId: unknown): string => {
  return toOptionalString(rawProjectId) || DEFAULT_PROJECT_ID;
};

export const getAntigravityTokenHint = (rawToken: unknown): string => {
  const token = toOptionalString(rawToken);
  if (!token) {
    return '';
  }
  return token.slice(0, 8);
};

export const getAntigravityTokenExpiry = (rawExpiresAt: unknown): number => {
  return toOptionalNumber(rawExpiresAt) || 0;
};
