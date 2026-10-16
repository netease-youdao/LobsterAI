import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { version } from '../../package.json';
import { SearchEngine, SearchResponse, SearchResult } from './types';

export const PARALLEL_ENDPOINT = 'https://search.parallel.ai/mcp';
// Identify aggregate project usage; never add user or installation identifiers.
export const PARALLEL_USER_AGENT = `LobsterAI-WebSearch/${version}`;
export const PARALLEL_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 25000;
const CLEANUP_TIMEOUT_MS = 1000;

/** Bound bytes while the SDK reads either JSON or SSE, before buffering. */
function boundedResponse(response: Response): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let bytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        bytes += chunk.value.byteLength;
        if (bytes > PARALLEL_MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error('Parallel response exceeded the 1 MiB limit');
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function parseResults(result: CallToolResult, query: string, maxResults: number, start: number): SearchResponse {
  if (result.isError) throw new Error('Parallel web_search returned a tool error');
  let payload: unknown = result.structuredContent;
  if (payload === undefined) {
    const text = result.content.find((item) => item.type === 'text');
    if (!text || text.type !== 'text') throw new Error('Parallel search response is missing its payload');
    try {
      payload = JSON.parse(text.text);
    } catch {
      throw new Error('Parallel search response contains invalid JSON');
    }
  }
  if (!payload || typeof payload !== 'object' || !('results' in payload) || !Array.isArray(payload.results)) {
    throw new Error('Parallel search response is missing a results array');
  }
  const warnings: string[] = [];
  if ('warnings' in payload && payload.warnings != null) {
    if (!Array.isArray(payload.warnings) || !payload.warnings.every((item) => typeof item === 'string')) {
      throw new Error('Parallel search response contains invalid warnings');
    }
    warnings.push(...payload.warnings.map((item) => item.slice(0, 500)).slice(0, 10));
  }
  const results: SearchResult[] = [];
  let outputChars = query.length + warnings.join('').length;
  let truncated = false;
  for (const item of payload.results) {
    if (!item || typeof item.url !== 'string' || !Array.isArray(item.excerpts)
      || !item.excerpts.every((excerpt: unknown) => typeof excerpt === 'string')
      || (item.title != null && typeof item.title !== 'string')) {
      throw new Error('Parallel search response contains an invalid result');
    }
    let url: URL;
    try {
      url = new URL(item.url);
    } catch {
      throw new Error('Parallel search response contains an invalid URL');
    }
    if (!['http:', 'https:'].includes(url.protocol) || item.url.length > 2000) {
      throw new Error('Parallel search response contains an unsupported URL');
    }
    if (results.length >= maxResults) continue;
    const title = (item.title || item.url).slice(0, 500);
    const excerpts = item.excerpts.join('\n\n');
    const snippet = excerpts.slice(0, 4000);
    if (title.length < (item.title || item.url).length || snippet.length < excerpts.length) truncated = true;
    const chars = title.length + item.url.length + snippet.length;
    if (outputChars + chars > MAX_OUTPUT_CHARS) {
      truncated = true;
      continue;
    }
    outputChars += chars;
    results.push({ title, url: item.url, snippet, source: SearchEngine.Parallel, position: results.length + 1 });
  }
  if (truncated) warnings.push('Parallel search output was truncated to fit local output limits.');
  return {
    query, engine: SearchEngine.Parallel, results, totalResults: results.length,
    timestamp: Date.now(), duration: Date.now() - start,
    ...(warnings.length ? { warnings } : {}),
  };
}

export class ParallelSearch {
  async search(query: unknown, maxResults = 10, timeoutMs = 30000): Promise<SearchResponse> {
    if (typeof query !== 'string' || !query.trim() || query.trim().length > 200) {
      throw new Error('Parallel requires a non-empty query of at most 200 characters');
    }
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) {
      throw new Error('Parallel maxResults must be an integer between 1 and 50');
    }
    query = query.trim();
    const start = Date.now();
    const deadline = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, 30000)));
    let activeSignal = deadline;
    const transport = new StreamableHTTPClientTransport(new URL(PARALLEL_ENDPOINT), {
      requestInit: { headers: { 'User-Agent': PARALLEL_USER_AGENT } },
      fetch: async (input, init) => boundedResponse(await fetch(input, {
        ...init, redirect: 'error',
        signal: init?.signal ? AbortSignal.any([init.signal, activeSignal]) : activeSignal,
      })),
      reconnectionOptions: {
        maxRetries: 0, initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1,
      },
    });
    const client = new Client({ name: 'lobsterai-web-search', version });
    try {
      await client.connect(transport, { timeout: Math.min(timeoutMs, 30000) });
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      let found = false;
      do {
        const tools = await client.listTools(cursor ? { cursor } : {}, { signal: deadline });
        found = tools.tools.some((tool) => tool.name === 'web_search');
        cursor = tools.nextCursor;
        if (cursor && seenCursors.has(cursor)) throw new Error('Parallel tool discovery repeated a cursor');
        if (cursor) seenCursors.add(cursor);
      } while (!found && cursor);
      if (!found) throw new Error('Parallel MCP did not advertise web_search');
      const result = await client.callTool({
        name: 'web_search', arguments: { objective: query, search_queries: [query] },
      }, undefined, { signal: deadline, timeout: Math.min(timeoutMs, 30000) });
      return parseResults(result as CallToolResult, query as string, maxResults, start);
    } catch (error) {
      const status = error instanceof StreamableHTTPError && error.code ? ` (HTTP ${error.code})` : '';
      throw new Error(`Parallel search failed${status}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Independent deadline lets session cleanup run after a search timeout.
      activeSignal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
      try {
        await transport.terminateSession();
      } catch {
        // Best effort cleanup must preserve the original outcome.
      }
      try {
        await client.close();
      } catch {
        // Closing local transport resources must not replace search evidence.
      }
    }
  }
}
