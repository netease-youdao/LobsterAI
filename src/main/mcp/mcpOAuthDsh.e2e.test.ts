// Real end-to-end verification of Remote MCP OAuth 2.1 + Streamable HTTP MCP
// against the real bundled DeepSeek Harness (DSH) host runtime:
//
// Fresh flow:
//   1. Before login: excluded from DSH sync (`needsReauthIds`), status `RequiresAuthorization`.
//   2. RFC 9728 401 WWW-Authenticate probe + path-inserted PRM + RFC 8414 path-based issuer
//      + RFC 7591 confidential DCR + PKCE S256 with RFC 8707 `resource` & `scope`
//      -> stored under SQLite UUID `server.id` -> `syncMcpServers` -> real DSH session
//      invokes `whoami_oauth` and receives authenticated identity.
//   3. Expire token -> refresh with DCR `client_id`/`client_secret` -> `syncMcpServers`
//      -> real DSH session invokes `whoami_oauth` with refreshed token (generation 2).
//   4. Revoke (`deleteToken`) + `syncMcpServers` -> `whoami_oauth` removed / uncallable
//      and status returns `RequiresAuthorization`.
//
// Upgrade flow:
//   Seed legacy `openclaw.sqlite` (`mcp_oauth_stores`) with one valid token and one
//   expired unrefreshable token -> run `runLegacyOpenClawMigration` -> valid token
//   migrates into `kv['mcp.oauth.token.<server.id>']` and authenticates a real DSH
//   MCP tool call WITHOUT re-login; expired unrefreshable server reports
//   `reauthRequired` and `RequiresAuthorization`.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { DshPermissionPreset } from '../../shared/dshEngine/hostConstants';
import { McpAuthMode, McpOAuthState } from '../../shared/mcp/auth';
import { MigrationV2Status } from '../../shared/migration/constants';
import { DshHostManager, resolveBundledDshPaths } from '../libs/dsh/dshHostManager';
import { buildDshMcpServerSpecs, buildDshProvidersPayload } from '../libs/dsh/dshProviderSync';
import {
  computeLegacyMcpOAuthStoreKey,
  runLegacyOpenClawMigration,
} from '../migration/legacyOpenClawMigrator';
import { McpOAuthManager } from './mcpOAuthManager';

const BUNDLED_PATHS = resolveBundledDshPaths({
  isPackaged: false,
  appRootDir: process.cwd(),
});
const HAS_REAL_DSH_RUNTIME = fs.existsSync(path.join(BUNDLED_PATHS.runtimeDir, 'lib', 'bin.js'));

