export const RemoteNetworkMessage = {
  StreamStart: 'stream_start', StreamPull: 'stream_pull', StreamChunk: 'stream_chunk', StreamEnd: 'stream_end',
  Fetch: 'fetch', FetchStarted: 'fetch_started', Result: 'result', Cancel: 'cancel', Socket: 'socket', Frame: 'frame', FrameAck: 'frame_ack',
  SocketSend: 'socket_send', SocketClose: 'socket_close', SocketOpened: 'socket_opened', SocketClosed: 'socket_closed', Alive: 'alive',
} as const;
export const RemoteNetworkLimit = { Requests: 6, BodyBytes: 2 * 1024 * 1024, HeaderBytes: 16 * 1024,
  ArtifactPartBytes: 4 * 1024 * 1024, InputPartBytes: 8 * 1024 * 1024,
  QueueBytes: 8 * 1024 * 1024, BackgroundQueueBytes: 16 * 1024 * 1024, BackgroundQueueRequests: 16,
  BinaryBytes: 100 * 1024 * 1024, BinaryChunkBytes: 64 * 1024, BinaryTimeoutMs: 120000,
  JsonDepth: 32, JsonNodes: 20000, FrameBytes: 64 * 1024, FramesPending: 16, FramesPerSecond: 60, SocketBufferedBytes: 64 * 1024, WorkerMemoryMb: 128 } as const;
export const RemoteNetworkBodyEncoding = { Base64: 'base64' } as const;
export interface RemoteNetworkRequestBody { body?: string; bodyEncoding?: typeof RemoteNetworkBodyEncoding.Base64 }
/** Existing bounded PUT part APIs are the only binary request-body routes. */
export function remoteNetworkUploadBytes(url: string, method = 'GET'): number {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || method.toUpperCase() !== 'PUT') return 0;
  const match = /^\/api\/remote\/v1\/(artifact-uploads|input-assets)\/[A-Za-z0-9_-]{1,64}\/parts\/[1-9]\d{0,9}$/u.exec(parsed.pathname);
  return match ? match[1] === 'artifact-uploads' ? RemoteNetworkLimit.ArtifactPartBytes : RemoteNetworkLimit.InputPartBytes : 0;
}
export interface RemoteSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

/** Finite local error identities; never serialize an arbitrary child error message. */
export const RemoteNetworkFailure = {
  AdmissionBusy: 'REMOTE_NETWORK_ADMISSION_BUSY', Busy: 'REMOTE_NETWORK_BUSY',
  Cancelled: 'REMOTE_NETWORK_CANCELLED', IpcFailed: 'REMOTE_NETWORK_IPC_FAILED',
  RequestFailed: 'REMOTE_NETWORK_REQUEST_FAILED', Failed: 'REMOTE_NETWORK_FAILED',
  RequestInvalid: 'REMOTE_NETWORK_REQUEST_INVALID', RequestBudget: 'REMOTE_NETWORK_REQUEST_BUDGET',
  ResponseInvalid: 'REMOTE_NETWORK_RESPONSE_INVALID', ResponseBudget: 'REMOTE_NETWORK_RESPONSE_BUDGET',
  WorkerExit: 'REMOTE_NETWORK_WORKER_EXIT', WorkerUnavailable: 'REMOTE_NETWORK_WORKER_UNAVAILABLE',
  RestartBudget: 'REMOTE_NETWORK_RESTART_BUDGET', SocketNotReady: 'REMOTE_NETWORK_SOCKET_NOT_READY',
} as const;
export type RemoteNetworkFailure = typeof RemoteNetworkFailure[keyof typeof RemoteNetworkFailure];
export type RemoteNetworkLane = 'control' | 'live' | 'background';
export const remoteNetworkCapacities = { control: 3, live: 2, background: 1 } as const;
/** Only immutable input asset downloads use binary IPC; errors keep the JSON response contract. */
export function remoteNetworkBinaryDownload(url: string, method = 'GET'): boolean {
  const parsed = new URL(url);
  return parsed.protocol === 'https:' && method.toUpperCase() === 'GET'
    && /^\/api\/remote\/v1\/input-assets\/[A-Za-z0-9_-]{1,64}\/content$/u.test(parsed.pathname);
}
/** Keep the supervisor and worker on the same physical admission policy. */
export function remoteNetworkRequestLane(url: string, method = 'GET'): RemoteNetworkLane {
  const path = new URL(url).pathname;
  if (remoteNetworkBinaryDownload(url, method) || remoteNetworkUploadBytes(url, method)) return 'background';
  // A download must never occupy the permit needed to renew its preparation lease or report its result.
  if (method.toUpperCase() === 'POST' && /^\/api\/remote\/v1\/input-preparations\/[^/]+\/(?:renew|result)$/u.test(path)) return 'control';
  if (method.toUpperCase() === 'GET' && /^\/api\/remote\/v[12]\/devices\/[^/]+\/input-preparations$/u.test(path)) return 'background';
  const receipt = method.toUpperCase() === 'GET' && (/^\/api\/remote\/v3\/sync\/(?:state|(?:recoveries|live-projections|mode-activations)\/[^/]+)$/u.test(path)
    || /^\/api\/remote\/v1\/sync\/imports\/[^/]+$/u.test(path));
  const abort = /^\/api\/remote\/(?:v3\/sync\/recoveries|v1\/sync\/imports)\/[^/]+\/abort$/u.test(path);
  const control = receipt || abort || /\/(?:control|commands|connection-tickets|capabilities|mode-activations|device-connections|device-connection-operations)(?:\/|$)/u.test(path)
    || /\/devices\/(?:register|connections|[^/]+\/connection\/(?:remove|resume))(?:\/|$)/u.test(path);
  return control ? 'control' : /\/(?:live-projections|sessions|devices)(?:\/|$)/u.test(path) && !/\/(?:files|contents)\//u.test(path) ? 'live' : 'background';
}
export function remoteNetworkFailureValue(value: unknown): RemoteNetworkFailure | null {
  return typeof value === 'string' && Object.values(RemoteNetworkFailure).some(code => code === value) ? value as RemoteNetworkFailure : null;
}
