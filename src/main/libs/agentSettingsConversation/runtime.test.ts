import { expect, test, vi } from 'vitest';

import { AgentSettingsRuntimeBridge } from './runtime';

function fixture() {
  const owner = { userId: 'owner', scopeKey: 'scope' };
  const request = vi.fn(async () => ({ registered: true }));
  const remote = { run: () => ({ runId: 'remote-run', status: 'running' }), get: () => 'command', owner: () => owner,
    assertNoDeletionEffect: vi.fn(), assertActor: vi.fn() };
  const runtime = new AgentSettingsRuntimeBridge({ store: { remote, getSession: () => ({ agentId: 'main' }), assertAgentAccess: vi.fn() },
    gateway: () => ({ request }), owner: () => owner, epoch: () => 1, resolveSession: () => 'session', currentRun: () => true,
    otherRuns: () => false, approval: () => null } as never);
  return { runtime, request };
}

test('local desktop dispatch never registers the remote settings tool', async () => {
  const f = fixture(); await f.runtime.bindRemoteRun('session', 'agent:main:lobsterai:session', 'gateway-run');
  expect(f.request).not.toHaveBeenCalled();
});
test('only the actual persisted remote command can register an exact run', async () => {
  const f = fixture(); await f.runtime.bindRemoteRun('session', 'agent:main:lobsterai:session', 'gateway-run', 'forged');
  expect(f.request).not.toHaveBeenCalled();
  await f.runtime.bindRemoteRun('session', 'agent:main:lobsterai:session', 'gateway-run', 'command');
  expect(f.request).toHaveBeenCalledWith('lobster.settings.bindRun', { agentId: 'main', sessionKey: 'agent:main:lobsterai:session', runId: 'gateway-run' }, { timeoutMs: 3000 });
});
test('an old runtime missing the registration method keeps ordinary remote chat compatible', async () => {
  const f = fixture(); f.request.mockRejectedValue(new Error('Unknown method'));
  await expect(f.runtime.bindRemoteRun('session', 'agent:main:lobsterai:session', 'gateway-run', 'command')).resolves.toBeUndefined();
});
