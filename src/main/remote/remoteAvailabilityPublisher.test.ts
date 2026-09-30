import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type AvailabilityContext,RemoteAvailabilityPublisher } from './remoteAvailabilityPublisher';
import { RemoteStore } from './remoteStore';

vi.mock('./remoteLogSink', () => ({ enqueueRemoteLog: (level: 'debug' | 'warn' | 'error' | 'info', message: string, fields: Record<string, unknown>) => console[level](message, fields) }));

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(dispose => dispose()); vi.restoreAllMocks(); });
function fixture() {
  const db = new Database(':memory:'); cleanup.push(() => db.close());
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,model_override TEXT,thinking_level TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db, { deferredProjection: true, restoreRuns: false }); store.setWake(() => {});
  const owner = { userId: '1', scopeKey: 'personal' };
  let context: AvailabilityContext | null = { scope: 'target:1:personal:desktop', owner, deviceId: 'desktop', generation: '1', supported: true, historySupported: true };
  store.transaction(() => {
    db.prepare('INSERT INTO cowork_sessions VALUES(?,?,1,1,?,NULL,NULL)').run('local', 'Task', 'idle');
    store.assignNew('local', owner, 'local_create');
    db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,?,2,1)').run('message', 'local', 'assistant', 'Hello', '{}');
  });
  store.bindRemote('local', store.sync('local')!.session_id, 'desktop');
  const request = vi.fn(async (pathname: string, _method: string, body: any) => {
    if (pathname === '/sync/mode-activations') return { writerGeneration: body.writerGeneration, state: 'fenced', pendingCommandIds: [], pendingCommands: [] };
    if (pathname === '/control/bootstrap') return { state: 'uploading' };
    if (/\/parts\/\d+$/u.test(pathname)) return { state: 'accepted' };
    if (pathname.endsWith('/commit')) return { state: 'committed', controlReady: true };
    if (pathname === '/control/facts/batches') return { state: 'committed', lastFactSeq: body.lastFactSeq };
    if (pathname === '/sync/live-projections') return { publicationId: body.publicationId, state: 'accepted', projectionRevision: '900', committedSeq: '10' };
    throw Object.assign(new Error('unknown operation'), { httpStatus: 404 });
  });
  const publisher = new RemoteAvailabilityPublisher({ store, context: () => context, admitted: () => true, request });
  store.setIndependentControlReady(id => publisher.controlReady(id));
  cleanup.push(() => store.history.close());
  cleanup.push(() => publisher.dispose());
  const controls = (): Promise<void> => (publisher as any).controls(context);
  const live = (): Promise<void> => (publisher as any).live(context);
  return { db, store, owner, context: context!, setContext: (value: AvailabilityContext | null) => { context = value; }, request, publisher, controls, live };
}

