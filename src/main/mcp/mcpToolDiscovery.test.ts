import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, test } from 'vitest';

import { McpToolDiscoveryErrorCode } from '../../shared/mcp/toolDiscovery';
import {
  discoverMcpTools,
  estimateMcpToolTokens,
  McpToolDiscoveryError,
  normalizeMcpToolDiscoveryRequest,
} from './mcpToolDiscovery';

// Minimal newline-delimited JSON-RPC MCP server, run with `node -e`. The mode
// comes in as the first argument: ok | no-tools | crash | hang.
const STDIO_FIXTURE = `
const readline = require('readline');
const mode = process.argv[1] || 'ok';
if (mode === 'crash') {
  process.stderr.write('Error: FIXTURE_API_KEY is not set\\n');
  process.exit(1);
}
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const pages = {
  first: {
    tools: [
      { name: 'search_issues', title: 'Search issues', description: 'Search issues in a repository', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
      { name: 'create_issue', description: '创建一个新的议题', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
    ],
    nextCursor: 'page-2',
  },
  'page-2': {
    tools: [
      { name: 'delete_repo', inputSchema: { type: 'object' } },
      { name: 'search_issues', inputSchema: { type: 'object' } },
    ],
  },
};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    if (mode === 'hang') return;
    send({ id: message.id, result: {
      protocolVersion: message.params.protocolVersion,
      capabilities: mode === 'no-tools' ? { resources: {} } : { tools: {} },
      serverInfo: { name: 'fixture', version: '1.0.0' },
    } });
  } else if (message.method === 'tools/list' && mode !== 'no-tools') {
    send({ id: message.id, result: pages[(message.params && message.params.cursor) || 'first'] });
  } else {
    send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
}).on('close', () => process.exit(0));
`;

const stdioLaunch = (mode: string) => ({
  name: 'fixture',
  transportType: 'stdio' as const,
  command: process.execPath,
  args: ['-e', STDIO_FIXTURE, mode],
});

const listTools = () => ({
  tools: [
    {
      name: 'lookup',
      description: 'Look up a record',
      inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } } },
    },
  ],
});

const createFixtureServer = () => {
  const server = new Server({ name: 'http-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => listTools());
  return server;
};

const openServers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(openServers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

const listen = async (handler: http.RequestListener): Promise<string> => {
  const server = http.createServer(handler);
  openServers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const captureFailure = async (promise: Promise<unknown>): Promise<McpToolDiscoveryError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(McpToolDiscoveryError);
    return error as McpToolDiscoveryError;
  }
  throw new Error('expected discovery to fail');
};

describe('discoverMcpTools over stdio', () => {
  test('lists every page, keeps server order, and drops duplicate names', async () => {
    const tools = await discoverMcpTools(stdioLaunch('ok'), { timeoutMs: 15_000 });

    expect(tools.map(tool => tool.name)).toEqual(['search_issues', 'create_issue', 'delete_repo']);
    expect(tools[0]).toMatchObject({ title: 'Search issues', description: 'Search issues in a repository' });
    expect(tools[2]).not.toHaveProperty('description');
    for (const tool of tools) {
      expect(tool.estimatedTokens).toBeGreaterThan(0);
    }
  });

  test('treats a server without tools/list as having no tools', async () => {
    await expect(discoverMcpTools(stdioLaunch('no-tools'), { timeoutMs: 15_000 })).resolves.toEqual([]);
  });

  test('reports the server stderr when the process exits during startup', async () => {
    const error = await captureFailure(discoverMcpTools(stdioLaunch('crash'), { timeoutMs: 15_000 }));

    expect(error.code).toBe(McpToolDiscoveryErrorCode.Failed);
    expect(error.message).toContain('FIXTURE_API_KEY is not set');
  });

  test('fails with a timeout when the server never answers', async () => {
    const error = await captureFailure(discoverMcpTools(stdioLaunch('hang'), { timeoutMs: 800 }));

    expect(error.code).toBe(McpToolDiscoveryErrorCode.Timeout);
    expect(error.timeoutMs).toBe(800);
  });

  test('rejects a stdio launch without a command', async () => {
    const error = await captureFailure(discoverMcpTools(
      { name: 'empty', transportType: 'stdio' },
      { timeoutMs: 1_000 },
    ));

    expect(error.code).toBe(McpToolDiscoveryErrorCode.InvalidRequest);
  });
});

describe('discoverMcpTools over HTTP', () => {
  test('lists tools from a streamable HTTP server with custom headers and fetch', async () => {
    const seenPaths: string[] = [];
    const baseUrl = await listen(async (req, res) => {
      if (req.headers['x-api-key'] !== 'secret') {
        res.writeHead(401).end('unauthorized');
        return;
      }
      const server = createFixtureServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });

    const tools = await discoverMcpTools(
      { name: 'remote', transportType: 'http', url: `${baseUrl}/mcp`, headers: { 'X-Api-Key': 'secret' } },
      {
        timeoutMs: 10_000,
        fetch: (url, init) => {
          seenPaths.push(new URL(url).pathname);
          return fetch(url, init);
        },
      },
    );

    expect(tools.map(tool => tool.name)).toEqual(['lookup']);
    expect(seenPaths.length).toBeGreaterThan(0);
    expect(seenPaths.every(pathname => pathname === '/mcp')).toBe(true);
  });

  test('surfaces the HTTP status when the server rejects the request', async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(401).end('unauthorized');
    });

    const error = await captureFailure(discoverMcpTools(
      { name: 'remote', transportType: 'http', url: `${baseUrl}/mcp` },
      { timeoutMs: 10_000 },
    ));

    expect(error.code).toBe(McpToolDiscoveryErrorCode.Failed);
    expect(error.message).toContain('401');
  });

  test('lists tools from a legacy SSE server', async () => {
    const transports = new Map<string, SSEServerTransport>();
    const baseUrl = await listen(async (req, res) => {
      const requestUrl = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && requestUrl.pathname === '/sse') {
        const transport = new SSEServerTransport('/messages', res);
        transports.set(transport.sessionId, transport);
        await createFixtureServer().connect(transport);
        return;
      }
      const transport = transports.get(requestUrl.searchParams.get('sessionId') ?? '');
      if (req.method === 'POST' && transport) {
        await transport.handlePostMessage(req, res);
        return;
      }
      res.writeHead(404).end();
    });

    const tools = await discoverMcpTools(
      { name: 'legacy', transportType: 'sse', url: `${baseUrl}/sse` },
      { timeoutMs: 10_000 },
    );

    expect(tools.map(tool => tool.name)).toEqual(['lookup']);
  });

  test('rejects a remote launch with an unparsable URL', async () => {
    const error = await captureFailure(discoverMcpTools(
      { name: 'remote', transportType: 'http', url: 'not a url' },
      { timeoutMs: 1_000 },
    ));

    expect(error.code).toBe(McpToolDiscoveryErrorCode.InvalidRequest);
  });
});

