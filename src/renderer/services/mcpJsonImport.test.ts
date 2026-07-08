import { describe, expect, test } from 'vitest';

import { McpJsonImportErrorCode, parseMcpServersJson } from './mcpJsonImport';

describe('parseMcpServersJson', () => {
  test('parses the standard mcpServers wrapper with a stdio server', () => {
    const result = parseMcpServersJson(JSON.stringify({
      mcpServers: {
        MiniMax: {
          command: 'uvx',
          args: ['minimax-mcp'],
          env: { MINIMAX_API_KEY: 'key', MINIMAX_PORT: 8080 },
        },
      },
    }));
    expect(result).toEqual({
      ok: true,
      servers: [{
        name: 'MiniMax',
        description: '',
        transportType: 'stdio',
        command: 'uvx',
        args: ['minimax-mcp'],
        env: { MINIMAX_API_KEY: 'key', MINIMAX_PORT: '8080' },
      }],
    });
  });

  test('parses a bare name-to-config map with multiple servers', () => {
    const result = parseMcpServersJson(JSON.stringify({
      one: { command: 'npx', args: ['-y', 'one-mcp'] },
      two: { type: 'http', url: 'https://example.com/mcp' },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.servers).toHaveLength(2);
    expect(result.servers[0].transportType).toBe('stdio');
    expect(result.servers[1]).toMatchObject({ transportType: 'http', url: 'https://example.com/mcp' });
  });

  test('supports the VS Code style servers wrapper', () => {
    const result = parseMcpServersJson(JSON.stringify({
      servers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'] } },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.servers[0].name).toBe('fetch');
  });

  test('resolves remote transport from explicit type aliases', () => {
    for (const [rawType, expected] of [
      ['sse', 'sse'],
      ['http', 'http'],
      ['streamable-http', 'http'],
      ['streamableHttp', 'http'],
    ] as const) {
      const result = parseMcpServersJson(JSON.stringify({
        remote: { type: rawType, url: 'https://example.com/x' },
      }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.servers[0].transportType).toBe(expected);
    }
  });

  test('reads transport from the "transport" field as a fallback', () => {
    const result = parseMcpServersJson(JSON.stringify({
      remote: { transport: 'sse', url: 'https://example.com/x' },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.servers[0].transportType).toBe('sse');
  });

  test('falls back to the /sse URL heuristic, defaulting to http otherwise', () => {
    const sse = parseMcpServersJson(JSON.stringify({ a: { url: 'https://example.com/sse' } }));
    const http = parseMcpServersJson(JSON.stringify({ a: { url: 'https://example.com/mcp' } }));
    expect(sse.ok && sse.servers[0].transportType).toBe('sse');
    expect(http.ok && http.servers[0].transportType).toBe('http');
  });

  test('prefers stdio when both command and url are present', () => {
    const result = parseMcpServersJson(JSON.stringify({
      both: { command: 'npx', url: 'https://example.com/mcp' },
    }));
    expect(result.ok && result.servers[0].transportType).toBe('stdio');
  });

  test('accepts serverUrl as a url alias', () => {
    const result = parseMcpServersJson(JSON.stringify({
      remote: { serverUrl: 'https://example.com/mcp' },
    }));
    expect(result.ok && result.servers[0].url).toBe('https://example.com/mcp');
  });

  test('rejects invalid JSON', () => {
    const result = parseMcpServersJson('{ not json');
    expect(result).toEqual({ ok: false, code: McpJsonImportErrorCode.InvalidJson });
  });

  test('rejects non-object JSON and empty maps', () => {
    expect(parseMcpServersJson('[1,2]')).toEqual({ ok: false, code: McpJsonImportErrorCode.NoServers });
    expect(parseMcpServersJson('{}')).toEqual({ ok: false, code: McpJsonImportErrorCode.NoServers });
    expect(parseMcpServersJson(JSON.stringify({ mcpServers: {} })))
      .toEqual({ ok: false, code: McpJsonImportErrorCode.NoServers });
  });

  test('rejects a single config object without a name key', () => {
    const result = parseMcpServersJson(JSON.stringify({ command: 'uvx', args: ['minimax-mcp'] }));
    expect(result).toEqual({ ok: false, code: McpJsonImportErrorCode.MissingName });
  });

  test('rejects entries missing both command and url', () => {
    const result = parseMcpServersJson(JSON.stringify({ broken: { args: ['x'] } }));
    expect(result).toEqual({ ok: false, code: McpJsonImportErrorCode.EntryInvalid, detail: 'broken' });
  });

  test('rejects duplicate names after trimming', () => {
    const result = parseMcpServersJson(JSON.stringify({
      'srv ': { command: 'a' },
      srv: { command: 'b' },
    }));
    expect(result).toEqual({ ok: false, code: McpJsonImportErrorCode.DuplicateName, detail: 'srv' });
  });

  test('drops non-primitive args and env values instead of stringifying them', () => {
    const result = parseMcpServersJson(JSON.stringify({
      srv: {
        command: 'npx',
        args: ['ok', { nested: true }, 42, '  '],
        env: { GOOD: 'v', BAD: { nested: true }, NUM: 1 },
      },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.servers[0].args).toEqual(['ok', '42']);
    expect(result.servers[0].env).toEqual({ GOOD: 'v', NUM: '1' });
  });
});