describe('availability-first control and current messages', () => {
  it('publishes controls and live content past a poisoned historical outbox without advancing its ACK', async () => {
    const f = fixture();
    f.db.prepare('INSERT INTO remote_outbox VALUES(?,?,?)').run('local', 160, '{');
    f.db.prepare('UPDATE remote_sync SET source_seq=332,ack_seq=159 WHERE local_id=?').run('local');
    await f.controls(); await f.live();
    expect(f.publisher.ownsHistory('local')).toBe(true);
    expect(f.publisher.ledger.session(f.context.scope, 'local')?.phase).toBe('active');
    const live = f.request.mock.calls.find(call => call[0] === '/sync/live-projections')![2];
    expect(live.payload.blocks[0].text).toBe('Hello'); expect(live.payload).not.toHaveProperty('revision');
    expect(f.store.sync('local')).toMatchObject({ source_seq: 332, ack_seq: 159 });
    expect(f.db.prepare('SELECT event_json FROM remote_outbox').get()).toEqual({ event_json: '{' });
  });
  it('replays a lost live response with the original ID and body before publishing a newer core revision', async () => {
    const f = fixture(); await f.controls();
    const ordinary = f.request.getMockImplementation()!; let first = true;
    f.request.mockImplementation(async (...args) => {
      if (args[0] === '/sync/live-projections' && first) { first = false; throw new TypeError('lost response'); }
      return ordinary(...args);
    });
    await f.live();
    const initial = f.request.mock.calls.find(call => call[0] === '/sync/live-projections')![2];
    f.store.transaction(() => f.db.prepare('UPDATE cowork_messages SET content=? WHERE id=?').run('Hello again', 'message'));
    (f.publisher as any).failures.clear();
    await f.live();
    const publications = f.request.mock.calls.filter(call => call[0] === '/sync/live-projections');
    expect(publications[1][2]).toEqual(initial);
    expect(f.request.mock.calls.some(call => call[0].startsWith('/sync/live-projections/') && call[1] === 'GET')).toBe(true);
    (f.publisher as any).liveScan.clear(); await f.live();
    const latest = f.request.mock.calls.filter(call => call[0] === '/sync/live-projections').at(-1)![2];
    expect(latest.publicationId).not.toBe(initial.publicationId); expect(latest.sourceObjectRevision).toBe('2');
  });
  it('keeps deterministic rejection local to one display object', async () => {
    const f = fixture();
    f.store.transaction(() => f.db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,?,3,2)').run('bad', 'local', 'assistant', 'bad', '{'));
    await f.controls(); await f.live();
    expect(f.request.mock.calls.some(call => call[0] === '/sync/live-projections' && call[2].objectId === 'message')).toBe(true);
    expect(f.publisher.ledger.session(f.context.scope, 'local')?.phase).toBe('active');
  });
  it('does not perform network requests for unchanged idle controls or acknowledged live objects', async () => {
    const f = fixture(); await f.controls(); await f.live(); f.request.mockClear();
    await f.controls(); await f.live();
    expect(f.request).not.toHaveBeenCalled();
  });
  it('carries terminal run changes through the independent fact stream', async () => {
    const f = fixture(); f.store.beginRun('local', 'run'); f.store.updateRun('local', 'running');
    await f.controls(); f.request.mockClear();
    f.store.updateRun('local', 'succeeded'); await f.controls();
    const body = f.request.mock.calls.find(call => call[0] === '/control/facts/batches')![2];
    expect(body.facts.some((fact: any) => fact.payload.run?.status === 'succeeded')).toBe(true);
    expect(f.store.sync('local')!.ack_seq).toBe(0);
  });
  it('increments per-object revision in the core transaction and rolls it back with failed mutations', async () => {
    const f = fixture();
    expect(() => f.store.transaction(() => {
      f.db.prepare('UPDATE cowork_messages SET content=? WHERE id=?').run('rolled back', 'message'); throw new Error('fail');
    })).toThrow('fail');
    expect(f.db.prepare('SELECT revision FROM remote_live_revisions WHERE object_id=?').get('message')).toEqual({ revision: 1 });
  });
  it('fences legacy history before the activation response is known', async () => {
    const f = fixture(); f.request.mockRejectedValue(new TypeError('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await f.controls(); expect(f.publisher.ownsHistory('local')).toBe(true);
    expect(f.publisher.ledger.session(f.context.scope, 'local')?.phase).toBe('activating');
  });
  it('publishes a deletion as a protected source revision rather than reviving its old live body', async () => {
    const f = fixture(); await f.controls(); await f.live(); f.request.mockClear();
    f.store.transaction(() => f.db.prepare('DELETE FROM cowork_messages WHERE id=?').run('message'));
    await f.controls(); await f.live();
    const body = f.request.mock.calls.find(call => call[0] === '/control/facts/batches')![2];
    expect(body.facts.some((fact: any) => fact.eventType === 'message.deleted' && fact.payload.sourceObjectRevision === '2')).toBe(true);
    expect(f.request.mock.calls.some(call => call[0] === '/sync/live-projections')).toBe(false);
  });
});

describe('durable control transitions and capability retirement', () => {
  it('publishes the previous terminal run even if another run started before the next scan', async () => {
    const f = fixture(); f.store.beginRun('local', 'first'); f.store.updateRun('local', 'running'); await f.controls();
    f.store.updateRun('local', 'succeeded'); f.store.beginRun('local', 'second'); f.store.updateRun('local', 'running');
    f.request.mockClear(); await f.controls();
    const facts = f.request.mock.calls.find(call => call[0] === '/control/facts/batches')![2].facts;
    expect(facts.some((fact: any) => fact.payload.run?.runId === 'first' && fact.payload.run.status === 'succeeded')).toBe(true);
    expect(facts.some((fact: any) => fact.payload.run?.runId === 'second' && fact.payload.run.status === 'running')).toBe(true);
  });
  it('continues an active writer after capabilities stop admitting new writers', async () => {
    const f = fixture(); await f.controls(); f.setContext({ ...f.context, supported: false });
    f.store.beginRun('local', 'new-run'); f.request.mockClear(); await f.controls(); await f.live();
    expect(f.request.mock.calls.some(call => call[0] === '/control/facts/batches')).toBe(true);
    expect(f.request.mock.calls.some(call => call[0] === '/sync/live-projections')).toBe(true);
  });
  it('does not fence a previously legacy session when capabilities are absent', async () => {
    const f = fixture(); f.setContext({ ...f.context, supported: false }); await f.controls();
    expect(f.publisher.ownsHistory('local')).toBe(false); expect(f.request).not.toHaveBeenCalled();
  });
  it('keeps a rejected full publication terminal and schedules a new explicit desktop-only fallback', async () => {
    const f = fixture(); await f.controls();
    const ordinary = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => args[0] === '/sync/live-projections' && args[2].representation === 'complete'
      ? { publicationId: args[2].publicationId, state: 'rejected', reason: 'INVALID_REMOTE_REQUEST' } : ordinary(...args));
    await f.live(); const original = f.request.mock.calls.find(call => call[0] === '/sync/live-projections')![2];
    await f.live(); const fallback = f.request.mock.calls.filter(call => call[0] === '/sync/live-projections').at(-1)![2];
    expect(fallback.publicationId).not.toBe(original.publicationId); expect(fallback.sourceObjectRevision).toBe(original.sourceObjectRevision);
    expect(fallback.payload).toMatchObject({ contentState: 'desktop_only', blocks: [], contentUnavailableReason: 'CONTENT_UNAVAILABLE' });
  });
});


describe('explicit historical gaps', () => {
  it('seals a known bad display event as a gap while preserving old exact ACK and original bytes', async () => {
    const f = fixture();
    const original = JSON.stringify({ sourceSeq: '1',eventId: 'legacy-display',eventType: 'message.upsert',occurredAt: new Date().toISOString(),payload: { message: { invalid: true } } });
    f.db.prepare('INSERT INTO remote_outbox VALUES(?,?,?)').run('local',1,original);
    f.db.prepare("UPDATE remote_sync SET source_seq=1,ack_seq=0 WHERE local_id='local'").run();
    const normal = f.request.getMockImplementation()!; let recovery: any;
    f.request.mockImplementation(async (...args) => {
      if (args[0] === '/sync/mode-activations') return { writerGeneration: args[2].writerGeneration,state: recovery ? 'active' : f.publisher.controlReady('local') ? 'active' : 'fenced',pendingCommandIds: [],pendingCommands: [] };
      if (args[0].startsWith('/sync/state?')) return { historyGeneration: '0',historyResolvedSourceSeq: '0',streamEpoch: 'stream' };
      if (args[0] === '/sync/recoveries') { recovery = args[2]; return { state: 'preparing' }; }
      if (args[0].startsWith('/sync/recoveries/') && args[0].endsWith('/commit')) return { state: 'committed',recoveryId: recovery.recoveryId,historyGeneration: '1',resolvedSourceSeq: '1',exactSourcePrefix: '0' };
      return normal(...args);
    });
    await f.controls(); await (f.publisher as any).history(f.context);
    expect(recovery.sourceManifest).toEqual([{ sourceSeq: '1',eventId: 'legacy-display',eventType: 'message.upsert',payloadHash: expect.any(String) }]);
    const activationIds = f.request.mock.calls.filter(call => call[0] === '/sync/mode-activations').map(call => call[2].operationId);
    expect(activationIds).not.toContain(recovery.recoveryId);
    const checkpoint = f.request.mock.calls.filter(call => call[0] === '/control/bootstrap').at(-1)![2];
    expect(checkpoint.sourceManifestHash).toBeDefined(); expect(checkpoint.frozenThroughSourceSeq).toBe('1');
    expect(f.store.sync('local')).toMatchObject({ source_seq: 1,ack_seq: 0 });
    expect(f.db.prepare('SELECT event_json FROM remote_outbox').get()).toEqual({ event_json: original });
    const state = f.publisher.ledger.session(f.context.scope,'local')!;
    const historyContext = { scope: f.context.scope,localId: 'local',sessionId: state.sessionId,writerGeneration: state.writerGeneration,owner: f.owner,deviceId: 'desktop' };
    expect(f.store.history.session(historyContext)).toMatchObject({ resolvedSourceSeq: '1',historyGeneration: '1' });
    await f.live(); expect(f.request.mock.calls.some(call => call[0] === '/sync/live-projections')).toBe(true);
  });
  it('refuses protected history without actual core execution evidence while current messages continue', async () => {
    const f = fixture(); vi.spyOn(console,'warn').mockImplementation(() => {});
    f.db.prepare('INSERT INTO remote_outbox VALUES(?,?,?)').run('local',1,JSON.stringify({ sourceSeq: '1',eventId: 'missing-core',eventType: 'run.updated',payload: { run: { runId: 'unknown',status: 'running',statusVersion: '2' } } }));
    f.db.prepare("UPDATE remote_sync SET source_seq=1 WHERE local_id='local'").run();
    const normal = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      if (args[0].startsWith('/sync/state?')) return { historyGeneration: '0',historyResolvedSourceSeq: '0',streamEpoch: 'stream' };
      if (args[0] === '/sync/mode-activations' && f.publisher.controlReady('local')) return { writerGeneration: args[2].writerGeneration,state: 'active',pendingCommandIds: [],pendingCommands: [] };
      return normal(...args);
    });
    await f.controls(); await (f.publisher as any).history(f.context); await f.live();
    expect(f.request.mock.calls.some(call => call[0] === '/sync/recoveries')).toBe(false);
    expect(f.request.mock.calls.some(call => call[0] === '/sync/live-projections')).toBe(true);
    expect(f.publisher.controlReady('local')).toBe(true); expect(f.store.sync('local')!.ack_seq).toBe(0);
  });
});

