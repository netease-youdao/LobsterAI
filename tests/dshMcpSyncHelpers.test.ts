import * as path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, test, vi } from 'vitest';

const HELPERS_URL = pathToFileURL(
  path.resolve('dsh-bundles/lobsterai-host/plugins/mcp-sync-helpers.mjs'),
).href;

type ReconcileResult = {
  registered: string[];
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: string[];
  errors: string[];
};

type McpSyncHelpers = {
  canonicalJson: (value: unknown) => string;
  normalizeMcpServerEntry: (entry: unknown) =>
    | { name: string; config: Record<string, unknown>; fingerprint: string }
    | { name: string; error: string }
    | null;
  reconcileMcpServers: (params: {
    managedEntries: Map<string, { fingerprint: string; dispose: () => unknown }>;
    servers: unknown[];
    register: (name: string, config: Record<string, unknown>) => () => unknown;
    logger?: { warn?: (message: string) => void };
    afterDispose?: (removedNames: string[]) => Promise<void> | void;
  }) => Promise<ReconcileResult>;
};

let cached: McpSyncHelpers | null = null;
async function loadHelpers(): Promise<McpSyncHelpers> {
  if (!cached) {
    cached = (await import(HELPERS_URL)) as McpSyncHelpers;
  }
  return cached;
}

describe('mcp-sync-helpers', () => {
  test('produces order-independent canonical fingerprints and preserves timeouts', async () => {
    const { normalizeMcpServerEntry } = await loadHelpers();

    const first = normalizeMcpServerEntry({
      name: 'demo-stdio',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { B: '2', A: '1' },
      startupTimeoutMs: 15_000,
      toolCallTimeoutMs: 90_000,
    });
    const second = normalizeMcpServerEntry({
      name: 'demo-stdio',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { A: '1', B: '2' },
      startupTimeoutMs: 15_000,
      toolCallTimeoutMs: 90_000,
    });

    expect(first && !('error' in first)).toBe(true);
    expect(second && !('error' in second)).toBe(true);
    if (first && !('error' in first) && second && !('error' in second)) {
      expect(first.fingerprint).toBe(second.fingerprint);
      expect(first.config).toMatchObject({
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { A: '1', B: '2' },
        startupTimeoutMs: 15_000,
        toolCallTimeoutMs: 90_000,
      });
    }
  });

  test('differentially keeps unchanged servers mounted, updates only modified ones, and disposes removed/disabled ones', async () => {
    const { reconcileMcpServers } = await loadHelpers();

    const managedEntries = new Map<string, { fingerprint: string; dispose: () => unknown }>();
    const disposers = new Map<string, ReturnType<typeof vi.fn>>();
    const register = vi.fn((name: string) => {
      const dispose = vi.fn();
      disposers.set(`${name}#${register.mock.calls.length}`, dispose);
      return dispose;
    });
    const afterDispose = vi.fn();

    const stdioSpec = {
      name: 'stdio-srv',
      transport: 'stdio',
      command: 'node',
      args: ['a.js'],
      env: { K1: 'v1', K2: 'v2' },
    };
    const httpSpec = {
      name: 'http-srv',
      transport: 'streamable-http',
      url: 'http://127.0.0.1:9999/mcp',
      headers: { Authorization: 'Bearer tok' },
    };

    // 1. Initial sync registers both servers.
    const r1 = await reconcileMcpServers({
      managedEntries,
      servers: [stdioSpec, httpSpec],
      register,
      afterDispose,
    });
    expect(r1).toEqual({
      registered: ['stdio-srv', 'http-srv'],
      added: ['stdio-srv', 'http-srv'],
      updated: [],
      removed: [],
      unchanged: [],
      errors: [],
    });
    expect(register).toHaveBeenCalledTimes(2);
    const stdioDispose1 = disposers.get('stdio-srv#1')!;
    const httpDispose1 = disposers.get('http-srv#2')!;
    expect(afterDispose).not.toHaveBeenCalled();

    // 2. Identical sync (even with reordered env keys) causes ZERO teardown or respawn.
    const r2 = await reconcileMcpServers({
      managedEntries,
      servers: [
        { ...stdioSpec, env: { K2: 'v2', K1: 'v1' } },
        httpSpec,
      ],
      register,
      afterDispose,
    });
    expect(r2).toEqual({
      registered: ['stdio-srv', 'http-srv'],
      added: [],
      updated: [],
      removed: [],
      unchanged: ['stdio-srv', 'http-srv'],
      errors: [],
    });
    expect(register).toHaveBeenCalledTimes(2);
    expect(stdioDispose1).not.toHaveBeenCalled();
    expect(httpDispose1).not.toHaveBeenCalled();

    // 3. Modifying only stdio-srv disposes & re-registers ONLY stdio-srv.
    const r3 = await reconcileMcpServers({
      managedEntries,
      servers: [
        { ...stdioSpec, toolCallTimeoutMs: 120_000 },
        httpSpec,
      ],
      register,
      afterDispose,
    });
    expect(r3).toEqual({
      registered: ['http-srv', 'stdio-srv'],
      added: [],
      updated: ['stdio-srv'],
      removed: [],
      unchanged: ['http-srv'],
      errors: [],
    });
    expect(stdioDispose1).toHaveBeenCalledTimes(1);
    expect(httpDispose1).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledTimes(3);

    // 4. Disabling stdio-srv disposes ONLY stdio-srv and invokes afterDispose.
    const stdioDispose2 = disposers.get('stdio-srv#3')!;
    const r4 = await reconcileMcpServers({
      managedEntries,
      servers: [
        { ...stdioSpec, enabled: false },
        httpSpec,
      ],
      register,
      afterDispose,
    });
    expect(r4).toEqual({
      registered: ['http-srv'],
      added: [],
      updated: [],
      removed: ['stdio-srv'],
      unchanged: ['http-srv'],
      errors: [],
    });
    expect(stdioDispose2).toHaveBeenCalledTimes(1);
    expect(httpDispose1).not.toHaveBeenCalled();
    expect(afterDispose).toHaveBeenCalledWith(['stdio-srv']);
  });

  test('collects validation and registration errors without dropping valid sibling servers', async () => {
    const { reconcileMcpServers } = await loadHelpers();

    const managedEntries = new Map<string, { fingerprint: string; dispose: () => unknown }>();
    const warn = vi.fn();
    const register = vi.fn((name: string) => {
      if (name === 'throws-on-register') {
        throw new Error('simulated dsh assertTemplateSyntax rejection');
      }
      return vi.fn();
    });

    const result = await reconcileMcpServers({
      managedEntries,
      servers: [
        { name: 'bad-url', transport: 'streamable-http', url: 'not-a-url' },
        { name: 'throws-on-register', transport: 'stdio', command: 'node' },
        { name: 'healthy', transport: 'stdio', command: 'node', args: ['ok.js'] },
      ],
      register,
      logger: { warn },
    });

    expect(result.registered).toEqual(['healthy']);
    expect(result.added).toEqual(['healthy']);
    expect(result.errors).toEqual([
      'bad-url: invalid streamable-http URL',
      'throws-on-register: simulated dsh assertTemplateSyntax rejection',
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
