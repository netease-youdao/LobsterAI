import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, expect, test, vi } from 'vitest';

const helper = pathToFileURL(path.resolve('dsh-bundles/lobsterai-host/plugins/agent-workspace-sync.mjs')).href;
const scratch: string[] = [];

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-agent-workspaces-'));
  scratch.push(home);
  const statePath = path.join(home, 'registered.json');
  const history = path.join(home, 'history');
  const idle = path.join(home, 'idle');
  const missing = path.join(home, 'missing');
  await Promise.all([fs.mkdir(history), fs.mkdir(idle)]);

  type Workspace = { title: string; sessionIds: string[] };
  const rows = new Map<string, Workspace>();
  const create = vi.fn(async (directory: string) => {
    const canonical = await fs.realpath(directory);
    const existing = rows.get(canonical);
    if (existing) return existing;

    const workspace: Workspace = {
      title: path.basename(canonical),
      sessionIds: [],
    };
    rows.set(canonical, workspace);
    return workspace;
  });
  const registry = { create, list: () => [...rows.values()] };
  const ctx = {
    get(name: string) {
      return name === 'workspaceRegistry' ? registry : undefined;
    },
    logger: { warn: vi.fn() },
  };
  return { home, statePath, history, idle, missing, registry, ctx, rows, create };
}

