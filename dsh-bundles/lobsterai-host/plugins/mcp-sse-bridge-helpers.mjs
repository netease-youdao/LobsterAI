/**
 * Pure lifecycle & protocol helpers for LobsterAI's legacy MCP SSE bridge
 * (`mcp-sse-bridge.mjs`).
 *
 * Zero DSH / `@modelcontextprotocol/*` peer imports so Vitest can test tool
 * naming, validation, two-phase swap/rollback, `tools/list_changed`, reconnect
 * backoff, disconnect handling, and full cleanup directly in Node.
 */

import { createHash } from 'node:crypto';

export const DEFAULT_SSE_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;
export const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
export const DEFAULT_INITIAL_SYNC_WAIT_MS = 10_000;
export const DEFAULT_MAX_INSTRUCTION_BYTES = 32_768;

export const DEFAULT_RECONNECT_POLICY = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
});

const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const HASH_LENGTH = 12;

export class McpSseToolRegistrationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'McpSseToolRegistrationError';
  }
}

/**
 * Derive the model-facing public tool name for an MCP SSE tool.
 *
 * Matches `@deepseek-ai/dsh-mcp-client`'s `publicToolName(serverName, rawName)`
 * contract verbatim: `mcp__<serverName>__<rawName>` when valid and <= 64 chars,
 * otherwise sanitized + truncated with a 12-hex-char SHA-256 identity suffix.
 *
 * @param {string} serverName
 * @param {string} rawName
 * @returns {string}
 */
export function publicSseToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, '_');
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) {
    return normalized;
  }
  const hash = createHash('sha256')
    .update(`${serverName}\0${rawName}`)
    .digest('hex')
    .slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

/**
 * Format an error (including `SseError.code` and `cause` chains) into a concise
 * diagnostic string.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function describeMcpError(error) {
  const seen = new Set();
  const segments = [];
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      const statusCode = typeof (/** @type {{ code?: unknown }} */ (current)).code === 'number'
        ? (/** @type {{ code: number }} */ (current)).code
        : undefined;
      const base = current.name === 'Error' || current.message === ''
        ? (current.message || current.name)
        : `${current.name}: ${current.message}`;
      const withCode = statusCode !== undefined && !base.includes(String(statusCode))
        ? `${base} (HTTP ${statusCode})`
        : base;
      segments.push(withCode);
      current = current.cause;
    } else {
      segments.push(String(current));
      current = undefined;
    }
  }
  if (segments.length === 0) return String(error);
  return segments[0] + segments.slice(1).map((seg) => `, cause: ${seg}`).join('');
}

/**
 * Determine whether an error reported by an active SSE client indicates that
 * the underlying SSE stream or session is broken and should trigger a full
 * transport teardown + fresh MCP reconnect.
 *
 * Single POST tool-call errors (e.g. HTTP 400/500) do not tear down a healthy
 * SSE stream, whereas `SseError` (from EventSource) or HTTP 404/410 (expired
 * session endpoint) mean the SSE connection must be rebuilt.
 *
 * @param {unknown} error
 * @param {((err: unknown) => boolean) | undefined} isSseError
 * @returns {boolean}
 */
export function isSseDisconnectError(error, isSseError) {
  if (!error || typeof error !== 'object') return false;
  if (typeof isSseError === 'function' && isSseError(error)) return true;
  const err = /** @type {{ name?: unknown, message?: unknown }} */ (error);
  if (err.name === 'SseError') return true;
  const msg = typeof err.message === 'string' ? err.message : '';
  if (msg.startsWith('SSE error:')) return true;
  if (/Error POSTing to endpoint \(HTTP (404|410)\)/.test(msg)) return true;
  return false;
}

/**
 * Normalize headers into a clean string-to-string record.
 *
 * @param {unknown} rawHeaders
 * @returns {Record<string, string>}
 */
