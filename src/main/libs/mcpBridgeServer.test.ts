import { afterEach, describe, expect, test, vi } from 'vitest';

import { type AskUserRequest, AskUserResponseReason, type DecisionToolRequest, McpBridgeServer } from './mcpBridgeServer';

const makeQuestions = (): AskUserRequest['questions'] => [{
  question: 'Continue?',
  options: [
    { label: 'Yes' },
    { label: 'No' },
  ],
}];

describe('McpBridgeServer AskUser session attribution', () => {
  test('passes sessionKey from HTTP AskUser callback requests', async () => {
    const secret = 'test-secret';
    const server = new McpBridgeServer(secret);
    const received: AskUserRequest[] = [];

    try {
      await server.start();
      const url = server.askUserCallbackUrl;
      expect(url).toBeTruthy();

      server.onAskUser(request => {
        received.push(request);
        server.resolveAskUser(request.requestId, { behavior: 'allow' });
      });

      const response = await fetch(url!, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ask-user-secret': secret,
        },
        body: JSON.stringify({
          sessionKey: 'agent:main:lobsterai:session-a',
          createdAt: -1, expiresAt: Number.MAX_SAFE_INTEGER,
          questions: makeQuestions(),
        }),
      });

      expect(response.ok).toBe(true);
      await expect(response.json()).resolves.toEqual({ behavior: 'allow' });
      expect(received).toHaveLength(1);
      expect(received[0].sessionKey).toBe('agent:main:lobsterai:session-a');
      expect(received[0].createdAt).toBeGreaterThan(0);
      expect(received[0].expiresAt - received[0].createdAt).toBe(120_000);
    } finally {
      await server.stop();
    }
  });

  test('passes sessionKey from internal AskUser requests', async () => {
    const server = new McpBridgeServer('test-secret');
    const received: AskUserRequest[] = [];

    server.onAskUser(request => {
      received.push(request);
      server.resolveAskUser(request.requestId, { behavior: 'deny' });
    });

    await expect(server.askUserInternal(
      makeQuestions(),
      1_000,
      { sessionKey: 'agent:main:lobsterai:session-b' },
    )).resolves.toEqual({ behavior: 'deny' });

    expect(received).toHaveLength(1);
    expect(received[0].sessionKey).toBe('agent:main:lobsterai:session-b');
  });
});

describe('McpBridgeServer AskUser response lifecycle', () => {
  afterEach(() => vi.useRealTimers());

  test.each(['allow', 'deny'] as const)('settles %s once and dismisses the dialog', async behavior => {
    vi.useFakeTimers();
    const server = new McpBridgeServer('test-secret');
    const dismiss = vi.fn();
    let requestId = '';
    server.onAskUser(request => { requestId = request.requestId; });
    server.onAskUserDismiss(dismiss);
    const response = server.askUserInternal(makeQuestions(), 1_000);

    expect(server.resolveAskUser(requestId, { behavior })).toBe(true);
    await expect(response).resolves.toEqual({ behavior });
    expect(server.resolveAskUser(requestId, { behavior })).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dismiss).toHaveBeenCalledExactlyOnceWith(requestId);
  });

  test('reports timeout separately from user refusal and rejects a late response', async () => {
    vi.useFakeTimers();
    const server = new McpBridgeServer('test-secret');
    const dismiss = vi.fn();
    let requestId = '';
    server.onAskUser(request => { requestId = request.requestId; });
    server.onAskUserDismiss(dismiss);
    const response = server.askUserInternal(makeQuestions(), 1_000);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(response).resolves.toEqual({ behavior: 'deny', reason: AskUserResponseReason.Timeout });
    expect(server.resolveAskUser(requestId, { behavior: 'allow' })).toBe(false);
    expect(dismiss).toHaveBeenCalledExactlyOnceWith(requestId);
  });

  test('provides trusted lifetimes and reports actual timeout even before its timer runs', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const server = new McpBridgeServer('test-secret');
    let request!: AskUserRequest;
    const settled = vi.fn();
    server.onAskUser(value => { request = value; });
    server.onAskUserSettled(settled);
    const response = server.askUserInternal(makeQuestions(), 1_000);
    expect(request.createdAt).toBe(10_000); expect(request.expiresAt).toBe(11_000);
    vi.setSystemTime(11_001); // No timer dispatch: wall-clock expiry still applies.
    expect(server.resolveAskUser(request.requestId, { behavior: 'allow' })).toBe(true);
    await expect(response).resolves.toEqual({ behavior: 'deny', reason: AskUserResponseReason.Timeout });
    expect(settled).toHaveBeenCalledExactlyOnceWith(request.requestId, { behavior: 'deny', reason: AskUserResponseReason.Timeout });
    expect(server.resolveAskUser(request.requestId, { behavior: 'deny' })).toBe(false);
  });

  test('settles pending internal questions on stop without a bound HTTP server', async () => {
    const server = new McpBridgeServer('test-secret');
    let requestId = '';
    const settled = vi.fn();
    server.onAskUser(value => { requestId = value.requestId; });
    server.onAskUserSettled(settled);
    const response = server.askUserInternal(makeQuestions());
    await server.stop();
    await expect(response).resolves.toEqual({ behavior: 'deny', reason: AskUserResponseReason.Unavailable });
    expect(settled).toHaveBeenCalledExactlyOnceWith(requestId, { behavior: 'deny', reason: AskUserResponseReason.Unavailable });
    expect(server.resolveAskUser(requestId, { behavior: 'allow' })).toBe(false);
  });

  test('observer failure never strands an already resolved local question', async () => {
    const server = new McpBridgeServer('test-secret');
    let requestId = '';
    const dismiss = vi.fn();
    server.onAskUser(value => { requestId = value.requestId; });
    server.onAskUserDismiss(dismiss);
    server.onAskUserSettled(() => { throw new Error('derived storage unavailable'); });
    const response = server.askUserInternal(makeQuestions());
    expect(server.resolveAskUser(requestId, { behavior: 'allow' })).toBe(true);
    await expect(response).resolves.toEqual({ behavior: 'allow' });
    expect(dismiss).toHaveBeenCalledExactlyOnceWith(requestId);
  });

  test('reports an unavailable dialog handler separately from user refusal', async () => {
    const server = new McpBridgeServer('test-secret');

    await expect(server.askUserInternal(makeQuestions())).resolves.toEqual({
      behavior: 'deny', reason: AskUserResponseReason.Unavailable,
    });
  });
});

