import { RemoteNetworkFailure as Failure, RemoteNetworkLimit as Limit, RemoteNetworkMessage as Message } from './remoteNetworkProtocol';

const requests = new Map<string, AbortController>();
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
async function fetchRequest(message: any): Promise<void> {
  const { id } = message;
  if (!validId(id) || requests.has(id)) return;
  if (requests.size >= Limit.Requests) { emit({ type: Message.Result, id, error: Failure.Busy }); return; }
  const controller = new AbortController(); requests.set(id, controller);
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const url = new URL(message.url);
    if (url.protocol !== 'https:' || !/^\/api\/remote\/v[1-3]\//u.test(url.pathname)
      || typeof message.method !== 'string' || !['GET','POST','PUT','PATCH','DELETE'].includes(message.method)
      || message.body !== undefined && typeof message.body !== 'string'
      || Buffer.byteLength(message.body || '') > Limit.BodyBytes
      || Buffer.byteLength(JSON.stringify(message.headers)) > Limit.HeaderBytes) throw new Error(Failure.RequestInvalid);
    const response = await fetch(url, { method: message.method, headers: message.headers, body: message.body,
      signal: controller.signal, redirect: 'error' });
    const headers = Object.fromEntries(response.headers);
    if (Buffer.byteLength(JSON.stringify(headers)) > Limit.HeaderBytes) throw new Error(Failure.ResponseBudget);
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
    const allowed = new Set<string>([Failure.RequestInvalid,Failure.ResponseBudget]);
    emit({ type: Message.Result, id, error: controller.signal.aborted ? Failure.Cancelled
      : error instanceof Error && allowed.has(error.message) ? error.message : Failure.Failed });
  } finally { clearTimeout(timer); requests.delete(id); }
}
process.on('message', (message: any) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === Message.Fetch) { void fetchRequest(message); return; }
  if (message.type === Message.Cancel && validId(message.id)) { requests.get(message.id)?.abort(); return; }
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
process.on('disconnect', () => { clearInterval(alive); for (const request of requests.values()) request.abort(); closeSocket(); process.exit(0); });
