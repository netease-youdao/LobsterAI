import { execFile } from 'node:child_process';
import { createServer, Server } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';

import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { BridgeServer } from '../SKILLs/web-search/server';
import * as browser from '../SKILLs/web-search/server/playwright/browser';
import { PlaywrightManager } from '../SKILLs/web-search/server/playwright/manager';
import { BingSearch } from '../SKILLs/web-search/server/search/bing';
import { GoogleSearch } from '../SKILLs/web-search/server/search/google';
import {
  PARALLEL_ENDPOINT, PARALLEL_MAX_RESPONSE_BYTES, PARALLEL_USER_AGENT, ParallelSearch,
} from '../SKILLs/web-search/server/search/parallel';
import { SearchEngine, SearchResponse } from '../SKILLs/web-search/server/search/types';
import { convertLatexMathDelimiters } from '../src/renderer/components/MarkdownContent';

vi.mock('../SKILLs/web-search/server/playwright/browser', async (importOriginal) => ({
  ...await importOriginal<typeof browser>(),
  launchBrowser: vi.fn().mockRejectedValue(new Error('Browser must not launch in this test')),
}));

const run = promisify(execFile);
const nativeFetch = globalThis.fetch;
const servers: Server[] = [];
const bridges: BridgeServer[] = [];
const page = { url: 'https://example.com/reference', title: 'A "quoted" title', excerpts: ['First line.\nSecond line.'] };
type RequestCapture = { method: string; headers: Record<string, unknown>; body: Record<string, unknown> };

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  return `http://127.0.0.1:${address.port}`;
}

async function fixture(options: {
  result?: Record<string, unknown>; httpStatus?: number; rpcError?: boolean;
  missingTool?: boolean; paginate?: boolean; slow?: boolean; huge?: boolean;
  redirect?: string; cleanupFails?: boolean;
} = {}) {
  const requests: RequestCapture[] = [];
  const url = await listen(createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ method: req.method || '', headers: req.headers, body });
    if (req.method === 'GET') { res.writeHead(405).end(); return; }
    if (req.method === 'DELETE') { res.writeHead(options.cleanupFails ? 500 : 200).end(); return; }
    if (body.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
    if (body.method === 'tools/call' && options.slow) return;
    if (body.method === 'tools/call' && options.redirect) {
      res.writeHead(302, { location: options.redirect }).end(); return;
    }
    if (body.method === 'tools/call' && options.httpStatus) {
      res.writeHead(options.httpStatus).end('Rate limited'); return;
    }
    res.setHeader('content-type', 'application/json');
    if (body.method === 'tools/call' && options.huge) {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {
        content: [{ type: 'text', text: 'x'.repeat(PARALLEL_MAX_RESPONSE_BYTES + 1) }],
      } })); return;
    }
    let result: Record<string, unknown> = {};
    if (body.method === 'initialize') {
      res.setHeader('mcp-session-id', 'fixture-session');
      result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    } else if (body.method === 'tools/list') {
      const nextPage = !!body.params?.cursor;
      result = {
        tools: options.missingTool || (options.paginate && !nextPage) ? [] : [{
          name: 'web_search', inputSchema: { type: 'object', properties: { objective: { type: 'string' }, search_queries: { type: 'array', items: { type: 'string' } } }, required: ['objective', 'search_queries'] },
        }],
        ...(options.paginate && !nextPage ? { nextCursor: 'page-2' } : {}),
      };
    } else if (body.method === 'tools/call') {
      result = options.result ?? { content: [], structuredContent: { results: [page], warnings: ['Service warning'] } };
    }
    res.end(JSON.stringify(options.rpcError && body.method === 'tools/call'
      ? { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'Quota exceeded' } }
      : { jsonrpc: '2.0', id: body.id, result }));
  }));
  vi.stubGlobal('fetch', vi.fn((input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) =>
    nativeFetch(String(input) === PARALLEL_ENDPOINT ? url : input, init)));
  return requests;
}

async function bridge(): Promise<string> {
  const server = new BridgeServer({ server: { port: 0, host: '127.0.0.1' } });
  bridges.push(server);
  await server.start();
  const address = (server as unknown as { httpServer: Server }).httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Missing bridge address');
  return `http://127.0.0.1:${address.port}`;
}

