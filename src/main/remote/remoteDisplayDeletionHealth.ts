import type Database from 'better-sqlite3';

import type { RemoteOwner } from '../../shared/remote/constants';
import { RemoteDeletionProtocol } from './remoteDeletionSyncPolicy';
import { readRemoteDeletionDatabaseStatus } from './remoteDeletionSyncState';

interface Context { owner: RemoteOwner; targetId: string | null; deviceId: string | null; scope: string | null }
export interface RemoteDisplayDeletionHealth { pending: boolean; confirmed: boolean }
/** One task, bounded metadata only. In particular a core ACK does not erase an unfinished sidecar operation. */
export function readRemoteDisplayDeletionHealth(core: Database.Database, control: Database.Database | null,
  context: Context, localId: string): RemoteDisplayDeletionHealth {
  if (!context.targetId || !context.deviceId) return { pending: true, confirmed: false };
  const row = control && context.scope ? control.prepare(`SELECT CASE WHEN length(CAST(body AS BLOB))<=1048576 AND json_valid(body) THEN
    json_object('sessionId',json_extract(body,'$.sessionId'),'writerGeneration',json_extract(body,'$.writerGeneration'),'controlEpoch',json_extract(body,'$.controlEpoch')) END AS body
    FROM availability_sessions WHERE scope=? AND local_id=?`).get(context.scope, localId) as { body: string | null } | undefined : undefined;
  let state: Record<string, unknown> | undefined;
  if (row) {
    try {
      state = row.body === null ? undefined : JSON.parse(row.body) as Record<string, unknown>;
      if (!state || typeof state !== 'object' || Array.isArray(state)) return { pending: true, confirmed: false };
    } catch { return { pending: true, confirmed: false }; }
  }
  const status = readRemoteDeletionDatabaseStatus(core, localId, { owner: context.owner, targetId: context.targetId, deviceId: context.deviceId,
    ...(context.scope ? { scope: context.scope } : {}), adopted: !!row,
    ...(state && typeof state.sessionId === 'string' && typeof state.writerGeneration === 'string' && typeof state.controlEpoch === 'string'
      ? { controlBinding: { scope: context.scope!, sessionId: state.sessionId, deviceId: context.deviceId, writerGeneration: state.writerGeneration, controlEpoch: state.controlEpoch } } : {}),
  });
  const unresolved = !!control && !!context.scope && (!!control.prepare('SELECT 1 FROM availability_requests WHERE scope=? AND local_id=? AND resolution_receipt IS NULL LIMIT 1')
    .get(context.scope, localId) || !!control.prepare('SELECT 1 FROM availability_faults WHERE scope=? AND local_id=? LIMIT 1').get(context.scope, localId));
  return { confirmed: status.settled, pending: !status.settled || status.protocol === RemoteDeletionProtocol.Control && !row || unresolved };
}
