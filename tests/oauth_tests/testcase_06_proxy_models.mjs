import {
  extractAssistantText,
  getProxyModels,
  postAnthropicMessages,
  startConfiguredAntigravityProxy,
  stopProxyAndQuitApp,
} from './_proxy_common.mjs';
import { startMockOpenAIUpstream } from './_mock_openai_upstream.mjs';

const PROVIDER_MODEL_ID = 'google-antigravity/gemini-3-flash';
const MOCK_PROJECT_ID = 'mock-project';
const STALE_TOKEN = 'stale-token';
const FRESH_TOKEN = 'fresh-token';

const run = async () => {
  const mockUpstream = await startMockOpenAIUpstream({
    acceptedTokens: [FRESH_TOKEN],
    expectedProjectId: MOCK_PROJECT_ID,
    replyPrefix: 'MOCK_REFRESH',
  });

  let resolveCalls = 0;
  let forceRefreshCalls = 0;

  try {
    const proxyBaseURL = await startConfiguredAntigravityProxy({
      accessToken: STALE_TOKEN,
      projectId: MOCK_PROJECT_ID,
      providerModelId: PROVIDER_MODEL_ID,
      baseURL: mockUpstream.baseURL,
      resolveAuthApiKey: async (forceRefresh = false) => {
        resolveCalls += 1;
        if (forceRefresh) {
          forceRefreshCalls += 1;
        }
        const token = forceRefresh ? FRESH_TOKEN : STALE_TOKEN;
        return JSON.stringify({
          token,
          projectId: MOCK_PROJECT_ID,
        });
      },
    });

    const models = await getProxyModels(proxyBaseURL);
    if (!models.includes(PROVIDER_MODEL_ID)) {
      throw new Error(`proxy /v1/models 缺少模型: ${PROVIDER_MODEL_ID}`);
    }

    const response = await postAnthropicMessages(proxyBaseURL, {
      model: PROVIDER_MODEL_ID,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'refresh test' }],
    });
    const text = extractAssistantText(response);
    if (!text.includes('MOCK_REFRESH_')) {
      throw new Error(`刷新重试后返回不符合预期: ${text || '(empty)'}`);
    }

    if (resolveCalls < 2 || forceRefreshCalls < 1) {
      throw new Error(`未触发预期 refresh 流程: resolve=${resolveCalls}, forceRefresh=${forceRefreshCalls}`);
    }
    if (mockUpstream.requests.length < 2) {
      throw new Error(`未观察到 401->重试流程: requests=${mockUpstream.requests.length}`);
    }

    console.log('[testcase_06] proxy models + auth refresh success');
    console.log(`  resolveCalls: ${resolveCalls}`);
    console.log(`  forceRefreshCalls: ${forceRefreshCalls}`);
    console.log(`  upstreamRequests: ${mockUpstream.requests.length}`);
  } finally {
    await mockUpstream.stop();
  }
};

let exitCode = 0;

run()
  .catch((error) => {
    exitCode = 1;
    console.error(`[testcase_06] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  })
  .finally(async () => {
    await stopProxyAndQuitApp();
    process.exit(exitCode);
  });
