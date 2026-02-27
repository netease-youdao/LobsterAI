import { app, session } from 'electron';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const {
  startCoworkOpenAICompatProxy,
  stopCoworkOpenAICompatProxy,
  configureCoworkOpenAICompatProxy,
  getCoworkOpenAICompatProxyBaseURL,
} = require('../../dist-electron/libs/coworkOpenAICompatProxy.js');

const {
  normalizeAntigravityModelId,
  toOAuthApiKeyPayload,
} = require('../../dist-electron/oauth/providers/googleAntigravity.js');

const DEFAULT_ANTIGRAVITY_BASE_URL = (
  process.env.LOBSTER_ANTIGRAVITY_BASE_URL
  && process.env.LOBSTER_ANTIGRAVITY_BASE_URL.trim()
)
  ? process.env.LOBSTER_ANTIGRAVITY_BASE_URL.trim()
  : 'https://daily-cloudcode-pa.sandbox.googleapis.com';

const GEMINI_MODEL_ORDER = [
  'gemini-3-flash',
  'gemini-3.1-pro-low',
  'gemini-3.1-pro-high',
  'gemini-3-pro-low',
  'gemini-3-pro-high',
  'gemini-3-pro-image',
];

const normalizeString = (value) => (typeof value === 'string' ? value.trim() : '');

const resolveProxyRulesFromEnv = () => (
  normalizeString(process.env.HTTPS_PROXY)
  || normalizeString(process.env.https_proxy)
  || normalizeString(process.env.HTTP_PROXY)
  || normalizeString(process.env.http_proxy)
);

const applyElectronProxyFromEnv = async () => {
  const proxyRules = resolveProxyRulesFromEnv();
  if (!proxyRules) {
    return '';
  }

  const proxyBypassRules = normalizeString(process.env.NO_PROXY)
    || normalizeString(process.env.no_proxy)
    || '<-loopback>';

  await session.defaultSession.setProxy({
    proxyRules,
    proxyBypassRules,
  });

  return proxyRules;
};

export const pickGeminiModel = (models) => {
  const candidates = models.map((item) => normalizeString(item?.id)).filter(Boolean);

  for (const preferred of GEMINI_MODEL_ORDER) {
    const matched = candidates.find((id) => id === preferred);
    if (matched) return matched;
  }

  return candidates.find((id) => id.startsWith('gemini-3')) || '';
};

export const extractAssistantText = (payload) => {
  const blocks = payload?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block?.type === 'text' && typeof block?.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
};

export const postAnthropicMessages = async (baseURL, body, timeoutMs = 60000) => {
  const response = await fetch(`${baseURL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'lobsterai-test',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const reason = typeof data === 'string' ? data : JSON.stringify(data || {});
    throw new Error(`proxy /v1/messages -> ${response.status} ${reason}`);
  }
  return data;
};

export const streamAnthropicMessages = async (baseURL, body, timeoutMs = 120000) => {
  const response = await fetch(`${baseURL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'lobsterai-test',
      'anthropic-version': '2023-06-01',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`proxy /v1/messages(stream) -> ${response.status} ${raw || '(empty response)'}`);
  }

  const events = [];
  let text = '';
  let thinking = '';
  let hasMessageStop = false;

  for (const chunk of raw.split('\n\n')) {
    const lines = chunk
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) continue;

    let eventName = '';
    let dataRaw = '';
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataRaw = line.slice('data:'.length).trim();
      }
    }
    if (!dataRaw || dataRaw === '[DONE]') continue;

    let payload = null;
    try {
      payload = JSON.parse(dataRaw);
    } catch {
      continue;
    }

    const payloadType = normalizeString(payload?.type);
    events.push(eventName || payloadType || 'unknown');
    if (payloadType === 'message_stop') {
      hasMessageStop = true;
    }
    if (payloadType === 'content_block_delta') {
      const deltaType = normalizeString(payload?.delta?.type);
      if (deltaType === 'text_delta') {
        text += normalizeString(payload?.delta?.text);
      } else if (deltaType === 'thinking_delta') {
        thinking += normalizeString(payload?.delta?.thinking);
      }
    }
  }

  return {
    events,
    hasMessageStop,
    text: text.trim(),
    thinking: thinking.trim(),
  };
};

export const getProxyModels = async (baseURL, timeoutMs = 15000) => {
  const response = await fetch(`${baseURL}/v1/models`, {
    method: 'GET',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`proxy /v1/models -> ${response.status} ${JSON.stringify(data || {})}`);
  }
  const models = Array.isArray(data?.data) ? data.data : [];
  return models
    .map((item) => normalizeString(item?.id))
    .filter(Boolean);
};

export const startConfiguredAntigravityProxy = async ({
  accessToken,
  projectId,
  providerModelId,
  baseURL = DEFAULT_ANTIGRAVITY_BASE_URL,
  resolveAuthApiKey,
  endpointMode = 'openai-chat',
}) => {
  await app.whenReady();
  const appliedProxy = await applyElectronProxyFromEnv();
  if (appliedProxy) {
    console.log(`[proxy_common] apply electron proxy: ${appliedProxy}`);
  }

  const normalizedProviderModel = normalizeString(providerModelId);
  if (!normalizedProviderModel) {
    throw new Error('providerModelId 不能为空。');
  }

  const upstreamModel = normalizeAntigravityModelId(normalizedProviderModel);
  const defaultResolver = async () =>
    toOAuthApiKeyPayload({
      token: accessToken,
      projectId,
    });

  await startCoworkOpenAICompatProxy();
  configureCoworkOpenAICompatProxy({
    baseURL,
    model: upstreamModel,
    providerModelId: normalizedProviderModel,
    provider: 'antigravity',
    upstreamKind: 'openai',
    endpointMode,
    resolveAuthApiKey: resolveAuthApiKey || defaultResolver,
  });

  const proxyBaseURL = getCoworkOpenAICompatProxyBaseURL();
  if (!proxyBaseURL) {
    throw new Error('本地 proxy baseURL 不可用。');
  }
  return proxyBaseURL;
};

export const stopProxyAndQuitApp = async () => {
  try {
    await stopCoworkOpenAICompatProxy();
  } catch {
    // ignore
  }
  app.quit();
};
