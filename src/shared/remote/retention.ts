/** Sync retention is independent of WS and message projection protocol versions. */
export const RemoteRetention = {
  Capability: 'sync_retention_v2', Receipts: 'operation_receipts_v1', Version: 2,
  EventIdAlgorithm: 'sha256-array-v1', EventDomain: 'remote-sync-event-v2',
  Compacted: 'compacted', StateMissingCode: 47038, StateConflict: 'SYNC_STATE_CONFLICT', ResyncCode: 47015, ProtocolCode: 47009,
  SourceExpired: 'SOURCE_WINDOW_EXPIRED', EpochChanged: 'STREAM_EPOCH_CHANGED', Gap: 'GAP',
} as const;
export interface RetentionImport {
  syncProtocolVersion?: number; expectedStreamEpoch?: string | null; targetStreamEpoch?: string;
  migration?: boolean; owner?: { userId: string; scopeKey: string }; environment?: string; deviceId?: string;
}
export interface RetentionState {
  deviceId: string; sessionId: string; localSessionId: string; syncProtocolVersion: number;
  streamEpoch: string | null; lastSourceSeq: string; lastSeq: string;
  sourcePurgeSeq: string; eventPurgeSeq: string; activeImport?: { importId: string } | null;
  deleted?: boolean;
}
