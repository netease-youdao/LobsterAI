import * as path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, test, vi } from 'vitest';

const HELPERS_URL = pathToFileURL(
  path.resolve('dsh-bundles/lobsterai-host/plugins/mcp-sse-bridge-helpers.mjs'),
).href;

interface MockTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface MockClientInstance {
  onclose?: () => void;
  onerror?: (error: unknown) => void;
  connect: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  getServerCapabilities: ReturnType<typeof vi.fn>;
  getInstructions: ReturnType<typeof vi.fn>;
  triggerListChanged: () => void;
}

interface MockTransportInstance {
  close: ReturnType<typeof vi.fn>;
}

interface McpSseBridgeHelpersModule {
  publicSseToolName: (serverName: string, rawName: string) => string;
  normalizeSseServerEntry: (entry: Record<string, unknown>) => {
    name: string;
    url: string;
    headers: Record<string, string>;
    startupTimeoutMs: number;
    toolCallTimeoutMs: number;
    closeTimeoutMs: number;
    fingerprint: string;
  };
  describeMcpError: (error: unknown) => string;
  isSseDisconnectError: (error: unknown, isSseError?: (err: unknown) => boolean) => boolean;
  createMcpSseBridgeController: (
    ctx: unknown,
    deps: {
      createClient: (opts: { serverName: string; onToolsListChanged: () => void }) => MockClientInstance;
      createTransport: (config: { name: string; url: string; headers: Record<string, string> }) => MockTransportInstance;
      createToolDefinition: (ctx: unknown, opts: Record<string, unknown>) => Record<string, unknown>;
      isSseError?: (err: unknown) => boolean;
      initialSyncWaitMs?: number;
      now?: () => number;
    },
  ) => {
    list: () => Array<{ name: string; configured: boolean; transport: string; status: Record<string, unknown> }>;
    disposeRemovedOrChanged: (entries: Array<Record<string, unknown>>) => Promise<void>;
    sync: (entries: Array<Record<string, unknown>>) => Promise<{
      registered: string[];
      errors: string[];
      statuses: Array<{ name: string; configured: boolean; transport: string; status: Record<string, unknown> }>;
    }>;
    disposeAll: () => Promise<void>;
  };
}

let cached: McpSseBridgeHelpersModule | null = null;
async function loadHelpers(): Promise<McpSseBridgeHelpersModule> {
  if (!cached) {
    cached = (await import(HELPERS_URL)) as McpSseBridgeHelpersModule;
  }
  return cached;
}

function createFakeCtx() {
  const registeredTools = new Map<string, Record<string, unknown>>();
  const promptSections = new Map<string, { text: () => string; order: number; interpolate: boolean }>();

  const toolsService = {
    register: vi.fn((def: { name: string }) => {
      if (registeredTools.has(def.name)) {
        throw new Error(`Tool "${def.name}" is already registered`);
      }
      registeredTools.set(def.name, def);
      return () => {
        registeredTools.delete(def.name);
      };
    }),
  };

  const systemPromptService = {
    getSectionOrder: vi.fn(() => 50),
    section: vi.fn((sec: { name: string; text: () => string; order: number; interpolate: boolean }) => {
      promptSections.set(sec.name, sec);
      return () => {
        promptSections.delete(sec.name);
      };
    }),
  };

  const ctx = {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    get(serviceName: string) {
      if (serviceName === 'tools') return toolsService;
      if (serviceName === 'systemPrompt') return systemPromptService;
      return undefined;
    },
  };

  return { ctx, toolsService, systemPromptService, registeredTools, promptSections };
}

