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