afterEach(async () => {
  for (const directory of scratch.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

test('adds a workspace with no history and preserves an existing group for a shared directory', async () => {
  const { createAgentWorkspaceSync } = await import(helper);
  const { ctx, statePath, registry, history, idle, missing } = await fixture();
  const existing = await registry.create(history);
  existing.title = 'Existing user title';
  existing.sessionIds.push('already-grouped');

  const sync = createAgentWorkspaceSync(ctx, statePath);
  await sync([idle, history, history, missing, 'relative']);
  expect(registry.list().map(({ title, sessionIds }) => [title, sessionIds])).toEqual([
    ['Existing user title', ['already-grouped']],
    ['idle', []],
  ]);
  expect(JSON.parse(await fs.readFile(statePath, 'utf8'))).toEqual([idle, history]);
  expect(ctx.logger.warn).not.toHaveBeenCalled();
});

test('serializes updates and leaves a user-removed workspace unregistered across host restarts', async () => {
  const { createAgentWorkspaceSync } = await import(helper);
  const { ctx, statePath, registry, idle, history, rows, create } = await fixture();
  const sync = createAgentWorkspaceSync(ctx, statePath);
  await Promise.all([sync([idle]), sync([idle, history])]);
  expect(create.mock.calls).toEqual([[idle], [history]]);

  rows.delete(await fs.realpath(idle));
  const restarted = createAgentWorkspaceSync(ctx, statePath);
  await restarted([idle, history]);
  expect(registry.list().map(workspace => workspace.title)).toEqual(['history']);

  await restarted([history]);
  await restarted([history, idle]);
  expect(registry.list().map(workspace => workspace.title)).toEqual(['history', 'idle']);
});

test('reconciles deferred agent directories once workspaceRegistry mounts after startup', async () => {
  const { createAgentWorkspaceSync } = await import(helper);
  const { statePath, registry, idle, history } = await fixture();
  let mounted = false;
  const readyCallbacks: Array<() => void> = [];
  const ctx = {
    get(name: string) {
      return name === 'workspaceRegistry' && mounted ? registry : undefined;
    },
    inject(services: string[], callback: () => void) {
      if (services.includes('workspaceRegistry')) {
        readyCallbacks.push(callback);
      }
    },
    logger: { info: vi.fn(), warn: vi.fn() },
  };

  const sync = createAgentWorkspaceSync(ctx, statePath);
  const initial = await sync([idle, history]);
  expect(initial).toMatchObject({ deferred: true, registeredCount: 0 });
  expect(registry.list()).toEqual([]);

  mounted = true;
  for (const callback of readyCallbacks) callback();
  await vi.waitFor(() => {
    expect(registry.list().map(workspace => workspace.title)).toEqual(['idle', 'history']);
  });
  expect(JSON.parse(await fs.readFile(statePath, 'utf8'))).toEqual([idle, history]);
});

test('retries a directory that appears on disk later and attaches top-level sessions to their workspace', async () => {
  const { attachSessionToWorkspace, createAgentWorkspaceSync } = await import(helper);
  const { ctx, statePath, registry, idle, missing } = await fixture();
  const attachSession = vi.fn(async () => {});
  const resolveByPath = vi.fn(async (directory: string) => {
    const canonical = await fs.realpath(directory);
    return canonical === await fs.realpath(idle) ? { attachSession } : undefined;
  });
  Object.assign(registry, { resolveByPath });

  const sync = createAgentWorkspaceSync(ctx, statePath);
  await sync([idle, missing]);
  expect(registry.list().map(workspace => workspace.title)).toEqual(['idle']);

  await fs.mkdir(missing);
  await sync([idle, missing]);
  expect(registry.list().map(workspace => workspace.title)).toEqual(['idle', 'missing']);

  expect(await attachSessionToWorkspace(ctx, 'sess-1', idle)).toBe(true);
  expect(attachSession).toHaveBeenCalledWith('sess-1');
  expect(await attachSessionToWorkspace(ctx, 'sess-2', missing)).toBe(false);
});

test('reconciles historical knownSessions into matching workspaces without disturbing live order or archived sessions', async () => {
  const { createAgentWorkspaceSync } = await import(helper);
  const { ctx, statePath, registry, idle, history, rows } = await fixture();

  const makeManagedWorkspace = (ws: { title: string; sessionIds: string[] }) => Object.assign(ws, {
    attachSession: async (sessionId: string) => {
      if (!ws.sessionIds.includes(sessionId)) {
        ws.sessionIds.unshift(sessionId);
      }
    },
    moveSession: async (sessionId: string, beforeSessionId?: string) => {
      ws.sessionIds = ws.sessionIds.filter(id => id !== sessionId);
      if (beforeSessionId === undefined) {
        ws.sessionIds.push(sessionId);
      } else {
        const idx = ws.sessionIds.indexOf(beforeSessionId);
        ws.sessionIds.splice(idx >= 0 ? idx : ws.sessionIds.length, 0, sessionId);
      }
    },
  });

  const historyWs = makeManagedWorkspace(await registry.create(history));
  historyWs.sessionIds.push('live-recent');

  Object.assign(registry, {
    archivedSessionIds: ['archived-old'],
    resolveByPath: async (directory: string) => {
      const canonical = await fs.realpath(directory);
      const found = rows.get(canonical);
      return found ? makeManagedWorkspace(found) : undefined;
    },
  });

  const sync = createAgentWorkspaceSync(ctx, statePath);
  const result = await sync(
    [idle, history],
    [
      { sessionId: 'hist-older', cwd: history, updatedAt: 100 },
      { sessionId: 'hist-newer', cwd: history, updatedAt: 200 },
      { sessionId: 'archived-old', cwd: history, updatedAt: 150 },
      { sessionId: 'live-recent', cwd: history, updatedAt: 300 },
      { sessionId: 'idle-old', cwd: idle, updatedAt: 10 },
      { sessionId: 'idle-new', cwd: idle, updatedAt: 20 },
    ],
  );

  expect(result.attachedSessionsCount).toBe(4);
  // Populated workspace keeps live sessions on top and appends historical sessions newest-first.
  expect(historyWs.sessionIds).toEqual(['live-recent', 'hist-newer', 'hist-older']);
  // Previously empty workspace ends up ordered newest-first.
  const idleWs = rows.get(await fs.realpath(idle));
  expect(idleWs?.sessionIds).toEqual(['idle-new', 'idle-old']);
});

test('warms DSH sessionProjectionCache for uncached cold historical sessions newest-first while skipping cached, live, and subagent sessions', async () => {
  const { createAgentWorkspaceSync } = await import(helper);
  const { statePath, registry, history } = await fixture();
  const ws = await registry.create(history);
  ws.sessionIds.push('cold-older', 'cold-newer', 'cached-named', 'cached-blank', 'live-sess', 'subagent-sess', 'broken-sess');

  const headers = new Map<string, Record<string, unknown>>([
    ['cold-older', { id: 'cold-older', cwd: history, createdAt: 100 }],
    ['cold-newer', { id: 'cold-newer', cwd: history, createdAt: 200 }],
    ['cached-named', { id: 'cached-named', cwd: history, createdAt: 150 }],
    ['cached-blank', { id: 'cached-blank', cwd: history, createdAt: 120 }],
    ['live-sess', { id: 'live-sess', cwd: history, createdAt: 300 }],
    ['subagent-sess', { id: 'subagent-sess', cwd: history, createdAt: 250, origin: 'subagent' }],
    ['broken-sess', { id: 'broken-sess', cwd: history, createdAt: 180 }],
  ]);

  const cachedMap = new Map<string, { asOfSeq: number; values: Record<string, unknown> }>([
    ['cached-named', { asOfSeq: 5, values: { title: 'Existing Title', sessionListMetadata: { blank: false, lastPromptAt: 150 } } }],
    ['cached-blank', { asOfSeq: 0, values: { title: null, sessionListMetadata: { blank: true, lastPromptAt: null } } }],
  ]);

  const closeSpies: Record<string, ReturnType<typeof vi.fn>> = {};
  const openOrder: string[] = [];
  const persistence = {
    list: vi.fn(async () => [...headers.values()].map(header => ({ header }))),
    open: vi.fn(async (sessionId: string) => {
      openOrder.push(sessionId);
      const close = vi.fn(async () => {});
      closeSpies[sessionId] = close;
      if (sessionId === 'broken-sess') {
        return {
          header: headers.get(sessionId),
          inheritedEventCount: 0,
          read: vi.fn(async () => {
            throw new Error('corrupt zstd');
          }),
          close,
        };
      }
      return {
        header: { ...headers.get(sessionId), openedTag: true },
        inheritedEventCount: sessionId === 'cold-newer' ? 4 : 0,
        read: vi.fn(async () => ({
          events: [{ seq: 0, type: 'session/title', data: { title: `Title for ${sessionId}` } }],
        })),
        close,
      };
    }),
  };

  const coldSnapshot = vi.fn((header: Record<string, unknown>, _inherited: number, events: unknown[]) => {
    const titleEvent = events[0] as { data?: { title?: string } } | undefined;
    cachedMap.set(String(header.id), {
      asOfSeq: events.length - 1,
      values: {
        title: titleEvent?.data?.title ?? null,
        sessionListMetadata: { blank: false, lastPromptAt: Number(header.createdAt) || 0 },
      },
    });
    return cachedMap.get(String(header.id));
  });

  const cache = {
    cachedSnapshot: vi.fn((header: Record<string, unknown>) => cachedMap.get(String(header.id))),
    coldSnapshot,
  };
  const sessions = {
    get: vi.fn((sessionId: string) => (sessionId === 'live-sess' ? { id: 'live-sess' } : undefined)),
  };
  const sessionProjections = {
    summaryKeys: () => new Set(['title', 'sessionListMetadata']),
  };

  const ctx = {
    get(name: string) {
      if (name === 'workspaceRegistry') return registry;
      if (name === 'sessionPersistence') return persistence;
      if (name === 'sessionProjectionCache') return cache;
      if (name === 'sessions') return sessions;
      if (name === 'sessionProjections') return sessionProjections;
      return undefined;
    },
    logger: { info: vi.fn(), warn: vi.fn() },
  };

  const sync = createAgentWorkspaceSync(ctx, statePath);
  const result = await sync(
    [history],
    [
      { sessionId: 'cold-older', cwd: history, updatedAt: 100 },
      { sessionId: 'broken-sess', cwd: history, updatedAt: 180 },
      { sessionId: 'cold-newer', cwd: history, updatedAt: 200 },
    ],
  );

  expect(result.warmedProjectionsCount).toBe(2);
  // Newest-first order from knownSessions; cached/live/subagent are never opened.
  expect(openOrder).toEqual(['cold-newer', 'broken-sess', 'cold-older']);
  // Failed read still closes its handle cleanly.
  expect(closeSpies['broken-sess']).toHaveBeenCalledTimes(1);
  expect(closeSpies['cold-newer']).toHaveBeenCalledTimes(1);
  expect(closeSpies['cold-older']).toHaveBeenCalledTimes(1);
  // coldSnapshot receives handle.header and handle.inheritedEventCount captured before close.
  expect(coldSnapshot).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'cold-newer', openedTag: true }),
    4,
    expect.arrayContaining([expect.objectContaining({ type: 'session/title' })]),
  );
  expect(coldSnapshot).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'cold-older', openedTag: true }),
    0,
    expect.arrayContaining([expect.objectContaining({ type: 'session/title' })]),
  );

  // Subsequent sync does not re-open already-warmed sessions.
  const second = await sync([history]);
  expect(second.warmedProjectionsCount).toBe(0);
  expect(openOrder).toEqual(['cold-newer', 'broken-sess', 'cold-older', 'broken-sess']);
});