describe('independent fact reconciliation invariants', () => {
  it('does not regress a newer checkpoint when an older unknown batch receipt arrives', async () => {
    const f = fixture(); await f.controls();
    const current = f.publisher.ledger.session(f.context.scope,'local')!;
    const previous = { ...current, factSeq: '10', controlRevision: '1', records: {} };
    const request = (f.publisher as any).save(f.context,previous,'old-batch','control','/control/facts/batches',{
      batchId: 'old-batch',controlEpoch: current.controlEpoch,firstFactSeq: '11',lastFactSeq: '11',coreRevision: '2',ackCoreRevision: '2',
      facts: [{ eventType: 'run.updated',eventId: 'old-event',factSeq: '11',payload: { run: { runId: 'old',status: 'running' } } }],
    },1,'/control/operations/old-batch');
    f.publisher.ledger.attempted(request);
    current.factSeq = '1000'; current.controlRevision = '500'; current.records = { latest: 'preserve' }; f.publisher.ledger.saveSession(current);
    f.request.mockResolvedValue({ state: 'committed',lastFactSeq: '11' });
    await (f.publisher as any).facts(f.context,previous);
    expect(f.publisher.ledger.session(f.context.scope,'local')).toMatchObject({ factSeq: '1000',controlRevision: '500',records: { latest: 'preserve' } });
    expect(f.publisher.ledger.request('old-batch')).toBeNull();
  });
  it('keeps distinct message tombstones and chunks a large control change without losing the remainder', async () => {
    const f = fixture(); await f.controls();
    f.store.transaction(() => {
      for (let index=0; index<20; index++) {
        const id = `deleted-${index}`;
        f.db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,?,2,?)').run(id,'local','assistant','gone','{}',index+2);
        f.db.prepare('DELETE FROM cowork_messages WHERE id=?').run(id);
      }
    });
    await f.controls(); await f.controls();
    const batches = f.request.mock.calls.filter(call => call[0] === '/control/facts/batches');
    expect(batches.length).toBe(2); expect(batches.every(call => call[2].facts.length<=16)).toBe(true);
    const ids = batches.flatMap(call => call[2].facts.filter((fact:any) => fact.eventType==='message.deleted').map((fact:any) => fact.payload.messageId));
    expect(new Set(ids).size).toBe(20);
  });
  it('publishes the authentic locally resolved approval requested by server activation', async () => {
    const f = fixture(); f.store.beginRun('local','old-run'); f.store.updateRun('local','succeeded'); f.store.beginRun('local','current-run');
    f.store.put('approval:local:approval', { approvalId: 'approval',runId: 'old-run',approvalVersion: '2',status: 'approved',operationDigest: 'digest' });
    const normal = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => args[0] === '/sync/mode-activations'
      ? { writerGeneration: args[2].writerGeneration,state:'fenced',pendingCommandIds: [],pendingRunIds:['old-run'],pendingApprovalIds:['approval'] }
      : normal(...args));
    await f.controls();
    const records = f.request.mock.calls.filter(call => /\/parts\/\d+$/u.test(call[0])).flatMap(call => call[2].records || []);
    expect(records.some((record:any) => record.payload.approval?.approvalId==='approval' && record.payload.approval?.status==='approved')).toBe(true);
    expect(records.some((record:any) => record.payload.run?.runId==='old-run' && record.payload.run?.status==='succeeded')).toBe(true);
  });
});

