// Authenticated Node.js client for DeepSeek Harness (DSH) Typert HTTP RPC,
// WebSocket multiplexed streams (/api/remote.mux), forwarded Host waterfall
// events ($events -> $events/result), and LobsterAI's owner-only /api/lobsterai/ops.
//
// Zero Electron imports — safe for unit tests and CLI tooling.

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import * as http from 'http';
import * as https from 'https';

import {
  DSH_OPS_ROUTE_PATH,
  DshOpsAction,
  type DshPluginInstallPhase,
  type DshPluginUpdateStep,
} from '../../../shared/dshEngine/hostConstants';

export const DSH_REMOTE_MUX_PATH = '/api/remote.mux';
export const DSH_REMOTE_EVENT_STREAM_ENDPOINT = '$events';
export const DSH_REMOTE_EVENT_RESULT_ENDPOINT = '$events/result';
export const DshSocketErrorCode = { ConnectionReset: 'ECONNRESET' } as const;
const INITIAL_HANDSHAKE_TIMEOUT_MS = 90_000;
const RECONNECT_HANDSHAKE_TIMEOUT_MS = 12_000;

export class DshRemoteError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DshRemoteError';
    this.code = code;
    this.details = details;
  }
}

export interface DshWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

export type DshWebSocketFactory = (url: string, headers: Record<string, string>) => DshWebSocketLike;

export interface DshHttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export type DshHttpRequester = (
  url: string,
  options: {
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<DshHttpResponse>;

export interface DshWaterfallEvent {
  event: string;
  eventId: string;
  agentId: string;
  request: Record<string, unknown>;
  signal: AbortSignal;
}

export type DshWaterfallOutcome =
  | { kind: 'next' }
  | { kind: 'result'; value?: unknown }
  | { kind: 'rejected'; error: { name: string; message: string; code?: string; details?: Record<string, unknown> } };

export type DshWaterfallHandler = (
  event: DshWaterfallEvent,
) => Promise<DshWaterfallOutcome> | DshWaterfallOutcome;

export interface DshTypertClientOptions {
  runtimePid?: number;
  /** Override HTTP transport for unit tests. */
  requester?: DshHttpRequester;
  /** Override WebSocket constructor for unit tests. */
  webSocketFactory?: DshWebSocketFactory;
  /** Initial reconnect delay in ms (default 500). */
  reconnectBaseMs?: number;
  /** Maximum reconnect delay in ms (default 8000). */
  reconnectMaxMs?: number;
}

interface PendingStreamFrame {
  type: 'item' | 'end' | 'error';
  streamId: string;
  value?: unknown;
  error?: { code: string; message: string; details: Record<string, unknown> };
}

class AsyncFrameQueue<T> {
  private readonly items: T[] = [];
  private waiter: ((value: IteratorResult<T>) => void) | null = null;
  private rejecter: ((reason: unknown) => void) | null = null;
  private ended = false;
  private failure: unknown = undefined;

  push(item: T): void {
    if (this.ended || this.failure !== undefined) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      this.rejecter = null;
      resolve({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      this.rejecter = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.ended || this.failure !== undefined) return;
    this.failure = error;
    if (this.rejecter) {
      const reject = this.rejecter;
      this.waiter = null;
      this.rejecter = null;
      reject(error);
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      return Promise.resolve({ value: this.items.shift() as T, done: false });
    }
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    if (this.ended) {
      return Promise.resolve({ value: undefined as unknown as T, done: true });
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiter = resolve;
      this.rejecter = reject;
    });
  }
}

export function defaultHttpRequester(
  urlString: string,
  options: {
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<DshHttpResponse> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new Error('Request aborted'));
      return;
    }
    const url = new URL(urlString);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: options.method,
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.once('error', (error) => {
          cleanup();
          reject(error);
        });
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          cleanup();
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );

    const onAbort = () => {
      req.destroy(new Error('Request aborted'));
    };
    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort);
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (error) => {
      cleanup();
      reject(error);
    });
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

function defaultWebSocketFactory(url: string, headers: Record<string, string>): DshWebSocketLike {
  // Node 24+ global WebSocket (undici) accepts `{ headers }` as the second argument.
  const GlobalWebSocket = globalThis.WebSocket as unknown as new (
    url: string,
    init?: { headers?: Record<string, string> },
  ) => DshWebSocketLike;
  return new GlobalWebSocket(url, { headers });
}

export interface DshSessionCreateParams {
  cwd?: string;
  sessionId?: string;
  workspaceId?: string;
  agentPreset?: string;
}

export interface DshSessionPromptContentPart {
  type: 'text';
  text: string;
}