async function searchAt(url: string, engine?: string) {
  const response = await nativeFetch(`${url}/api/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectionId: 'fixture-browser', query: 'public reference', ...(engine ? { engine } : {}) }),
  });
  return { status: response.status, body: await response.json() };
}

function incumbent(engine: typeof SearchEngine.Google | typeof SearchEngine.Bing): SearchResponse {
  return { query: 'public reference', engine, results: [], totalResults: 0, timestamp: 1, duration: 1 };
}

beforeEach(() => {
  vi.spyOn(PlaywrightManager.prototype, 'connectToCDP').mockRejectedValue(new Error('Browser connection must not be used'));
});
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((server) => server.stop()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('native optional Parallel search', () => {
  test('CLI selects the real bridge/SDK path, preserving quoted text and citations without a browser', async () => {
    const requests = await fixture({ paginate: true });
    const url = await bridge();
    const output = await run('bash', ['-c', 'bash "$SKILLS_ROOT/web-search/scripts/search.sh" "$@"', 'web-search', 'public reference', '1'], {
      env: { PATH: process.env.PATH, SKILLS_ROOT: path.resolve('SKILLs'), WEB_SEARCH_SERVER: url, WEB_SEARCH_ENGINE: SearchEngine.Parallel, WEB_SEARCH_CLEANUP: '1' },
    });
    expect(output.stdout).toContain('**Engine:** parallel');
    expect(output.stdout).toContain('A "quoted" title');
    expect(output.stdout).toContain(`[${page.url}](${page.url})`);
    expect(output.stdout).toContain('First line.\nSecond line.');
    expect(output.stdout).toContain('Service warning');
    expect(browser.launchBrowser).not.toHaveBeenCalled();
    expect(PlaywrightManager.prototype.connectToCDP).not.toHaveBeenCalled();
    const calls = requests.filter((request) => request.body.method === 'tools/call');
    expect(calls).toHaveLength(1);
    expect(calls[0].body.params).toEqual({ name: 'web_search', arguments: { objective: 'public reference', search_queries: ['public reference'] } });
    expect(requests.filter((request) => request.body.method === 'tools/list')).toHaveLength(2);
    for (const request of requests) {
      expect(request.headers['user-agent']).toBe(PARALLEL_USER_AGENT);
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers['x-api-key']).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
    }
    expect(requests.some((request) => request.method === 'DELETE')).toBe(true);
  });

  test.each([undefined, SearchEngine.Auto, 'unknown'])('default/auto/unknown selection preserves Google then Bing (%s)', async (engine) => {
    const requests = await fixture();
    const google = vi.spyOn(GoogleSearch.prototype, 'search').mockRejectedValue(new Error('Google unavailable'));
    const bing = vi.spyOn(BingSearch.prototype, 'search').mockResolvedValue(incumbent(SearchEngine.Bing));
    const response = await searchAt(await bridge(), engine);
    expect(response.body.data.engine).toBe(SearchEngine.Bing);
    expect(google).toHaveBeenCalledOnce();
    expect(bing).toHaveBeenCalledOnce();
    expect(requests).toEqual([]);
  });

  test.each([
    'https://example.com/release notes',
    'https://example.com/q?value=[unclosed',
    'https://example.com/q?value=[balanced]',
    'https://example.com/q?value=&copy;',
    'https://example.com/q?value=$literal$',
    'https://example.com/q?value=~~literal~~',
    'https://example.com/q?value=\\*',
    'https://example.com/q?value=\\\\',
    'https://example.com/q?value=\\&copy;',
    'https://example.com/reference_(draft)?value=(unclosed',
    'https://example.com/q?value=\\)&literal=&amp;#fragment\\*',
    'https://example.com/q?value=\\[\\]\\(\\)\\`\\!\\_\\~',
  ])('CLI renders a complete citation for source URL %s', async (sourceUrl) => {
    await fixture({ result: { content: [], structuredContent: { results: [{ ...page, url: sourceUrl }] } } });
    const output = await run('bash', [path.resolve('SKILLs/web-search/scripts/search.sh'), 'public reference'], {
      env: { PATH: process.env.PATH, WEB_SEARCH_SERVER: await bridge(), WEB_SEARCH_ENGINE: SearchEngine.Parallel },
    });
    const tree = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath).parse(convertLatexMathDelimiters(output.stdout));
    const links = tree.children.flatMap((node) => node.type === 'paragraph'
      ? node.children.filter((child) => child.type === 'link') : []);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      url: new URL(sourceUrl).href,
      children: [{ type: 'text', value: sourceUrl }],
    });
  });

  test.each(['```ts', '~~~ts'])('a truncated %s excerpt fence does not swallow the next source citation', async (fence) => {
    await fixture({ result: { content: [], structuredContent: { results: [
      { ...page, excerpts: [`An example:\n${fence}\n${'x'.repeat(6000)}\n${fence}`] },
      { ...page, url: `${page.url}/next` },
    ] } } });
    const output = await run('bash', [path.resolve('SKILLs/web-search/scripts/search.sh'), 'public reference'], {
      env: { PATH: process.env.PATH, WEB_SEARCH_SERVER: await bridge(), WEB_SEARCH_ENGINE: SearchEngine.Parallel },
    });
    const tree = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath).parse(convertLatexMathDelimiters(output.stdout));
    const links = tree.children.flatMap((node) => node.type === 'paragraph'
      ? node.children.filter((child) => child.type === 'link') : []);
    expect(links.map((link) => link.url)).toEqual([page.url, `${page.url}/next`]);
  });

  test.each([SearchEngine.Google, SearchEngine.Bing])('explicit %s preserves selection without Parallel requests', async (engine) => {
    const requests = await fixture();
    const google = vi.spyOn(GoogleSearch.prototype, 'search').mockResolvedValue(incumbent(SearchEngine.Google));
    const bing = vi.spyOn(BingSearch.prototype, 'search').mockResolvedValue(incumbent(SearchEngine.Bing));
    expect((await searchAt(await bridge(), engine)).body.data.engine).toBe(engine);
    expect(engine === SearchEngine.Google ? bing : google).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  test('Parallel error exits the CLI without retries, browser connection or incumbent fallback', async () => {
    const requests = await fixture({ httpStatus: 429 });
    const google = vi.spyOn(GoogleSearch.prototype, 'search');
    const bing = vi.spyOn(BingSearch.prototype, 'search');
    await expect(run('bash', [path.resolve('SKILLs/web-search/scripts/search.sh'), 'public reference'], {
      env: { PATH: process.env.PATH, WEB_SEARCH_SERVER: await bridge(), WEB_SEARCH_ENGINE: SearchEngine.Parallel },
    })).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('429') });
    expect(requests.filter((request) => request.body.method === 'tools/call')).toHaveLength(1);
    expect(google).not.toHaveBeenCalled();
    expect(bing).not.toHaveBeenCalled();
    expect(browser.launchBrowser).not.toHaveBeenCalled();
  });

  test('text JSON and valid empty results remain successful even when session cleanup fails', async () => {
    await fixture({ result: { content: [{ type: 'text', text: JSON.stringify({ results: [] }) }] }, cleanupFails: true });
    expect((await new ParallelSearch().search('public reference')).results).toEqual([]);
  });

  test.each([
    { name: 'HTTP', options: { httpStatus: 503 }, message: '503' },
    { name: 'RPC', options: { rpcError: true }, message: 'Quota exceeded' },
    { name: 'tool', options: { result: { content: [], isError: true } }, message: 'tool error' },
    { name: 'payload', options: { result: { content: [], structuredContent: {} } }, message: 'results array' },
    { name: 'text JSON', options: { result: { content: [{ type: 'text', text: 'not JSON' }] } }, message: 'invalid JSON' },
    { name: 'URL', options: { result: { content: [], structuredContent: { results: [{ ...page, url: 'javascript:bad' }] } } }, message: 'unsupported URL' },
    { name: 'discovery', options: { missingTool: true }, message: 'did not advertise' },
    { name: 'response bytes', options: { huge: true }, message: '1 MiB' },
  ])('$name failure is never converted to empty success', async ({ options, message }) => {
    await fixture(options);
    await expect(new ParallelSearch().search('public reference')).rejects.toThrow(message);
  });

  test('timeout aborts in-flight retrieval and still cleans up the negotiated session', async () => {
    const requests = await fixture({ slow: true });
    const start = Date.now();
    await expect(new ParallelSearch().search('public reference', 10, 150)).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(2000);
    expect(requests.some((request) => request.method === 'DELETE')).toBe(true);
  });

  test('redirect rejection prevents transmitting the search to another origin', async () => {
    let destinationCalls = 0;
    const destination = await listen(createServer((_req, res) => { destinationCalls++; res.end(); }));
    await fixture({ redirect: destination });
    await expect(new ParallelSearch().search('public reference')).rejects.toThrow();
    expect(destinationCalls).toBe(0);
  });

  test('local result/output bounds retain whole source URLs and warn about truncated excerpts', async () => {
    await fixture({ result: { content: [], structuredContent: {
      results: Array.from({ length: 20 }, (_, i) => ({ ...page, url: `${page.url}/${i}`, excerpts: ['x'.repeat(6000)] })),
    } } });
    const result = await new ParallelSearch().search('public reference', 20);
    expect(result.results.length).toBeLessThan(20);
    expect(result.results[0].url).toBe(`${page.url}/0`);
    expect(result.warnings).toContain('Parallel search output was truncated to fit local output limits.');
    expect(result.results.reduce((sum, item) => sum + item.title.length + item.url.length + item.snippet.length, 0)).toBeLessThan(25000);
  });

  test.each([['   ', 10], ['x'.repeat(201), 10], ['public reference', 0], ['public reference', 51]])('invalid query/count is rejected before dispatch', async (query, count) => {
    const requests = await fixture();
    await expect(new ParallelSearch().search(query, Number(count))).rejects.toThrow();
    expect(requests).toEqual([]);
  });
});
