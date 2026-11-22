import type { WebContents } from 'electron';
import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { AuthRefreshOutcome } from '../../shared/auth/constants';
import {
  CompanionQuickAnswerEventType,
  DesktopCompanionIpc,
} from '../../shared/desktopCompanion/constants';
import { CompanionSelectionAction } from '../../shared/desktopCompanion/selectionActions';
import { ModelPresetId, modelPresetModelId } from '../../shared/modelPresets/constants';
import { ApiFormat, OpenAIApiMode, ProviderName } from '../../shared/providers';

// Bridge Electron's `net.fetch` in Node Vitest to Node's real `globalThis.fetch`
// so `openclawTokenProxy` makes real HTTP loopback connections to our local mock servers.
vi.mock('electron', () => ({
  net: {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
  },
}));
vi.mock('../i18n', () => ({ t: (key: string) => key, getLanguage: () => 'zh' }));

import {
  clearServerModelMetadata,
  setAuthTokensGetter,
  setServerBaseUrlGetter,
  setStoreGetter,
} from '../libs/claudeSettings';
import { __copilotLoopbackProxyTestUtils } from '../libs/copilotLoopbackProxy';
import {
  getModelAuthProxyUrl,
  startModelAuthProxy,
  stopModelAuthProxy,
} from '../libs/modelAuthProxy';
import type { SqliteStore } from '../sqliteStore';
import { CompanionQuickAnswerService } from './quickAnswerService';

type RecordedRequest = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};