test('waits until title and sessionListMetadata projection units are registered before warming via deferred inject', async () => {
  const { createAgentWorkspaceSync } = await import(helper);
  const { statePath, registry, history } = await fixture();
  const ws = await registry.create(history);
  ws.sessionIds.push('hist-1');

  const registeredSummaryKeys = new Set<string>();
  const deferredCallbacks: Array<() => void> = [];
  const header = { id: 'hist-1', cwd: history, createdAt: 500 };

  const persistence = {
    list: vi.fn(async () => [{ header }]),
    open: vi.fn(async () => ({
      header,
      inheritedEventCount: 0,
      read: vi.fn(async () => ({
        events: [{ seq: 0, type: 'session/title', data: { title: 'Deferred Title' } }],
      })),
      close: vi.fn(async () => {}),
    })),
  };
  const cache = {
    cachedSnapshot: vi.fn(() => undefined),
    coldSnapshot: vi.fn(),
  };

  const ctx = {
    get(name: string) {
      if (name === 'workspaceRegistry') return registry;
      if (name === 'sessionPersistence') return persistence;
      if (name === 'sessionProjectionCache') return cache;
      if (name === 'sessionProjections') return { summaryKeys: () => registeredSummaryKeys };
      return undefined;
    },
    inject(services: string[], callback: () => void) {
      if (services.includes('sessionTitle') && services.includes('sessionController')) {
        deferredCallbacks.push(callback);
      }
    },
    logger: { info: vi.fn(), warn: vi.fn() },
  };

  const sync = createAgentWorkspaceSync(ctx, statePath);
  // Before sessionTitle & sessionController register their projection units, warm-up skips cleanly.
  const first = await sync([history], [{ sessionId: 'hist-1', cwd: history, updatedAt: 500 }]);
  expect(first.warmedProjectionsCount).toBe(0);
  expect(cache.coldSnapshot).not.toHaveBeenCalled();

  // Once both projection units register and the deferred inject fires, warm-up runs.
  registeredSummaryKeys.add('title');
  registeredSummaryKeys.add('sessionListMetadata');
  for (const cb of deferredCallbacks) cb();
  await vi.waitFor(() => {
    expect(cache.coldSnapshot).toHaveBeenCalledTimes(1);
  });
  expect(cache.coldSnapshot).toHaveBeenCalledWith(header, 0, [
    { seq: 0, type: 'session/title', data: { title: 'Deferred Title' } },
  ]);
});