const tempDirs: string[] = [];
const openHttpServers: http.Server[] = [];
const activeHosts: DshHostManager[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function startHttpServer(handler: http.RequestListener): Promise<{
  server: http.Server;
  origin: string;
}> {
  const server = http.createServer(handler);
  openHttpServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${addr.port}` };
}

interface ActiveOAuthTokenInfo {
  user: string;
  generation: number;
  scope: string;
}

async function startLocalOAuthMcpServer() {
  const registeredClients = new Map<string, { clientSecret: string; redirectUris: string[] }>();
  const authCodes = new Map<
    string,
    { codeChallenge: string; clientId: string; redirectUri: string; resource: string; scope: string }
  >();
  const activeTokens = new Map<string, ActiveOAuthTokenInfo>();
  const refreshTokens = new Map<
    string,
    { clientId: string; user: string; generation: number; resource: string; scope: string; accessToken: string }
  >();
  const observedMcpTokens: string[] = [];
  const toolsListWaiters = new Map<string, Array<() => void>>();
  const toolsListedTokens = new Set<string>();
  let dcrRegistrationCount = 0;
  let refreshCount = 0;
  let unauthorizedHits = 0;

  let origin = '';

  const notifyToolsListed = (token: string) => {
    toolsListedTokens.add(token);
    const waiters = toolsListWaiters.get(token);
    if (waiters) {
      toolsListWaiters.delete(token);
      for (const resolve of waiters) resolve();
    }
  };

  const { server } = await startHttpServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? '/', origin || 'http://127.0.0.1');
    const pathname = reqUrl.pathname;

    // 1. RFC 9728 path-inserted Protected Resource Metadata
    if (req.method === 'GET' && pathname === '/.well-known/oauth-protected-resource/api/mcp') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          resource: `${origin}/api/mcp`,
          authorization_servers: [`${origin}/idp/tenant-1`],
          scopes_supported: ['mcp:whoami'],
        }),
      );
      return;
    }

    // 2. RFC 8414 path-inserted Authorization Server Metadata (path-based issuer!)
    if (req.method === 'GET' && pathname === '/.well-known/oauth-authorization-server/idp/tenant-1') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: `${origin}/idp/tenant-1`,
          authorization_endpoint: `${origin}/idp/tenant-1/authorize`,
          token_endpoint: `${origin}/idp/tenant-1/token`,
          registration_endpoint: `${origin}/idp/tenant-1/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
        }),
      );
      return;
    }

    // 3. RFC 7591 Dynamic Client Registration (returns confidential client_secret)
    if (req.method === 'POST' && pathname === '/idp/tenant-1/register') {
      const body = JSON.parse(await readRequestBody(req)) as Record<string, unknown>;
      dcrRegistrationCount += 1;
      const clientId = `dcr-client-${dcrRegistrationCount}`;
      const clientSecret = `dcr-secret-${dcrRegistrationCount}`;
      registeredClients.set(clientId, {
        clientSecret,
        redirectUris: Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [],
      });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          token_endpoint_auth_method: 'client_secret_post',
          redirect_uris: body.redirect_uris,
        }),
      );
      return;
    }

    // 4. OAuth 2.1 Authorization Endpoint (auto-approves and redirects to loopback callback)
    if (req.method === 'GET' && pathname === '/idp/tenant-1/authorize') {
      const clientId = reqUrl.searchParams.get('client_id') ?? '';
      const redirectUri = reqUrl.searchParams.get('redirect_uri') ?? '';
      const codeChallenge = reqUrl.searchParams.get('code_challenge') ?? '';
      const method = reqUrl.searchParams.get('code_challenge_method') ?? '';
      const state = reqUrl.searchParams.get('state') ?? '';
      const resource = reqUrl.searchParams.get('resource') ?? '';
      const scope = reqUrl.searchParams.get('scope') ?? '';

      const client = registeredClients.get(clientId);
      if (!client || !client.redirectUris.includes(redirectUri) || method !== 'S256' || !codeChallenge) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_request' }));
        return;
      }

      const code = `code-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      authCodes.set(code, { codeChallenge, clientId, redirectUri, resource, scope });
      const target = new URL(redirectUri);
      target.searchParams.set('code', code);
      target.searchParams.set('state', state);
      res.writeHead(302, { location: target.href });
      res.end();
      return;
    }

    // 5. OAuth 2.1 Token Endpoint (authorization_code with PKCE S256 + refresh_token with DCR secret)
    if (req.method === 'POST' && pathname === '/idp/tenant-1/token') {
      const params = new URLSearchParams(await readRequestBody(req));
      const grantType = params.get('grant_type');
      const clientId = params.get('client_id') ?? '';
      const clientSecret = params.get('client_secret') ?? '';
      const client = registeredClients.get(clientId);

      if (!client || client.clientSecret !== clientSecret) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_client' }));
        return;
      }

      if (grantType === 'authorization_code') {
        const code = params.get('code') ?? '';
        const verifier = params.get('code_verifier') ?? '';
        const redirectUri = params.get('redirect_uri') ?? '';
        const resource = params.get('resource') ?? '';
        const pending = authCodes.get(code);
        authCodes.delete(code);

        const expectedChallenge = createHash('sha256').update(verifier).digest('base64url');
        if (
          !pending
          || pending.clientId !== clientId
          || pending.redirectUri !== redirectUri
          || pending.codeChallenge !== expectedChallenge
          || resource !== `${origin}/api/mcp`
        ) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }

        const accessToken = 'oauth-access-gen-1';
        const refreshToken = 'oauth-refresh-gen-1';
        activeTokens.set(accessToken, {
          user: 'alice@lobsterai.test',
          generation: 1,
          scope: pending.scope || 'mcp:whoami',
        });
        refreshTokens.set(refreshToken, {
          clientId,
          user: 'alice@lobsterai.test',
          generation: 1,
          resource: pending.resource,
          scope: pending.scope || 'mcp:whoami',
          accessToken,
        });

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: accessToken,
            refresh_token: refreshToken,
            token_type: 'Bearer',
            expires_in: 120,
            scope: pending.scope || 'mcp:whoami',
          }),
        );
        return;
      }

      if (grantType === 'refresh_token') {
        const refreshToken = params.get('refresh_token') ?? '';
        const resource = params.get('resource') ?? '';
        const stored = refreshTokens.get(refreshToken);
        if (!stored || stored.clientId !== clientId || resource !== `${origin}/api/mcp`) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        refreshTokens.delete(refreshToken);
        activeTokens.delete(stored.accessToken);
        refreshCount += 1;

        const nextGen = stored.generation + 1;
        const nextAccess = `oauth-access-gen-${nextGen}`;
        const nextRefresh = `oauth-refresh-gen-${nextGen}`;
        activeTokens.set(nextAccess, {
          user: stored.user,
          generation: nextGen,
          scope: stored.scope,
        });
        refreshTokens.set(nextRefresh, {
          ...stored,
          generation: nextGen,
          accessToken: nextAccess,
        });

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: nextAccess,
            refresh_token: nextRefresh,
            token_type: 'Bearer',
            expires_in: 3600,
            scope: stored.scope,
          }),
        );
        return;
      }

      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
      return;
    }

    // 6. Protected Streamable HTTP MCP Endpoint (`/api/mcp`)
    if (pathname === '/api/mcp') {
      const authHeader = req.headers.authorization;
      const trimmedAuth = typeof authHeader === 'string' ? authHeader.trim() : '';
      const bearerToken = trimmedAuth.toLowerCase().startsWith('bearer ')
        ? trimmedAuth.slice('bearer '.length).trim()
        : '';
      const tokenInfo = bearerToken ? activeTokens.get(bearerToken) : undefined;

      if (!tokenInfo) {
        unauthorizedHits += 1;
        res.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': `Bearer realm="mcp", resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp", scope="mcp:whoami"`,
        });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      observedMcpTokens.push(bearerToken);
      const mcpServer = new Server(
        { name: 'oauth-e2e-mcp', version: '1.0.0' },
        { capabilities: { tools: {} } },
      );
      mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
        notifyToolsListed(bearerToken);
        return {
          tools: [
            {
              name: 'whoami_oauth',
              description: 'Return the authenticated OAuth identity from the Bearer token',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        };
      });
      mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (request.params.name === 'whoami_oauth') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  authenticated: true,
                  user: tokenInfo.user,
                  generation: tokenInfo.generation,
                  scope: tokenInfo.scope,
                  token: bearerToken,
                }),
              },
            ],
          };
        }
        return {
          isError: true,
          content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
        };
      });

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
  });

  const addr = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${addr.port}`;

  return {
    origin,
    mcpUrl: `${origin}/api/mcp`,
    tokenEndpoint: `${origin}/idp/tenant-1/token`,
    seedToken(token: string, info: ActiveOAuthTokenInfo) {
      activeTokens.set(token, info);
    },
    waitForToolsList(token: string, timeoutMs = 15_000): Promise<void> {
      if (toolsListedTokens.has(token)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for DSH MCP tools/list with token "${token}"`));
        }, timeoutMs);
        const list = toolsListWaiters.get(token) ?? [];
        list.push(() => {
          clearTimeout(timer);
          resolve();
        });
        toolsListWaiters.set(token, list);
      });
    },
    getStats: () => ({
      dcrRegistrationCount,
      refreshCount,
      unauthorizedHits,
      observedMcpTokens: [...observedMcpTokens],
    }),
  };
}

