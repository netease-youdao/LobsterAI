import { fetchAntigravityModels, loadOAuthProfile } from './_antigravity_common.mjs';

const ENDPOINTS = [
  'https://cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
];
const STREAM_ROUTE = '/v1internal:streamGenerateContent?alt=sse';
const REQUEST_TIMEOUT_MS = 30000;

const normalizeString = (value) => (typeof value === 'string' ? value.trim() : '');

const toLowerText = (value) => normalizeString(value).toLowerCase();

const isThinkingLevelUnsupported = (errorText) => {
  const text = normalizeString(errorText);
  return /thinking[\s_-]?level/i.test(text) && /not supported|unsupported/i.test(text);
};

const classifyError = (statusCode, errorText) => {
  const normalized = toLowerText(errorText);
  if (statusCode === 429 || normalized.includes('resource_exhausted') || normalized.includes('quota')) {
    return 'quota';
  }
  if (statusCode === 503 || normalized.includes('unavailable') || normalized.includes('no capacity')) {
    return 'capacity';
  }
  if (statusCode === 401 || statusCode === 403 || normalized.includes('unauthorized') || normalized.includes('permission')) {
    return 'auth_error';
  }
  if (statusCode === 400) {
    return 'invalid_arg';
  }
  if (statusCode === 404) {
    return 'not_found';
  }
  return `http_${statusCode || 'unknown'}`;
};

const buildRequestBody = ({ projectId, modelId, includeThinkingLevel }) => {
  const thinkingConfig = { includeThoughts: true };
  if (includeThinkingLevel) {
    thinkingConfig.thinkingLevel = 'LOW';
  }

  return {
    project: projectId,
    model: modelId,
    requestType: 'agent',
    userAgent: 'antigravity',
    requestId: `matrix-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    request: {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'reply exactly: OK' }],
        },
      ],
      generationConfig: {
        thinkingConfig,
      },
    },
  };
};

const callCloudCode = async ({ endpoint, token, projectId, modelId, includeThinkingLevel }) => {
  const response = await fetch(`${endpoint}${STREAM_ROUTE}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': 'antigravity/1.15.8 darwin/arm64',
      'X-Goog-Api-Client': 'gl-node/20.11.0 fire/1.15.8',
      'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_DARWIN,pluginType=GEMINI',
    },
    body: JSON.stringify(
      buildRequestBody({
        projectId,
        modelId,
        includeThinkingLevel,
      })
    ),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const raw = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    bodyPreview: normalizeString(raw).slice(0, 260),
  };
};

const probeModel = async ({ token, projectId, modelId }) => {
  let lastResult = null;

  for (const endpoint of ENDPOINTS) {
    const first = await callCloudCode({
      endpoint,
      token,
      projectId,
      modelId,
      includeThinkingLevel: true,
    });

    if (first.ok) {
      return {
        modelId,
        endpoint,
        result: 'direct_ok',
        status: first.status,
      };
    }

    if (isThinkingLevelUnsupported(first.bodyPreview)) {
      const second = await callCloudCode({
        endpoint,
        token,
        projectId,
        modelId,
        includeThinkingLevel: false,
      });

      if (second.ok) {
        return {
          modelId,
          endpoint,
          result: 'fallback_ok',
          status: second.status,
          firstStatus: first.status,
        };
      }

      return {
        modelId,
        endpoint,
        result: `fallback_${classifyError(second.status, second.bodyPreview)}`,
        status: second.status,
        firstStatus: first.status,
        error: second.bodyPreview,
      };
    }

    const classified = classifyError(first.status, first.bodyPreview);
    lastResult = {
      modelId,
      endpoint,
      result: classified,
      status: first.status,
      error: first.bodyPreview,
    };

    if (first.status !== 404) {
      return lastResult;
    }
  }

  return lastResult || {
    modelId,
    endpoint: ENDPOINTS[0],
    result: 'unknown',
    status: 0,
  };
};

const run = async () => {
  const profile = await loadOAuthProfile();
  const models = await fetchAntigravityModels({
    token: profile.accessToken,
    projectId: profile.projectId,
  });

  const geminiModelIds = [...new Set(
    models
      .map((item) => normalizeString(item?.id))
      .filter((id) => id.startsWith('gemini-'))
  )];

  if (!geminiModelIds.length) {
    throw new Error('未获取到任何 gemini-* 模型。');
  }

  const results = [];
  for (const modelId of geminiModelIds) {
    const row = await probeModel({
      token: profile.accessToken,
      projectId: profile.projectId,
      modelId,
    });
    results.push(row);
    console.log(`[testcase_08] ${row.modelId} => ${row.result} (status=${row.status}, endpoint=${row.endpoint})`);
  }

  const summary = results.reduce((acc, item) => {
    acc[item.result] = (acc[item.result] || 0) + 1;
    return acc;
  }, {});

  console.log(`[testcase_08] summary: ${JSON.stringify(summary)}`);

  const successCount = results.filter((item) => item.result === 'direct_ok' || item.result === 'fallback_ok').length;
  if (successCount === 0) {
    throw new Error('没有任何 gemini 模型通过 direct/fallback 校验，请检查 OAuth、项目权限或上游容量。');
  }
};

run().catch((error) => {
  console.error(`[testcase_08] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
