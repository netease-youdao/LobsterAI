import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({ app: {
  getAppPath: () => process.cwd(), getPath: () => process.cwd(), getVersion: () => '2.0.9',
}, BrowserWindow: { getAllWindows: () => [] } }));
import { OpenClawRuntimeAdapter } from './openclawRuntimeAdapter';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture() {
  let generation = 2;
  const engine = {
    isShuttingDown: () => false, isGatewayStartupBlocked: () => false,
    startGateway: vi.fn(async () => ({ phase: 'running' })),
    getGatewayProcessGeneration: () => generation,
    getGatewayConnectionInfo: () => ({ url: 'ws://127.0.0.1:1', token: 'fixture', version: 'fixture', clientEntryPath: 'fixture-client' }),
    getStatus: () => ({ phase: 'running' }),
  };
  const adapter = new OpenClawRuntimeAdapter({} as never, engine as never) as any;
  const clients: Client[] = [];
  let atStart: ((client: Client) => void) | undefined;
  class Client {
    callbacks: any;
    stop = vi.fn();
    request = vi.fn(async () => ({ subscribed: true }));
    constructor(callbacks: unknown) { this.callbacks = callbacks; clients.push(this); }
    start() { atStart?.(this); }
  }
  vi.spyOn(adapter, 'loadGatewayClientCtor').mockResolvedValue(Client);
  vi.spyOn(adapter.questionController, 'restorePending').mockResolvedValue(undefined);
  const poll = vi.spyOn(adapter, 'startChannelPolling').mockImplementation(() => undefined);
  return { adapter, engine, clients, poll, Client, setGeneration: (value: number) => { generation = value; },
    onStart: (callback: (client: Client) => void) => { atStart = callback; } };
}

test('late configuration reconnect joins the new pending handshake instead of stopping it and reporting false readiness', async () => {
  const { adapter, clients, onStart, poll } = fixture();
  let restarting!: Promise<void>;
  let reconnectFinished = false;
  let connectFinished = false;
  // Exact production interleaving: the automatic reconnect has created its
  // pending transport, but its async createGatewayClient call has not returned.
  onStart(() => { restarting = adapter.reconnectGateway().then(() => { reconnectFinished = true; }); });
  const connecting = adapter.connectGatewayIfNeeded().then(() => { connectFinished = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(clients).toHaveLength(1);
  expect(clients[0].stop).not.toHaveBeenCalled();
  expect(connectFinished).toBe(false);
  expect(reconnectFinished).toBe(false);
  expect(poll).not.toHaveBeenCalled();
  clients[0].callbacks.onHelloOk();
  await Promise.all([connecting, restarting]);
  expect(adapter.gatewayClient).toBe(clients[0]);
  expect(adapter.gatewayHandshakeComplete).toBe(true);
});

test('a late process-restart notification preserves an already authenticated client for that process generation', async () => {
  const { adapter, clients } = fixture();
  const connecting = adapter.connectGatewayIfNeeded();
  await vi.advanceTimersByTimeAsync(0);
  clients[0].callbacks.onHelloOk();
  await connecting;
  await adapter.reconnectGateway();
  expect(clients).toHaveLength(1);
  expect(clients[0].stop).not.toHaveBeenCalled();
  expect(adapter.gatewayClient).toBe(clients[0]);
});

test('disconnect during client module import cannot construct or report a ready late connection', async () => {
  const { adapter, Client, clients, poll } = fixture();
  let release!: (value: unknown) => void;
  adapter.loadGatewayClientCtor.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const connecting = adapter.connectGatewayIfNeeded();
  const rejected = expect(connecting).rejects.toThrow(/superseded|stopped|cancelled/i);
  await vi.advanceTimersByTimeAsync(0);
  adapter.disconnectGatewayClient();
  release(Client);
  await rejected;
  expect(clients).toHaveLength(0);
  expect(adapter.gatewayClient).toBeNull();
  expect(poll).not.toHaveBeenCalled();
});

test('disconnect while waiting for the engine cancels the pending explicit ensure', async () => {
  const { adapter, engine, clients, poll } = fixture();
  let release!: (value: { phase: string }) => void;
  engine.startGateway.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const connecting = adapter.ensureReady();
  const rejected = expect(connecting).rejects.toThrow(/superseded|stopped/i);
  await vi.advanceTimersByTimeAsync(0);
  adapter.disconnectGatewayClient();
  release({ phase: 'running' });
  await rejected;
  expect(clients).toHaveLength(0);
  expect(poll).not.toHaveBeenCalled();
});

test('a closed handshake must reject its waiter and cannot be mistaken for an optional null readiness promise', async () => {
  const { adapter, clients, onStart, poll } = fixture();
  onStart(() => adapter.disconnectGatewayClient());
  const connecting = adapter.connectGatewayIfNeeded();
  await expect(connecting).rejects.toThrow(/superseded|stopped|cancelled/i);
  expect(clients[0].stop).toHaveBeenCalledOnce();
  expect(adapter.gatewayHandshakeComplete).toBe(false);
  expect(poll).not.toHaveBeenCalled();
});

test('late auth errors from a stopped pending client do not clear the new readiness rejection handler', async () => {
  const { adapter, clients, setGeneration } = fixture();
  const first = adapter.connectGatewayIfNeeded();
  const firstRejected = expect(first).rejects.toThrow(/stopped/i);
  await vi.advanceTimersByTimeAsync(0);
  adapter.disconnectGatewayClient();
  await firstRejected;
  setGeneration(3);
  const reconnect = adapter.reconnectGateway();
  const rejected = expect(reconnect).rejects.toThrow(/stopped/i);
  await vi.advanceTimersByTimeAsync(0);
  expect(clients).toHaveLength(2);
  const rejectCurrent = adapter.gatewayReadyReject;
  clients[0].callbacks.onConnectError(new Error('auth stale transport'));
  expect(adapter.gatewayReadyReject).toBe(rejectCurrent);
  adapter.disconnectGatewayClient();
  await rejected;
});

test('an explicit connect replaces a ready socket from an older gateway process generation', async () => {
  const { adapter, clients, setGeneration } = fixture();
  const first = adapter.connectGatewayIfNeeded();
  await vi.advanceTimersByTimeAsync(0);
  clients[0].callbacks.onHelloOk();
  await first;
  setGeneration(3);
  let finished = false;
  const current = adapter.connectGatewayIfNeeded().then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(clients[0].stop).toHaveBeenCalledOnce();
  expect(clients).toHaveLength(2);
  expect(finished).toBe(false);
  clients[0].callbacks.onHelloOk();
  clients[0].callbacks.onClose(1006, 'late old transport close');
  expect(adapter.gatewayClient).toBeNull();
  clients[1].callbacks.onHelloOk();
  await current;
  expect(adapter.gatewayClient).toBe(clients[1]);
  expect(adapter.gatewayClientProcessGeneration).toBe(3);
});
