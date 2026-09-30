export const RemoteNetworkMessage = {
  Fetch: 'fetch', Result: 'result', Cancel: 'cancel', Socket: 'socket', Frame: 'frame', FrameAck: 'frame_ack',
  SocketSend: 'socket_send', SocketClose: 'socket_close', SocketOpened: 'socket_opened', SocketClosed: 'socket_closed', Alive: 'alive',
} as const;
export const RemoteNetworkLimit = { Requests: 6, BodyBytes: 2 * 1024 * 1024, HeaderBytes: 16 * 1024,
  JsonDepth: 32, JsonNodes: 20000, FrameBytes: 64 * 1024, FramesPending: 16, FramesPerSecond: 60, SocketBufferedBytes: 64 * 1024, WorkerMemoryMb: 128 } as const;
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
export function remoteNetworkFailureValue(value: unknown): RemoteNetworkFailure | null {
  return typeof value === 'string' && Object.values(RemoteNetworkFailure).some(code => code === value) ? value as RemoteNetworkFailure : null;
}
