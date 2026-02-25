import { app } from 'electron';
import { createRequire } from 'module';
import { fetchAntigravityModels, loadOAuthProfile } from './_antigravity_common.mjs';

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

const pickGeminiModel = (models) => {
  const candidates = models.map((item) => item.id);
  const order = [
    'gemini-3-flash',
    'gemini-3.1-pro-low',
    'gemini-3.1-pro-high',
    'gemini-3-pro-low',
    'gemini-3-pro-high',
    'gemini-3-pro-image',
  ];

  for (const preferred of order) {
    const matched = candidates.find((id) => id === preferred);
    if (matched) return matched;
  }

  return candidates.find((id) => id.startsWith('gemini-3')) || '';
};

const extractAssistantText = (payload) => {
  const blocks = payload?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block?.type === 'text' && typeof block?.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
};

const postAnthropicMessages = async (baseURL, body) => {
  const response = await fetch(`${baseURL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'lobsterai-test',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
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

const run = async () => {
  await app.whenReady();

  const profile = await loadOAuthProfile();
  const models = await fetchAntigravityModels({
    token: profile.accessToken,
    projectId: profile.projectId,
  });

  const model = pickGeminiModel(models);
  if (!model) {
    throw new Error('可用模型中未找到 Gemini 3 系列。');
  }

  const providerModelId = `google-antigravity/${model}`;
  const upstreamModelId = normalizeAntigravityModelId(providerModelId);

  await startCoworkOpenAICompatProxy();
  configureCoworkOpenAICompatProxy({
    baseURL: 'https://daily-cloudcode-pa.sandbox.googleapis.com',
    model: upstreamModelId,
    providerModelId,
    provider: 'antigravity',
    upstreamKind: 'antigravity',
    resolveAuthApiKey: async () =>
      toOAuthApiKeyPayload({
        token: profile.accessToken,
        projectId: profile.projectId,
      }),
  });

  const proxyBaseURL = getCoworkOpenAICompatProxyBaseURL();
  if (!proxyBaseURL) {
    throw new Error('本地 proxy baseURL 不可用。');
  }

  const chatPayload = {
    model: providerModelId,
    max_tokens: 128,
    stream: false,
    messages: [
      { role: 'user', content: 'Reply with one short sentence about your model.' },
    ],
  };
  const chatResponse = await postAnthropicMessages(proxyBaseURL, chatPayload);
  const chatText = extractAssistantText(chatResponse);
  if (!chatText) {
    throw new Error('Chat 主流程返回为空。');
  }

  const coworkPayload = {
    model: providerModelId,
    max_tokens: 128,
    stream: false,
    messages: [
      { role: 'user', content: 'Remember the token FLOW_OK.' },
      { role: 'assistant', content: chatText },
      { role: 'user', content: 'Now continue this session and reply exactly: FLOW_OK' },
    ],
  };
  const coworkResponse = await postAnthropicMessages(proxyBaseURL, coworkPayload);
  const coworkText = extractAssistantText(coworkResponse);
  if (!coworkText) {
    throw new Error('Cowork 主流程返回为空。');
  }

  console.log('[testcase_04] chat + cowork flow success');
  console.log(`  proxyBaseURL: ${proxyBaseURL}`);
  console.log(`  model: ${providerModelId}`);
  console.log(`  chatReply: ${chatText}`);
  console.log(`  coworkReply: ${coworkText}`);
};

let exitCode = 0;

run()
  .catch((error) => {
    exitCode = 1;
    console.error(`[testcase_04] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  })
  .finally(async () => {
    try {
      await stopCoworkOpenAICompatProxy();
    } catch {
      // ignore
    }
    app.quit();
    process.exit(exitCode);
  });