export function normalizeSseHeaders(rawHeaders) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
    return headers;
  }
  for (const [rawKey, rawVal] of Object.entries(rawHeaders)) {
    const key = rawKey.trim();
    if (!key || rawVal === undefined || rawVal === null) continue;
    headers[key] = String(rawVal);
  }
  return headers;
}

/**
 * Normalize and validate a single SSE MCP server entry.
 *
 * @param {Record<string, unknown>} entry
 * @param {RegExp} [serverNamePattern]
 */
export function normalizeSseServerEntry(entry, serverNamePattern = DEFAULT_SSE_SERVER_NAME_PATTERN) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('SSE MCP server entry must be an object');
  }
  const name = String(entry.name || '').trim();
  if (!name || !serverNamePattern.test(name)) {
    throw new Error(`servers.${name || '(empty)'}: server name must match ${String(serverNamePattern)}`);
  }

  const rawUrl = typeof entry.url === 'string' ? entry.url.trim() : '';
  if (!rawUrl) {
    throw new Error(`servers.${name}: an sse server requires "url"`);
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error(`servers.${name}: invalid SSE URL "${rawUrl}"`);
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`servers.${name}: SSE URL must use http or https protocol`);
  }

  const headers = normalizeSseHeaders(entry.headers);
  const startupTimeoutMs = typeof entry.startupTimeoutMs === 'number'
    && Number.isFinite(entry.startupTimeoutMs)
    && entry.startupTimeoutMs > 0
    ? entry.startupTimeoutMs
    : DEFAULT_STARTUP_TIMEOUT_MS;
  const toolCallTimeoutMs = typeof entry.toolCallTimeoutMs === 'number'
    && Number.isFinite(entry.toolCallTimeoutMs)
    && entry.toolCallTimeoutMs > 0
    ? entry.toolCallTimeoutMs
    : DEFAULT_TOOL_CALL_TIMEOUT_MS;
  const closeTimeoutMs = typeof entry.closeTimeoutMs === 'number'
    && Number.isFinite(entry.closeTimeoutMs)
    && entry.closeTimeoutMs > 0
    ? entry.closeTimeoutMs
    : DEFAULT_CLOSE_TIMEOUT_MS;

  const rawReconnect = entry.reconnect && typeof entry.reconnect === 'object'
    ? /** @type {Record<string, unknown>} */ (entry.reconnect)
    : {};
  const reconnect = Object.freeze({
    enabled: typeof rawReconnect.enabled === 'boolean'
      ? rawReconnect.enabled
      : DEFAULT_RECONNECT_POLICY.enabled,
    initialDelayMs: typeof rawReconnect.initialDelayMs === 'number'
      && Number.isFinite(rawReconnect.initialDelayMs)
      && rawReconnect.initialDelayMs > 0
      ? rawReconnect.initialDelayMs
      : DEFAULT_RECONNECT_POLICY.initialDelayMs,
    maxDelayMs: typeof rawReconnect.maxDelayMs === 'number'
      && Number.isFinite(rawReconnect.maxDelayMs)
      && rawReconnect.maxDelayMs > 0
      ? rawReconnect.maxDelayMs
      : DEFAULT_RECONNECT_POLICY.maxDelayMs,
    maxAttempts: typeof rawReconnect.maxAttempts === 'number'
      && Number.isInteger(rawReconnect.maxAttempts)
      && rawReconnect.maxAttempts >= 1
      ? rawReconnect.maxAttempts
      : DEFAULT_RECONNECT_POLICY.maxAttempts,
  });

  const sortedHeaders = Object.keys(headers)
    .sort()
    .map((k) => [k, headers[k]]);
  const fingerprint = JSON.stringify({
    url: parsedUrl.href,
    headers: sortedHeaders,
    startupTimeoutMs,
    toolCallTimeoutMs,
    closeTimeoutMs,
    reconnect,
  });

  return {
    name,
    url: parsedUrl.href,
    headers,
    startupTimeoutMs,
    toolCallTimeoutMs,
    closeTimeoutMs,
    reconnect,
    fingerprint,
  };
}