export interface DshSessionPromptImagePart {
  type: 'image';
  mediaType: string;
  data: string;
}

export type DshPromptPart = DshSessionPromptContentPart | DshSessionPromptImagePart;

export interface DshSessionPromptParams {
  sessionId: string;
  requestId: string;
  content: DshPromptPart[];
  mode?: 'queue' | 'steer';
  clientTimeZone?: string;
}

export interface DshSessionSelectModelParams {
  sessionId: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface DshSessionForkParams {
  sessionId: string;
  atSeq?: number;
  allowMigration?: boolean;
}

export type DshSessionAddress =
  | { kind: 'session'; sessionId: string }
  | { kind: 'subagent'; parentSessionId: string; childSessionId: string; mode: 'one-shot' | 'continuable' | 'unknown' };

export const DshSessionControlFrameType = {
  Baseline: 'baseline',
  Projection: 'projection',
} as const;
export type DshSessionControlFrameType =
  typeof DshSessionControlFrameType[keyof typeof DshSessionControlFrameType];

export type DshSessionControlFrame =
  | {
    type: typeof DshSessionControlFrameType.Baseline;
    value: {
      projections: Record<string, { asOfSeq: number; values: Record<string, unknown> }>;
    };
  }
  | {
    type: typeof DshSessionControlFrameType.Projection;
    sessionId: string;
    seq: number;
    changes: Array<{ key: string; val: unknown }>;
  };

export interface DshSessionFollowParams {
  address: DshSessionAddress;
  maxMessages?: number;
  assistantStream?: boolean;
  activate?: boolean;
}

export interface DshSessionUpdateQueueParams {
  sessionId: string;
  itemId: string;
  action:
    | { kind: 'edit'; content: Array<{ type: 'text'; text: string }> }
    | { kind: 'remove' }
    | { kind: 'steer' };
}

export type DshCommandSubmitAttachment =
  | {
      type: 'image';
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
      data: string;
      name?: string;
    }
  | {
      type: 'file';
      receiptId: string;
    };

export interface DshExecuteCommandParams {
  agentId: string;
  line: string;
  submittedAttachments?: DshCommandSubmitAttachment[];
}

export type DshCommandResult =
  | {
      kind: 'success';
      text?: string;
      sourceEventSeq?: number;
    }
  | {
      kind: 'error';
      text: string;
    };

export interface DshCommandExecution {
  commandId: string;
  result: DshCommandResult;
}

export type DshLocalizedText = string | { readonly en: string; readonly [locale: string]: string };

export interface DshPluginLocalizedMeta {
  readonly title?: DshLocalizedText;
  readonly description?: DshLocalizedText;
  readonly icon?: string;
  readonly error?: string;
}

export interface DshPluginIncompatibleInfo {
  name: string;
  version: string;
  runtimeVersion: string;
  requirements: Record<string, string>;
}

export interface DshPluginManagementError {
  code: string;
  diagnostic?: string;
  incompatible?: DshPluginIncompatibleInfo[];
}

export interface DshPluginBundleRowInfo {
  rowId: string;
  moduleName: string;
  meta?: DshPluginLocalizedMeta;
  entryId?: string;
}

export interface DshPluginBundleInfo {
  name: string;
  official: boolean;
  availability: 'installation' | 'profile' | 'missing';
  installTarget?: { spec: string; version: string };
  version?: string;
  meta?: DshPluginLocalizedMeta;
  description?: string;
  listedByDefault?: boolean;
  enabled: boolean;
  installed: boolean;
  source?: string;
  optional: boolean;
  removable: boolean;
  update?: 'registry' | 'git';
  readOnlyReason?: string;
  error?: DshPluginManagementError;
  rows: DshPluginBundleRowInfo[];
  overrides: string[];
}

export interface DshPluginPackageResult {
  exitCode: number;
  output: string;
  truncated: boolean;
  logPath: string;
  kind?: string;
  timedOut?: boolean;
  incompatible?: DshPluginIncompatibleInfo[];
  unmet?: 'unexpected-package' | 'not-bundle';
}

export interface DshPluginChangeResult {
  changed: boolean;
  application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled';
  restartReason?: string;
  stage: 'install' | 'enable' | 'remove';
  target: string;
  enabled?: boolean;
  error?: DshPluginManagementError;
  warnings?: string[];
  packageResult?: DshPluginPackageResult;
  bundle?: string;
  version?: string;
  pendingBuilds?: string[];
  approvedBuilds?: string[];
  registries?: Array<string | null>;
  failedAt?: 'registry' | 'spec-host';
}

export type DshPluginSpecInspection =
  | {
    readonly status: 'accepted';
    readonly kind: 'registry' | 'path' | 'git' | 'tarball';
    readonly name?: string;
    readonly version?: string;
    readonly description?: string;
    readonly bundle: boolean | null;
    readonly registry: string | null;
    readonly host?: string;
  }
  | {
    readonly status: 'refused';
    readonly problem: string;
    readonly reason: string;
    readonly registries?: Array<string | null>;
  };

export interface DshPluginRegistriesInfo {
  readonly registry: string | null;
  readonly fallbackRegistries: readonly string[];
  readonly resolved: string | null;
}

export interface DshPluginInstallBundleOptions {
  enabled?: boolean;
  saveExact?: boolean;
  requestId?: string;
  approvedBuilds?: string[];
  registry?: string | null;
}

export interface DshPluginRegistryAttempt {
  readonly registry: string | null;
  readonly problem?: 'not-found' | 'network' | 'unknown';
  readonly reason?: string;
}

export interface DshPluginVersionInfo {
  readonly version: string;
  readonly publishedAt?: string;
  readonly tags: readonly string[];
  readonly prerelease: boolean;
  readonly deprecated?: string;
  readonly bundle: boolean;
  readonly incompatible?: DshPluginIncompatibleInfo;
}

export type DshPluginVersionList =
  | {
    readonly status: 'listed';
    readonly installed: string;
    readonly registry: string | null;
    readonly attempts: readonly DshPluginRegistryAttempt[];
    readonly versions: readonly DshPluginVersionInfo[];
    readonly omitted: number;
  }
  | {
    readonly status: 'refused';
    readonly problem: 'not-updatable' | 'not-found' | 'network' | 'unknown';
    readonly reason: string;
    readonly attempts: readonly DshPluginRegistryAttempt[];
  };

export interface DshPluginUpdateBundleOptions {
  readonly registry?: string | null;
  readonly spec?: string;
  readonly requestId?: string;
}

export interface DshPluginUpdateProgress {
  readonly requestId: string;
  readonly step: DshPluginUpdateStep;
}

export interface DshPluginInstallAttempt {
  readonly registry: string | null;
  readonly index: number;
  readonly total: number;
}

export interface DshPluginInstallProgress {
  readonly requestId: string;
  readonly phase: DshPluginInstallPhase;
  readonly attempt?: DshPluginInstallAttempt;
}

export interface DshPluginInstallLogChunk {
  readonly requestId?: string;
  readonly jobId: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
  readonly exitCode?: number | null;
}

export interface DshPluginUpdateResult {
  readonly from: string;
  readonly to: string;
  readonly step: 'check' | 'remove' | 'install';
  readonly result: DshPluginChangeResult;
  readonly restore?: DshPluginChangeResult;
}

export interface DshPluginChangedEvent {
  readonly reason?: 'plugin' | 'bundle' | 'install' | 'remove';
}

export class DshTypertClient extends EventEmitter {
  private readonly runtimePid?: number;
  private readonly requester: DshHttpRequester;
  private readonly wsFactory: DshWebSocketFactory;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;

