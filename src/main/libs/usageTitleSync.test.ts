import { afterEach, describe, expect, test, vi } from 'vitest';

import { type UsageTitleOutbox, UsageTitleSync } from './usageTitleSync';

const instances: UsageTitleSync[] = [];
afterEach(() => { instances.forEach(sync => sync.stop()); instances.length = 0; vi.useRealTimers(); });
function fixture() {
  let state: UsageTitleOutbox | undefined;
  let owner: string | null = 'server/account-a';
  const send = vi.fn().mockImplementation(async () => Response.json({ code: 0 }));
  const create = () => {
    const sync = new UsageTitleSync({ load: () => structuredClone(state), save: value => { state = structuredClone(value); }, getOwner: () => owner, send });
    instances.push(sync);
    return sync;
  };
  return { send, create, state: () => state, owner: (value: string | null) => { owner = value; } };
}

describe('usage session title outbox', () => {
  test.each(['http', 'business', 'offline', 'json'])('retries %s failure without another user turn', async kind => {
    vi.useFakeTimers();
    const f = fixture();
    if (kind === 'http') f.send.mockResolvedValueOnce(Response.json({ code: 0 }, { status: 503 }));
    if (kind === 'business') f.send.mockResolvedValueOnce(Response.json({ code: 500 }));
    if (kind === 'offline') f.send.mockRejectedValueOnce(new Error('offline'));
    if (kind === 'json') f.send.mockResolvedValueOnce(new Response('invalid'));
    const sync = f.create();
    sync.enqueue('session', '新标题');
    await sync.flush();
    expect(f.state()?.pending).toHaveLength(1);
    sync.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.state()?.pending).toHaveLength(0);
  });

  test('survives restart and never sends another account pending title', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error('offline'));
    const first = f.create();
    first.enqueue('session', '账号 A');
    await first.flush();
    first.stop();
    const restored = f.create();
    f.owner('server/account-b');
    restored.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.state()?.pending).toHaveLength(1);
    f.owner('server/account-a');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.state()?.pending).toHaveLength(0);
  });

  test('late success cannot acknowledge a newer rename; revision survives restart', async () => {
    const f = fixture();
    let resolve!: (response: Response) => void;
    f.send.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    const sync = f.create();
    sync.enqueue('session', '旧标题');
    const oldRevision = f.state()!.revision;
    sync.enqueue('session', '最新标题');
    resolve(Response.json({ code: 0 }));
    await sync.flush();
    expect(f.state()!.pending[0]?.title).toBe('最新标题');
    expect(f.state()!.revision).toBeGreaterThan(oldRevision);
    const restored = f.create();
    await restored.flush();
    expect(f.send.mock.calls[1]?.[0].title).toBe('最新标题');
    expect(f.state()?.pending).toHaveLength(0);
    const previous = f.state()!.revision;
    restored.enqueue('session', '再次改名');
    await restored.flush();
    expect(f.state()!.revision).toBeGreaterThan(previous);
  });
});
