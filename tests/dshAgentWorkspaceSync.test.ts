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
