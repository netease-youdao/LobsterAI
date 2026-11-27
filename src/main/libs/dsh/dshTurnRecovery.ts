import { setTimeout as delay } from 'node:timers/promises';

import { record } from './dshSubagentHistory';
import { DshSocketErrorCode, type DshTypertClient } from './dshTypertClient';

type Frame = Record<string, unknown>;
type ReadyClient = () => Promise<DshTypertClient>;

const transportErrors = new Set([
  'gateway/disconnected', 'gateway/closed', DshSocketErrorCode.ConnectionReset, 'ECONNREFUSED',
  'EPIPE', 'ETIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE',
]);

export function isDshTransportError(error: unknown): boolean {
  return transportErrors.has(String(record(error).code));
}

export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class DshAdmissionUnconfirmedError extends Error {}

/** A lost HTTP response leaves admission unknown. The Host journals this requestId. */
export async function admitDshPrompt(
  client: DshTypertClient, params: Parameters<DshTypertClient['promptSession']>[0],
  ready: ReadyClient, signal: AbortSignal, checkAccount?: () => void,
): ReturnType<DshTypertClient['promptSession']> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    checkAccount?.();
    try {
      return await client.promptSession(params);
    } catch (error) {
      if (!isDshTransportError(error) || signal.aborted) throw error;
      await delay(Math.min(4_000, 250 * 2 ** attempt), undefined, { signal });
      for (;;) {
        try {
          client = await ready();
          checkAccount?.();
          const page = await client.getSessionEvents(params.sessionId, { maxMessages: 8 });
          if (!Array.isArray(page.records)) throw new Error('Missing session event records');
          const frames = await readGap(page, client, params.sessionId, undefined, params.requestId, signal);
          if (frames.some(item => belongsToRequest(item, params.requestId))) return { accepted: true };
          break;
        } catch (lookupError) {
          signal.throwIfAborted();
          if (!isDshTransportError(lookupError)) {
            throw new DshAdmissionUnconfirmedError('Could not verify prompt admission', { cause: lookupError });
          }
          await delay(1_000, undefined, { signal });
        }
      }
    }
  }
}

function entries(page: Frame): Frame[] {
  const rows = Array.isArray(page.records) ? page.records.map(record) : [];
  if (rows.some(row => typeof record(row.event).seq !== 'number')) throw new Error('Missing DSH session event sequence');
  return rows;
}

function belongsToRequest(frame: Frame, id?: string): boolean {
  if (!id) return false;
  const event = record(frame.event);
  const data = record(event.data);
  const messages = event.type === 'agent/inbox/spliced' && Array.isArray(data.inserted)
    ? data.inserted : event.type === 'user/message' ? [data] : [];
  return messages.some(message => record(record(message).source).rpcId === id);
}

async function readGap(
  opening: Frame, client: DshTypertClient | undefined, sessionId: string,
  cursor: number | undefined, requestId: string | undefined, signal: AbortSignal,
): Promise<Frame[]> {
  let page = opening;
  const pages = [entries(page)];
  while (client && page.hasMore) {
    const firstSeq = record(pages[0][0]?.event).seq;
    if (typeof firstSeq !== 'number') throw new Error('Missing DSH session history page');
    if (firstSeq <= (cursor ?? -1) + 1) break;
    if (cursor === undefined && (!requestId || pages[0].some(item => belongsToRequest(item, requestId)))) break;
    signal.throwIfAborted();
    if (typeof opening.cursor !== 'number') throw new Error('Missing DSH session history cursor');
    page = await client.getSessionEvents(sessionId, {
      throughSeq: opening.cursor, beforeSeq: firstSeq, maxMessages: 100,
    });
    const older = entries(page);
    if (!older.length || Number(record(older[older.length - 1].event).seq) >= firstSeq) {
      throw new Error('DSH session history did not advance');
    }
    pages.unshift(older);
  }
  const frames = pages.flat();
  if (cursor !== undefined) return frames.filter(item => Number(record(item.event).seq) > cursor);
  const first = frames.findIndex(item => belongsToRequest(item, requestId));
  return first < 0 ? [] : frames.slice(first);
}