  private origin = '';
  private cookieHeader = '';
  private connectUrl = '';
  private peerGrant: Promise<string> | null = null;
  private verifyPeerBeforeUpgrade = false;
  private socket: DshWebSocketLike | null = null;
  private clientId = '';
  private hostHome = '';
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private muxReady = false;
  private hasConnected = false;
  private connectionWait: Promise<void> | null = null;
  private eventsAbort: AbortController | null = null;

  private readonly activeStreams = new Map<string, AsyncFrameQueue<PendingStreamFrame>>();
  private readonly waterfallHandlers = new Map<string, DshWaterfallHandler>();
  private readonly activeWaterfallControllers = new Map<string, AbortController>();

  constructor(options: DshTypertClientOptions = {}) {
    super();
    this.runtimePid = options.runtimePid;
    this.requester = options.requester ?? defaultHttpRequester;
    this.wsFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 500;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 8_000;
  }

  getOrigin(): string {
    return this.origin;
  }

  getHostHome(): string {
    return this.hostHome;
  }

  isConnected(): boolean {
    return !this.disposed && this.muxReady && this.socket?.readyState === 1;
  }

  waitUntilConnected(): Promise<void> {
    if (this.disposed) return Promise.reject(new DshRemoteError('gateway/closed', 'DSH client closed'));
    if (this.isConnected()) return Promise.resolve();
    if (this.connectionWait) return this.connectionWait;
    this.connectionWait = new Promise<void>((resolve, reject) => {
      const connected = () => { cleanup(); resolve(); };
      const closed = () => { cleanup(); reject(new DshRemoteError('gateway/closed', 'DSH client closed')); };
      const cleanup = () => {
        this.off('connected', connected);
        this.off('closed', closed);
        this.connectionWait = null;
      };
      this.once('connected', connected);
      this.once('closed', closed);
    });
    return this.connectionWait;
  }

