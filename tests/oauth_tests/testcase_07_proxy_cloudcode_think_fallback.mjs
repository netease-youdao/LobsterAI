import {
  startConfiguredAntigravityProxy,
  stopProxyAndQuitApp,
  streamAnthropicMessages,
} from './_proxy_common.mjs';
import { startMockOpenAIUpstream } from './_mock_openai_upstream.mjs';

const PROVIDER_MODEL_ID = 'google-antigravity/gemini-2.5-flash-thinking';
const MOCK_PROJECT_ID = 'mock-project';
const MOCK_TOKEN = 'mock-token';

const SCENARIOS = [
  {
    name: 'underscore',
    thinkingLevelErrorMessage: 'Unable to submit request because thinking_level is not supported by this model.',
  },
  {
    name: 'space-case',
    thinkingLevelErrorMessage: 'Thinking level LOW is not supported for this model. Please retry with other thinking level.',
  },
];

const runScenario = async (scenario) => {
  const mockUpstream = await startMockOpenAIUpstream({
    acceptedTokens: [MOCK_TOKEN],
    expectedProjectId: MOCK_PROJECT_ID,
    rejectThinkingLevel: true,
    thinkingLevelErrorMessage: scenario.thinkingLevelErrorMessage,
    cloudCodeParts: [
      { text: '思考中', thought: true },
      { text: '广州天气：晴，26C' },
    ],
  });

  try {
    const proxyBaseURL = await startConfiguredAntigravityProxy({
      accessToken: MOCK_TOKEN,
      projectId: MOCK_PROJECT_ID,
      providerModelId: PROVIDER_MODEL_ID,
      baseURL: mockUpstream.baseURL,
      endpointMode: 'cloudcode-sse',
    });

    const streamResult = await streamAnthropicMessages(proxyBaseURL, {
      model: PROVIDER_MODEL_ID,
      max_tokens: 128,
      messages: [{ role: 'user', content: '广州天气查询' }],
    });
    const firstPath = mockUpstream.requests[0]?.path || '(none)';
    const firstBody = mockUpstream.requests[0]?.body || {};
    const secondBody = mockUpstream.requests[1]?.body || {};
    const includeThoughts = secondBody?.request?.generationConfig?.thinkingConfig?.includeThoughts;
    const firstThinkingLevel = firstBody?.request?.generationConfig?.thinkingConfig?.thinkingLevel;
    const secondThinkingLevel = secondBody?.request?.generationConfig?.thinkingConfig?.thinkingLevel;

    if (!streamResult.hasMessageStop) {
      throw new Error('SSE 未收到 message_stop。');
    }
    if (mockUpstream.requests.length < 2) {
      throw new Error(`[${scenario.name}] 未触发 thinking_level 降级重试，requests=${mockUpstream.requests.length}`);
    }
    if (!firstThinkingLevel) {
      throw new Error(`[${scenario.name}] 首次请求未带 thinkingLevel，无法验证降级逻辑: ${JSON.stringify(firstBody?.request?.generationConfig || {})}`);
    }
    if (secondThinkingLevel !== undefined) {
      throw new Error(`[${scenario.name}] 重试请求仍携带 thinkingLevel: ${JSON.stringify(secondBody?.request?.generationConfig || {})}`);
    }
    if (includeThoughts !== true) {
      throw new Error(`[${scenario.name}] CloudCode 重试请求未开启 thinkingConfig.includeThoughts: ${JSON.stringify(secondBody?.request?.generationConfig || {})}`);
    }
    if (!streamResult.thinking.includes('思考中')) {
      throw new Error(`[${scenario.name}] 未解析出 thinking 内容: thinking=${streamResult.thinking || '(empty)'} text=${streamResult.text || '(empty)'} upstreamPath=${firstPath}`);
    }
    if (!streamResult.text.includes('广州天气：晴，26C')) {
      throw new Error(`[${scenario.name}] 未解析出正文内容: ${streamResult.text || '(empty)'}`);
    }

    console.log(`[testcase_07] scenario=${scenario.name} cloudcode thinking_level fallback success`);
    console.log(`  thinking: ${streamResult.thinking}`);
    console.log(`  text: ${streamResult.text}`);
  } finally {
    await mockUpstream.stop();
  }
};

const run = async () => {
  for (const scenario of SCENARIOS) {
    await runScenario(scenario);
  }
};

let exitCode = 0;

run()
  .catch((error) => {
    exitCode = 1;
    console.error(`[testcase_07] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  })
  .finally(async () => {
    await stopProxyAndQuitApp();
    process.exit(exitCode);
  });
