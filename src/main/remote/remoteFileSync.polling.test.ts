import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteFileReason } from '../../shared/remote/files';
import { RemoteFileSync } from './remoteFileSync';
import type { RemoteStore } from './remoteStore';

const owner = { userId: 'policy-user', scopeKey: 'personal' };
function fixture() {
  let now = 1000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const request = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: {
    policyVersion: '1', types: [], limits: {}, features: { desktopInputSync: false, artifactPublish: false },
  } })));
  const store = { setArtifactProjectionResolver: vi.fn(), setFileTerminalBoundary: vi.fn(), setFileEnvironment: vi.fn(), entries: () => [] };
  const sync = new RemoteFileSync({ store: store as unknown as RemoteStore, cacheRoot: '/unused', owner: () => owner,
    environment: () => 'https://example.invalid', enabled: () => true, access: () => ({ assertAllowed: () => {} }), request });
  sync.configure(true);
  const connection = { owner, environment: 'https://example.invalid', deviceId: 'pc', generation: '1', routeEpoch: 1 };
  const tick = async (): Promise<void> => { sync.tick({ ...connection }); await sync.settled(); };
  return { sync, request, connection, tick, advance: (ms: number) => { now += ms; } };
}
afterEach(() => vi.restoreAllMocks());
describe('remote file policy polling', () => {
  it('keeps local two-second observation without two-second remote requests', async () => {
    const { request, tick, advance } = fixture();
    await tick();
    for (let i = 0; i < 150; i++) { advance(2000); await tick(); }
    expect(request).toHaveBeenCalledTimes(1);
    advance(2000); await tick(); expect(request).toHaveBeenCalledTimes(2);
  });
  it('backs off unavailable policy requests and refreshes immediately on reconnect', async () => {
    const { request, connection, tick, advance } = fixture();
    request.mockRejectedValueOnce(new Error('unavailable'));
    await tick();
    for (let i = 0; i < 29; i++) { advance(2000); await tick(); }
    expect(request).toHaveBeenCalledTimes(1);
    advance(2000); await tick(); expect(request).toHaveBeenCalledTimes(2);
    connection.generation = '2'; await tick(); expect(request).toHaveBeenCalledTimes(3);
  });
  it('invalidates cached policy when the server reports a changed policy version', async () => {
    const { request, sync, tick } = fixture();
    await tick();
    request.mockResolvedValueOnce(new Response(JSON.stringify({ code: 47067, data: { reason: RemoteFileReason.Policy } }), { status: 409 }));
    await expect((sync as any).json((sync as any).connection, '/artifact-operation', {})).rejects.toThrow(RemoteFileReason.Policy);
    await tick(); expect(request).toHaveBeenCalledTimes(3);
  });
  it('reports unavailable file transport independently and clears it when disabled', async () => {
    const { sync, request, tick } = fixture();
    expect(sync.health()).toEqual({ degraded: false, pending: null });
    request.mockRejectedValueOnce(new Error('private upstream path'));
    await tick();
    expect(sync.health()).toEqual({ degraded: true, pending: null });
    sync.configure(false);
    expect(sync.health()).toEqual({ degraded: false, pending: null });
  });

  it.each([false, true])('rejects a late policy after A returns with the same server generation (pause=%s)', async pause => {
    const { request, sync, tick, connection } = fixture();
    let finish!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { finish = resolve; });
    const original = request.getMockImplementation()!;
    request.mockImplementationOnce(() => response);
    const first = tick();
    if (pause) sync.pause(); else connection.routeEpoch += 2;
    sync.tick({ ...connection });
    finish(await original());
    await first;
    expect(sync.health()).toEqual({ degraded: false, pending: null });
    await tick();
    expect(request).toHaveBeenCalledTimes(2);
    expect(sync.health()).toEqual({ degraded: false, pending: 0 });
  });

  it('ignores the first A failure instead of degrading the returned A connection', async () => {
    const { request, sync, tick, connection } = fixture();
    let fail!: (error: Error) => void;
    request.mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { fail = reject; }));
    const first = tick();
    connection.routeEpoch += 2; sync.tick({ ...connection });
    fail(new Error('first A failed'));
    await first;
    expect(sync.health()).toEqual({ degraded: false, pending: null });
    await tick(); expect(request).toHaveBeenCalledTimes(2);
  });

});
