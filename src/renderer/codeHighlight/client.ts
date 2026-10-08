import { HighlightStatus } from './constants';
import type { HighlightRequest, HighlightResponse } from './tokenizer';

let worker: Worker | null = null;
let sequence = 0;
const pending = new Map<number, { resolve: (response: HighlightResponse) => void; identity: string; timer: ReturnType<typeof setTimeout> }>();
const unavailable = (id: number, identity: string): HighlightResponse => ({ id, identity, status: HighlightStatus.Unavailable, lines: [] });

function finish(id: number, result?: HighlightResponse) {
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id); clearTimeout(request.timer);
  request.resolve(result?.identity === request.identity ? result : unavailable(id, request.identity));
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./tokenizer.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<HighlightResponse>) => finish(event.data.id, event.data);
  worker.onerror = () => { worker?.terminate(); worker = null; for (const id of pending.keys()) finish(id); };
  return worker;
}

export function highlightCode(request: Omit<HighlightRequest, 'id'>, signal?: AbortSignal): Promise<HighlightResponse> {
  const id = ++sequence;
  if (signal?.aborted || typeof Worker === 'undefined') return Promise.resolve(unavailable(id, request.identity));
  return new Promise(resolve => {
    const abort = () => finish(id);
    const done = (result: HighlightResponse) => { signal?.removeEventListener('abort', abort); resolve(result); };
    pending.set(id, { resolve: done, identity: request.identity, timer: setTimeout(() => finish(id), 30_000) });
    signal?.addEventListener('abort', abort, { once: true });
    try { getWorker().postMessage({ ...request, id }); } catch { finish(id); }
  });
}