async function startLocalServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>,
): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(error => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function closeServer(server: http.Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>(resolve => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createFakeStore(appConfig: Record<string, unknown>): SqliteStore {
  return {
    get: <T>(key: string) => (key === 'app_config' ? (appConfig as T) : undefined),
  } as unknown as SqliteStore;
}

describe('CompanionQuickAnswerService real local loopback proxy E2E', () => {
  const serversToClose: http.Server[] = [];
  const servicesToDispose: CompanionQuickAnswerService[] = [];

  afterEach(async () => {
    for (const service of servicesToDispose.splice(0)) {
      service.dispose();
    }
    stopModelAuthProxy();
    clearServerModelMetadata();
    setStoreGetter(() => null);
    setAuthTokensGetter(() => null);
    setServerBaseUrlGetter(() => '');
    for (const server of serversToClose.splice(0)) {
      await closeServer(server);
    }
  });

  test('routes LobsterAI Plan (enterprise) through local loopback proxy with JWT, enterprise headers, and 401 refresh', async () => {
    const loopbackSecret = 'loopback-secret-for-e2e-test-0123456789abcdef';
    const upstreamRequests: RecordedRequest[] = [];
    let currentAccessToken = 'expired-user-jwt';

    const upstream = await startLocalServer(async (req, res) => {
      const body = await readBody(req);
      upstreamRequests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      });

      const auth = req.headers.authorization;
      const accountMode = req.headers['x-lobsterai-account-mode'];
      const enterpriseId = req.headers['x-lobsterai-enterprise-id'];

      // Reject loopback secret or stale JWT with HTTP 401.
      if (auth === `Bearer ${loopbackSecret}` || auth !== 'Bearer real-user-jwt') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
        return;
      }
      if (accountMode !== 'enterprise' || enterpriseId !== 'ent-42') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Missing enterprise headers' } }));
        return;
      }

      if (req.url === '/api/proxy/v1/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"Enterprise "}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"answer"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      if (req.url === '/api/proxy/v1/messages') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Anthropic preset answer"}}\n\n');
        res.write('data: {"type":"message_stop"}\n\n');
        res.end();
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Unexpected path ${req.url}` } }));
    });
    serversToClose.push(upstream.server);

    const refreshToken = vi.fn(async () => {
      currentAccessToken = 'real-user-jwt';
      return { outcome: AuthRefreshOutcome.Success, accessToken: currentAccessToken };
    });

    await startModelAuthProxy({
      getAuthTokens: () => ({ accessToken: currentAccessToken, refreshToken: 'refresh-tok' }),
      refreshToken,
      getServerBaseUrl: () => upstream.baseUrl,
      getAccountContextHeaders: () => ({
        'X-LobsterAI-Account-Mode': 'enterprise',
        'X-LobsterAI-Enterprise-Id': 'ent-42',
      }),
      getClientVersion: () => '1.0.0-e2e',
      getInboundAuthToken: () => loopbackSecret,
    });

    const proxyBaseUrl = getModelAuthProxyUrl();
    expect(proxyBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    setAuthTokensGetter(() => ({ accessToken: currentAccessToken, refreshToken: 'refresh-tok' }));
    setServerBaseUrlGetter(() => upstream.baseUrl);
    setStoreGetter(() => createFakeStore({
      model: {
        defaultModel: 'deepseek-v3.2',
        defaultModelProvider: ProviderName.LobsteraiServer,
      },
      providers: {},
    }));

    const seenFetchUrls: string[] = [];
    const seenFetchAuths: Array<string | null> = [];
    const service = new CompanionQuickAnswerService({
      getSessionKey: () => 'enterprise:ent-42:user-1',
      getProxyToken: () => loopbackSecret,
      getProxyBaseUrl: getModelAuthProxyUrl,
      resolvePreset: async () => ({ modelId: 'claude-sonnet-4-6', apiFormat: ApiFormat.Anthropic }),
      fetch: (input, init) => {
        seenFetchUrls.push(String(input));
        seenFetchAuths.push(new Headers(init?.headers).get('authorization') ?? new Headers(init?.headers).get('x-api-key'));
        return globalThis.fetch(input, init);
      },
    });
    servicesToDispose.push(service);

    const sender = { id: 101, isDestroyed: () => false, send: vi.fn() };
    expect(service.start(sender as unknown as WebContents, {
      requestId: 'ent-explain-1',
      action: CompanionSelectionAction.Explain,
      text: 'Zero-trust proxy',
    })).toEqual({ success: true });

    await vi.waitFor(() => {
      expect(sender.send).toHaveBeenCalledWith(DesktopCompanionIpc.QuickAnswerEvent, {
        requestId: 'ent-explain-1',
        type: CompanionQuickAnswerEventType.Done,
      });
    });

    // Quick Answer hit the local loopback proxy (NOT remote directly).
    expect(seenFetchUrls[0]).toBe(`${proxyBaseUrl}/v1/lobsterai-server/chat/completions`);
    expect(seenFetchAuths[0]).toBe(`Bearer ${loopbackSecret}`);

    // Upstream never received the loopback secret; first call had expired JWT,
    // proxy refreshed on 401 and retried with fresh JWT + enterprise headers.
    expect(refreshToken).toHaveBeenCalledOnce();
    expect(upstreamRequests).toHaveLength(2);
    expect(upstreamRequests.every(r => r.headers.authorization !== `Bearer ${loopbackSecret}`)).toBe(true);
    expect(upstreamRequests[0].headers.authorization).toBe('Bearer expired-user-jwt');
    expect(upstreamRequests[1]).toMatchObject({
      url: '/api/proxy/v1/chat/completions',
      headers: expect.objectContaining({
        authorization: 'Bearer real-user-jwt',
        'x-lobsterai-account-mode': 'enterprise',
        'x-lobsterai-enterprise-id': 'ent-42',
      }),
    });

    const deltas = sender.send.mock.calls
      .map(([, event]) => event)
      .filter(event => event.type === CompanionQuickAnswerEventType.Delta)
      .map(event => event.text);
    expect(deltas.join('')).toBe('Enterprise answer');

    // Also verify preset resolution into Anthropic Messages routes to /api/proxy/v1/messages (no /v1/v1 duplication).
    setStoreGetter(() => createFakeStore({
      model: {
        defaultModel: modelPresetModelId(ModelPresetId.Ultimate),
        defaultModelProvider: ProviderName.LobsteraiServer,
      },
      providers: {},
    }));
    sender.send.mockClear();

    expect(service.start(sender as unknown as WebContents, {
      requestId: 'ent-preset-2',
      action: CompanionSelectionAction.Ask,
      text: 'Hello',
      history: [{ role: 'assistant', content: '你好' }, { role: 'user', content: '换个说法' }],
    })).toEqual({ success: true });

    await vi.waitFor(() => {
      expect(sender.send).toHaveBeenCalledWith(DesktopCompanionIpc.QuickAnswerEvent, {
        requestId: 'ent-preset-2',
        type: CompanionQuickAnswerEventType.Done,
      });
    });

    expect(seenFetchUrls[1]).toBe(`${proxyBaseUrl}/v1/lobsterai-server/v1/messages`);
    expect(upstreamRequests[2]).toMatchObject({
      url: '/api/proxy/v1/messages',
      headers: expect.objectContaining({
        authorization: 'Bearer real-user-jwt',
        'x-lobsterai-account-mode': 'enterprise',
        'x-lobsterai-enterprise-id': 'ent-42',
      }),
    });
    expect(sender.send).toHaveBeenCalledWith(DesktopCompanionIpc.QuickAnswerEvent, {
      requestId: 'ent-preset-2',
      type: CompanionQuickAnswerEventType.Delta,
      text: 'Anthropic preset answer',
    });
  });

  test('routes GitHub Copilot through ${proxyBaseUrl}/v1/github-copilot -> copilot loopback proxy -> upstream with 401 refresh', async () => {
    const loopbackSecret = 'copilot-loopback-secret-0123456789abcdef01234567';
    const copilotUpstreamCalls: RecordedRequest[] = [];
    let currentCopilotToken = 'expired-copilot-token';

    const copilotUpstream = await startLocalServer(async (req, res) => {
      const body = await readBody(req);
      copilotUpstreamCalls.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      });
      if (req.headers.authorization !== 'Bearer fresh-copilot-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Copilot token expired' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Copilot "}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"stream ok"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    serversToClose.push(copilotUpstream.server);

    const refreshCopilotToken = vi.fn(async () => {
      currentCopilotToken = 'fresh-copilot-token';
      return { copilotToken: currentCopilotToken, baseUrl: copilotUpstream.baseUrl };
    });

    const copilotLoopback = await startLocalServer(
      __copilotLoopbackProxyTestUtils.createRequestHandler({
        getAuthToken: () => loopbackSecret,
        getCurrentToken: async () => ({ copilotToken: currentCopilotToken, baseUrl: copilotUpstream.baseUrl }),
        refreshToken: refreshCopilotToken,
        fetch: (url, init) => globalThis.fetch(url, init),
      }),
    );
    serversToClose.push(copilotLoopback.server);

    await startModelAuthProxy({
      getAuthTokens: () => ({ accessToken: 'unused-lobster-jwt', refreshToken: 'unused-refresh' }),
      refreshToken: vi.fn(),
      getServerBaseUrl: () => 'http://127.0.0.1:9',
      getClientVersion: () => '1.0.0-e2e',
      getInboundAuthToken: () => loopbackSecret,
      resolveOAuthProviderUpstream: (providerId) => {
        if (providerId === ProviderName.Copilot) {
          return {
            baseUrl: `${copilotLoopback.baseUrl}/v1/copilot`,
            headers: { authorization: `Bearer ${loopbackSecret}` },
          };
        }
        return null;
      },
    });

    const proxyBaseUrl = getModelAuthProxyUrl();
    expect(proxyBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    setStoreGetter(() => createFakeStore({
      model: {
        defaultModel: 'gpt-4o',
        defaultModelProvider: ProviderName.Copilot,
      },
      providers: {
        [ProviderName.Copilot]: {
          enabled: true,
          apiKey: '',
          baseUrl: 'https://api.individual.githubcopilot.com',
          apiFormat: 'openai',
          models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
        },
      },
    }));

    const seenFetchUrls: string[] = [];
    const service = new CompanionQuickAnswerService({
      getSessionKey: () => 'signed-in-user',
      getProxyToken: () => loopbackSecret,
      getProxyBaseUrl: getModelAuthProxyUrl,
      fetch: (input, init) => {
        seenFetchUrls.push(String(input));
        return globalThis.fetch(input, init);
      },
    });
    servicesToDispose.push(service);

    const sender = { id: 102, isDestroyed: () => false, send: vi.fn() };
    expect(service.start(sender as unknown as WebContents, {
      requestId: 'copilot-summarize-1',
      action: CompanionSelectionAction.Summarize,
      text: 'Long paragraph to summarize',
    })).toEqual({ success: true });

    await vi.waitFor(() => {
      expect(sender.send).toHaveBeenCalledWith(DesktopCompanionIpc.QuickAnswerEvent, {
        requestId: 'copilot-summarize-1',
        type: CompanionQuickAnswerEventType.Done,
      });
    });

    expect(seenFetchUrls).toEqual([`${proxyBaseUrl}/v1/github-copilot/chat/completions`]);
    expect(refreshCopilotToken).toHaveBeenCalledOnce();
    expect(copilotUpstreamCalls).toHaveLength(2);
    expect(copilotUpstreamCalls[1]).toMatchObject({
      url: '/chat/completions',
      headers: expect.objectContaining({
        authorization: 'Bearer fresh-copilot-token',
        'copilot-integration-id': 'vscode-chat',
      }),
    });
    const deltas = sender.send.mock.calls
      .map(([, event]) => event)
      .filter(event => event.type === CompanionQuickAnswerEventType.Delta)
      .map(event => event.text);
    expect(deltas.join('')).toBe('Copilot stream ok');
  });

  test('streams cleanly from BYOK providers whose baseUrl ends with /chat/completions or /responses without duplicating the suffix', async () => {
    const byokRequests: RecordedRequest[] = [];
    const byokUpstream = await startLocalServer(async (req, res) => {
      const body = await readBody(req);
      byokRequests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      });
      if (req.headers.authorization !== 'Bearer sk-byok-secret') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid BYOK key' } }));
        return;
      }
      if (req.url === '/llmgateway/api/v1/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"Youdao BYOK ok"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      if (req.url === '/v1/responses') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Responses BYOK ok"}\n\n');
        res.write('data: {"type":"response.completed"}\n\n');
        res.end();
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Not Found: ${req.url}` } }));
    });
    serversToClose.push(byokUpstream.server);

    setStoreGetter(() => createFakeStore({
      model: {
        defaultModel: 'deepseek-reasoner',
        defaultModelProvider: ProviderName.Youdaozhiyun,
      },
      providers: {
        [ProviderName.Youdaozhiyun]: {
          enabled: true,
          apiKey: 'sk-byok-secret',
          baseUrl: `${byokUpstream.baseUrl}/llmgateway/api/v1/chat/completions`,
          apiFormat: 'openai',
          models: [{ id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }],
        },
      },
    }));

    const service = new CompanionQuickAnswerService({
      getSessionKey: () => 'signed-in-user',
      getProxyToken: () => 'unused-loopback-secret',
      getProxyBaseUrl: () => 'http://127.0.0.1:49999',
    });
    servicesToDispose.push(service);

    const sender = { id: 103, isDestroyed: () => false, send: vi.fn() };
    expect(service.start(sender as unknown as WebContents, {
      requestId: 'byok-youdao-1',
      action: CompanionSelectionAction.Explain,
      text: 'Suffix normalization test',
    })).toEqual({ success: true });

    await vi.waitFor(() => {
      expect(sender.send).toHaveBeenCalledWith(DesktopCompanionIpc.QuickAnswerEvent, {
        requestId: 'byok-youdao-1',
        type: CompanionQuickAnswerEventType.Done,
      });
    });

    expect(byokRequests[0].url).toBe('/llmgateway/api/v1/chat/completions');
    expect(sender.send).toHaveBeenCalledWith(DesktopCompanionIpc.QuickAnswerEvent, {
      requestId: 'byok-youdao-1',
      type: CompanionQuickAnswerEventType.Delta,
      text: 'Youdao BYOK ok',
    });

    // Also verify a custom Responses-mode BYOK provider whose baseUrl already ends with /responses/.
    setStoreGetter(() => createFakeStore({
      model: {
        defaultModel: 'gpt-5.5',
        defaultModelProvider: 'custom_0',
      },
      providers: {
        custom_0: {
          enabled: true,
          apiKey: 'sk-byok-secret',
          baseUrl: `${byokUpstream.baseUrl}/v1/responses/`,
          apiFormat: 'openai',
          openaiApiMode: OpenAIApiMode.Responses,
          models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
        },
      },
    }));
    sender.send.mockClear();

    expect(service.start(sender as unknown as WebContents, {
      requestId: 'byok-responses-2',
      action: CompanionSelectionAction.Ask,
      text: 'Responses endpoint',
    })).toEqual({ success: true });

    await vi.waitFor(() => {
      expect(sender.send).toHaveBeenCalledWith(DesktopCompanionIpc.QuickAnswerEvent, {
        requestId: 'byok-responses-2',
        type: CompanionQuickAnswerEventType.Done,
      });
    });

    expect(byokRequests[1].url).toBe('/v1/responses');
    expect(sender.send).toHaveBeenCalledWith(DesktopCompanionIpc.QuickAnswerEvent, {
      requestId: 'byok-responses-2',
      type: CompanionQuickAnswerEventType.Delta,
      text: 'Responses BYOK ok',
    });
  });

  test('never sends loopback secret directly to remote upstream when proxy is unavailable, and cancels in-flight proxied streams cleanly', async () => {
    const loopbackSecret = 'loopback-secret-never-sent-remotely-0123456789ab';
    const upstreamHits: RecordedRequest[] = [];
    let releaseSecondChunk!: () => void;
    const secondChunkGate = new Promise<void>(resolve => { releaseSecondChunk = resolve; });

    const upstream = await startLocalServer(async (req, res) => {
      const body = await readBody(req);
      upstreamHits.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (req.headers.authorization !== 'Bearer real-user-jwt') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"First chunk"}}]}\n\n');
      await secondChunkGate;
      if (!res.destroyed && !res.writableEnded) {
        res.write('data: {"choices":[{"delta":{"content":"Second chunk"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });
    serversToClose.push(upstream.server);

    setAuthTokensGetter(() => ({ accessToken: 'real-user-jwt', refreshToken: 'refresh-tok' }));
    setServerBaseUrlGetter(() => upstream.baseUrl);
    setStoreGetter(() => createFakeStore({
      model: {
        defaultModel: 'deepseek-v3.2',
        defaultModelProvider: ProviderName.LobsteraiServer,
      },
      providers: {},
    }));

    // 1) When local proxy is not running (getProxyBaseUrl returns null), refuse before touching upstream.
    const sender = { id: 104, isDestroyed: () => false, send: vi.fn() };
    const noProxyService = new CompanionQuickAnswerService({
      getSessionKey: () => 'signed-in-user',
      getProxyToken: () => loopbackSecret,
      getProxyBaseUrl: () => null,
    });
    servicesToDispose.push(noProxyService);

    expect(noProxyService.start(sender as unknown as WebContents, {
      requestId: 'no-proxy-1',
      action: CompanionSelectionAction.Explain,
      text: 'Do not leak loopback token',
    })).toEqual({
      success: false,
      error: 'desktopCompanionAnswerUnsupportedModel',
    });
    expect(upstreamHits).toHaveLength(0);

    // 2) When local proxy is running, aborting mid-stream cancels cleanly without late events.
    await startModelAuthProxy({
      getAuthTokens: () => ({ accessToken: 'real-user-jwt', refreshToken: 'refresh-tok' }),
      refreshToken: vi.fn(),
      getServerBaseUrl: () => upstream.baseUrl,
      getClientVersion: () => '1.0.0-e2e',
      getInboundAuthToken: () => loopbackSecret,
    });
    const service = new CompanionQuickAnswerService({
      getSessionKey: () => 'signed-in-user',
      getProxyToken: () => loopbackSecret,
      getProxyBaseUrl: getModelAuthProxyUrl,
    });
    servicesToDispose.push(service);

    expect(service.start(sender as unknown as WebContents, {
      requestId: 'cancel-1',
      action: CompanionSelectionAction.Summarize,
      text: 'Cancel me mid-stream',
    })).toEqual({ success: true });

    await vi.waitFor(() => {
      expect(sender.send).toHaveBeenCalledWith(DesktopCompanionIpc.QuickAnswerEvent, {
        requestId: 'cancel-1',
        type: CompanionQuickAnswerEventType.Delta,
        text: 'First chunk',
      });
    });

    service.abort('cancel-1');
    releaseSecondChunk();
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(upstreamHits).toHaveLength(1);
    expect(upstreamHits[0].headers.authorization).toBe('Bearer real-user-jwt');
  });
});