it('does not let accumulated acknowledged tombstones block later controls', async () => {
  const f = fixture(); await f.controls();
  for (let index=0; index<80; index++) f.store.transaction(() => {
    const id=`gone-${index}`;
    f.db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,?,2,?)').run(id,'local','assistant','gone','{}',index+2);
    f.db.prepare('DELETE FROM cowork_messages WHERE id=?').run(id);
  });
  for (let batch=0; batch<8; batch++) await f.controls();
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM remote_control_pending WHERE object_key LIKE 'message.deleted:%'").get()).toEqual({ count:0 });
  f.store.beginRun('local','after-deletes'); f.request.mockClear(); await f.controls();
  expect(f.request.mock.calls.some(call => call[0]==='/control/facts/batches' && call[2].facts.some((fact:any)=>fact.payload.run?.runId==='after-deletes'))).toBe(true);
});
it('yields an optional checkpoint as soon as a new core control appears during its network await', async () => {
  const f = fixture(); await f.controls();
  const state=f.publisher.ledger.session(f.context.scope,'local')!;
  const request=(f.publisher as any).save(f.context,state,'yield-operation','control','/control/bootstrap',{ operationId:'yield-operation' },1,null);
  f.request.mockImplementation(async () => { f.store.beginRun('local','new-control'); return { state:'uploading' }; });
  await expect((f.publisher as any).serialControl(f.context,async () => {
    (f.publisher as any).checkpointRevision={ localId:'local',revision:String((f.db.prepare("SELECT revision FROM remote_control_revisions WHERE session_id='local'").get() as any).revision) };
    await (f.publisher as any).send(f.context,request);
  })).rejects.toThrow('REMOTE_HISTORY_CHECKPOINT_YIELDED');
  expect((f.publisher as any).controlWork).toBeNull(); expect(f.publisher.ledger.request('yield-operation')?.attempted).toBe(true);
  expect((f.request.mock.calls.at(-1) as any[])[4]).toBeLessThanOrEqual(3000);
});