  /**
   * Register a waterfall handler for forwarded Host events such as
   * `'approval/request'` or `'user-questions/request'`.
   */
  onWaterfall(eventName: string, handler: DshWaterfallHandler): () => void {
    this.waterfallHandlers.set(eventName, handler);
    return () => {
      if (this.waterfallHandlers.get(eventName) === handler) {
        this.waterfallHandlers.delete(eventName);
      }
    };
  }

  /**
   * Exchange DSH's startup launch URL (`http://127.0.0.1:<port>/?token=...`)
   * for an authenticated API session cookie via `/connect?token=...&interactions=answer`,
   * then establish the multiplexed WebSocket and `$events` stream.
   */
  async connect(authenticatedLaunchUrl: string): Promise<{ origin: string; hostHome: string }> {
    this.disposed = false;
    const parsed = new URL(authenticatedLaunchUrl);
    const token = parsed.searchParams.get('token');
    if (!token) {
      throw new Error('DSH launch URL is missing a token');
    }
    this.origin = parsed.origin;

    this.connectUrl = `${this.origin}/connect?token=${encodeURIComponent(token)}&interactions=answer`;
    await this.openMuxAndEvents();
    return { origin: this.origin, hostHome: this.hostHome };
  }

  private getPeerCookie(): Promise<string> {
    if (this.disposed || !this.connectUrl) return Promise.reject(new DshRemoteError('gateway/closed', 'DSH client is closed'));
    if (this.cookieHeader) return Promise.resolve(this.cookieHeader);
    this.peerGrant ??= this.authorizePeer().finally(() => { this.peerGrant = null; });
    return this.peerGrant;
  }

  private async authorizePeer(): Promise<string> {
    const timeout = this.hasConnected ? RECONNECT_HANDSHAKE_TIMEOUT_MS : INITIAL_HANDSHAKE_TIMEOUT_MS;
    const res = await this.requester(this.connectUrl, { method: 'GET', signal: AbortSignal.timeout(timeout) });
    const rawSetCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(rawSetCookie)
      ? rawSetCookie
      : typeof rawSetCookie === 'string'
        ? [rawSetCookie]
        : [];
    if (res.status < 200 || res.status >= 400 || cookies.length === 0) {
      throw new Error(`DSH /connect failed with HTTP ${res.status}: ${res.body}`);
    }
    if (this.disposed) throw new DshRemoteError('gateway/closed', 'DSH client closed during authorization');
    this.cookieHeader = cookies.map((entry) => entry.split(';')[0]).join('; ');
    return this.cookieHeader;
  }