describe('McpBridgeServer browser bridge', () => {
  test('authenticates and forwards browser tool requests', async () => {
    const secret = 'browser-test-secret';
    const server = new McpBridgeServer(secret);

    try {
      await server.start();
      server.onBrowserTool(async request => ({
        content: [{ type: 'text', text: request.tool }],
        structuredContent: { args: request.args },
      }));

      const unauthorized = await fetch(server.browserCallbackUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool: 'list_pages', args: {} }),
      });
      expect(unauthorized.status).toBe(401);

      const response = await fetch(server.browserCallbackUrl!, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mcp-bridge-secret': secret,
        },
        body: JSON.stringify({ tool: 'navigate_page', args: { pageId: 7 } }),
      });
      expect(response.ok).toBe(true);
      await expect(response.json()).resolves.toEqual({
        content: [{ type: 'text', text: 'navigate_page' }],
        structuredContent: { args: { pageId: 7 } },
      });
    } finally {
      await server.stop();
    }
  });
});

describe('McpBridgeServer decision tool', () => {
  const secret = 'decision-test-secret';
  const post = (url: string, body: unknown, options: { secret?: string; signal?: AbortSignal } = {}) => fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.secret ? { 'x-mcp-bridge-secret': options.secret } : {}),
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  test('authenticates and forwards arguments with the calling session', async () => {
    const server = new McpBridgeServer(secret);
    const received: DecisionToolRequest[] = [];

    try {
      await server.start();
      server.onDecisionTool(async request => {
        received.push(request);
        return { content: [{ type: 'text', text: '{"status":"ok"}' }] };
      });
      const body = {
        args: { state: 'x', questions: [] },
        context: { sessionKey: 'agent:main:lobsterai:session-a', toolCallId: 'call-1' },
      };

      const unauthorized = await post(server.decisionCallbackUrl!, body);
      expect(unauthorized.status).toBe(401);

      const response = await post(server.decisionCallbackUrl!, body, { secret });
      expect(response.ok).toBe(true);
      await expect(response.json()).resolves.toEqual({ content: [{ type: 'text', text: '{"status":"ok"}' }] });
      expect(received).toEqual([body]);
    } finally {
      await server.stop();
    }
  });

  test('answers with a tool error when arguments or the handler are missing', async () => {
    const server = new McpBridgeServer(secret);

    try {
      await server.start();
      const missingArgs = await post(server.decisionCallbackUrl!, { context: {} }, { secret });
      expect(missingArgs.status).toBe(400);

      const notReady = await post(server.decisionCallbackUrl!, { args: {} }, { secret });
      expect(notReady.status).toBe(503);
      await expect(notReady.json()).resolves.toMatchObject({ isError: true });
    } finally {
      await server.stop();
    }
  });

  test('aborts the handler when the caller drops the connection', async () => {
    const server = new McpBridgeServer(secret);
    let handlerSignal: AbortSignal | null = null;

    try {
      await server.start();
      const started = new Promise<void>(resolve => {
        server.onDecisionTool((_request, signal) => {
          handlerSignal = signal;
          resolve();
          return new Promise(settle => {
            signal.addEventListener('abort', () => settle({ content: [{ type: 'text', text: 'aborted' }], isError: true }));
          });
        });
      });

      const caller = new AbortController();
      const pending = post(server.decisionCallbackUrl!, { args: {} }, { secret, signal: caller.signal }).catch(() => null);
      await started;
      caller.abort();
      await pending;

      await vi.waitFor(() => expect(handlerSignal?.aborted).toBe(true));
    } finally {
      await server.stop();
    }
  });
});