function createMockClient(options: {
  tools?: MockTool[];
  instructions?: string;
  connectImpl?: () => Promise<void>;
  callToolImpl?: (params: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
  onToolsListChanged: () => void;
}): MockClientInstance {
  let currentTools = options.tools ?? [];
  return {
    connect: vi.fn(async () => {
      if (options.connectImpl) await options.connectImpl();
    }),
    listTools: vi.fn(async () => ({ tools: currentTools })),
    callTool: vi.fn(async (params: { name: string; arguments: Record<string, unknown> }) => (
      options.callToolImpl
        ? options.callToolImpl(params)
        : { content: [{ type: 'text', text: `called:${params.name}` }] }
    )),
    close: vi.fn(async () => {}),
    getServerCapabilities: vi.fn(() => ({ tools: { listChanged: true } })),
    getInstructions: vi.fn(() => options.instructions),
    triggerListChanged: () => {
      options.onToolsListChanged();
    },
    set tools(next: MockTool[]) {
      currentTools = next;
    },
  } as MockClientInstance & { tools: MockTool[] };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('mcp-sse-bridge-helpers', () => {
  test('publicSseToolName matches dsh-mcp-client naming invariants', async () => {
    const { publicSseToolName } = await loadHelpers();

    expect(publicSseToolName('legacy-sse', 'get_warehouse_code')).toBe('mcp__legacy-sse__get_warehouse_code');

    const withDots = publicSseToolName('legacy-sse', 'v1.warehouse/get');
    expect(withDots).toMatch(/^mcp__legacy-sse__v1_warehouse_get_[0-9a-f]{12}$/);
    expect(withDots.length).toBeLessThanOrEqual(64);
    expect(publicSseToolName('legacy-sse', 'v1.warehouse/get')).toBe(withDots);

    const longName = publicSseToolName('my-very-long-server-name', 'extremely_verbose_legacy_tool_name_exceeding_limit');
    expect(longName.length).toBe(64);
    expect(longName).toMatch(/_[0-9a-f]{12}$/);
  });

  test('normalizeSseServerEntry validates names, URLs, headers, and computes stable fingerprints', async () => {
    const { normalizeSseServerEntry } = await loadHelpers();

    const a = normalizeSseServerEntry({
      name: 'legacy-sse',
      url: 'https://example.com/sse',
      headers: { 'X-B': '2', Authorization: 'Bearer secret' },
    });
    const b = normalizeSseServerEntry({
      name: 'legacy-sse',
      url: 'https://example.com/sse',
      headers: { Authorization: 'Bearer secret', 'X-B': '2' },
    });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.headers).toEqual({ 'X-B': '2', Authorization: 'Bearer secret' });

    const rotated = normalizeSseServerEntry({
      name: 'legacy-sse',
      url: 'https://example.com/sse',
      headers: { Authorization: 'Bearer rotated-secret', 'X-B': '2' },
    });
    expect(rotated.fingerprint).not.toBe(a.fingerprint);

    expect(() => normalizeSseServerEntry({ name: 'bad name!', url: 'https://example.com/sse' })).toThrow(/server name/);
    expect(() => normalizeSseServerEntry({ name: 'legacy-sse', url: '' })).toThrow(/requires "url"/);
    expect(() => normalizeSseServerEntry({ name: 'legacy-sse', url: 'ftp://example.com/sse' })).toThrow(/http or https/);
  });

  test('describeMcpError and isSseDisconnectError distinguish SSE stream failures from ordinary POST errors', async () => {
    const { describeMcpError, isSseDisconnectError } = await loadHelpers();

    const sseErr = Object.assign(new Error('SSE error: Non-200 status code (401)'), {
      name: 'SseError',
      code: 401,
    });
    expect(describeMcpError(sseErr)).toContain('401');
    expect(isSseDisconnectError(sseErr)).toBe(true);

    const sessionGone = new Error('Error POSTing to endpoint (HTTP 404): Unknown session');
    expect(isSseDisconnectError(sessionGone)).toBe(true);

    const toolPost500 = new Error('Error POSTing to endpoint (HTTP 500): Internal error');
    expect(isSseDisconnectError(toolPost500)).toBe(false);
  });

  test('registers tools, handles tools/list_changed, reuses unchanged connections, and cleans up on removal', async () => {
    const { createMcpSseBridgeController } = await loadHelpers();
    const { ctx, registeredTools, promptSections } = createFakeCtx();

    const clients: Array<MockClientInstance & { tools?: MockTool[] }> = [];
    const transportCloseSpies: Array<ReturnType<typeof vi.fn>> = [];

    const controller = createMcpSseBridgeController(ctx, {
      createClient: ({ onToolsListChanged }) => {
        const client = createMockClient({
          tools: [{ name: 'get_warehouse_code', description: 'Lookup code' }],
          instructions: 'Use warehouse codes carefully.',
          onToolsListChanged,
        });
        clients.push(client);
        return client;
      },
      createTransport: () => {
        const closeSpy = vi.fn(async () => {});
        transportCloseSpies.push(closeSpy);
        return { close: closeSpy };
      },
      createToolDefinition: (_pluginCtx, opts) => opts,
    });

    const res1 = await controller.sync([
      {
        name: 'legacy-sse',
        url: 'http://127.0.0.1:9999/sse',
        headers: { Authorization: 'Bearer tok-1' },
      },
    ]);

    expect(res1.registered).toEqual(['legacy-sse']);
    expect(res1.errors).toEqual([]);
    expect(res1.statuses).toEqual([
      expect.objectContaining({
        name: 'legacy-sse',
        configured: true,
        transport: 'sse',
        status: expect.objectContaining({ state: 'connected', toolCount: 1 }),
      }),
    ]);
    expect([...registeredTools.keys()]).toEqual(['mcp__legacy-sse__get_warehouse_code']);
    expect(promptSections.get('mcp:legacy-sse')?.text()).toContain('Use warehouse codes carefully.');

    // Invoking the registered tool calls client.callTool with the raw tool name.
    const toolDef = registeredTools.get('mcp__legacy-sse__get_warehouse_code') as {
      call: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<unknown>;
    };
    const callResult = await toolDef.call({ id: 'W1' }, { signal: new AbortController().signal });
    expect(callResult).toEqual({ content: [{ type: 'text', text: 'called:get_warehouse_code' }] });
    expect(clients[0].callTool).toHaveBeenCalledWith(
      { name: 'get_warehouse_code', arguments: { id: 'W1' } },
      expect.objectContaining({ timeout: 60_000 }),
    );

    // tools/list_changed swaps the live tool registrations cleanly.
    (clients[0] as unknown as { tools: MockTool[] }).tools = [
      { name: 'get_warehouse_code', description: 'Lookup code v2' },
      { name: 'list_warehouses', description: 'List all' },
    ];
    clients[0].triggerListChanged();
    await vi.waitFor(() => {
      expect([...registeredTools.keys()].sort()).toEqual([
        'mcp__legacy-sse__get_warehouse_code',
        'mcp__legacy-sse__list_warehouses',
      ]);
    });
    expect(controller.list()[0].status).toMatchObject({ state: 'connected', toolCount: 2 });

    // Re-syncing identical config reuses the live connection without reopening.
    await controller.sync([
      {
        name: 'legacy-sse',
        url: 'http://127.0.0.1:9999/sse',
        headers: { Authorization: 'Bearer tok-1' },
      },
    ]);
    expect(clients).toHaveLength(1);

    // Changing headers closes the old connection and opens a fresh one.
    await controller.sync([
      {
        name: 'legacy-sse',
        url: 'http://127.0.0.1:9999/sse',
        headers: { Authorization: 'Bearer tok-2' },
      },
    ]);
    expect(clients).toHaveLength(2);
    expect(clients[0].close).toHaveBeenCalledTimes(1);
    expect(transportCloseSpies[0]).toHaveBeenCalledTimes(1);

    // Disabling/removing the server unregisters all tools, clears prompt section, and closes transport.
    const resEmpty = await controller.sync([]);
    expect(resEmpty.registered).toEqual([]);
    expect(resEmpty.statuses).toEqual([]);
    expect(registeredTools.size).toBe(0);
    expect(promptSections.size).toBe(0);
    expect(clients[1].close).toHaveBeenCalledTimes(1);
    expect(transportCloseSpies[1]).toHaveBeenCalledTimes(1);
  });

  test('reconnects after SSE disconnect and unregisters tools if retries are exhausted', async () => {
    const { createMcpSseBridgeController } = await loadHelpers();
    const { ctx, registeredTools } = createFakeCtx();

    let attempt = 0;
    const clients: MockClientInstance[] = [];
    const transportCloseSpies: Array<ReturnType<typeof vi.fn>> = [];

    const controller = createMcpSseBridgeController(ctx, {
      createClient: ({ onToolsListChanged }) => {
        attempt += 1;
        const currentAttempt = attempt;
        const client = createMockClient({
          tools: [{ name: 'ping' }],
          connectImpl: async () => {
            if (currentAttempt === 2 || currentAttempt >= 4) {
              throw new Error('SSE error: ECONNREFUSED');
            }
          },
          onToolsListChanged,
        });
        clients.push(client);
        return client;
      },
      createTransport: () => {
        const closeSpy = vi.fn(async () => {});
        transportCloseSpies.push(closeSpy);
        return { close: closeSpy };
      },
      createToolDefinition: (_pluginCtx, opts) => opts,
    });

    await controller.sync([
      {
        name: 'flaky-sse',
        url: 'http://127.0.0.1:9998/sse',
        reconnect: { enabled: true, initialDelayMs: 10, maxDelayMs: 25, maxAttempts: 2 },
      },
    ]);
    expect(registeredTools.has('mcp__flaky-sse__ping')).toBe(true);

    // Simulate an SSE stream drop -> attempt 2 fails -> attempt 3 succeeds!
    const sseDisconnect = Object.assign(new Error('SSE error: stream closed'), { name: 'SseError' });
    clients[0].onerror?.(sseDisconnect);

    await vi.waitFor(() => {
      expect(clients.length).toBe(3);
      expect(controller.list()[0].status).toMatchObject({ state: 'connected', toolCount: 1 });
    }, { timeout: 2_000 });
    expect(transportCloseSpies[0]).toHaveBeenCalledTimes(1);
    expect(transportCloseSpies[1]).toHaveBeenCalledTimes(1);

    // Now simulate permanent outage -> exhausts reconnect budget and unregisters tools.
    clients[2].onclose?.();
    await vi.waitFor(() => {
      expect(controller.list()[0].status).toMatchObject({ state: 'failed', reason: 'gave-up' });
      expect(registeredTools.size).toBe(0);
    }, { timeout: 2_000 });

    await controller.disposeAll();
  });

  test('rolls back partial registrations on tool name collision and reports startup error cleanly', async () => {
    const { createMcpSseBridgeController } = await loadHelpers();
    const { ctx, registeredTools } = createFakeCtx();

    // Squat on the second tool's name to trigger a mid-swap registration failure.
    registeredTools.set('mcp__clash-sse__second', { name: 'mcp__clash-sse__second' });

    const controller = createMcpSseBridgeController(ctx, {
      createClient: ({ onToolsListChanged }) => createMockClient({
        tools: [{ name: 'first' }, { name: 'second' }],
        onToolsListChanged,
      }),
      createTransport: () => ({ close: vi.fn(async () => {}) }),
      createToolDefinition: (_pluginCtx, opts) => opts,
    });

    const res = await controller.sync([
      {
        name: 'clash-sse',
        url: 'http://127.0.0.1:9997/sse',
        reconnect: { enabled: false },
      },
    ]);

    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain('tool registration failed');
    // First tool was rolled back; only the pre-existing foreign registration remains.
    expect(registeredTools.has('mcp__clash-sse__first')).toBe(false);
    expect(registeredTools.has('mcp__clash-sse__second')).toBe(true);
    expect(res.statuses[0].status).toMatchObject({ state: 'failed', reason: 'reconnect-disabled' });

    await controller.disposeAll();
  });
});
