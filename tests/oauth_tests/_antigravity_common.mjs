import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import initSqlJs from 'sql.js';

const require = createRequire(import.meta.url);

const OAUTH_PROVIDER_ID = 'google-antigravity';
const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';
const OAUTH_REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_DB_PATH = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'LobsterAI',
  'lobsterai.sqlite'
);

const USER_AGENT = 'antigravity/1.15.8 darwin/arm64';
const GOOGLE_API_CLIENT = 'google-cloud-sdk vscode_cloudshelleditor/0.1';
const CLIENT_METADATA = JSON.stringify({
  ideType: 'IDE_UNSPECIFIED',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI',
});

const ENDPOINTS = [
  'https://cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
];

const normalizeString = (value, fallback = '') => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return fallback;
};

const normalizeModelId = (modelId) => {
  const normalized = normalizeString(modelId).toLowerCase();
  if (!normalized) return '';
  return normalized.startsWith('google-antigravity/')
    ? normalized.slice('google-antigravity/'.length)
    : normalized;
};

const getWasmPath = () => require.resolve('sql.js/dist/sql-wasm.wasm');

export const resolveDbPath = () => normalizeString(process.env.LOBSTER_DB_PATH, DEFAULT_DB_PATH);

const loadSqlJs = async () => {
  const wasmPath = getWasmPath();
  return initSqlJs({ locateFile: () => wasmPath });
};

