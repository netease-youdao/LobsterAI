import {
  startConfiguredAntigravityProxy,
  stopProxyAndQuitApp,
  streamAnthropicMessages,
} from './_proxy_common.mjs';
import { startMockOpenAIUpstream } from './_mock_openai_upstream.mjs';

const PROVIDER_MODEL_ID = 'google-antigravity/gemini-3-flash';
const MOCK_PROJECT_ID = 'mock-project';
const MOCK_TOKEN = 'mock-token';

const run = async () => {
  const mockUpstream = await startMockOpenAIUpstream({
    acceptedTokens: [MOCK_TOKEN],
    expectedProjectId: MOCK_PROJECT_ID,
    replyPrefix: 'MOCK_STREAM',
  });

  try {
    const proxyBaseURL = await startConfiguredAntigravityProxy({
      accessToken: MOCK_TOKEN,
      projectId: MOCK_PROJECT_ID,
      providerModelId: PROVIDER_MODEL_ID,
      baseURL: mockUpstream.baseURL,
    });

    const streamResult = await streamAnthropicMessages(proxyBaseURL, {
      model: PROVIDER_MODEL_ID,
      max_tokens: 128,
      messages: [{ role: 'user', content: 'stream test' }],
    });

    if (!streamResult.hasMessageStop) {
      throw new Error('SSE 未收到 message_stop。');
    }
    if (!(streamResult.text.includes('MOCK_STREAM') && streamResult.text.includes('STREAM_1'))) {
      throw new Error(`SSE 文本不符合预期: ${streamResult.text || '(empty)'}`);
    }
    if (mockUpstream.requests.length !== 1) {
      throw new Error(`mock upstream 请求次数异常: ${mockUpstream.requests.length}`);
    }

    console.log('[testcase_05] proxy stream flow success');
    console.log(`  events: ${streamResult.events.length}`);
    console.log(`  text: ${streamResult.text}`);
  } finally {
    await mockUpstream.stop();
  }
};

let exitCode = 0;

run()
  .catch((error) => {
    exitCode = 1;
    console.error(`[testcase_05] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  })
  .finally(async () => {
    await stopProxyAndQuitApp();
    process.exit(exitCode);
  });