it('keeps current messages independent of an expired history control checkpoint budget', async () => {
  const f=fixture(); await f.controls();
  (f.publisher as any).checkpointDeadline=Date.now()-1;
  (f.publisher as any).checkpointRevision={ localId:'local',revision:'invalid' };
  await f.live();
  const call=f.request.mock.calls.find(item=>item[0]==='/sync/live-projections');
  expect(call).toBeDefined(); expect((call as any[])[4]).toBeUndefined();
});
it('reconciles a superseded saved checkpoint by aborting the original recovery before sealing a replacement', async () => {
  const f=fixture(); await f.controls();
  const state=f.publisher.ledger.session(f.context.scope,'local')!;
  const historyContext={ scope:f.context.scope,localId:'local',sessionId:state.sessionId,writerGeneration:state.writerGeneration,owner:f.owner,deviceId:'desktop' };
  f.store.history.prepare(historyContext);
  const checkpoint={ ...state,operationId:'old-checkpoint' };
  const operation=f.store.history.sealOperation({ id:'old-recovery',context:historyContext,kind:'recovery',request:{
    checkpointState:checkpoint,snapshot:{ revision:'1',hash:'',records:[] },extra:{},
    begin:{ deviceId:'desktop',owner:f.owner,sessionId:state.sessionId,localSessionId:'local',writerGeneration:state.writerGeneration,mode:'online',recoveryId:'old-recovery' },
  } });
  const begin=(f.publisher as any).save(f.context,checkpoint,'old-checkpoint:begin','control','/control/bootstrap',{
    operationId:'old-checkpoint',controlEpoch:state.controlEpoch,throughFactSeq:'1' },1,'/control/operations/old-checkpoint');
  f.publisher.ledger.attempted(begin);
  f.request.mockImplementation(async (...args) => {
    if(args[0]==='/control/bootstrap/old-checkpoint/abort')return{ state:'aborted' };
    if(args[0]==='/sync/recoveries/old-recovery/abort')return{ state:'aborted',recoveryId:'old-recovery' };
    throw new Error('unexpected request');
  });
  await (f.publisher as any).abortRecovery(f.context,operation);
  expect(f.store.history.operation(historyContext,'old-recovery')?.state).toBe('complete');
  expect(f.store.history.pending(historyContext)).toEqual([]);
  expect(f.publisher.controlReady('local')).toBe(true);
});

