import { remoteNetworkBinaryDownload,RemoteNetworkBodyEncoding, remoteNetworkCapacities, RemoteNetworkFailure as Failure, type RemoteNetworkLane, RemoteNetworkLimit as Limit, RemoteNetworkMessage as Message, remoteNetworkRequestLane,remoteNetworkUploadBytes } from './remoteNetworkProtocol';

interface Request {
  controller: AbortController; lane: RemoteNetworkLane;
  stream?: { next: number; credit: boolean; wake?: () => void };
}
const requests = new Map<string, Request>();
let socket: WebSocket | null = null;
let socketId: string | null = null;
let frameSeq = 0, windowStart = Date.now(), framesInWindow = 0;
const framesPending = new Set<number>();
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/u.test(value);
function boundedJson(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++nodes > Limit.JsonNodes || next.depth > Limit.JsonDepth) return false;
    if (next.value && typeof next.value === 'object') {
      const values = Object.values(next.value);
      if (values.length + pending.length + nodes > Limit.JsonNodes) return false;
      for (const child of values) pending.push({ value: child, depth: next.depth + 1 });
    }
  }
  return true;
}
function emit(value: Record<string, unknown>): boolean {
  try { return process.send?.(value, error => { if (error) process.exit(1); }) ?? false; }
  catch { process.exit(1); return false; }
}
function closeSocket(code = 1000): void {
  const previous = socket, id = socketId;
  socket = null; socketId = null; framesPending.clear();
  try { previous?.close(); } catch { /* Process exit remains available to the supervisor. */ }
  if (id) emit({ type: Message.SocketClosed, id, code });
}
async function binaryResponse(id: string, request: Request, response: Response, headers: Record<string, string>): Promise<number> {
  const size = headers['content-length'];
  const stream = request.stream = { next: 0, credit: false } as NonNullable<Request['stream']>;
  const reader = response.body?.getReader();
  let chunk: Uint8Array | undefined, offset = 0, bytes = 0;
  const aborted = (): void => { stream.wake?.(); };
  request.controller.signal.addEventListener('abort', aborted);
  try {
    if (size !== undefined && (!/^\d+$/u.test(size) || Number(size) > Limit.BinaryBytes)) throw new Error(Failure.ResponseBudget);
    emit({ type: Message.StreamStart, id, status: response.status, headers });
    while (true) {
      if (!stream.credit && !request.controller.signal.aborted) await new Promise<void>(resolve => { stream.wake = resolve; });
      stream.wake = undefined;
      if (request.controller.signal.aborted) throw new Error(Failure.Cancelled);
      stream.credit = false;
      while (!chunk || offset === chunk.byteLength) {
        const next = await reader?.read();
        if (!next || next.done) return bytes;
        chunk = next.value; offset = 0;
      }
      const length = Math.min(Limit.BinaryChunkBytes, chunk.byteLength - offset);
      bytes += length;
      if (bytes > Limit.BinaryBytes) throw new Error(Failure.ResponseBudget);
      const body = Buffer.from(chunk.buffer, chunk.byteOffset + offset, length).toString('base64');
      offset += length;
      emit({ type: Message.StreamChunk, id, seq: stream.next++, body });
    }
  } finally {
    request.controller.signal.removeEventListener('abort', aborted);
    try { await reader?.cancel(); } catch { /* Preserve the transfer error. */ } finally { reader?.releaseLock(); }
  }
}
async function fetchRequest(message: any): Promise<void> {
  const { id } = message;
  if (!validId(id) || requests.has(id)) return;
  let lane: RemoteNetworkLane;
  try { lane = remoteNetworkRequestLane(message.url, message.method); }
  catch { emit({ type: Message.Result, id, error: Failure.RequestInvalid }); return; }
  if (requests.size >= Limit.Requests || [...requests.values()].filter(request => request.lane === lane).length >= remoteNetworkCapacities[lane]) { emit({ type: Message.Result, id, error: Failure.Busy }); return; }
  const controller = new AbortController(), request: Request = { controller, lane };
  requests.set(id, request);
  const binary = remoteNetworkBinaryDownload(message.url, message.method);
  const uploadBytes = remoteNetworkUploadBytes(message.url, message.method);
  const timer = setTimeout(() => controller.abort(), binary || uploadBytes ? Limit.BinaryTimeoutMs : 30000);
  try {
    const url = new URL(message.url);
    let requestBody: RequestInit['body'] = message.body;
    if (message.bodyEncoding !== undefined) {
      if (message.bodyEncoding !== RemoteNetworkBodyEncoding.Base64 || !uploadBytes || typeof message.body !== 'string') throw new Error(Failure.RequestInvalid);
      if (message.body.length > 4 * Math.ceil(uploadBytes / 3)) throw new Error(Failure.RequestBudget);
      const decoded = Buffer.from(message.body, 'base64');
      if (decoded.length > uploadBytes) throw new Error(Failure.RequestBudget);
      if (decoded.toString('base64') !== message.body) throw new Error(Failure.RequestInvalid);
      requestBody = decoded;
    } else if (message.body !== undefined && typeof message.body !== 'string') throw new Error(Failure.RequestInvalid);
    else if (Buffer.byteLength(message.body || '') > Limit.BodyBytes) throw new Error(Failure.RequestBudget);
    if (url.protocol !== 'https:' || !/^\/api\/remote\/v[1-3]\//u.test(url.pathname)
      || typeof message.method !== 'string' || !['GET','POST','PUT','PATCH','DELETE'].includes(message.method)
      || Buffer.byteLength(JSON.stringify(message.headers)) > Limit.HeaderBytes) throw new Error(Failure.RequestInvalid);
    // This notification carries no URL/body/auth data and must not change the HTTP outcome.
    try { process.send?.({ type: Message.FetchStarted, id }, () => {}); } catch { /* Best-effort telemetry only. */ }
    const response = await fetch(url, { method: message.method, headers: message.headers, body: requestBody,
      signal: controller.signal, redirect: 'error' });
    const headers = Object.fromEntries(response.headers);
    if (Buffer.byteLength(JSON.stringify(headers)) > Limit.HeaderBytes) throw new Error(Failure.ResponseBudget);
    if (binary && response.status === 200) {
      const bytes = await binaryResponse(id, request, response, headers);
      requests.delete(id); emit({ type: Message.StreamEnd, id, bytes }); return;
    }
    const chunks: Buffer[] = []; let bytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > Limit.BodyBytes) { await reader.cancel(); throw new Error(Failure.ResponseBudget); }
          chunks.push(Buffer.from(next.value));
        }
      } finally { reader.releaseLock(); }
    }
    const body = Buffer.concat(chunks).toString('utf8');
    let json: unknown = null, jsonValid = false;
    try { json = JSON.parse(body); jsonValid = true; } catch { /* Parent preserves the existing invalid-response error. */ }
    if (jsonValid && !boundedJson(json)) throw new Error(Failure.ResponseBudget);
    emit({ type: Message.Result, id, status: response.status, headers, body, json, jsonValid });
  } catch (error) {
    const allowed = new Set<string>([Failure.RequestInvalid,Failure.RequestBudget,Failure.ResponseBudget]);
    emit({ type: Message.Result, id, error: controller.signal.aborted ? Failure.Cancelled
      : error instanceof Error && allowed.has(error.message) ? error.message : Failure.Failed });
  } finally { clearTimeout(timer); requests.delete(id); }
}
process.on('message', (message: any) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === Message.Fetch) { void fetchRequest(message); return; }
  if (message.type === Message.StreamPull && validId(message.id)) {
    const stream = requests.get(message.id)?.stream;
    if (stream && message.seq === stream.next && !stream.credit) { stream.credit = true; stream.wake?.(); }
    return;
  }
  if (message.type === Message.Cancel && validId(message.id)) { requests.get(message.id)?.controller.abort(); return; }
  if (message.type === Message.Socket && validId(message.id)) {
    closeSocket();
    try {
      if (typeof message.url !== 'string' || message.url.length > 8192) throw new Error();
      const url = new URL(message.url);
      if (url.protocol !== 'wss:' || !url.pathname.startsWith('/api/remote/v1/')) throw new Error();
      const current = new WebSocket(url); socket = current; socketId = message.id;
      current.addEventListener('open', () => { if (socket === current) emit({ type: Message.SocketOpened, id: message.id }); });
      current.addEventListener('message', event => {
        if (socket !== current) return;
        try {
          if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > Limit.FrameBytes) { closeSocket(1009); return; }
          const now = Date.now(); if (now - windowStart >= 1000) { windowStart = now; framesInWindow = 0; }
          if (++framesInWindow > Limit.FramesPerSecond || framesPending.size >= Limit.FramesPending) { closeSocket(1013); return; }
          const frame = JSON.parse(event.data);
          if (!boundedJson(frame) || !frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.type !== 'string') { closeSocket(1002); return; }
          const seq = ++frameSeq; framesPending.add(seq);
          emit({ type: Message.Frame, id: message.id, seq, frame });
        } catch { closeSocket(1002); }
      });
      current.addEventListener('close', event => { if (socket === current) closeSocket(event.code); });
      current.addEventListener('error', () => { if (socket === current) closeSocket(1006); });
    } catch { socketId = message.id; closeSocket(1002); }
    return;
  }
  if (message.id !== socketId) return;
  if (message.type === Message.FrameAck && Number.isSafeInteger(message.seq)) framesPending.delete(message.seq);
  else if (message.type === Message.SocketClose) closeSocket();
  else if (message.type === Message.SocketSend) {
    try {
      if (typeof message.data !== 'string' || Buffer.byteLength(message.data) > 4096 || !socket || socket.readyState !== WebSocket.OPEN
        || socket.bufferedAmount > Limit.SocketBufferedBytes) { closeSocket(1013); return; }
      socket.send(message.data);
    } catch { closeSocket(1006); }
  }
});
const alive = setInterval(() => { emit({ type: Message.Alive, rss: process.memoryUsage().rss }); }, 1000);
process.on('disconnect', () => { clearInterval(alive); for (const request of requests.values()) request.controller.abort(); closeSocket(); process.exit(0); });
