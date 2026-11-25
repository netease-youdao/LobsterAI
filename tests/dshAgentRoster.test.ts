import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test, vi } from 'vitest';

const pluginsDir = path.resolve('dsh-bundles/lobsterai-host/plugins');
const pluginUrl = pathToFileURL(path.join(pluginsDir, 'agent-roster/index.mjs')).href;
const stateUrl = pathToFileURL(path.join(pluginsDir, 'shared-state.mjs')).href;

test('the DSH agent roster returns the current synced agents without exposing runtime configuration', async () => {
  const { AGENT_ROSTER_PATH, apply } = await import(pluginUrl);
  const { getHostState } = await import(stateUrl);
  const register = vi.fn<(route: { path: string; methods: string[]; fetch: () => Promise<Response> }) => void>();
  const ctx = { connection: { fetch: { register } } };
  const state = getHostState(ctx);

  apply(ctx);
  const [route] = register.mock.calls[0];
  expect(route).toMatchObject({ path: AGENT_ROSTER_PATH, methods: ['GET'] });
  expect(await (await route.fetch()).json()).toEqual({ agents: [] });

  state.agents = new Map([
    ['main', { id: 'main', name: 'LobsterAI', enabled: true, workingDirectory: '/shared' }],
    ['writer', { id: 'writer', name: '写作助手', enabled: true, workingDirectory: '/shared', systemPrompt: 'Private' }],
    ['idle', { id: 'idle', name: '无会话', enabled: true }],
    ['disabled', { id: 'disabled', name: '停用助手', enabled: false }],
  ]);

  const response = await route.fetch();
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({
    agents: [
      { id: 'main', name: 'LobsterAI', enabled: true },
      { id: 'writer', name: '写作助手', enabled: true },
      { id: 'idle', name: '无会话', enabled: true },
      { id: 'disabled', name: '停用助手', enabled: false },
    ],
  });

  state.agents = new Map([['writer', { id: 'writer', name: '内容助手', enabled: true }]]);
  expect(await (await route.fetch()).json()).toEqual({
    agents: [{ id: 'writer', name: '内容助手', enabled: true }],
  });
});