it('reconciles an expired initial baseline and activates a new immutable checkpoint', async () => {
  const f=fixture(); vi.spyOn(console,'warn').mockImplementation(() => {});
  const normal=f.request.getMockImplementation()!; let lose=true;
  f.request.mockImplementation(async (...args) => {
    if(lose && /\/parts\/\d+$/u.test(args[0]))throw new TypeError('lost part response');
    return normal(...args);
  });
  await f.controls(); const old=f.publisher.ledger.session(f.context.scope,'local')!.operationId;
  expect(f.publisher.controlReady('local')).toBe(false);
  lose=false; (f.publisher as any).failures.clear();
  f.request.mockImplementation(async (...args) => args[0]===`/control/operations/${old}` ? { state:'expired',operationId:old } : normal(...args));
  await f.controls(); expect(f.publisher.ledger.session(f.context.scope,'local')?.phase).toBe('activating');
  expect(f.publisher.ledger.db.prepare('SELECT 1 FROM availability_receipts WHERE operation_id=?').get(old)).toBeDefined();
  await f.controls(); expect(f.publisher.controlReady('local')).toBe(true);
  const begins=f.request.mock.calls.filter(call=>call[0]==='/control/bootstrap').map(call=>call[2].operationId);
  expect(new Set(begins).size).toBe(2);
});

