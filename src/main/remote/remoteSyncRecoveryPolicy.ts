import { payloadHash } from './canonical';

export const RemoteRecoveryPolicyVersion = 1;
const causes = new Set(['protocol_requirement', 'capability_unavailable', 'projection_invalid', 'reference_unavailable', 'run_version_conflict', 'immutable_operation_conflict', 'state_conflict']);
const capabilities = ['sync_retention_v2', 'reply_content_v1', 'input_schema_v2', 'input_attachments_v1', 'session_delete_v1'];
const forbidden = new Set(['ACCESS_DENIED', 'DEVICE_NOT_READY', 'SESSION_DELETED', 'SYNC_TARGET_CHANGED', 'DEVICE_RETIRED', 'REMOTE_SYNC_STATE_CONFLICT']);
export const RecoveryImmutableErrors = [
  'Operation ID already has different content', 'Immutable checkpoint page changed', 'Checkpoint page differs from frozen manifest',
  'Immutable part cannot change', 'Import manifest cannot change', 'Part payload hash mismatch', 'Import tombstone cannot change',
  'Immutable snapshot message conflicts with its tombstone', 'Immutable tombstone timestamp cannot change', 'Immutable snapshot object appears with different content',
];
const invalid = new Set(['A source sequence cannot change content', 'Event hash mismatch', 'Object version has different content', 'Message identity and ordinal cannot change', 'Deleted message cannot be resurrected']);
export interface RecoveryFailure { code: number; httpStatus: number; reason: string; cause?: string; requiredCapability?: string }
/** Hints select bounded state queries, never grant a repair or override authentication. */
export function recoveryFailure(raw: unknown): RecoveryFailure | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, any>, data = item.data ?? item;
  const code = Number(item.code), httpStatus = Number(item.httpStatus);
  const reason = data.reason;
  if (!([47009, 47019, 47006].includes(code) || code === 47017 && reason === 'CAPABILITY_UNSUPPORTED') || ![400, 409, 426].includes(httpStatus)
    || typeof reason !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/u.test(reason) || forbidden.has(reason)
    || invalid.has(item.validation ?? item.message)) return null;
  const hint = data.syncDiagnostic?.version === 1 ? data.syncDiagnostic : null;
  const immutable = RecoveryImmutableErrors.includes(item.validation ?? item.message);
  return { code, httpStatus, reason,
    ...(immutable ? { cause: 'immutable_operation_conflict' } : causes.has(hint?.cause) ? { cause: hint.cause } : {}),
    ...(capabilities.includes(hint?.requiredCapability) ? { requiredCapability: hint.requiredCapability } : {}) };
}
export function recoveryCapabilityKey(failure: RecoveryFailure, support: any, original?: { syncProtocolVersion?: number; projectionVersion?: number; replyProjection?: boolean }): string {
  const required = new Set<string>();
  if (failure.requiredCapability) required.add(failure.requiredCapability);
  if (original?.syncProtocolVersion === 2 || failure.httpStatus === 426) required.add('sync_retention_v2');
  if (original?.replyProjection || (original?.projectionVersion ?? 0) >= 4 || failure.httpStatus === 426) required.add('reply_content_v1');
  return payloadHash({ capabilities: [...required].sort().map(capability => [capability, support?.capabilities?.includes(capability) === true]),
    ...(required.has('sync_retention_v2') ? { retention: support?.syncRetention ?? null } : {}),
    ...(required.has('reply_content_v1') ? { reply: support?.projectionVersions?.includes(4) === true } : {}) });
}