/** Expand only unseen presentation chunks. Tool operations come exclusively from durable events. */
function* missingChunks(attempt: Frame, seen: number): Generator<Frame> {
  if (!Array.isArray(attempt.stream)) return;
  let index = 0;
  for (const item of attempt.stream.map(record)) {
    const texts = Array.isArray(item.texts) ? item.texts : [];
    if (item.type === 'tool-call-chunks' && Array.isArray(item.args)) {
      index += item.args.length;
    } else if (item.type === 'chunk') {
      if (index++ >= seen) yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: item.chunk, turn: attempt.turn } };
    } else {
      // A snapshot already contains all these consecutive deltas. Render them
      // together instead of replaying a burst of intermediate UI updates.
      const suffix = texts.slice(Math.max(0, seen - index)).join('');
      index += texts.length;
      if (suffix) {
        const type = item.type === 'reasoning-chunks' ? 'reasoning-delta' : 'text-delta';
        yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type, text: suffix }, turn: attempt.turn } };
      }
    }
  }
}

export async function* followDshTurn(
  initial: AsyncGenerator<Frame, void, void>, sessionId: string, requestId: string | undefined,
  ready: ReadyClient, signal: AbortSignal, onInterrupted: () => void,
  owner?: DshTypertClient, onOwnerStopped?: () => void,
): AsyncGenerator<Frame, void, void> {
  let stream = initial;
  let cursor: number | undefined;
  let client: DshTypertClient | undefined;
  let attemptId: unknown;
  let nextChunk = 0;
  let ownerReplaced = false;
  let observedRequest = false;
  while (!signal.aborted) {
    try {
      for await (const frame of stream) {
        if (frame.type === 'snapshot' && typeof frame.cursor === 'number') {
          const gap = await readGap(frame, client, sessionId, cursor, requestId, signal);
          for (const entry of gap) {
            cursor = Number(record(entry.event).seq);
            observedRequest ||= belongsToRequest(entry, requestId);
            yield entry;
          }
          cursor = frame.cursor;
          if (ownerReplaced && observedRequest && client && onOwnerStopped) {
            // A process exit can leave a journal without turn/end. Only settle
            // locally if the replacement sees the same durable cut and no work.
            const state = await client.getSessionState(sessionId);
            if (state.cursor === cursor && state.running === false && !(Array.isArray(state.queue) && state.queue.length)) {
              onOwnerStopped();
              return;
            }
          }
          ownerReplaced = false;
          const attempt = record(record(frame.assistantStream).activeAttempt);
          if (attempt.attemptId && (client || gap.length)) {
            yield* missingChunks(attempt, attemptId === attempt.attemptId ? nextChunk : 0);
            attemptId = attempt.attemptId;
            nextChunk = Number(attempt.nextIndex);
          }
          continue;
        }
        const seq = record(frame.event).seq;
        observedRequest ||= belongsToRequest(frame, requestId);
        if (typeof seq === 'number') {
          if (cursor !== undefined && seq <= cursor) continue;
          cursor = seq;
        }
        if (frame.type === 'assistant-stream') {
          const part = record(frame.frame);
          if (part.type === 'start') { attemptId = part.attemptId; nextChunk = 0; }
          if (part.type === 'chunk' && typeof part.index === 'number') {
            attemptId = part.attemptId;
            nextChunk = part.index + 1;
          }
        }
        yield frame;
      }
      return;
    } catch (error) {
      if (!isDshTransportError(error) || signal.aborted) throw error;
      onInterrupted();
      client = await ready();
      ownerReplaced ||= Boolean(owner && client !== owner);
      owner = client;
      stream = client.followSession({
        address: { kind: 'session', sessionId }, assistantStream: true, activate: !(ownerReplaced && observedRequest),
      }, signal);
    }
  }
}
