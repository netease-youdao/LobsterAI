import { type ChildProcess, fork } from 'child_process';
import { randomUUID } from 'crypto';

import { RemoteTelemetryEvent as TelemetryEvent } from '../../shared/remote/telemetry';
import { RemoteNetworkError } from './remoteNetworkError';
import { remoteNetworkCapacities as capacities, RemoteNetworkFailure as Failure, remoteNetworkFailureValue, type RemoteNetworkLane as Lane, RemoteNetworkLimit as Limit, RemoteNetworkMessage as Message, remoteNetworkRequestLane as requestLane, type RemoteSocket } from './remoteNetworkProtocol';
import { remoteDiagnosticLog } from './remoteSyncLog';
import { captureRemoteTelemetry, type RemoteTelemetryRequestTracker } from './remoteTelemetry';
import { currentRemoteTelemetryRequest, withRemoteTelemetryRequest } from './remoteTelemetryTransport';
import { RemoteWorkerFile, remoteWorkerPath } from './remoteWorkerPath';

interface QueuedRequest { lane: Lane; bytes: number; start(): void; cancel(): void }
interface Pending {
  lane: Lane; resolve(response: Response): void; reject(error: Error): void;
  removeAbort(): void; cancelled: boolean; dispatched: boolean; transportStarted: boolean; telemetry?: RemoteTelemetryRequestTracker;
}
const parsedResponses = new WeakMap<Response, { valid: boolean; value: unknown }>();
export function remoteResponseJson(response: Response, text: string): any {
  const parsed = parsedResponses.get(response);
  if (parsed) { if (!parsed.valid) throw new RemoteNetworkError(Failure.ResponseInvalid); return parsed.value; }
  return JSON.parse(text);
}
function responseFromWorker(message: any): Response {
  const build = (): Response => {
    const response = new Response([204,205,304].includes(message.status) ? null : message.body,
      { status: message.status, headers: message.headers });
    parsedResponses.set(response, { valid: message.jsonValid, value: message.json });
    response.json = async () => remoteResponseJson(response, message.body);
    response.clone = build;
    return response;
  };
  return build();
}
class NetworkSocket implements RemoteSocket {
  readyState = 0;
  readonly id = randomUUID();
  private readonly listeners = new Map<string, Array<(event: any) => void>>();
  constructor(private readonly transport: RemoteNetworkTransport) {}
  addEventListener(type: string, listener: (event: any) => void): void {
    const values = this.listeners.get(type) || []; values.push(listener); this.listeners.set(type, values);
  }
  dispatch(type: string, event: any): void {
    for (const listener of this.listeners.get(type) || []) {
      try { listener(event); } catch { this.close(); }
    }
  }
  send(data: string): void {
    if (this.readyState !== 1 || Buffer.byteLength(data) > 4096) throw new RemoteNetworkError(Failure.SocketNotReady);
    this.transport.send({ type: Message.SocketSend, id: this.id, data });
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3; this.transport.closeSocket(this);
  }
}
/** One lazy, bounded network process per desktop profile. It has no core DB, tool or token-refresh access. */
export class RemoteNetworkTransport {
  private child: ChildProcess | null = null;
  private retiring: ChildProcess | null = null;
  private retirementObserver: ReturnType<typeof setInterval> | null = null;
  private starting: Promise<ChildProcess> | null = null;
  private epoch = 0;
  private startingEpoch = 0;
  private readonly pending = new Map<string, Pending>();
  private currentSocket: NetworkSocket | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastAlive = 0;
  private workerReady = false;
  private workerTelemetry: ReturnType<typeof captureRemoteTelemetry> | null = null;
  private readonly starts: number[] = [];
  private readonly queue: QueuedRequest[] = [];
  private draining = false;
  constructor(private readonly spawn: typeof fork = fork, private readonly filename = remoteWorkerPath(RemoteWorkerFile.Network)) {}
  private async ensure(): Promise<ChildProcess> {
    if (this.child?.connected) return this.child;
    if (this.starting && this.startingEpoch === this.epoch) return this.starting;
    const epoch = this.epoch; this.startingEpoch = epoch;
    const starting = (async () => {
      // Foreground requests never wait indefinitely for a lost exit event.
      this.observeRetirement();
      if (this.retiring) throw new RemoteNetworkError(Failure.WorkerUnavailable);
      if (epoch !== this.epoch) throw new RemoteNetworkError(Failure.Cancelled);
      const now = Date.now(); while (this.starts.length && now - this.starts[0] > 60000) this.starts.shift();
      if (this.starts.length >= 5) {
        captureRemoteTelemetry().emit(TelemetryEvent.WorkerExit, { role: 'network', phase: 'starting', reason: 'WORKER_RESTART_BUDGET', worker_instance_id: randomUUID() });
        throw new RemoteNetworkError(Failure.RestartBudget);
      }
      this.starts.push(now);
      const telemetry = captureRemoteTelemetry({ role: 'network', worker_instance_id: randomUUID() });
      let child: ChildProcess;
      try { child = this.spawn(this.filename, [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        execArgv: [`--max-old-space-size=${Limit.WorkerMemoryMb}`], stdio: ['ignore','ignore','ignore','ipc'], serialization: 'json' });
      } catch (error) { telemetry.emit(TelemetryEvent.WorkerExit, { phase: 'starting', reason: 'WORKER_SPAWN_ERROR' }); throw error; }
      this.child = child; this.lastAlive = Date.now(); this.workerReady = false; this.workerTelemetry = telemetry;
      telemetry.emit(TelemetryEvent.WorkerRestart, { phase: 'starting', outcome: 'started', reason: 'STATE_CHANGED' });
      child.on('message', message => { if (this.child === child) this.receive(message); });
      child.once('error', () => this.failed(child, 'WORKER_SPAWN_ERROR')); child.once('exit', () => this.failed(child, 'WORKER_EXIT'));
      this.watchdog = setInterval(() => { if (this.child === child && Date.now() - this.lastAlive > 8000) this.failed(child, 'WORKER_WATCHDOG'); }, 1000);
      this.watchdog.unref?.();
      remoteDiagnosticLog(TelemetryEvent.WorkerRestart, { lane: 'transport', result: 'success' }, 'info');
      return child;
    })();
    this.starting = starting;
    try { return await starting; } finally { if (this.starting === starting) this.starting = null; }
  }
  private failed(child: ChildProcess, reason: string): void {
    if (this.child !== child) return;
    this.workerTelemetry?.emit(TelemetryEvent.WorkerExit, { phase: 'exit', reason, outcome: reason === 'WORKER_DISPOSE' ? 'cancelled' : 'failed' });
    this.workerTelemetry = null;
    this.child = null; if (this.watchdog) clearInterval(this.watchdog); this.watchdog = null;
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      this.retiring = child;
      child.once('exit', () => this.finishRetirement(child));
      this.retirementObserver = setInterval(() => this.observeRetirement(), 1000);
      this.retirementObserver.unref?.();
      try { child.kill('SIGKILL'); } catch { /* Keep the exact child fenced until absence is confirmed. */ }
    }
    for (const request of this.pending.values()) { request.removeAbort(); request.reject(new RemoteNetworkError(Failure.WorkerExit)); }
    this.pending.clear();
    for (const request of [...this.queue]) request.cancel();
    const socket = this.currentSocket; this.currentSocket = null;
    if (socket && socket.readyState !== 3) { socket.readyState = 3; socket.dispatch('close', { code: 1006 }); }
    remoteDiagnosticLog(TelemetryEvent.WorkerExit, { lane: 'transport', reason: 'DEPENDENCY_UNAVAILABLE' }, 'warn');
  }
  private finishRetirement(child: ChildProcess): void {
    if (this.retiring !== child) return;
    this.retiring = null;
    if (this.retirementObserver) clearInterval(this.retirementObserver);
    this.retirementObserver = null;
  }
  private observeRetirement(): void {
    const child = this.retiring;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) { this.finishRetirement(child); return; }
    if (!child.pid) return;
    try { process.kill(child.pid, 0); }
    catch (error) {
      // EPERM, missing metrics and a successful kill request are not exit evidence.
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') this.finishRetirement(child);
    }
  }
  send(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child?.connected) throw new RemoteNetworkError(Failure.WorkerUnavailable);
    try {
      // false is Node's queued-write backpressure, not a failed send. Request/frame counts bound retained bytes.
      child.send(message, error => { if (error) this.failed(child, 'WORKER_IPC_FAILURE'); });
    } catch { this.failed(child, 'WORKER_IPC_FAILURE'); throw new RemoteNetworkError(Failure.IpcFailed); }
  }
  private receive(message: any): void {
    if (!message || typeof message !== 'object') return;
    if (message.type === Message.Alive) {
      if (typeof message.rss === 'number' && message.rss > 192 * 1024 * 1024) { if (this.child) this.failed(this.child, 'WORKER_MEMORY_LIMIT'); return; }
      if (!this.workerReady) { this.workerReady = true; this.workerTelemetry?.emit(TelemetryEvent.WorkerRestart, { phase: 'ready', outcome: 'succeeded', reason: 'STATE_CHANGED' }); }
      this.lastAlive = Date.now(); return;
    }
    if (message.type === Message.FetchStarted) {
      const request = this.pending.get(message.id);
      if (request && !request.transportStarted) {
        request.transportStarted = true;
        try { request.telemetry?.transportStarted(); } catch { /* Telemetry cannot affect the pending response. */ }
      }
      return;
    }
    if (message.type === Message.Result) {
      const request = this.pending.get(message.id); if (!request) return;
      this.pending.delete(message.id); request.removeAbort(); queueMicrotask(() => this.drain());
      if (request.cancelled) return;
      if (message.error) { request.reject(new RemoteNetworkError(remoteNetworkFailureValue(message.error) ?? Failure.RequestFailed)); return; }
      try {
        if (typeof message.body !== 'string' || Buffer.byteLength(message.body) > Limit.BodyBytes || !Number.isInteger(message.status)
          || message.status < 200 || message.status > 599 || Buffer.byteLength(JSON.stringify(message.headers || {})) > Limit.HeaderBytes) throw new RemoteNetworkError(Failure.ResponseInvalid);
        request.resolve(responseFromWorker(message));
      } catch { request.reject(new RemoteNetworkError(Failure.ResponseInvalid)); }
      return;
    }
    const socket = this.currentSocket;
    if (!socket || socket.id !== message.id || socket.readyState === 3) return;
    if (message.type === Message.SocketOpened) socket.readyState = 1;
    else if (message.type === Message.SocketClosed) {
      this.currentSocket = null; socket.readyState = 3;
      socket.dispatch('close', { code: Number.isInteger(message.code) ? message.code : 1006 });
    } else if (message.type === Message.Frame) {
      try {
        socket.dispatch('message', { data: '', parsedFrame: message.frame });
        this.send({ type: Message.FrameAck, id: socket.id, seq: message.seq });
      } catch { socket.close(); }
    }
  }
  readonly fetch = async (url: string, options: RequestInit = {}): Promise<Response> => {
    const telemetry = currentRemoteTelemetryRequest();
    const lane = requestLane(url, options.method);
    if (this.pending.size >= Limit.Requests || [...this.pending.values()].filter(value => value.lane === lane).length >= capacities[lane])
      throw new RemoteNetworkError(Failure.AdmissionBusy);
    if (options.body !== undefined && options.body !== null && typeof options.body !== 'string') throw new RemoteNetworkError(Failure.RequestInvalid);
    if (Buffer.byteLength(String(options.body || '')) > Limit.BodyBytes) throw new RemoteNetworkError(Failure.RequestBudget);
    const headers = Object.fromEntries(new Headers(options.headers));
    if (Buffer.byteLength(JSON.stringify(headers)) > Limit.HeaderBytes) throw new RemoteNetworkError(Failure.RequestBudget);
    const id = randomUUID();
    return new Promise<Response>((resolve, reject) => {
      const signal = options.signal;
      const cancel = (): void => {
        const item = this.pending.get(id); if (!item || item.cancelled) return;
        item.cancelled = true; reject(new RemoteNetworkError(Failure.Cancelled));
        if (!item.dispatched) {
          this.pending.delete(id); item.removeAbort(); queueMicrotask(() => this.drain()); return;
        }
        if (this.child?.connected) { try { this.send({ type: Message.Cancel, id }); } catch { /* Worker failure rejects and releases every pending slot. */ } }
      };
      this.pending.set(id, { lane, resolve, reject, cancelled: false, dispatched: false, transportStarted: false, telemetry, removeAbort: () => signal?.removeEventListener('abort', cancel) });
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      if (!this.pending.has(id)) return;
      void this.ensure().then(() => {
        if (!this.pending.has(id)) return;
        if (this.pending.get(id)!.cancelled) { this.pending.delete(id); signal?.removeEventListener('abort', cancel); this.drain(); return; }
        this.pending.get(id)!.dispatched = true;
        this.send({ type: Message.Fetch, id, url, method: options.method || 'GET', headers, ...(typeof options.body === 'string' ? { body: options.body } : {}) });
      }).catch(error => { this.pending.delete(id); signal?.removeEventListener('abort', cancel); reject(error instanceof RemoteNetworkError ? error : new RemoteNetworkError(Failure.WorkerUnavailable)); this.drain(); });
    });
  };
  /** Admission waits for an actual permit release; it never spins on the worker's Busy response. */
  readonly queuedFetch = (url: string, options: RequestInit = {}): Promise<Response> => {
    if (options.body !== undefined && options.body !== null && typeof options.body !== 'string') return Promise.reject(new RemoteNetworkError(Failure.RequestInvalid));
    let headers: Record<string, string>;
    try { headers = Object.fromEntries(new Headers(options.headers)); } catch { return Promise.reject(new RemoteNetworkError(Failure.RequestInvalid)); }
    const bodyBytes = Buffer.byteLength(String(options.body || '')), headerBytes = Buffer.byteLength(JSON.stringify(headers)), urlBytes = Buffer.byteLength(url);
    if (bodyBytes > Limit.BodyBytes || headerBytes > Limit.HeaderBytes || urlBytes > Limit.HeaderBytes) return Promise.reject(new RemoteNetworkError(Failure.RequestBudget));
    options = { ...options, headers };
    const bytes = bodyBytes + headerBytes + urlBytes, lane = requestLane(url, options.method), tracker = currentRemoteTelemetryRequest();
    if (this.queue.length >= 64 || this.queue.reduce((sum, item) => sum + item.bytes, bytes) > 8 * 1024 * 1024)
      return Promise.reject(new RemoteNetworkError(Failure.AdmissionBusy));
    return new Promise((resolve, reject) => {
      const remove = (): void => { const index = this.queue.indexOf(item); if (index >= 0) this.queue.splice(index, 1); options.signal?.removeEventListener('abort', item.cancel); };
      const item: QueuedRequest = { lane, bytes,
        cancel: () => { remove(); reject(new RemoteNetworkError(Failure.Cancelled)); },
        start: () => {
          remove();
          const send = (): Promise<Response> => this.fetch(url, options);
          void (tracker ? withRemoteTelemetryRequest(tracker, send) : send()).then(resolve, reject);
        } };
      if (options.signal?.aborted) { item.cancel(); return; }
      options.signal?.addEventListener('abort', item.cancel, { once: true });
      this.queue.push(item); this.drain();
    });
  };
  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const lane of ['control', 'live', 'background'] as const) {
        while (this.pending.size < Limit.Requests && [...this.pending.values()].filter(item => item.lane === lane).length < capacities[lane]) {
          const next = this.queue.find(item => item.lane === lane); if (!next) break; next.start();
        }
      }
    } finally { this.draining = false; }
  }
  socket(url: string): RemoteSocket {
    this.currentSocket?.close();
    const socket = new NetworkSocket(this); this.currentSocket = socket;
    void this.ensure().then(() => {
      if (this.currentSocket === socket && socket.readyState !== 3) this.send({ type: Message.Socket, id: socket.id, url });
    }).catch(() => { if (this.currentSocket === socket) { this.currentSocket = null; socket.readyState = 3; socket.dispatch('close', { code: 1006 }); } });
    return socket;
  }
  closeSocket(socket: NetworkSocket): void {
    if (this.currentSocket !== socket) return;
    this.currentSocket = null;
    try { if (this.child?.connected) this.send({ type: Message.SocketClose, id: socket.id }); } catch { /* Local detach already fences old frames. */ }
  }
  dispose(): void {
    this.epoch++;
    for (const request of [...this.queue]) request.cancel();
    if (this.child) { this.failed(this.child, 'WORKER_DISPOSE'); return; }
    for (const request of this.pending.values()) { request.removeAbort(); request.reject(new RemoteNetworkError(Failure.Cancelled)); }
    this.pending.clear();
    this.currentSocket?.close();
  }
}
export const remoteNetworkTransport = new RemoteNetworkTransport();
