import {
  extractAssistantText,
  postAnthropicMessages,
  startConfiguredAntigravityProxy,
  stopProxyAndQuitApp,
} from './_proxy_common.mjs';
import { startMockOpenAIUpstream } from './_mock_openai_upstream.mjs';

const PROVIDER_MODEL_ID = 'google-antigravity/gemini-3-flash';
const MOCK_PROJECT_ID = 'mock-project';
const MOCK_TOKEN = 'mock-token';

const run = async () => {
  const mockUpstream = await startMockOpenAIUpstream({
    acceptedTokens: [MOCK_TOKEN],
    expectedProjectId: MOCK_PROJECT_ID,
    replyPrefix: 'MOCK_FLOW',
  });

  try {
    const proxyBaseURL = await startConfiguredAntigravityProxy({
      accessToken: MOCK_TOKEN,
      projectId: MOCK_PROJECT_ID,
      providerModelId: PROVIDER_MODEL_ID,
      baseURL: mockUpstream.baseURL,
    });

    const first = await postAnthropicMessages(proxyBaseURL, {
      model: PROVIDER_MODEL_ID,
      max_tokens: 128,
      stream: false,
      messages: [{ role: 'user', content: 'first turn' }],
    });
    const firstText = extractAssistantText(first);
    if (!firstText.includes('MOCK_FLOW_1')) {
      throw new Error(`第一轮返回不符合预期: ${firstText || '(empty)'}`);
    }

    const second = await postAnthropicMessages(proxyBaseURL, {
      model: PROVIDER_MODEL_ID,
      max_tokens: 128,
      stream: false,
      messages: [
        { role: 'user', content: 'first turn' },
        { role: 'assistant', content: firstText },
        { role: 'user', content: 'second turn' },
      ],
    });
    const secondText = extractAssistantText(second);
    if (!secondText.includes('MOCK_FLOW_2')) {
      throw new Error(`第二轮返回不符合预期: ${secondText || '(empty)'}`);
    }

    if (mockUpstream.requests.length !== 2) {
      throw new Error(`mock upstream 请求次数异常: ${mockUpstream.requests.length}`);
    }

    const firstReq = mockUpstream.requests[0];
    if (firstReq.projectHeader) {
      throw new Error(`默认链路不应发送 x-goog-user-project: ${firstReq.projectHeader}`);
    }
    if (firstReq.body?.model !== 'gemini-3-flash') {
      throw new Error(`模型未被正确归一化: ${firstReq.body?.model || '(empty)'}`);
    }

    console.log('[testcase_04] chat + continue flow success');
    console.log(`  proxyBaseURL: ${proxyBaseURL}`);
    console.log(`  upstreamRequests: ${mockUpstream.requests.length}`);
  } finally {
    await mockUpstream.stop();
  }
};

let exitCode = 0;

run()
  .catch((error) => {
    exitCode = 1;
    console.error(`[testcase_04] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  })
  .finally(async () => {
    await stopProxyAndQuitApp();
    process.exit(exitCode);
  });
