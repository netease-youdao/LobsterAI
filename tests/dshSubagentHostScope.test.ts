import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from 'vitest';

test('only native subagents inherit the bound Cowork permission, persona, and trace context', async () => {
  const plugin = pathToFileURL(path.resolve('dsh-bundles/lobsterai-host/plugins/shared-state.mjs')).href;
  const { resolveSessionContext } = await import(plugin);
  const headers = new Map([
    ['child', { origin: 'subagent', parentSession: 'parent' }],
    ['nested', { origin: 'subagent', parentSession: 'child' }],
    ['fork', { parentSession: 'parent' }],
    ['loop', { origin: 'subagent', parentSession: 'loop' }],
  ]);
  const ctx = { get: () => ({ get: (id: string) => ({ session: { header: headers.get(id) } }) }) };
  const bound = { coworkSessionId: 'desktop', agentId: 'expert', permissionPreset: 'read-only' };
  const state = { sessionContexts: new Map([['parent', bound]]) };
  expect(resolveSessionContext(ctx, state, 'nested')).toBe(bound);
  expect(resolveSessionContext(ctx, state, 'fork')).toBeUndefined();
  expect(resolveSessionContext(ctx, state, 'loop')).toBeUndefined();
});