export const loadOAuthProfile = async () => {
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error(`数据库文件不存在: ${dbPath}`);
  }

  const SQL = await loadSqlJs();
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const result = db.exec(
    `
      SELECT access_token, refresh_token, expires_at_ms, project_id, email
      FROM oauth_profiles
      WHERE provider_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [OAUTH_PROVIDER_ID]
  );
  db.close();

  const row = result?.[0]?.values?.[0];
  if (!row) {
    throw new Error('未找到 antigravity OAuth 凭证，请先在设置页完成登录。');
  }

  const accessToken = normalizeString(row[0]);
  const refreshToken = normalizeString(row[1]);
  const expiresAtMs = Number(row[2]) || 0;
  const projectId = normalizeString(row[3], DEFAULT_PROJECT_ID);
  const email = normalizeString(row[4], '');

  if (!accessToken) {
    throw new Error('OAuth access_token 为空。');
  }
  if (!refreshToken) {
    throw new Error('OAuth refresh_token 为空。');
  }

  const profile = { accessToken, refreshToken, expiresAtMs, projectId, email, dbPath };
  return ensureFreshAccessToken(profile);
};

const persistRefreshedToken = async ({ dbPath, accessToken, refreshToken, expiresAtMs }) => {
  const SQL = await loadSqlJs();
  const db = new SQL.Database(fs.readFileSync(dbPath));
  db.run(
    `
      UPDATE oauth_profiles
      SET access_token = ?, refresh_token = ?, expires_at_ms = ?, updated_at = ?
      WHERE provider_id = ?
    `,
    [accessToken, refreshToken, Math.floor(expiresAtMs), Date.now(), OAUTH_PROVIDER_ID]
  );
  const data = db.export();
  db.close();
  fs.writeFileSync(dbPath, Buffer.from(data));
};

export const ensureFreshAccessToken = async (profile) => {
  const expiry = Number(profile.expiresAtMs) || 0;
  const needsRefresh = !Number.isFinite(expiry) || Date.now() >= (expiry - OAUTH_REFRESH_SKEW_MS);
  if (!needsRefresh) {
    return profile;
  }

  try {
    const piAi = await import('@mariozechner/pi-ai');
    const refreshed = await piAi.refreshAntigravityToken(
      profile.refreshToken,
      normalizeString(profile.projectId, DEFAULT_PROJECT_ID)
    );
    const nextAccessToken = normalizeString(refreshed?.access);
    const nextRefreshToken = normalizeString(refreshed?.refresh, profile.refreshToken);
    const nextExpiresAtMs = Number(refreshed?.expires) || 0;
    if (!nextAccessToken || nextExpiresAtMs <= 0) {
      throw new Error('OAuth refresh 响应不合法。');
    }
    await persistRefreshedToken({
      dbPath: profile.dbPath,
      accessToken: nextAccessToken,
      refreshToken: nextRefreshToken,
      expiresAtMs: nextExpiresAtMs,
    });

    return {
      ...profile,
      accessToken: nextAccessToken,
      refreshToken: nextRefreshToken,
      expiresAtMs: nextExpiresAtMs,
    };
  } catch (error) {
    return {
      ...profile,
      refreshError: error instanceof Error ? error.message : String(error),
    };
  }
};

const parseModelList = (payload) => {
  const models = payload?.models;
  if (!models) return [];

  if (Array.isArray(models)) {
    return models
      .map((item) => {
        const id = normalizeModelId(item?.id || item?.modelId);
        const name = normalizeString(item?.displayName || item?.name, id);
        return id ? { id, name } : null;
      })
      .filter(Boolean);
  }

  if (typeof models === 'object') {
    return Object.entries(models)
      .map(([rawId, info]) => {
        const id = normalizeModelId(rawId);
        const name = normalizeString(info?.displayName, id);
        return id ? { id, name } : null;
      })
      .filter(Boolean);
  }

  return [];
};

const fetchJson = async ({ endpoint, route, token, projectId, body, includeProjectHeader = false }) => {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    'X-Goog-Api-Client': GOOGLE_API_CLIENT,
  };
  if (includeProjectHeader && projectId) {
    headers['X-Goog-User-Project'] = projectId;
  }

  let response;
  try {
    response = await fetch(`${endpoint}${route}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new Error(`${endpoint}${route} -> network error: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const errorText = typeof data === 'string'
      ? data
      : JSON.stringify(data || {});
    throw new Error(`${endpoint}${route} -> ${response.status} ${errorText}`);
  }

  return data || {};
};

export const fetchAntigravityModels = async ({ token, projectId }) => {
  const requestedProjectId = normalizeString(projectId);
  const bodyCandidates = [];
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

  let lastError = null;
  for (const endpoint of ENDPOINTS) {
    for (const requestBody of dedupedBodyCandidates) {
      try {
        const payload = await fetchJson({
          endpoint,
          route: '/v1internal:fetchAvailableModels',
          token,
          projectId: requestedProjectId,
          body: requestBody,
        });
        return parseModelList(payload);
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError || new Error('fetchAvailableModels 请求失败');
};

const getGeminiCandidateModels = (models) => {
  const candidates = models.map((item) => item.id);
  const preferredOrder = [
    'gemini-3-flash',
    'gemini-3.1-pro-low',
    'gemini-3.1-pro-high',
    'gemini-3-pro-low',
    'gemini-3-pro-high',
    'gemini-3-pro-image',
    'gemini-3-pro',
    'gemini-3',
  ];

  const ordered = [];
  for (const preferred of preferredOrder) {
    const matched = candidates.find((id) => id === preferred);
    if (matched && !ordered.includes(matched)) {
      ordered.push(matched);
    }
  }

  for (const id of candidates) {
    if (id.startsWith('gemini-3') && !ordered.includes(id)) {
      ordered.push(id);
    }
  }

  return ordered;
};

const buildAntigravityStreamRequestBody = ({ projectId, model, prompt }) => ({
  project: normalizeString(projectId, DEFAULT_PROJECT_ID),
  model,
  request: {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
  },
  requestType: 'agent',
  userAgent: 'antigravity',
  requestId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
});

const extractTextFromStreamChunk = (chunk) => {
  const response = chunk?.response;
  const candidate = response?.candidates?.[0];
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) {
    return '';
  }
  return parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('');
};

const callAntigravityStream = async ({ endpoint, token, projectId, model, prompt }) => {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': USER_AGENT,
    'X-Goog-Api-Client': GOOGLE_API_CLIENT,
    'Client-Metadata': CLIENT_METADATA,
  };

  const route = '/v1internal:streamGenerateContent?alt=sse';
  const response = await fetch(`${endpoint}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(
      buildAntigravityStreamRequestBody({
        projectId,
        model,
        prompt,
      })
    ),
    signal: AbortSignal.timeout(30000),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`${endpoint}${route} -> ${response.status} ${raw || '(empty response)'}`);
  }

  const lines = raw.split('\n');
  let text = '';
  for (const line of lines) {
    if (!line.startsWith('data:')) {
      continue;
    }
    const jsonStr = line.slice(5).trim();
    if (!jsonStr || jsonStr === '[DONE]') {
      continue;
    }
    try {
      const chunk = JSON.parse(jsonStr);
      text += extractTextFromStreamChunk(chunk);
    } catch {
      // ignore non-json chunk
    }
  }

  return {
    endpoint,
    route,
    model,
    content: text.trim(),
  };
};

export const callGemini3Chat = async ({ token, projectId, models }) => {
  const candidates = getGeminiCandidateModels(models);
  if (!candidates.length) {
    throw new Error('当前可用模型中未找到 Gemini 3 系列模型。');
  }

  let lastError = null;
  for (const model of candidates) {
    for (const endpoint of ENDPOINTS) {
      try {
        const result = await callAntigravityStream({
          endpoint,
          token,
          projectId,
          model,
          prompt: 'reply exactly: OK',
        });
        if (!result.content) {
          throw new Error(`${endpoint}${result.route} -> empty stream content`);
        }
        if (/no longer available|not available/i.test(result.content)) {
          lastError = new Error(`${model}: ${result.content}`);
          continue;
        }
        return result;
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error('Gemini 3 对话请求失败');
};

export const formatExpiry = (expiresAtMs) => {
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return 'unknown';
  return new Date(expiresAtMs).toISOString();
};
