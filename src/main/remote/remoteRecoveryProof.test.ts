import { describe,expect,it } from 'vitest';

import { recoveryEvents,recoverySourceManifest } from './remoteRecoveryProof';

const run = { runId: 'run',statusVersion: '2',status: 'succeeded' };
const event = { sourceSeq: '160',eventId: 'source',eventType: 'run.updated',occurredAt: '2026-09-23T00:00:00Z',payload: { run } };
const snapshot = { revision: '99',hash: '',records: [{ eventType: 'run.updated',payload: { run } }] };
describe('protected source coverage', () => {
  it('uses real matching terminal successors as baseline coverage, not exact original source acknowledgement', () => {
    const events = recoveryEvents([{ sourceSeq: '160',eventJson: JSON.stringify(event) }],'159');
    expect(recoverySourceManifest(events,snapshot,'101')).toEqual([{ sourceSeq:'160',eventId:'source',eventType:'run.updated',payloadHash:expect.any(String),controlFactSeq:'101' }]);
  });
  it('refuses missing or conflicting terminal core evidence', () => {
    expect(() => recoverySourceManifest([event],{ ...snapshot,records: [] },'101')).toThrow('UNCOVERED');
    expect(() => recoverySourceManifest([event],{ ...snapshot,records: [{ eventType:'run.updated',payload:{ run:{ ...run,statusVersion:'3',status:'running' } } }] },'101')).toThrow('UNCOVERED');
  });
  it('does not treat a missing body as a deletion or unknown event as dispensable display', () => {
    expect(() => recoverySourceManifest([{ ...event,eventType:'message.deleted',payload:{ messageId:'message' } } as any],snapshot,'101')).toThrow('DELETION_UNCOVERED');
    expect(() => recoveryEvents([{ sourceSeq:'160',eventJson:JSON.stringify({ ...event,eventType:'session.deleted' }) }],'159')).toThrow('EVIDENCE_INVALID');
    expect(() => recoveryEvents([{ sourceSeq:'162',eventJson:JSON.stringify({ ...event,sourceSeq:'162' }) }],'159')).toThrow('EVIDENCE_INVALID');
  });
  it('checks decision identity and actual decision version before allowing coverage', () => {
    const approval = { approvalId:'approval',runId:'run',approvalVersion:'2',status:'approved',operationDigest:'original' };
    const source:any = { ...event,eventType:'approval.updated',payload:{ approval } };
    const baseline:any = { ...snapshot,records:[{ eventType:'approval.updated',payload:{ approval:{ ...approval,operationDigest:'different' } } }] };
    expect(() => recoverySourceManifest([source],baseline,'101')).toThrow('UNCOVERED');
  });
});