/**
 * Minimal OpenAI-compatible streaming Chat Completions server that invokes
 * `whoami_oauth` whenever DSH advertises it in `tools`, and echoes the tool
 * result back as the final assistant response.
 */
async function startMockOpenAiServer() {
  const advertisedToolNamesPerCall: string[][] = [];
  const toolResultsObserved: string[] = [];

  const { origin } = await startHttpServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    const body = JSON.parse(await readRequestBody(req)) as {
      model?: string;
      messages?: Array<{ role?: string; content?: unknown }>;
      tools?: Array<{ function?: { name?: string } }>;
    };
    const model = body.model || 'mock-oauth-model';
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const toolNames = tools
      .map((t) => t?.function?.name)
      .filter((n): n is string => typeof n === 'string');
    advertisedToolNamesPerCall.push(toolNames);

    const lastMsg = messages[messages.length - 1];
    const whoamiToolName = toolNames.find((name) => name.endsWith('whoami_oauth'));

    const writeSseChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
      res.write(
        `data: ${JSON.stringify({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`,
      );
    };

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    if (lastMsg?.role === 'tool') {
      const contentStr = typeof lastMsg.content === 'string'
        ? lastMsg.content
        : JSON.stringify(lastMsg.content);
      toolResultsObserved.push(contentStr);
      writeSseChunk({ role: 'assistant', content: `WHOAMI_RESULT:${contentStr}` }, null);
      writeSseChunk({}, 'stop');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (whoamiToolName) {
      writeSseChunk(
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              index: 0,
              id: `call_whoami_${Date.now()}`,
              type: 'function',
              function: { name: whoamiToolName, arguments: '{}' },
            },
          ],
        },
        null,
      );
      writeSseChunk({}, 'tool_calls');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    writeSseChunk({ role: 'assistant', content: 'NO_WHOAMI_TOOL_AVAILABLE' }, null);
    writeSseChunk({}, 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
  });

  return {
    origin,
    getAdvertisedTools: () => advertisedToolNamesPerCall,
    getToolResults: () => toolResultsObserved,
  };
}

function extractTextFromBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (block && typeof block === 'object') {
        const rec = block as Record<string, unknown>;
        if (typeof rec.text === 'string') return rec.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('');
}

async function runSingleDshTurn(params: {
  hostManager: DshHostManager;
  cwd: string;
  prompt: string;
  providerId: string;
  modelId: string;
}): Promise<{ assistantText: string; toolResults: string[] }> {
  const client = params.hostManager.getClient();
  const { sessionId } = await client.createSession({ cwd: params.cwd });
  await client.selectModel({
    sessionId,
    provider: params.providerId,
    model: params.modelId,
  });

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('DSH turn timed out')), 25_000);
  const follow = client.followSession<Record<string, unknown>>(
    {
      address: { kind: 'session', sessionId },
      assistantStream: true,
      activate: true,
    },
    abort.signal,
  );

  let assistantText = '';
  const toolResults: string[] = [];
  const streamDone = (async () => {
    for await (const frame of follow) {
      if (frame.type === 'assistant-stream') {
        const inner = frame.frame as Record<string, unknown> | undefined;
        if (inner?.type === 'chunk') {
          const chunk = inner.chunk as Record<string, unknown> | undefined;
          if (chunk?.type === 'text-delta' && typeof chunk.delta === 'string') {
            assistantText += chunk.delta;
          }
        }
        continue;
      }
      if (frame.type === 'event' || (typeof frame.type === 'string' && frame.type.includes('/'))) {
        const ev = (frame.type === 'event' ? frame.event : frame) as Record<string, unknown> | undefined;
        if (!ev || typeof ev !== 'object') continue;
        const evType = typeof ev.type === 'string' ? ev.type : '';
        const data = (ev.data as Record<string, unknown> | undefined) ?? {};
        if (evType === 'tool/result') {
          const msgObj = data.message as Record<string, unknown> | undefined;
          const text = extractTextFromBlocks(msgObj?.content ?? data.content);
          if (text) toolResults.push(text);
        } else if (evType === 'assistant/message') {
          const msgObj = data.message as Record<string, unknown> | undefined;
          const text = extractTextFromBlocks(msgObj?.content ?? data.content);
          if (text) assistantText = text;
        } else if (evType === 'turn/end') {
          break;
        }
      }
    }
  })();

  try {
    await client.promptSession({
      sessionId,
      requestId: `req-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      content: [{ type: 'text', text: params.prompt }],
      mode: 'queue',
    });
    await streamDone;
  } finally {
    clearTimeout(timer);
    abort.abort();
    await streamDone.catch(() => undefined);
  }

  return { assistantText, toolResults };
}

function createSqliteKvPort(db: Database.Database) {
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
  return {
    get: (key: string): string | null => {
      const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
        | { value?: string }
        | undefined;
      return typeof row?.value === 'string' ? row.value : null;
    },
    set: (key: string, value: string): void => {
      db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
        key,
        value,
        Date.now(),
      );
    },
    delete: (key: string): void => {
      db.prepare('DELETE FROM kv WHERE key = ?').run(key);
    },
  };
}

afterEach(async () => {
  while (activeHosts.length > 0) {
    const host = activeHosts.pop()!;
    await host.stop().catch(() => undefined);
  }
  await Promise.all(
    openHttpServers.splice(0).map(
      (srv) =>
        new Promise<void>((resolve) => {
          srv.closeAllConnections();
          srv.close(() => resolve());
        }),
    ),
  );
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Real OAuth 2.1 + Streamable HTTP MCP + Real DSH Runtime E2E', () => {
  const realE2eTest = HAS_REAL_DSH_RUNTIME ? test : test.skip;

  realE2eTest(
    'Fresh flow: unauthenticated -> discovery+DCR+PKCE -> authenticated tool call -> refresh -> revoke',
    async () => {
      const oauthMcp = await startLocalOAuthMcpServer();
      const mockOpenAi = await startMockOpenAiServer();

      const userDataDir = createTempDir('lobsterai-dsh-oauth-fresh-');
      const workspaceDir = createTempDir('lobsterai-dsh-oauth-cwd-');
      const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');
      const db = new Database(sqlitePath);

      let clock = 10_000_000;
      const oauthManager = new McpOAuthManager({
        storage: createSqliteKvPort(db),
        now: () => clock,
      });

      const hostManager = new DshHostManager({
        userDataDir,
        runtimeDir: BUNDLED_PATHS.runtimeDir,
        hostBundleDir: BUNDLED_PATHS.hostBundleDir,
        skillsDir: path.join(userDataDir, 'SKILLs'),
        executablePath: process.execPath,
        skipElectronRunAsNode: true,
      });
      activeHosts.push(hostManager);
      hostManager.setApprovalEvaluator(() => ({ kind: 'allow' }));

      await hostManager.start();
      await hostManager.setPermissionPreset(DshPermissionPreset.FullAccess);

      const providerPayload = buildDshProvidersPayload({
        providers: {
          'mock-oauth-llm': {
            enabled: true,
            apiKey: 'mock-key',
            baseUrl: `${mockOpenAi.origin}/v1`,
            apiFormat: 'openai',
            models: [{ id: 'mock-oauth-model', name: 'Mock OAuth Model' }],
          },
        },
      });
      await hostManager.syncProviders(providerPayload);

      const serverUuid = 'uuid-fresh-oauth-mcp-001';
      const mcpRecords = [
        {
          id: serverUuid,
          name: 'OAuth Demo MCP',
          enabled: true,
          transportType: 'http',
          url: oauthMcp.mcpUrl,
          headers: { authorization: 'Bearer stale-should-be-stripped' },
          oauthEnabled: true,
        },
      ];

      // ── Step 1: Before login ─────────────────────────────────────────────
      const beforeStatus = await oauthManager.checkAuthorizationStatus(serverUuid);
      expect(beforeStatus.authorized).toBe(false);

      const beforeSpecs = await buildDshMcpServerSpecs(mcpRecords, oauthManager);
      expect(beforeSpecs.servers).toHaveLength(0);
      expect(beforeSpecs.needsReauthIds).toEqual([serverUuid]);
      await hostManager.syncMcpServers(beforeSpecs.servers);

      // ── Step 2: OAuth 2.1 Discovery + DCR + PKCE + Authenticated DSH Call ─
      const metadata = await oauthManager.discoverMetadata(oauthMcp.mcpUrl);
      expect(oauthMcp.getStats().unauthorizedHits).toBeGreaterThanOrEqual(1);
      expect(metadata.issuer).toBe(`${oauthMcp.origin}/idp/tenant-1`);
      expect(metadata.registrationEndpoint).toBe(`${oauthMcp.origin}/idp/tenant-1/register`);
      expect(metadata.resource).toBe(oauthMcp.mcpUrl);
      expect(metadata.defaultScope).toBe('mcp:whoami');

      const redirectUri = 'http://127.0.0.1:43210/oauth/callback';
      const dcr = await oauthManager.registerDynamicClient({
        registrationEndpoint: metadata.registrationEndpoint!,
        redirectUri,
        scope: metadata.defaultScope,
      });
      expect(dcr.clientId).toBe('dcr-client-1');
      expect(dcr.clientSecret).toBe('dcr-secret-1');

      const pkce = oauthManager.beginPkceFlow({
        serverId: serverUuid,
        metadata,
        redirectUri,
        clientId: dcr.clientId,
        clientSecret: dcr.clientSecret,
        tokenEndpointAuthMethod: dcr.tokenEndpointAuthMethod,
      });

      // Follow the authorization endpoint redirect to obtain `code` & `state`.
      const authRes = await fetch(pkce.authorizationUrl, { redirect: 'manual' });
      expect(authRes.status).toBe(302);
      const callbackLocation = new URL(authRes.headers.get('location')!);
      const code = callbackLocation.searchParams.get('code')!;
      const state = callbackLocation.searchParams.get('state')!;
      expect(state).toBe(pkce.state);

      const initialToken = await oauthManager.completePkceFlow(state, code);
      expect(initialToken.accessToken).toBe('oauth-access-gen-1');
      expect(initialToken.clientId).toBe('dcr-client-1');
      expect(initialToken.clientSecret).toBe('dcr-secret-1');

      const afterLoginStatus = await oauthManager.checkAuthorizationStatus(serverUuid);
      expect(afterLoginStatus.authorized).toBe(true);

      const loginSpecs = await buildDshMcpServerSpecs(mcpRecords, oauthManager);
      expect(loginSpecs.needsReauthIds).toEqual([]);
      expect(loginSpecs.servers).toHaveLength(1);
      expect(loginSpecs.servers[0].headers).toEqual({
        Authorization: 'Bearer oauth-access-gen-1',
      });

      const listPromiseGen1 = oauthMcp.waitForToolsList('oauth-access-gen-1');
      await hostManager.syncMcpServers(loginSpecs.servers);
      await listPromiseGen1;

      const turn1 = await runSingleDshTurn({
        hostManager,
        cwd: workspaceDir,
        prompt: 'Call whoami_oauth now.',
        providerId: 'mock-oauth-llm',
        modelId: 'mock-oauth-model',
      });
      expect(turn1.assistantText).toContain('WHOAMI_RESULT:');
      const parsedTurn1 = JSON.parse(mockOpenAi.getToolResults()[0]) as Record<string, unknown>;
      expect(parsedTurn1).toMatchObject({
        authenticated: true,
        user: 'alice@lobsterai.test',
        generation: 1,
        token: 'oauth-access-gen-1',
      });

      // ── Step 3: Expire token -> Refresh with DCR secret -> Authenticated Call ─
      clock += 90_000; // Within 60s leeway of 120s expiry -> triggers refresh!
      const refreshedSpecs = await buildDshMcpServerSpecs(mcpRecords, oauthManager);
      expect(refreshedSpecs.needsReauthIds).toEqual([]);
      expect(refreshedSpecs.servers).toHaveLength(1);
      expect(refreshedSpecs.servers[0].headers).toEqual({
        Authorization: 'Bearer oauth-access-gen-2',
      });
      expect(oauthMcp.getStats().refreshCount).toBe(1);

      const listPromiseGen2 = oauthMcp.waitForToolsList('oauth-access-gen-2');
      await hostManager.syncMcpServers(refreshedSpecs.servers);
      await listPromiseGen2;

      const turn2 = await runSingleDshTurn({
        hostManager,
        cwd: workspaceDir,
        prompt: 'Call whoami_oauth after refresh.',
        providerId: 'mock-oauth-llm',
        modelId: 'mock-oauth-model',
      });
      expect(turn2.assistantText).toContain('WHOAMI_RESULT:');
      const parsedTurn2 = JSON.parse(mockOpenAi.getToolResults()[1]) as Record<string, unknown>;
      expect(parsedTurn2).toMatchObject({
        authenticated: true,
        user: 'alice@lobsterai.test',
        generation: 2,
        token: 'oauth-access-gen-2',
      });

      // ── Step 4: Revoke (deleteToken) + syncMcpServers -> Tool removed ─────
      oauthManager.deleteToken(serverUuid);
      const afterRevokeStatus = await oauthManager.checkAuthorizationStatus(serverUuid);
      expect(afterRevokeStatus.authorized).toBe(false);

      const revokedSpecs = await buildDshMcpServerSpecs(mcpRecords, oauthManager);
      expect(revokedSpecs.servers).toHaveLength(0);
      expect(revokedSpecs.needsReauthIds).toEqual([serverUuid]);
      await hostManager.syncMcpServers(revokedSpecs.servers);

      const turn3 = await runSingleDshTurn({
        hostManager,
        cwd: workspaceDir,
        prompt: 'Try calling whoami_oauth after revoke.',
        providerId: 'mock-oauth-llm',
        modelId: 'mock-oauth-model',
      });
      expect(turn3.assistantText).toBe('NO_WHOAMI_TOOL_AVAILABLE');
      const lastAdvertisedTools = mockOpenAi.getAdvertisedTools().at(-1) ?? [];
      expect(lastAdvertisedTools.some((t) => t.endsWith('whoami_oauth'))).toBe(false);

      db.close();
    },
    90_000,
  );

  realE2eTest(
    'Upgrade flow: migrates valid legacy OpenClaw mcp_oauth_stores token and authenticates real DSH MCP call without re-login',
    async () => {
      const oauthMcp = await startLocalOAuthMcpServer();
      const mockOpenAi = await startMockOpenAiServer();

      const legacyValidToken = 'legacy-openclaw-live-token-99';
      oauthMcp.seedToken(legacyValidToken, {
        user: 'legacy-alice@lobsterai.test',
        generation: 99,
        scope: 'mcp:whoami',
      });

      const userDataDir = createTempDir('lobsterai-dsh-oauth-upgrade-');
      const workspaceDir = createTempDir('lobsterai-dsh-oauth-upgrade-cwd-');
      const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');
      const migrationNow = new Date('2026-11-21T12:00:00.000Z');
      const nowMs = migrationNow.getTime();

      const validServerId = 'uuid-upgrade-valid-001';
      const expiredServerId = 'uuid-upgrade-expired-002';

      // Seed LobsterAI SQLite with 2 OAuth MCP servers.
      const seedDb = new Database(sqlitePath);
      seedDb.exec(`
        CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
        CREATE TABLE mcp_servers (
          id TEXT PRIMARY KEY,
          name TEXT,
          transport_type TEXT,
          config_json TEXT
        );
      `);
      seedDb.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('cowork.agent_engine', 'openclaw', 1);
      seedDb.prepare('INSERT INTO mcp_servers VALUES (?, ?, ?, ?)').run(
        validServerId,
        'Legacy OAuth MCP',
        'http',
        JSON.stringify({ url: oauthMcp.mcpUrl, auth: McpAuthMode.OAuth }),
      );
      seedDb.prepare('INSERT INTO mcp_servers VALUES (?, ?, ?, ?)').run(
        expiredServerId,
        'Expired Legacy MCP',
        'http',
        JSON.stringify({ url: 'https://expired.mcp.example/mcp', auth: McpAuthMode.OAuth }),
      );
      seedDb.close();

      // Seed legacy OpenClaw `openclaw.sqlite` -> `mcp_oauth_stores`.
      const stateDir = path.join(userDataDir, 'openclaw', 'state');
      fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
      const openclawDb = new Database(path.join(stateDir, 'state', 'openclaw.sqlite'));
      openclawDb.exec(`
        CREATE TABLE mcp_oauth_stores (
          store_key TEXT PRIMARY KEY,
          format_version INTEGER NOT NULL,
          store_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      openclawDb.prepare(
        'INSERT INTO mcp_oauth_stores (store_key, format_version, store_json, updated_at) VALUES (?, 1, ?, ?)',
      ).run(
        computeLegacyMcpOAuthStoreKey('Legacy OAuth MCP', oauthMcp.mcpUrl),
        JSON.stringify({
          tokens: {
            access_token: legacyValidToken,
            token_type: 'Bearer',
            scope: 'mcp:whoami',
          },
          tokenExpiresAt: nowMs + 3_600_000,
          clientInformation: { client_id: 'legacy-dcr-client' },
          discoveryState: {
            authorizationServerUrl: `${oauthMcp.origin}/idp/tenant-1`,
            authorizationServerMetadata: { token_endpoint: oauthMcp.tokenEndpoint },
            resourceMetadata: { resource: oauthMcp.mcpUrl },
          },
        }),
        nowMs - 5000,
      );
      openclawDb.prepare(
        'INSERT INTO mcp_oauth_stores (store_key, format_version, store_json, updated_at) VALUES (?, 1, ?, ?)',
      ).run(
        computeLegacyMcpOAuthStoreKey('Expired Legacy MCP', 'https://expired.mcp.example/mcp'),
        JSON.stringify({
          tokens: { access_token: 'dead-legacy-token', token_type: 'Bearer' },
          tokenExpiresAt: nowMs - 10_000,
        }),
        nowMs - 20_000,
      );
      openclawDb.close();

      // Run offline OpenClaw -> DSH v2 migration!
      const migResult = runLegacyOpenClawMigration({
        userDataDir,
        sqlitePath,
        now: () => migrationNow,
      });
      expect(migResult.status).toBe(MigrationV2Status.Completed);
      expect(migResult.report?.summary.mcpOAuthTokensMigrated).toBe(1);
      expect(migResult.report?.reauthRequired).toEqual([
        { kind: 'mcp_oauth', id: expiredServerId, label: 'Expired Legacy MCP' },
      ]);

      // Boot real DSH runtime using the migrated SQLite database WITHOUT any re-login!
      const db = new Database(sqlitePath);
      const oauthManager = new McpOAuthManager({
        storage: createSqliteKvPort(db),
        now: () => nowMs,
      });

      const validStatus = await oauthManager.checkAuthorizationStatus(validServerId);
      const expiredStatus = await oauthManager.checkAuthorizationStatus(expiredServerId);
      expect(validStatus.authorized ? McpOAuthState.Authorized : McpOAuthState.RequiresAuthorization).toBe(
        McpOAuthState.Authorized,
      );
      expect(expiredStatus.authorized ? McpOAuthState.Authorized : McpOAuthState.RequiresAuthorization).toBe(
        McpOAuthState.RequiresAuthorization,
      );

      const hostManager = new DshHostManager({
        userDataDir,
        runtimeDir: BUNDLED_PATHS.runtimeDir,
        hostBundleDir: BUNDLED_PATHS.hostBundleDir,
        skillsDir: path.join(userDataDir, 'SKILLs'),
        executablePath: process.execPath,
        skipElectronRunAsNode: true,
      });
      activeHosts.push(hostManager);
      hostManager.setApprovalEvaluator(() => ({ kind: 'allow' }));

      await hostManager.start();
      await hostManager.setPermissionPreset(DshPermissionPreset.FullAccess);
      await hostManager.syncProviders(
        buildDshProvidersPayload({
          providers: {
            'mock-oauth-llm': {
              enabled: true,
              apiKey: 'mock-key',
              baseUrl: `${mockOpenAi.origin}/v1`,
              apiFormat: 'openai',
              models: [{ id: 'mock-oauth-model', name: 'Mock OAuth Model' }],
            },
          },
        }),
      );

      const specs = await buildDshMcpServerSpecs(
        [
          {
            id: validServerId,
            name: 'Legacy OAuth MCP',
            enabled: true,
            transportType: 'http',
            url: oauthMcp.mcpUrl,
            oauthEnabled: true,
          },
          {
            id: expiredServerId,
            name: 'Expired Legacy MCP',
            enabled: true,
            transportType: 'http',
            url: 'https://expired.mcp.example/mcp',
            oauthEnabled: true,
          },
        ],
        oauthManager,
      );
      expect(specs.servers).toHaveLength(1);
      expect(specs.servers[0].headers).toEqual({
        Authorization: `Bearer ${legacyValidToken}`,
      });
      expect(specs.needsReauthIds).toEqual([expiredServerId]);

      const toolsListedPromise = oauthMcp.waitForToolsList(legacyValidToken);
      await hostManager.syncMcpServers(specs.servers);
      await toolsListedPromise;

      const turn = await runSingleDshTurn({
        hostManager,
        cwd: workspaceDir,
        prompt: 'Call whoami_oauth using migrated credentials.',
        providerId: 'mock-oauth-llm',
        modelId: 'mock-oauth-model',
      });
      expect(turn.assistantText).toContain('WHOAMI_RESULT:');
      const parsed = JSON.parse(mockOpenAi.getToolResults()[0]) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        authenticated: true,
        user: 'legacy-alice@lobsterai.test',
        generation: 99,
        token: legacyValidToken,
      });

      db.close();
    },
    90_000,
  );
});
