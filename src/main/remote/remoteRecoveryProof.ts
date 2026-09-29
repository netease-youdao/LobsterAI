import { payloadHash } from './canonical';
import type { ControlSnapshot } from './remoteAvailabilitySource';
import type { ProjectionRecord, RemoteEvent } from './remoteStore';

const display = new Set(['message.upsert','message.delta','tool.upsert']);
const controls = new Set(['session.upsert','run.updated','approval.updated','question.updated','message.deleted']);
const terminal = new Set(['succeeded','failed','cancelled','interrupted','approved','denied','answered','expired','resolved','superseded','withdrawn']);
const version = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error('REMOTE_RECOVERY_CORE_VERSION_MISSING');
  return BigInt(value);
};
export function recoveryEvents(rows: Array<{ sourceSeq: string; eventJson: string }>, after: string): RemoteEvent[] {
  let expected = BigInt(after);
  const ids = new Set<string>();
  return rows.map(row => {
    const event = JSON.parse(row.eventJson) as RemoteEvent;
    if (BigInt(row.sourceSeq) !== ++expected || event.sourceSeq !== row.sourceSeq || !event.eventId || ids.has(event.eventId)
      || !event.payload || !controls.has(event.eventType) && !display.has(event.eventType)) throw new Error('REMOTE_RECOVERY_SOURCE_EVIDENCE_INVALID');
    ids.add(event.eventId); return event;
  });
}
export function recoveryRequired(events: RemoteEvent[]): { runIds: string[]; approvalIds: string[]; questionIds: string[]; deletedMessageIds: string[] } {
  const runIds = new Set<string>(), approvalIds = new Set<string>(), questionIds = new Set<string>(), deletedMessageIds = new Set<string>();
  for (const event of events) {
    const object = event.payload.run || event.payload.approval || event.payload.question || event.payload.session?.run;
    if (object?.runId) runIds.add(object.runId);
    if (event.eventType === 'approval.updated') approvalIds.add(event.payload.approval?.approvalId);
    if (event.eventType === 'question.updated') questionIds.add(event.payload.question?.questionId);
    if (event.eventType === 'message.deleted') deletedMessageIds.add(event.payload.messageId);
  }
  if ([...runIds,...approvalIds,...questionIds,...deletedMessageIds].some(id => typeof id !== 'string' || !id)) throw new Error('REMOTE_RECOVERY_CONTROL_ID_MISSING');
  return { runIds: [...runIds], approvalIds: [...approvalIds], questionIds: [...questionIds], deletedMessageIds: [...deletedMessageIds] };
}
/** A baseline covers actual current core successors, never merely an arbitrary fact cursor. */
export function recoverySourceManifest(events: RemoteEvent[], snapshot: ControlSnapshot, throughFactSeq: string): Array<Record<string,string>> {
  const find = (event: ProjectionRecord, field: string, id: string): any => snapshot.records.find(record => record.eventType === event.eventType
    && (field === 'messageId' ? record.payload.messageId === id : record.payload[field]?.[`${field}Id`] === id))?.payload;
  return events.map(event => {
    const row: Record<string,string> = { sourceSeq: event.sourceSeq, eventId: event.eventId, eventType: event.eventType, payloadHash: payloadHash(event.payload) };
    if (display.has(event.eventType)) return row;
    if (event.eventType === 'session.upsert') {
      const latest = snapshot.records.find(record => record.eventType === 'session.upsert')?.payload.session;
      if (!latest || latest.sessionId !== event.payload.session?.sessionId
        || version(latest.controlVersion) < version(event.payload.session.controlVersion)) throw new Error('REMOTE_RECOVERY_SESSION_UNCOVERED');
      if (event.payload.session.run) verifyObject(event.payload.session.run,
        snapshot.records.find(record => record.eventType === 'run.updated' && record.payload.run?.runId === event.payload.session.run.runId)?.payload.run);
    } else if (event.eventType === 'message.deleted') {
      const latest = find(event,'messageId',event.payload.messageId);
      if (!latest || version(latest.sourceObjectRevision) < 1n) throw new Error('REMOTE_RECOVERY_DELETION_UNCOVERED');
    } else {
      const field = event.eventType.split('.')[0], object = event.payload[field];
      const latest = object && find(event,field,object[`${field}Id`]);
      if (!latest) throw new Error('REMOTE_RECOVERY_CONTROL_UNCOVERED');
      verifyObject(object,latest[field]);
    }
    row.controlFactSeq = throughFactSeq; return row;
  });
}
function verifyObject(previous: any, current: any): void {
  if (!current || previous.runId !== current.runId || objectVersion(current) < objectVersion(previous)
    || previous.operationDigest !== undefined && previous.operationDigest !== current.operationDigest
    || terminal.has(previous.status) && previous.status !== current.status) throw new Error('REMOTE_RECOVERY_CONTROL_UNCOVERED');
  if (objectVersion(current) === objectVersion(previous) && current.status !== previous.status) throw new Error('REMOTE_RECOVERY_CONTROL_CONFLICT');
}

function objectVersion(value: any): bigint { return version(value.statusVersion ?? value.approvalVersion ?? value.questionVersion); }