  private async postWithPeer(route: string, body: string, signal?: AbortSignal): Promise<DshHttpResponse> {
    const post = (cookie: string) => this.requester(`${this.origin}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', cookie },
      body,
      signal,
    });
    const cookie = await this.getPeerCookie();
    const response = await post(cookie);
    if (response.status !== 401) return response;
    // An HTTP rejection can arrive before the WS close callback. The Host
    // rejected this peer before dispatch, so this request may be sent once more.
    if (this.cookieHeader === cookie) {
      this.cookieHeader = '';
      if (this.socket?.readyState === 1) this.socket.close(1000, 'renewing DSH peer');
    }
    signal?.throwIfAborted();
    return post(await this.getPeerCookie());
  }

  /**
   * Execute a Typert unary RPC against `POST /api/<endpoint>`.
   */
  async call<TResult = unknown>(
    endpoint: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<TResult> {
    const rpcId = randomUUID();
    const res = await this.postWithPeer(`/api/${endpoint}`, JSON.stringify({
      type: 'client-request', rpcId, method: endpoint, payload: { args },
    }), signal);

    if (res.status < 200 || res.status >= 300) {
      if (res.status === 401) {
        console.warn(`[DSH] RPC authorization failed (method=${endpoint}, pid=${this.runtimePid ?? 'unknown'}, muxConnected=${this.isConnected()})`);
      }
      throw new DshRemoteError(
        `http/${res.status}`,
        `DSH RPC "${endpoint}" failed with HTTP ${res.status}: ${res.body}`,
      );
    }

    let envelope: {
      type?: string;
      result?: {
        ok?: boolean;
        value?: TResult;
        error?: { code?: string; message?: string; details?: Record<string, unknown> };
      };
    };
    try {
      envelope = JSON.parse(res.body);
    } catch {
      throw new DshRemoteError('gateway/invalid-json', `DSH RPC "${endpoint}" returned non-JSON body`);
    }

    const result = envelope?.result;
    if (!result || result.ok !== true) {
      throw new DshRemoteError(
        result?.error?.code ?? 'gateway/error',
        result?.error?.message ?? `DSH RPC "${endpoint}" returned an error`,
        result?.error?.details ?? {},
      );
    }
    return result.value as TResult;
  }

  /**
   * Invoke LobsterAI's owner-only host operations endpoint (`POST /api/lobsterai/ops`).
   */
  async callOps<TResult = Record<string, unknown>>(
    action: DshOpsAction,
    payload?: unknown,
    signal?: AbortSignal,
  ): Promise<TResult> {
    const res = await this.postWithPeer(DSH_OPS_ROUTE_PATH, JSON.stringify({ action, payload }), signal);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new Error(`DSH ops "${action}" returned non-JSON HTTP ${res.status}: ${res.body}`);
    }
    if (res.status < 200 || res.status >= 300 || parsed.ok !== true) {
      const msg = typeof parsed.error === 'string'
        ? parsed.error
        : `DSH ops "${action}" failed with HTTP ${res.status}`;
      throw new Error(msg);
    }
    return (parsed.result !== undefined ? parsed.result : parsed) as TResult;
  }

  /**
   * Open a multiplexed Typert Remote stream on `/api/remote.mux`.
   */
  async *openStream<TItem = unknown>(
    endpoint: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): AsyncGenerator<TItem, void, void> {
    if (signal?.aborted) {
      throw signal.reason ?? new Error(`Stream "${endpoint}" aborted before open`);
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      throw new DshRemoteError('gateway/disconnected', `DSH mux WebSocket is not connected for stream "${endpoint}"`);
    }

    const streamId = randomUUID();
    const queue = new AsyncFrameQueue<PendingStreamFrame>();
    this.activeStreams.set(streamId, queue);

    let terminal = false;
    const onAbort = () => {
      queue.fail(signal?.reason ?? new Error(`Stream "${endpoint}" aborted`));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      socket.send(JSON.stringify({
        type: 'open',
        streamId,
        endpoint,
        payload: { args },
      }));

      while (true) {
        const next = await queue.next();
        if (next.done) {
          terminal = true;
          return;
        }
        const frame = next.value;
        if (frame.type === 'item') {
          yield frame.value as TItem;
          continue;
        }
        terminal = true;
        if (frame.type === 'error') {
          throw new DshRemoteError(
            frame.error?.code ?? 'gateway/stream-error',
            frame.error?.message ?? `Stream "${endpoint}" failed`,
            frame.error?.details ?? {},
          );
        }
        return;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.activeStreams.delete(streamId);
      if (!terminal && socket.readyState === 1) {
        try {
          socket.send(JSON.stringify({ type: 'cancel', streamId }));
        } catch {
          // Socket may already be closing.
        }
      }
    }
  }

  // ── Typed Session & Host Convenience RPCs ──────────────────────────────────

  createSession(params: DshSessionCreateParams): Promise<{ sessionId: string; agentPreset?: string }> {
    return this.call('session/create', { request: params });
  }

  promptSession(params: DshSessionPromptParams): Promise<{ accepted: boolean }> {
    return this.call('session/prompt', { request: params });
  }

  cancelSession(sessionId: string): Promise<{ accepted: boolean }> {
    return this.call('session/cancel', { request: { sessionId } });
  }

  selectModel(params: DshSessionSelectModelParams): Promise<{ selected: Record<string, unknown> }> {
    return this.call('session/selectModel', { request: params });
  }

  forkSession(params: DshSessionForkParams): Promise<{ sessionId: string }> {
    return this.call('session/fork', { request: params });
  }

  renameSession(sessionId: string, title: string): Promise<{ title: string; seq: number }> {
    return this.call('session/rename', { request: { sessionId, title } });
  }

  updateQueue(params: DshSessionUpdateQueueParams): Promise<{ accepted: boolean }> {
    return this.call('session/updateQueue', { request: params });
  }

  executeCommand(
    params: DshExecuteCommandParams,
    signal?: AbortSignal,
  ): Promise<DshCommandExecution | undefined> {
    return this.call<DshCommandExecution | undefined>(
      'commands/execute',
      {
        agentId: params.agentId,
        line: params.line,
        submittedAttachments: params.submittedAttachments ?? [],
      },
      signal,
    );
  }

  getSessionState(sessionId: string): Promise<Record<string, unknown>> {
    return this.call('session/state', { request: { sessionId } });
  }

  async getSessionProjections(sessionId: string, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    const read = () => this.call<Record<string, unknown> | null>('session/projections', { request: { sessionId } }, signal);
    try {
      return await read();
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== DshSocketErrorCode.ConnectionReset
        || this.disposed || signal?.aborted) throw error;
      // The peer may reset this HTTP connection independently of the mux.
      // Reading the same projection again cannot submit a second turn.
      return read();
    }
  }

  getSessionEvents(
    session: string | DshSessionAddress,
    options: { throughSeq?: number; beforeSeq?: number; maxMessages?: number } = {},
  ): Promise<Record<string, unknown>> {
    return this.call('session/events', {
      request: {
        address: typeof session === 'string' ? { kind: 'session', sessionId: session } : session,
        ...options,
      },
    });
  }

  followSession<TFrame = Record<string, unknown>>(
    params: DshSessionFollowParams,
    signal?: AbortSignal,
  ): AsyncGenerator<TFrame, void, void> {
    return this.openStream<TFrame>('session/follow', { request: params }, signal);
  }

  observeSessionControl(signal?: AbortSignal): AsyncGenerator<DshSessionControlFrame, void, void> {
    return this.openStream<DshSessionControlFrame>('session/control', {}, signal);
  }

  getModelCatalog(): Promise<{
    groups: Array<{ id: string; name: string; models: Array<Record<string, unknown>> }>;
    failures?: Array<{ id: string; name?: string; message?: string }>;
    routableProviders?: string[];
  }> {
    return this.call('session/modelCatalog', {});
  }

  listAgentPresets(): Promise<{
    presets: Array<{
      id: string;
      name?: string;
      description?: string;
      order?: number;
      broken?: string;
      isDefault: boolean;
    }>;
  }> {
    return this.call('agentPresets/list', {});
  }

  listSessions(): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.call('session/list', {});
  }

  readSessionAttachment(
    sessionId: string,
    attachment: Record<string, unknown>,
  ): Promise<{ attachment?: Record<string, unknown>; data?: string } | null> {
    return this.call('session/attachment', {
      request: {
        sessionId,
        attachment,
      },
    });
  }

  // ── Plugin Manager RPCs (HMR-backed live profile management) ───────────────

  listPluginBundles(): Promise<DshPluginBundleInfo[]> {
    return this.call<DshPluginBundleInfo[]>('pluginManager/listBundles', {});
  }

  inspectPluginSpec(
    spec: string,
    options?: { registry?: string | null },
    signal?: AbortSignal,
  ): Promise<DshPluginSpecInspection> {
    return this.call<DshPluginSpecInspection>(
      'pluginManager/inspect',
      { spec, ...(options !== undefined ? { options } : {}) },
      signal,
    );
  }

  installPluginBundle(
    spec: string,
    options?: DshPluginInstallBundleOptions,
  ): Promise<DshPluginChangeResult> {
    return this.call<DshPluginChangeResult>('pluginManager/installBundle', {
      spec,
      ...(options !== undefined ? { options } : {}),
    });
  }

  cancelPluginInstall(
    requestId: string,
  ): Promise<{ status: 'cancelled' | 'too-late' | 'not-running' }> {
    return this.call<{ status: 'cancelled' | 'too-late' | 'not-running' }>(
      'pluginManager/cancelInstall',
      { requestId },
    );
  }

  removePluginBundle(name: string): Promise<DshPluginChangeResult> {
    return this.call<DshPluginChangeResult>('pluginManager/removeBundle', { name });
  }

  setPluginBundleEnabled(name: string, enabled: boolean): Promise<DshPluginChangeResult> {
    return this.call<DshPluginChangeResult>('pluginManager/setBundleEnabled', { name, enabled });
  }

  listPluginVersions(
    name: string,
    options?: { registry?: string | null },
    signal?: AbortSignal,
  ): Promise<DshPluginVersionList> {
    return this.call<DshPluginVersionList>(
      'pluginManager/listVersions',
      { name, ...(options !== undefined ? { options } : {}) },
      signal,
    );
  }

  updatePluginBundle(
    name: string,
    version: string,
    options?: DshPluginUpdateBundleOptions,
  ): Promise<DshPluginUpdateResult> {
    return this.call<DshPluginUpdateResult>('pluginManager/updateBundle', {
      name,
      version,
      ...(options !== undefined ? { options } : {}),
    });
  }

  getPluginRegistries(): Promise<DshPluginRegistriesInfo> {
    return this.call<DshPluginRegistriesInfo>('pluginManager/registries', {});
  }

  probeFastestPluginRegistry(): Promise<string | null> {
    return this.call<string | null>('pluginRegistryProbe/fastest', {});
  }

  async close(): Promise<void> {
    this.disposed = true;
    this.muxReady = false;
    this.cookieHeader = '';
    this.connectUrl = '';
    this.emit('closed');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.eventsAbort?.abort(new Error('DshTypertClient closed'));
    this.eventsAbort = null;
    for (const controller of this.activeWaterfallControllers.values()) {
      controller.abort(new Error('DshTypertClient closed'));
    }
    this.activeWaterfallControllers.clear();

    const closedError = new DshRemoteError('gateway/closed', 'DshTypertClient closed');
    for (const queue of this.activeStreams.values()) {
      queue.fail(closedError);
    }
    this.activeStreams.clear();

    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < 2) {
      try {
        socket.close(1000, 'client closed');
      } catch {
        // Ignore close errors.
      }
    }
  }

  private buildMuxWsUrl(): string {
    const url = new URL(DSH_REMOTE_MUX_PATH, this.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.href;
  }

  private async openMuxAndEvents(): Promise<void> {
    const timeout = this.hasConnected ? RECONNECT_HANDSHAKE_TIMEOUT_MS : INITIAL_HANDSHAKE_TIMEOUT_MS;
    if (this.verifyPeerBeforeUpgrade && this.cookieHeader) {
      // A failed upgrade may already have consumed the grant. Probe it before
      // minting another one while a proxy or the local network is unavailable.
      await this.callOps(DshOpsAction.Health, undefined, AbortSignal.timeout(timeout));
    }
    this.verifyPeerBeforeUpgrade = false;
    const wsUrl = this.buildMuxWsUrl();
    const cookie = await this.getPeerCookie();
    if (this.disposed) throw new DshRemoteError('gateway/closed', 'DSH client closed before mux setup');
    const socket = this.wsFactory(wsUrl, { cookie });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onOpen = () => {
        settled = true;
        cleanupInit();
        if (this.disposed) {
          socket.close();
          reject(new DshRemoteError('gateway/closed', 'DSH client closed'));
          return;
        }
        this.socket = socket;
        resolve();
      };
      const onError = (err: unknown) => {
        if (!settled) {
          settled = true;
          this.verifyPeerBeforeUpgrade = true;
          cleanupInit();
          reject(err instanceof Error ? err : new Error('DSH mux WebSocket failed to connect'));
        }
      };
      const onClose = () => {
        if (!settled) {
          settled = true;
          this.verifyPeerBeforeUpgrade = true;
          cleanupInit();
          reject(new Error('DSH mux WebSocket closed before opening'));
        }
      };
      const cleanupInit = () => {
        clearTimeout(handshakeTimeout);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onClose);
      };
      const handshakeTimeout = setTimeout(() => {
        onError(new Error('Timed out opening the DSH mux'));
        socket.close();
      }, timeout);
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
      socket.addEventListener('close', onClose, { once: true });
    });

    socket.addEventListener('message', (event: unknown) => {
      const data = typeof event === 'object' && event !== null && 'data' in event
        ? (event as { data: unknown }).data
        : event;
      this.handleMuxMessage(typeof data === 'string' ? data : String(data));
    });

    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.muxReady = false;
      // The Host disposes the API peer backing this cookie on socket termination.
      // Re-authorize against this same Host before any further HTTP or mux work.
      if (this.cookieHeader === cookie) this.cookieHeader = '';
      const code = (event as { code?: number } | null)?.code;
      console.warn(`[DSH] Mux disconnected (pid=${this.runtimePid ?? 'unknown'}, closeCode=${code ?? 'unknown'}, activeStreams=${this.activeStreams.size})`);
      const lostError = new DshRemoteError('gateway/disconnected', 'DSH mux WebSocket disconnected');
      this.eventsAbort?.abort(lostError);
      for (const queue of this.activeStreams.values()) {
        queue.fail(lostError);
      }
      this.activeStreams.clear();
      this.emit('disconnected');
      this.scheduleReconnect();
    });

    // Open the `$events` logical stream and wait for the initial `ready` frame.
    const eventsAbort = new AbortController();
    this.eventsAbort = eventsAbort;
    const readyPromise = new Promise<void>((resolve, reject) => {
      this.pumpForwardedEvents(eventsAbort.signal, resolve, reject).catch((error) => {
        if (!this.disposed) {
          this.emit('error', error);
        }
      });
    });
    const readyTimeout = setTimeout(() => eventsAbort.abort(new Error('Timed out waiting for DSH events')), timeout);
    try {
      await readyPromise;
    } catch (error) {
      if (this.socket === socket && socket.readyState < 2) socket.close();
      throw error;
    } finally {
      clearTimeout(readyTimeout);
    }
    if (this.disposed || this.socket !== socket) throw new DshRemoteError('gateway/disconnected', 'DSH mux closed during handshake');
    this.reconnectAttempt = 0;
    this.muxReady = true;
    this.hasConnected = true;
    this.emit('connected', { origin: this.origin, hostHome: this.hostHome });
  }

  private handleMuxMessage(raw: string): void {
    let parsed: PendingStreamFrame;
    try {
      parsed = JSON.parse(raw) as PendingStreamFrame;
    } catch {
      return;
    }
    if (!parsed || typeof parsed.streamId !== 'string') return;
    const queue = this.activeStreams.get(parsed.streamId);
    if (!queue) return;
    queue.push(parsed);
    if (parsed.type === 'end' || parsed.type === 'error') {
      queue.end();
    }
  }

  private async pumpForwardedEvents(
    signal: AbortSignal,
    onReady: () => void,
    onReadyFail: (err: Error) => void,
  ): Promise<void> {
    let resolvedReady = false;
    try {
      const stream = this.openStream<Record<string, unknown>>(
        DSH_REMOTE_EVENT_STREAM_ENDPOINT,
        {},
        signal,
      );
      for await (const frame of stream) {
        if (!frame || typeof frame !== 'object') continue;
        if (!resolvedReady) {
          if (frame.type === 'ready' && typeof frame.clientId === 'string') {
            this.clientId = frame.clientId;
            const host = frame.host as Record<string, unknown> | undefined;
            if (host && typeof host.home === 'string') {
              this.hostHome = host.home;
            }
            resolvedReady = true;
            onReady();
            continue;
          }
          const err = new Error(`Expected $events ready frame, received: ${JSON.stringify(frame)}`);
          resolvedReady = true;
          onReadyFail(err);
          return;
        }

        if (frame.type === 'emit' && typeof frame.event === 'string') {
          const args = Array.isArray(frame.args) ? frame.args : [];
          this.emit('remoteEvent', frame.event, args);
          this.emit(`remote:${frame.event}`, ...args);
          continue;
        }

        if (frame.type === 'cancel' && typeof frame.eventId === 'string') {
          this.activeWaterfallControllers.get(frame.eventId)?.abort(
            new Error('Host cancelled forwarded waterfall event'),
          );
          this.activeWaterfallControllers.delete(frame.eventId);
          continue;
        }

        if (
          frame.type === 'waterfall'
          && typeof frame.event === 'string'
          && typeof frame.eventId === 'string'
          && typeof frame.agentId === 'string'
          && frame.request
          && typeof frame.request === 'object'
        ) {
          void this.handleWaterfallFrame(
            frame.event,
            frame.eventId,
            frame.agentId,
            frame.request as Record<string, unknown>,
            signal,
          );
        }
      }
    } catch (error) {
      if (!resolvedReady) {
        resolvedReady = true;
        onReadyFail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private async handleWaterfallFrame(
    event: string,
    eventId: string,
    agentId: string,
    request: Record<string, unknown>,
    generationSignal: AbortSignal,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeWaterfallControllers.set(eventId, controller);
    const onGenAbort = () => controller.abort(generationSignal.reason);
    generationSignal.addEventListener('abort', onGenAbort, { once: true });

    let outcome: DshWaterfallOutcome = { kind: 'next' };
    try {
      const handler = this.waterfallHandlers.get(event);
      if (handler) {
        outcome = await handler({
          event,
          eventId,
          agentId,
          request,
          signal: controller.signal,
        });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      outcome = {
        kind: 'rejected',
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      generationSignal.removeEventListener('abort', onGenAbort);
      this.activeWaterfallControllers.delete(eventId);
    }

    if (controller.signal.aborted || this.disposed) return;

    try {
      await this.call(
        DSH_REMOTE_EVENT_RESULT_ENDPOINT,
        {
          clientId: this.clientId,
          eventId,
          outcome: outcome.kind === 'result' && outcome.value === undefined
            ? { kind: 'result' }
            : outcome,
        },
        generationSignal,
      );
    } catch (error) {
      if (!this.disposed) {
        this.emit('error', error);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * Math.pow(2, this.reconnectAttempt),
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      this.openMuxAndEvents().catch(() => {
        this.scheduleReconnect();
      });
    }, delay);
  }
}