/**
 * Race `promise` against a timeout without keeping the Node event loop alive.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} remainingMs
 * @param {string} timeoutMessage
 * @returns {Promise<T>}
 */
function withDeadline(promise, remainingMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, Math.max(1, remainingMs));
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Truncate UTF-8 text cleanly to a maximum byte budget.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateUtf8Bytes(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  // Decode back and strip any trailing replacement char from a split multibyte sequence.
  return buf.toString('utf8').replace(/\uFFFD+$/, '');
}

/**
 * Create a managed MCP SSE bridge controller that owns legacy SSE connections,
 * registers discovered tools on `ctx.tools`, handles `tools/list_changed`,
 * performs bounded reconnects on disconnect, and cleans up all resources on
 * disable/removal/shutdown.
 *
 * @param {any} ctx
 * @param {{
 *   createClient: (opts: { serverName: string, onToolsListChanged: () => void }) => any,
 *   createTransport: (config: ReturnType<typeof normalizeSseServerEntry>) => any,
 *   createToolDefinition: (ctx: any, opts: any) => any,
 *   isSseError?: (err: unknown) => boolean,
 *   serverNamePattern?: RegExp,
 *   initialSyncWaitMs?: number,
 *   now?: () => number,
 * }} deps
 */
export function createMcpSseBridgeController(ctx, deps) {
  const serverNamePattern = deps.serverNamePattern ?? DEFAULT_SSE_SERVER_NAME_PATTERN;
  const initialSyncWaitMs = deps.initialSyncWaitMs ?? DEFAULT_INITIAL_SYNC_WAIT_MS;
  const now = deps.now ?? (() => Date.now());
  const logger = ctx?.logger ?? console;

  /** @type {Map<string, ReturnType<typeof createManagedEntry>>} */
  const entries = new Map();

  function getToolsService() {
    if (typeof ctx?.get === 'function') {
      return ctx.get('tools');
    }
    return ctx?.tools;
  }

  function getSystemPromptService() {
    if (typeof ctx?.get === 'function') {
      return ctx.get('systemPrompt');
    }
    return ctx?.systemPrompt;
  }

  function createManagedEntry(config) {
    const label = `[LobsterAI:McpSseBridge:${config.name}]`;
    let status = { state: 'connecting', attempt: 0 };
    let disposed = false;
    let current = null;
    /** @type {Map<string, () => void>} */
    let toolDisposers = new Map();
    let disposePromptSection = null;
    let serverInstructions = '';
    let syncChain = Promise.resolve();
    let settling = Promise.resolve();
    let reconnectTimer;
    let failedAttempts = 0;

    let resolveInitial;
    let initialSettled = false;
    const initialReady = new Promise((resolve) => {
      resolveInitial = (outcome) => {
        if (initialSettled) return;
        initialSettled = true;
        resolve(outcome);
      };
    });

    function isCurrent(gen) {
      return !disposed && current === gen && !gen.lifetime.signal.aborted;
    }

    function stopTimers() {
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
    }

    function clearPromptSection() {
      serverInstructions = '';
      if (disposePromptSection) {
        try {
          disposePromptSection();
        } catch {
          // ignore prompt section cleanup failure
        }
        disposePromptSection = null;
      }
    }

    function updatePromptInstructions(rawInstructions) {
      const trimmed = typeof rawInstructions === 'string' ? rawInstructions.trimEnd() : '';
      if (!trimmed) {
        clearPromptSection();
        return;
      }
      const formatted = `### MCP server: ${config.name}\n\n${trimmed}`;
      if (Buffer.byteLength(formatted, 'utf8') > DEFAULT_MAX_INSTRUCTION_BYTES) {
        logger.warn?.(
          `${label} server instructions exceed ${DEFAULT_MAX_INSTRUCTION_BYTES} bytes; truncating`,
        );
        serverInstructions = truncateUtf8Bytes(formatted, DEFAULT_MAX_INSTRUCTION_BYTES);
      } else {
        serverInstructions = formatted;
      }
      if (!disposePromptSection) {
        const systemPrompt = getSystemPromptService();
        if (
          systemPrompt
          && typeof systemPrompt.section === 'function'
          && typeof systemPrompt.getSectionOrder === 'function'
        ) {
          try {
            disposePromptSection = systemPrompt.section({
              name: `mcp:${config.name}`,
              order: systemPrompt.getSectionOrder('MCP_SERVERS'),
              interpolate: false,
              text: () => serverInstructions,
            });
          } catch (error) {
            logger.warn?.(
              `${label} failed to register systemPrompt section: ${describeMcpError(error)}`,
            );
          }
        }
      }
    }

    function clearTools() {
      for (const dispose of toolDisposers.values()) {
        try {
          dispose();
        } catch (error) {
          logger.warn?.(`${label} tool cleanup failed: ${describeMcpError(error)}`);
        }
      }
      toolDisposers = new Map();
      clearPromptSection();
    }

    async function closeGeneration(gen) {
      if (!gen) return;
      if (gen.closing) return gen.closing;
      gen.closing = (async () => {
        gen.intentionalClose = true;
        gen.lifetime.abort(new Error('MCP SSE connection closed'));
        const closeWork = async () => {
          try {
            if (typeof gen.client?.close === 'function') {
              await gen.client.close();
            }
          } catch {
            // Fall through to ensure underlying transport/EventSource is closed.
          } finally {
            try {
              await gen.transport?.close?.();
            } catch {
              // ignore close error
            }
          }
        };
        try {
          await withDeadline(closeWork(), config.closeTimeoutMs, `${label} cleanup timed out`);
        } catch (error) {
          logger.warn?.(`${label} close did not settle cleanly: ${describeMcpError(error)}`);
        }
      })();
      return gen.closing;
    }

    async function syncToolsForGeneration(gen) {
      const toolsService = getToolsService();
      if (!toolsService || typeof toolsService.register !== 'function') {
        throw new Error('tools service is not mounted');
      }

      const signal = gen.lifetime.signal;
      const hasToolsCapability = gen.client.getServerCapabilities?.()?.tools !== undefined;
      const response = hasToolsCapability
        ? await gen.client.listTools(undefined, {
            cacheMode: 'refresh',
            signal,
          })
        : { tools: [] };

      const listedTools = Array.isArray(response?.tools) ? response.tools : [];
      /** @type {Map<string, any>} */
      const definitions = new Map();
      for (const tool of listedTools) {
        if (!tool || typeof tool.name !== 'string' || tool.name.length === 0) continue;
        const publicName = publicSseToolName(config.name, tool.name);
        if (definitions.has(publicName)) {
          throw new Error(
            `${label} server listed duplicate tool "${tool.name}" (public name "${publicName}")`,
          );
        }
        const definition = deps.createToolDefinition(ctx, {
          name: publicName,
          rawName: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
          outputSchema: tool.outputSchema,
          taskRequired: tool.execution?.taskSupport === 'required',
          call: async (args, execution) => {
            const callSignal = execution?.signal
              ? AbortSignal.any([execution.signal, signal])
              : signal;
            return await gen.client.callTool(
              {
                name: tool.name,
                arguments: args,
              },
              {
                signal: callSignal,
                timeout: config.toolCallTimeoutMs,
                toolDefinition: tool,
              },
            );
          },
        });
        definitions.set(publicName, definition);
      }

      if (!isCurrent(gen)) return;

      for (const dispose of toolDisposers.values()) {
        try {
          dispose();
        } catch {
          // best-effort unmount of prior generation
        }
      }

      /** @type {Map<string, () => void>} */
      const nextDisposers = new Map();
      try {
        for (const [publicName, definition] of definitions) {
          nextDisposers.set(publicName, toolsService.register(definition));
        }
      } catch (error) {
        for (const dispose of nextDisposers.values()) {
          try {
            dispose();
          } catch {
            // rollback best-effort
          }
        }
        toolDisposers = new Map();
        throw new McpSseToolRegistrationError(
          `${label} tool registration failed: ${describeMcpError(error)}`,
          { cause: error },
        );
      }
      toolDisposers = nextDisposers;
    }

    function enqueueSync(gen) {
      const run = syncChain.then(async () => {
        if (!isCurrent(gen)) return;
        await syncToolsForGeneration(gen);
      });
      syncChain = run.then(() => undefined, () => undefined);
      return run;
    }

    function scheduleReconnect(errorMessage, connectedAt) {
      if (disposed) return;
      const policy = config.reconnect;
      if (!policy.enabled) {
        status = {
          state: 'failed',
          reason: 'reconnect-disabled',
          lastError: errorMessage,
        };
        logger.warn?.(`${label} connection failed and reconnect is disabled: ${errorMessage}`);
        return;
      }
      if (connectedAt !== undefined && now() - connectedAt >= policy.maxDelayMs) {
        failedAttempts = 0;
      }
      failedAttempts += 1;
      if (failedAttempts > policy.maxAttempts) {
        syncChain = syncChain.then(() => clearTools());
        status = {
          state: 'failed',
          reason: 'gave-up',
          lastError: errorMessage,
        };
        logger.warn?.(
          `${label} giving up after ${policy.maxAttempts} failed reconnect attempts: ${errorMessage}`,
        );
        return;
      }
      const delayMs = Math.min(policy.maxDelayMs, policy.initialDelayMs * (2 ** (failedAttempts - 1)));
      status = {
        state: 'reconnecting',
        attempt: failedAttempts,
        maxAttempts: policy.maxAttempts,
        nextRetryAtMs: now() + delayMs,
        lastError: errorMessage,
      };
      logger.warn?.(
        `${label} ${connectedAt !== undefined ? 'connection lost; reconnecting' : 'connection failed; retrying'} in ${delayMs}ms (attempt ${failedAttempts}/${policy.maxAttempts}): ${errorMessage}`,
      );
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        settling = connectGeneration();
      }, delayMs);
      reconnectTimer.unref?.();
    }

    function lost(gen, reason) {
      if (!isCurrent(gen)) return;
      current = null;
      settling = closeGeneration(gen).then(() => {
        resolveInitial({ ok: false, error: reason });
        if (!disposed) {
          scheduleReconnect(reason, gen.connectedAt);
        }
      });
    }

    async function refreshTools(gen) {
      if (!isCurrent(gen)) return;
      logger.info?.(`${label} tool list changed, re-syncing`);
      try {
        await enqueueSync(gen);
        if (isCurrent(gen) && gen.connectedAt !== undefined) {
          status = {
            state: 'connected',
            toolCount: toolDisposers.size,
            connectedAt: gen.connectedAt,
          };
        }
      } catch (error) {
        if (error instanceof McpSseToolRegistrationError) {
          lost(gen, describeMcpError(error));
        } else if (isCurrent(gen)) {
          logger.warn?.(`${label} tool re-sync failed: ${describeMcpError(error)}`);
        }
      }
    }

    async function connectGeneration() {
      if (disposed) return;

      const gen = {
        client: null,
        transport: null,
        lifetime: new AbortController(),
        connectedAt: undefined,
        intentionalClose: false,
        closing: null,
      };
      current = gen;
      status = { state: 'connecting', attempt: failedAttempts };

      try {
        const startedAt = now();
        const remaining = () => config.startupTimeoutMs - (now() - startedAt);

        const client = deps.createClient({
          serverName: config.name,
          onToolsListChanged: () => {
            void refreshTools(gen);
          },
        });
        const transport = deps.createTransport(config);
        if (transport && typeof transport.close === 'function') {
          const rawClose = transport.close.bind(transport);
          let transportClosing;
          transport.close = () => (transportClosing ??= Promise.resolve().then(() => rawClose()));
        }
        gen.client = client;
        gen.transport = transport;

        client.onclose = () => {
          if (!gen.intentionalClose && gen.connectedAt !== undefined) {
            lost(gen, 'SSE connection closed');
          }
        };
        client.onerror = (error) => {
          if (gen.intentionalClose || !isCurrent(gen)) return;
          const diag = describeMcpError(error);
          if (gen.connectedAt !== undefined && isSseDisconnectError(error, deps.isSseError)) {
            lost(gen, diag);
          } else {
            logger.warn?.(`${label} client error: ${diag}`);
          }
        };

        await withDeadline(
          client.connect(transport, {
            signal: gen.lifetime.signal,
            timeout: Math.max(1, remaining()),
          }),
          remaining(),
          `${label} SSE connect timed out after ${config.startupTimeoutMs}ms`,
        );

        if (!isCurrent(gen)) {
          await closeGeneration(gen);
          return;
        }

        const syncPromise = enqueueSync(gen);
        await withDeadline(
          syncPromise,
          remaining(),
          `${label} SSE initial tool listing timed out after ${config.startupTimeoutMs}ms`,
        );

        if (!isCurrent(gen)) {
          await closeGeneration(gen);
          return;
        }

        updatePromptInstructions(client.getInstructions?.());
        gen.connectedAt = now();
        status = {
          state: 'connected',
          toolCount: toolDisposers.size,
          connectedAt: gen.connectedAt,
        };
        resolveInitial({ ok: true });
        if (failedAttempts > 0) {
          logger.info?.(
            `${label} reconnected and synced ${toolDisposers.size} tool(s) (attempt ${failedAttempts}/${config.reconnect.maxAttempts})`,
          );
        }
      } catch (error) {
        const diag = describeMcpError(error);
        if (current === gen) {
          current = null;
        }
        await closeGeneration(gen);
        resolveInitial({ ok: false, error: diag });
        if (!disposed) {
          logger.warn?.(`${label} startup failed: ${diag}`);
          scheduleReconnect(diag, undefined);
        }
      }
    }

    settling = Promise.resolve().then(() => connectGeneration());

    return {
      config,
      initialReady,
      getStatus() {
        return { ...status };
      },
      getRegisteredToolNames() {
        return [...toolDisposers.keys()];
      },
      isReusableFor(nextConfig) {
        return !disposed
          && config.fingerprint === nextConfig.fingerprint
          && (status.state === 'connected' || status.state === 'connecting');
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        resolveInitial({ ok: false, error: 'disposed' });
        stopTimers();
        const gen = current;
        current = null;
        if (gen) {
          await closeGeneration(gen);
        }
        try {
          await withDeadline(
            Promise.allSettled([settling, syncChain]),
            config.closeTimeoutMs,
            `${label} dispose timed out`,
          );
        } catch {
          // continue best-effort tool cleanup
        }
        clearTools();
        status = { state: 'closed' };
      },
    };
  }

  /**
   * List status entries for all currently managed SSE servers in a shape
   * compatible with `ctx.mcpManager.list()`.
   */
  function list() {
    const out = [];
    for (const [name, entry] of entries.entries()) {
      out.push({
        name,
        configured: true,
        transport: 'sse',
        status: entry.getStatus(),
      });
    }
    return out;
  }

  /**
   * Dispose any currently managed SSE servers that are not present in
   * `rawEntries` (or whose config changed or whose connection is no longer
   * reusable). Call before registering stdio/streamable-http entries so a
   * server switching away from SSE releases its tool namespace first.
   *
   * @param {Array<Record<string, unknown>>} rawEntries
   */
  async function disposeRemovedOrChanged(rawEntries) {
    /** @type {Map<string, ReturnType<typeof normalizeSseServerEntry>>} */
    const nextByName = new Map();
    for (const raw of rawEntries) {
      try {
        const normalized = normalizeSseServerEntry(raw, serverNamePattern);
        if (!nextByName.has(normalized.name)) {
          nextByName.set(normalized.name, normalized);
        }
      } catch {
        // Validation errors are reported during `sync()`.
      }
    }

    const toDispose = [];
    for (const [name, managed] of entries.entries()) {
      const next = nextByName.get(name);
      if (!next || !managed.isReusableFor(next)) {
        entries.delete(name);
        toDispose.push(managed.dispose());
      }
    }
    if (toDispose.length > 0) {
      await Promise.allSettled(toDispose);
    }
  }

  /**
   * Reconcile the live SSE MCP server fleet against `rawEntries`.
   *
   * @param {Array<Record<string, unknown>>} rawEntries
   * @param {{ awaitInitialReady?: boolean }} [options]
   * @returns {Promise<{ registered: string[], errors: string[], statuses: ReturnType<typeof list> }>}
   */
  async function sync(rawEntries, options = {}) {
    const awaitInitialReady = options?.awaitInitialReady !== false;
    const registered = [];
    const errors = [];
    const listInput = Array.isArray(rawEntries) ? rawEntries : [];

    await disposeRemovedOrChanged(listInput);

    if (listInput.length === 0) {
      return { registered, errors, statuses: list() };
    }

    const toolsService = getToolsService();
    if (!toolsService || typeof toolsService.register !== 'function') {
      for (const raw of listInput) {
        const label = typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim() : 'sse';
        errors.push(`${label}: tools service is not mounted`);
      }
      return { registered, errors, statuses: list() };
    }

    const seenInBatch = new Set();
    /** @type {Array<{ name: string, entry: ReturnType<typeof createManagedEntry>, waitMs: number }>} */
    const newlyStarted = [];

    for (const raw of listInput) {
      let config;
      try {
        config = normalizeSseServerEntry(raw, serverNamePattern);
      } catch (error) {
        const label = typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim() : 'sse';
        errors.push(`${label}: ${describeMcpError(error)}`);
        continue;
      }

      if (seenInBatch.has(config.name)) {
        errors.push(`${config.name}: duplicate SSE server name`);
        continue;
      }
      seenInBatch.add(config.name);

      const existing = entries.get(config.name);
      if (existing && existing.isReusableFor(config)) {
        registered.push(config.name);
        continue;
      }

      const managed = createManagedEntry(config);
      entries.set(config.name, managed);
      registered.push(config.name);
      newlyStarted.push({
        name: config.name,
        entry: managed,
        waitMs: Math.min(config.startupTimeoutMs, initialSyncWaitMs),
      });
    }

    if (awaitInitialReady && newlyStarted.length > 0) {
      await Promise.all(
        newlyStarted.map(async ({ name, entry, waitMs }) => {
          let waitTimer;
          const outcome = await Promise.race([
            entry.initialReady,
            new Promise((resolve) => {
              waitTimer = setTimeout(() => resolve({ ok: true, pending: true }), Math.max(1, waitMs));
              waitTimer.unref?.();
            }),
          ]).finally(() => {
            if (waitTimer !== undefined) clearTimeout(waitTimer);
          });
          if (outcome && outcome.ok === false && outcome.error) {
            errors.push(`${name}: ${outcome.error}`);
          }
        }),
      );
    }

    return {
      registered,
      errors,
      statuses: list(),
    };
  }

  /**
   * Dispose every managed SSE server cleanly (e.g. on DSH shutdown).
   */
  async function disposeAll() {
    const toDispose = [...entries.values()].map((entry) => entry.dispose());
    entries.clear();
    if (toDispose.length > 0) {
      await Promise.allSettled(toDispose);
    }
  }

  return {
    list,
    disposeRemovedOrChanged,
    sync,
    disposeAll,
  };
}