describe('normalizeMcpToolDiscoveryRequest', () => {
  test('keeps a stdio launch and drops non-string args and env values', () => {
    expect(normalizeMcpToolDiscoveryRequest({
      serverId: 'abc',
      name: ' github ',
      transportType: 'stdio',
      command: ' npx ',
      args: ['-y', '@modelcontextprotocol/server-github', 42],
      env: { GITHUB_TOKEN: 'secret', ' ': 'blank key', COUNT: 3 },
    })).toEqual({
      serverId: 'abc',
      name: 'github',
      transportType: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'secret' },
    });
  });

  test('normalizes remote URLs the same way saving does', () => {
    expect(normalizeMcpToolDiscoveryRequest({
      name: 'docs',
      transportType: 'http',
      url: '地址：https://mcp.example.com/mcp。',
      headers: { Authorization: 'Bearer x' },
    })).toEqual({
      serverId: undefined,
      name: 'docs',
      transportType: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    });
  });

  test('explains why a request cannot run', () => {
    expect(normalizeMcpToolDiscoveryRequest(null)).toBe('Invalid request');
    expect(normalizeMcpToolDiscoveryRequest({ transportType: 'websocket' })).toBe('Unsupported transport');
    expect(normalizeMcpToolDiscoveryRequest({ transportType: 'stdio', command: '  ' })).toBe('Missing command');
    expect(normalizeMcpToolDiscoveryRequest({ transportType: 'sse', url: 'ftp://x' })).toBe('Invalid URL');
  });
});

describe('estimateMcpToolTokens', () => {
  test('grows with the schema and counts CJK characters individually', () => {
    const small = estimateMcpToolTokens({ name: 'a', inputSchema: { type: 'object' } });
    const large = estimateMcpToolTokens({
      name: 'a',
      description: 'x'.repeat(700),
      inputSchema: { type: 'object' },
    });
    const cjk = estimateMcpToolTokens({ name: 'a', description: '中'.repeat(100), inputSchema: { type: 'object' } });

    expect(small).toBeGreaterThan(0);
    expect(large - small).toBe(200);
    expect(cjk - small).toBe(100);
  });
});
