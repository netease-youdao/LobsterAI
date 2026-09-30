import { type ChildProcess, fork } from 'child_process';
import { randomUUID } from 'crypto';

import { RemoteNetworkLimit as Limit, RemoteNetworkMessage as Message, type RemoteSocket } from './remoteNetworkProtocol';
import { remoteDiagnosticLog } from './remoteSyncLog';
import { RemoteWorkerFile, remoteWorkerPath } from './remoteWorkerPath';

type Lane = 'control' | 'live' | 'background';
interface Pending {
  lane: Lane; resolve(response: Response): void; reject(error: Error): void;
  removeAbort(): void; cancelled: boolean;
}
const parsedResponses = new WeakMap<Response, { valid: boolean; value: unknown }>();
export function remoteResponseJson(response: Response, text: string): any {
  const parsed = parsedResponses.get(response);
  if (parsed) { if (!parsed.valid) throw new Error('REMOTE_NETWORK_RESPONSE_INVALID'); return parsed.value; }
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
    if (this.readyState !== 1 || Buffer.byteLength(data) > 4096) throw new Error('REMOTE_NETWORK_SOCKET_NOT_READY');
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
  private retiring: Promise<void> | null = null;
  private starting: Promise<ChildProcess> | null = null;
  private epoch = 0;
  private startingEpoch = 0;
  private readonly pending = new Map<string, Pending>();
  private currentSocket: NetworkSocket | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastAlive = 0;
  private readonly starts: number[] = [];
  constructor(private readonly spawn: typeof fork = fork, private readonly filename = remoteWorkerPath(RemoteWorkerFile.Network)) {}
  private async ensure(): Promise<ChildProcess> {
    if (this.child?.connected) return this.child;
    if (this.starting && this.startingEpoch === this.epoch) return this.starting;
    const epoch = this.epoch; this.startingEpoch = epoch;
    const starting = (async () => {
      if (this.retiring) await this.retiring;
      if (epoch !== this.epoch) throw new Error('REMOTE_NETWORK_CANCELLED');
      const now = Date.now(); while (this.starts.length && now - this.starts[0] > 60000) this.starts.shift();
      if (this.starts.length >= 5) throw new Error('REMOTE_NETWORK_RESTART_BUDGET');
      this.starts.push(now);
      const child = this.spawn(this.filename, [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        execArgv: [`--max-old-space-size=${Limit.WorkerMemoryMb}`], stdio: ['ignore','ignore','ignore','ipc'], serialization: 'json' });
      this.child = child; this.lastAlive = Date.now();
      child.on('message', message => { if (this.child === child) this.receive(message); });
      child.once('error', () => this.failed(child)); child.once('exit', () => this.failed(child));
      this.watchdog = setInterval(() => { if (this.child === child && Date.now() - this.lastAlive > 8000) this.failed(child); }, 1000);
      this.watchdog.unref?.();
      remoteDiagnosticLog('remote.worker.restart', { lane: 'transport', result: 'success' }, 'info');
      return child;
    })();
    this.starting = starting;
    try { return await starting; } finally { if (this.starting === starting) this.starting = null; }
  }
  private failed(child: ChildProcess): void {
    if (this.child !== child) return;
    this.child = null; if (this.watchdog) clearInterval(this.watchdog); this.watchdog = null;
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      this.retiring = new Promise(resolve => { child.once('exit', () => { this.retiring = null; resolve(); }); child.kill('SIGKILL'); });
    }
    for (const request of this.pending.values()) { request.removeAbort(); request.reject(new Error('REMOTE_NETWORK_WORKER_EXIT')); }
    this.pending.clear();
    const socket = this.currentSocket; this.currentSocket = null;
    if (socket && socket.readyState !== 3) { socket.readyState = 3; socket.dispatch('close', { code: 1006 }); }
    remoteDiagnosticLog('remote.worker.exit', { lane: 'transport', reason: 'DEPENDENCY_UNAVAILABLE' }, 'warn');
  }
  send(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child?.connected) throw new Error('REMOTE_NETWORK_WORKER_UNAVAILABLE');
    try {
      // false is Node's queued-write backpressure, not a failed send. Request/frame counts bound retained bytes.
      child.send(message, error => { if (error) this.failed(child); });
    } catch { this.failed(child); throw new Error('REMOTE_NETWORK_IPC_FAILED'); }
  }
  private receive(message: any): void {
    if (!message || typeof message !== 'object') return;
    if (message.type === Message.Alive) {
      if (typeof message.rss === 'number' && message.rss > 192 * 1024 * 1024) { if (this.child) this.failed(this.child); return; }
      this.lastAlive = Date.now(); return;
    }
    if (message.type === Message.Result) {
      const request = this.pending.get(message.id); if (!request) return;
      this.pending.delete(message.id); request.removeAbort();
      if (request.cancelled) return;
      if (message.error) { request.reject(new Error('REMOTE_NETWORK_REQUEST_FAILED')); return; }
      try {
        if (typeof message.body !== 'string' || Buffer.byteLength(message.body) > Limit.BodyBytes || !Number.isInteger(message.status)
          || message.status < 200 || message.status > 599 || Buffer.byteLength(JSON.stringify(message.headers || {})) > Limit.HeaderBytes) throw new Error('REMOTE_NETWORK_RESPONSE_INVALID');
        request.resolve(responseFromWorker(message));
      } catch { request.reject(new Error('REMOTE_NETWORK_RESPONSE_INVALID')); }
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
    const path = new URL(url).pathname;
    const lane: Lane = /\/(?:control|commands|connection-tickets|capabilities|mode-activations)(?:\/|$)/u.test(path) || /\/devices\/(?:register|connections)(?:\/|$)/u.test(path) ? 'control'
      : /\/(?:live-projections|sessions|devices)(?:\/|$)/u.test(path) && !/\/(?:files|contents)\//u.test(path) ? 'live' : 'background';
    if (this.pending.size >= Limit.Requests || [...this.pending.values()].filter(value => value.lane === lane).length >= ({ control: 3, live: 2, background: 1 })[lane])
      throw new Error('REMOTE_NETWORK_ADMISSION_BUSY');
    if (options.body !== undefined && options.body !== null && typeof options.body !== 'string') throw new Error('REMOTE_NETWORK_REQUEST_INVALID');
    if (Buffer.byteLength(String(options.body || '')) > Limit.BodyBytes) throw new Error('REMOTE_NETWORK_REQUEST_BUDGET');
    const headers = Object.fromEntries(new Headers(options.headers));
    if (Buffer.byteLength(JSON.stringify(headers)) > Limit.HeaderBytes) throw new Error('REMOTE_NETWORK_REQUEST_BUDGET');
    const id = randomUUID();
    return new Promise<Response>((resolve, reject) => {
      const signal = options.signal;
      const cancel = (): void => {
        const item = this.pending.get(id); if (!item || item.cancelled) return;
        item.cancelled = true; reject(new Error('REMOTE_NETWORK_CANCELLED'));
        if (this.child?.connected) { try { this.send({ type: Message.Cancel, id }); } catch { /* Worker failure rejects and releases every pending slot. */ } }
      };
      this.pending.set(id, { lane, resolve, reject, cancelled: false, removeAbort: () => signal?.removeEventListener('abort', cancel) });
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      void this.ensure().then(() => {
        if (!this.pending.has(id)) return;
        if (this.pending.get(id)!.cancelled) { this.pending.delete(id); signal?.removeEventListener('abort', cancel); return; }
        this.send({ type: Message.Fetch, id, url, method: options.method || 'GET', headers, ...(typeof options.body === 'string' ? { body: options.body } : {}) });
      }).catch(() => { this.pending.delete(id); signal?.removeEventListener('abort', cancel); reject(new Error('REMOTE_NETWORK_WORKER_UNAVAILABLE')); });
    });
  };
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
    if (this.child) { this.failed(this.child); return; }
    for (const request of this.pending.values()) { request.removeAbort(); request.reject(new Error('REMOTE_NETWORK_CANCELLED')); }
    this.pending.clear();
    this.currentSocket?.close();
  }
}
export const remoteNetworkTransport = new RemoteNetworkTransport();