describe('task and object fault boundaries', () => {
  function addTask(f: ReturnType<typeof fixture>, localId: string, messageId: string): void {
    f.store.transaction(() => {
      f.db.prepare('INSERT INTO cowork_sessions VALUES(?,?,1,1,?,NULL,NULL)').run(localId, 'Task', 'idle');
      f.store.assignNew(localId, f.owner, 'local_create');
      f.db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,?,3,2)').run(messageId, localId, 'assistant', 'Healthy reply', '{}');
    });
    f.store.bindRemote(localId, f.store.sync(localId)!.session_id, 'desktop');
  }
  it('does not let an invalid session ledger stop healthy live tasks or reactivate the legacy writer', async () => {
    const f = fixture(); addTask(f, 'second', 'second-message'); await f.controls();
    f.publisher.ledger.db.prepare("UPDATE availability_sessions SET body='{' WHERE local_id='local'").run();
    expect(f.publisher.ownsHistory('local')).toBe(true);
    expect(f.publisher.controlReady('local')).toBe(false);
    await f.live();
    expect(f.request.mock.calls.some(call => call[0] === '/sync/live-projections' && call[2].objectId === 'second-message')).toBe(true);
    expect(f.publisher.ledger.db.prepare("SELECT body FROM availability_sessions WHERE local_id='local'").get()).toEqual({ body: '{' });
  });
  it('keeps the original corrupt pending object blocked while publishing another object in the same session', async () => {
    const f = fixture(); await f.controls();
    const state = f.publisher.ledger.session(f.context.scope, 'local')!;
    f.publisher.ledger.saveRequest({ key: 'original-publication', scope: f.context.scope, localId: 'local', lane: 'live',
      body: { objectKind: 'message', objectId: 'message', publicationId: 'original-publication', writerGeneration: state.writerGeneration },
      pathname: '/sync/live-projections', method: 'POST', version: 3, lookup: null, lookupVersion: 3, createdAt: 1, attempted: true });
    f.publisher.ledger.db.prepare("UPDATE availability_requests SET body='{' WHERE key='original-publication'").run();
    f.store.transaction(() => f.db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,?,?,3,2)').run('new-message','local','assistant','New reply','{}'));
    await f.live();
    const objects = f.request.mock.calls.filter(call => call[0] === '/sync/live-projections').map(call => call[2].objectId);
    expect(objects).toContain('new-message'); expect(objects).not.toContain('message');
    expect(f.publisher.ledger.db.prepare("SELECT body FROM availability_requests WHERE key='original-publication'").get()).toEqual({ body: '{' });
  });
  it('does not retry bad encoding after a scheduler reset and probes repaired revision independently', async () => {
    const f = fixture();
    f.store.transaction(() => f.db.prepare('UPDATE cowork_messages SET metadata=? WHERE id=?').run('{','message'));
    await f.controls(); await f.live();
    const before = f.publisher.ledger.db.prepare("SELECT attempts FROM availability_faults WHERE object_key='message:message'").get();
    expect(before).toEqual({ attempts: 1 });
    (f.publisher as any).failures.clear(); (f.publisher as any).liveScan.clear();
    await f.live(); expect(f.publisher.ledger.db.prepare("SELECT attempts FROM availability_faults WHERE object_key='message:message'").get()).toEqual(before);
    f.store.transaction(() => f.db.prepare('UPDATE cowork_messages SET metadata=? WHERE id=?').run('{}','message'));
    await f.live();
    expect(f.request.mock.calls.some(call => call[0] === '/sync/live-projections' && call[2].objectId === 'message')).toBe(true);
    expect(f.publisher.ledger.db.prepare("SELECT 1 FROM availability_faults WHERE object_key='message:message'").get()).toBeUndefined();
  });
  it('keeps control and live publishing safe when the diagnostic sink throws', async () => {
    const f = fixture(); vi.spyOn(console,'debug').mockImplementation(() => { throw new Error('logger unavailable'); });
    vi.spyOn(console,'warn').mockImplementation(() => { throw new Error('logger unavailable'); });
    await f.controls(); await f.live();
    expect(f.publisher.controlReady('local')).toBe(true);
    expect(f.publisher.ledger.pending(f.context.scope,'live','local')).toEqual([]);
  });
});
