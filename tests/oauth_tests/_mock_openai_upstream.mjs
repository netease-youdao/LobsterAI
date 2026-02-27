import http from 'http';

const LOCAL_HOST = '127.0.0.1';

const normalizeString = (value) => (typeof value === 'string' ? value.trim() : '');

const readRequestBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

const writeJson = (res, statusCode, payload) => {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify(payload));
};

export const startMockOpenAIUpstream = async (options = {}) => {
  const acceptedTokens = Array.isArray(options.acceptedTokens) && options.acceptedTokens.length > 0
    ? options.acceptedTokens.map((item) => normalizeString(item)).filter(Boolean)
    : ['mock-token'];
  const expectedProjectId = normalizeString(options.expectedProjectId) || 'mock-project';
  const requireProjectHeader = options.requireProjectHeader === true;
  const replyPrefix = normalizeString(options.replyPrefix) || 'MOCK_REPLY';
  const cloudCodeParts = Array.isArray(options.cloudCodeParts) && options.cloudCodeParts.length > 0
    ? options.cloudCodeParts
    : null;
  const rejectThinkingLevel = options.rejectThinkingLevel === true;
  const thinkingLevelErrorMessage = normalizeString(options.thinkingLevelErrorMessage)
    || 'Unable to submit request because thinking_level is not supported by this model.';

  const requests = [];

  const server = http.createServer(async (req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    const requestURL = new URL(req.url || '/', `http://${LOCAL_HOST}`);
    const pathname = normalizeString(requestURL.pathname || '/');
    const path = normalizeString(req.url || '/');

    const isOpenAIChatPath = pathname === '/v1/chat/completions';
    const isCloudCodePath = pathname === '/v1internal:streamGenerateContent';

    if (method !== 'POST' || (!isOpenAIChatPath && !isCloudCodePath)) {
      writeJson(res, 404, {
        error: {
          type: 'not_found',
          message: `Unknown path: ${path}`,
        },
      });
      return;
    }

    const authHeader = normalizeString(req.headers.authorization);
    const projectHeader = normalizeString(req.headers['x-goog-user-project']);
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';

    const bodyRaw = await readRequestBody(req);
    let body = {};
    try {
      body = bodyRaw ? JSON.parse(bodyRaw) : {};
    } catch {
      writeJson(res, 400, {
        error: { type: 'invalid_json', message: 'Request body is not valid JSON' },
      });
      return;
    }

    requests.push({
      token,
      authHeader,
      projectHeader,
      body,
      path,
      timestamp: Date.now(),
    });

    if (!acceptedTokens.includes(token)) {
      writeJson(res, 401, {
        error: {
          type: 'authentication_error',
          message: 'invalid token',
        },
      });
      return;
    }

    if (requireProjectHeader && projectHeader !== expectedProjectId) {
      writeJson(res, 403, {
        error: {
          type: 'permission_error',
          message: 'missing required header: x-goog-user-project',
        },
      });
      return;
    }

    const model = normalizeString(body?.model) || 'gemini-3-flash';
    const requestNo = requests.length;

    if (isCloudCodePath) {
      if (rejectThinkingLevel) {
        const thinkingLevel = body?.request?.generationConfig?.thinkingConfig?.thinkingLevel;
        if (typeof thinkingLevel === 'string' && thinkingLevel.trim()) {
          writeJson(res, 400, {
            error: {
              type: 'api_error',
              message: thinkingLevelErrorMessage,
            },
          });
          return;
        }
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const parts = cloudCodeParts ?? [
        { text: `${replyPrefix} ` },
        { text: `STREAM_${requestNo}` },
      ];

      for (const part of parts) {
        const chunk = {
          response: {
            candidates: [{
              content: {
                parts: [part],
              },
            }],
          },
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      const finishChunk = {
        response: {
          candidates: [{
            finishReason: 'STOP',
          }],
          usageMetadata: {
            promptTokenCount: 11,
            candidatesTokenCount: 7,
            thoughtsTokenCount: 3,
            totalTokenCount: 21,
          },
        },
      };
      res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
      res.end();
      return;
    }

    if (body?.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const chunks = [
        {
          id: `chatcmpl-mock-${requestNo}`,
          model,
          choices: [{ index: 0, delta: { role: 'assistant', content: `${replyPrefix} ` } }],
        },
        {
          id: `chatcmpl-mock-${requestNo}`,
          model,
          choices: [{ index: 0, delta: { content: `STREAM_${requestNo}` } }],
        },
        {
          id: `chatcmpl-mock-${requestNo}`,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        },
      ];

      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    writeJson(res, 200, {
      id: `chatcmpl-mock-${requestNo}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: `${replyPrefix}_${requestNo}`,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
      },
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOCAL_HOST, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to get mock upstream port');
  }

  const baseURL = `http://${LOCAL_HOST}:${address.port}`;

  return {
    baseURL,
    requests,
    stop: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
};
