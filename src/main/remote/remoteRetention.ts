import { createHash } from 'crypto';

import { RemoteRetention } from '../../shared/remote/retention';

export class RemoteSyncStateError extends Error {}

/** SQLite source positions use safe integers; the wire always uses canonical decimals. */
export function retentionSequence(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/u.test(value)) throw new RemoteSyncStateError('Invalid remote sequence');
  return BigInt(value);
}
export function safeSourceSequence(value: unknown): number {
  const sequence = retentionSequence(value);
  if (sequence > BigInt(Number.MAX_SAFE_INTEGER)) throw new RemoteSyncStateError('Remote source sequence exceeds local integer precision');
  return Number(sequence);
}
export function retentionEventId(deviceId: string, sessionId: string, streamEpoch: string, sourceSeq: string): string {
  if (![deviceId, sessionId, streamEpoch].every(value => /^[\x21-\x7e]+$/u.test(value))) throw new RemoteSyncStateError('Invalid remote stream identity');
  retentionSequence(sourceSeq);
  return `e2_${createHash('sha256').update(JSON.stringify([RemoteRetention.EventDomain, deviceId, sessionId, streamEpoch, sourceSeq]), 'utf8').digest('base64url')}`;
}
