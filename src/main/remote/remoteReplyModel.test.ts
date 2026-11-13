import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { OpenClawCronRunMetadataKey } from '../../shared/cowork/openclawCronSessionKey';
import { ModelPresetId } from '../../shared/modelPresets/constants';
import { setLanguage } from '../i18n';
import { projectLiveMessage } from './remoteLiveProjection';
import { replyInputModel, ReplyModelMetadataBytes, replyModelPresetNames } from './remoteReplyModel';
import { RemoteStore } from './remoteStore';

const owner = { userId: 'A', scopeKey: 'personal' };
const selected = { modelRef: 'preset-ref', version: '3', source: 'subscription',
  displayName: '快速', providerLabel: 'LobsterAI', thinkingLevel: null };
const databases: Database.Database[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); setLanguage('zh'); });

function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,model_override TEXT,thinking_level TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db); store.setEnabledOwner(owner); store.setInputProjectionSupported(true); store.setReplyProjectionSupported(true);
  store.transaction(() => {
    db.exec("INSERT INTO cowork_sessions VALUES('s','Task',1,1,'idle','provider/new-model','low')");
    store.assignNew('s', owner, 'local_create');
  });
  db.prepare("UPDATE remote_sync SET device_id='pc' WHERE local_id='s'").run();
  store.setInputModel('s', { ...selected, displayName: '旗舰', modelRef: 'new-selection' });
  store.put('desktopInputRun:run', { owner, text: 'Question', attachments: [], inputModel: selected });
  return { db, store };
}

function add(store: RemoteStore, metadata: Record<string, unknown>, id = 'm') {
  store.transaction(() => store.db.prepare("INSERT INTO cowork_messages VALUES(?,'s','assistant','Reply',?,2,?)")
    .run(id, JSON.stringify({ remoteRunId: 'run', ...metadata }), id === 'm' ? 1 : 2));
}
function message(store: RemoteStore, id = 'm') {
  return store.snapshot('s').records.find(record => record.eventType === 'message.upsert' && record.payload.message.messageId === id)!.payload.message;
}
function live(store: RemoteStore, id = 'm', names = replyModelPresetNames(), replyModelLabelSupported = false) {
  const revision = store.db.prepare("SELECT revision FROM remote_live_revisions WHERE session_id='s' AND object_id=?").get(id) as { revision: number };
  return projectLiveMessage(store.db, { database: '', localId: 's', sessionId: store.sync('s')!.session_id,
    deviceId: 'pc', owner, replyModelLabelSupported, objectId: id, revision: String(revision.revision), modelPresetNames: names })!;
}

it.each([
  [{ model: 'lobsterai-server/deepseek-flash' }, 'deepseek-flash'],
  [{ modelPresetId: ModelPresetId.Balanced, resolvedModelId: 'deepseek-flash' }, '快速（deepseek-flash）'],
  [{ modelPresetId: ModelPresetId.Ultimate, resolvedModelId: 'glm-5.3-YoudaoInner' }, '旗舰（glm-5.3）'],
])('uses the desktop message label in legacy and live projections: %j', (metadata, label) => {
  const { store } = fixture(); add(store, metadata);
  expect(message(store).inputModel).toEqual({ ...selected, displayName: label });
  expect(live(store).payload.inputModel).toEqual(message(store).inputModel);
  expect(store.get('desktopInputRun:run')).toMatchObject({ inputModel: selected });
  expect(store.get('inputModel:s')).toMatchObject({ modelRef: 'new-selection', displayName: '旗舰' });
});

it('preserves each old reply model after the current session selection changes', () => {
  const { store } = fixture();
  add(store, { model: 'provider/first-model' });
  add(store, { model: 'provider/second-model' }, 'm2');
  expect(message(store).inputModel.displayName).toBe('first-model');
  expect(message(store, 'm2').inputModel.displayName).toBe('second-model');
  expect(live(store).payload.inputModel.displayName).toBe('first-model');
});

it('uses a higher full message revision when the actual model arrives during streaming', () => {
  const { store } = fixture(); add(store, { model: 'yd-fast', isStreaming: true });
  const before = message(store);
  expect(before.inputModel.displayName).toBe('快速');
  const sealed = store.pending('s');
  store.transaction(() => store.db.prepare("UPDATE cowork_messages SET content='Reply appended',metadata=? WHERE id='m'")
    .run(JSON.stringify({ remoteRunId: 'run', model: 'provider/deepseek-flash', isStreaming: true })));
  const after = message(store);
  expect(after.inputModel.displayName).toBe('deepseek-flash');
  expect(BigInt(after.revision)).toBeGreaterThan(BigInt(before.revision));
  expect(store.pending('s').slice(0, sealed.length)).toEqual(sealed);
  expect(store.pending('s').slice(sealed.length).some(event =>
    event.eventType === 'message.upsert' && event.payload.message.inputModel.displayName === 'deepseek-flash')).toBe(true);
});

it('supports frozen mobile input and keeps legacy v1 free of model metadata', () => {
  const { store } = fixture(); store.remove('desktopInputRun:run');
  store.put('inputRun:run', { input: { text: 'Question', attachments: [] }, inputModel: selected });
  add(store, { model: 'provider/deepseek-flash' });
  expect(live(store).payload.inputModel.displayName).toBe('deepseek-flash');
  store.setInputProjectionSupported(false);
  expect(message(store)).not.toHaveProperty('inputModel');
});

it('does not infer a historical selection from the current session or foreign run', () => {
  const { store } = fixture();
  store.put('desktopInputRun:run', { owner: { userId: 'B', scopeKey: 'personal' }, inputModel: { ...selected, displayName: 'Private' }, attachments: [] });
  add(store, { model: 'provider/deepseek-flash' });
  expect(message(store)).not.toHaveProperty('inputModel');
  expect(live(store).payload).not.toHaveProperty('inputModel');
  store.put('desktopInputRun:run', { owner, inputModel: selected, attachments: [] });
  store.put('syncTargetHistory:s', { runIds: ['run'] });
  expect(message(store)).not.toHaveProperty('inputModel');
  expect(live(store).payload).not.toHaveProperty('inputModel');
});

it('keeps unresolved, unsafe and non-conversation metadata from changing the label', () => {
  for (const model of ['yd-fast', 'lobsterai-server/yd-ultra', 'https://provider.invalid/sk-secret', 'sk-SecretKey', 'localhost/private', 'host/secret\nvalue']) {
    expect(replyInputModel('assistant', { model }, selected)).toBe(selected);
  }
  expect(replyInputModel('assistant', { model: 'actual' }, null)).toBeNull();
  expect(replyInputModel('tool_result', { model: 'actual' }, selected)).toBe(selected);
  const custom = { ...selected, source: 'custom', providerLabel: '50刀' };
  expect(replyInputModel('assistant', { model: 'custom_0/real-model' }, custom)).toEqual({ ...custom, displayName: 'real-model' });
});

it('uses the captured desktop language for worker-generated model labels', () => {
  const { store } = fixture(); add(store, { modelPresetId: ModelPresetId.Balanced, resolvedModelId: 'deepseek-flash' });
  setLanguage('en'); const names = replyModelPresetNames(); setLanguage('zh');
  expect(live(store, 'm', names).payload.inputModel.displayName).toBe('Fast（deepseek-flash）');
});

it('bounds a long model label without emitting a lone UTF-16 surrogate', () => {
  const projected = replyInputModel('assistant', { model: `${'a'.repeat(119)}😀` }, selected) as typeof selected;
  expect(projected.displayName).toBe('a'.repeat(119));
  expect(Buffer.byteLength(projected.displayName)).toBeLessThanOrEqual(480);
});

it.each([
  [ModelPresetId.Balanced, '快速'], [ModelPresetId.Ultimate, '旗舰'],
])('uses the frozen mobile tier in both sync paths: %s', (modelPresetId, name) => {
  const { store } = fixture();
  store.remove('desktopInputRun:run');
  store.put('inputRun:run', { input: { text: 'Question', attachments: [] }, inputModel: selected, modelPresetId });
  add(store, { model: 'provider/deepseek-flash-YoudaoInner' });
  const expected = `${name}（deepseek-flash）`;
  expect(message(store).inputModel.displayName).toBe(expected);
  expect(live(store).payload.inputModel.displayName).toBe(expected);
  expect(live(store).resolvedModelLabel).toBe(expected);
  expect(store.get('inputRun:run')).toMatchObject({ inputModel: selected, modelPresetId });
  // A different run's selection must not relabel earlier replies.
  store.put('inputRun:later', { inputModel: selected, modelPresetId: ModelPresetId.Ultimate });
  expect(message(store).inputModel.displayName).toBe(expected);
});

it('keeps explicit reply metadata ahead of the frozen mobile tier', () => {
  expect(replyInputModel('assistant', { modelPresetId: ModelPresetId.Ultimate, model: 'provider/actual' },
    selected, undefined, ModelPresetId.Balanced)).toMatchObject({ displayName: '旗舰（actual）' });
  expect(replyInputModel('assistant', { model: 'provider/yd-ultra', resolvedModelId: 'provider/actual' },
    selected, undefined, ModelPresetId.Balanced)).toMatchObject({ displayName: '旗舰（actual）' });
  expect(replyInputModel('assistant', { model: 'provider/actual' }, selected, undefined, 'unknown'))
    .toMatchObject({ displayName: 'actual' });
  expect(replyInputModel('assistant', { model: 'yd-fast' }, selected, undefined, ModelPresetId.Balanced)).toBe(selected);
  expect(replyInputModel('assistant', { model: 'provider/actual' }, selected,
    { balanced: 'Fast', ultimate: 'Flagship' }, ModelPresetId.Balanced)).toMatchObject({ displayName: 'Fast（actual）' });
});

it('keeps the frozen tier when streaming reveals the concrete model', () => {
  const { store } = fixture();
  store.remove('desktopInputRun:run');
  store.put('inputRun:run', { input: { text: 'Question', attachments: [] }, inputModel: selected,
    modelPresetId: ModelPresetId.Balanced });
  add(store, { model: 'yd-fast', isStreaming: true });
  const before = message(store);
  expect(before.inputModel.displayName).toBe('快速');
  store.transaction(() => store.db.prepare("UPDATE cowork_messages SET metadata=? WHERE id='m'")
    .run(JSON.stringify({ remoteRunId: 'run', model: 'provider/deepseek-flash', isStreaming: false })));
  const after = message(store);
  expect(after.inputModel.displayName).toBe('快速（deepseek-flash）');
  expect(BigInt(after.revision)).toBeGreaterThan(BigInt(before.revision));
  expect(live(store).payload.inputModel.displayName).toBe(after.inputModel.displayName);
  store.put('syncTargetHistory:s', { runIds: ['run'] });
  expect(message(store)).not.toHaveProperty('inputModel');
  expect(live(store).payload).not.toHaveProperty('inputModel');
});

it('does not infer a tier from rejected model metadata', () => {
  for (const model of ['https://private.invalid/yd-fast', 'localhost/yd-ultra', 'host/secret\n/yd-fast']) {
    expect(replyInputModel('assistant', { model, resolvedModelId: 'provider/actual' }, selected))
      .toMatchObject({ displayName: 'actual' });
  }
});


function nativeFixture() {
  const f = fixture(); f.store.remove('desktopInputRun:run'); f.store.setReplyModelLabelSupported(true);
  return f;
}
const cronMetadata = (index: number, key = 'agent:main:cron:job:run:execution') => ({
  [OpenClawCronRunMetadataKey.SessionKey]: key, [OpenClawCronRunMetadataKey.EntryIndex]: index,
});
function priorUser(store: RemoteStore, metadata: Record<string, unknown>) {
  store.transaction(() => store.db.prepare("INSERT INTO cowork_messages VALUES('u','s','user','Question',?,1,0)").run(JSON.stringify(metadata)));
}
function modelLabel(store: RemoteStore, id = 'm') {
  const historical = message(store, id), realtime = live(store, id, replyModelPresetNames(), true);
  expect(realtime.payload.modelLabel).toBe(historical.modelLabel);
  if (historical.modelLabel) expect(realtime.resolvedModelLabel).toBe(historical.modelLabel);
  return historical.modelLabel;
}

it('publishes display-only actual model evidence for native runs without inventing an input selection', () => {
  const { store } = nativeFixture();
  add(store, { remoteRunId: undefined, model: 'lobsterai-server/deepseek-flash-YoudaoInner', modelPresetId: ModelPresetId.Balanced });
  expect(modelLabel(store)).toBe('快速（deepseek-flash）');
  expect(message(store)).not.toHaveProperty('inputModel'); expect(live(store, 'm', replyModelPresetNames(), true).payload).not.toHaveProperty('inputModel');
  expect(store.get('inputModel:s')).toMatchObject({ modelRef: 'new-selection' });
  expect(store.get('desktopInputRun:run')).toBeNull();
});

it('keeps the new field absent for peers without the capability while preserving the original input model', () => {
  const { store } = fixture(); add(store, { model: 'actual' });
  expect(message(store)).not.toHaveProperty('modelLabel'); expect(live(store).payload).not.toHaveProperty('modelLabel');
  const original = message(store).inputModel;
  store.setReplyModelLabelSupported(true);
  expect(modelLabel(store)).toBe('actual'); expect(message(store).inputModel).toEqual(original);
  store.setReplyModelLabelSupported(false);
  expect(message(store)).not.toHaveProperty('modelLabel'); expect(message(store).inputModel).toEqual(original);
});

it.each(['run', 'cron'])('borrows only the preceding user tier proved to belong to the same %s', kind => {
  const { store } = nativeFixture();
  priorUser(store, { modelPresetId: ModelPresetId.Balanced, ...(kind === 'run' ? { remoteRunId: 'run' } : cronMetadata(0)) });
  add(store, { model: 'deepseek-flash', ...(kind === 'cron' ? { remoteRunId: undefined, ...cronMetadata(1) } : {}) });
  expect(modelLabel(store)).toBe('快速（deepseek-flash）');
});

it.each(['unknown', 'other-run', 'other-cron', 'reversed-cron', 'foreign-user'])('does not borrow a tier across %s provenance', reason => {
  const { store } = nativeFixture();
  priorUser(store, { modelPresetId: ModelPresetId.Ultimate, ...cronMetadata(reason === 'reversed-cron' ? 2 : 0),
    ...(reason === 'other-run' || reason === 'foreign-user' ? { remoteRunId: 'other-run' } : {}) });
  if (reason === 'foreign-user') store.put('syncTargetHistory:s', { runIds: ['other-run'] });
  add(store, { model: 'deepseek-flash', ...(reason === 'unknown' ? { remoteRunId: undefined }
    : { ...cronMetadata(1, reason === 'other-cron' ? 'agent:main:cron:job:run:other' : undefined) }) });
  expect(modelLabel(store)).toBe('deepseek-flash');
});

it('uses the nearest user only and does not borrow a matching tier from an earlier turn', () => {
  const { store } = nativeFixture(); priorUser(store, { modelPresetId: ModelPresetId.Ultimate, remoteRunId: 'run' });
  store.transaction(() => store.db.prepare("INSERT INTO cowork_messages VALUES('u2','s','user','New question',?,2,1)").run(JSON.stringify({ remoteRunId: 'other' })));
  add(store, { model: 'deepseek-flash' }, 'm2');
  expect(modelLabel(store, 'm2')).toBe('deepseek-flash');
});

it('does not use a user resolved model to fill missing actual assistant execution evidence', () => {
  const { store } = nativeFixture(); priorUser(store, { modelPresetId: ModelPresetId.Balanced, resolvedModelId: 'actual', remoteRunId: 'run' });
  add(store, { model: 'yd-fast' });
  expect(modelLabel(store)).toBeUndefined();
});

it.each(['https://internal.example/private', 'localhost/private', '10.0.0.2/private', 'provider/sk-secret',
  'provider/Bearer key', 'provider/api_key=private', 'provider/token:private', 'provider/password=private',
  'provider/secret=private', 'provider/model\u202eunsafe', 'provider/model\u0000unsafe', 'provider/\ud800broken'])('omits unsafe display-only models: %j', model => {
  const { store } = nativeFixture(); add(store, { model });
  expect(modelLabel(store)).toBeUndefined();
});

it('does not send model labels for user/tool rows or foreign and cross-account run metadata', () => {
  const { store } = nativeFixture(); priorUser(store, { model: 'private', remoteRunId: 'run' });
  add(store, { model: 'actual' });
  expect(message(store, 'u')).not.toHaveProperty('modelLabel');
  store.put('desktopInputRun:run', { owner: { userId: 'other', scopeKey: 'personal' }, inputModel: selected, attachments: [] });
  expect(modelLabel(store)).toBeUndefined(); store.remove('desktopInputRun:run');
  store.put('syncTargetHistory:s', { runIds: ['run'] }); expect(modelLabel(store)).toBeUndefined();
});

it('does not label a legacy command whose original target cannot be verified', () => {
  const { store } = nativeFixture();
  store.put('syncTargetHistory:s', { targetId: 'current', runIds: [] });
  add(store, { remoteRunId: undefined, remoteCommandId: 'legacy', model: 'actual' });
  expect(modelLabel(store)).toBeUndefined();
});

it('preserves explicit reply and frozen run tiers ahead of user tier metadata', () => {
  const { store } = nativeFixture(); priorUser(store, { remoteRunId: 'run', modelPresetId: ModelPresetId.Ultimate });
  store.put('inputRun:run', { input: { text: 'Question', attachments: [] }, modelPresetId: ModelPresetId.Balanced });
  add(store, { model: 'actual' }); expect(modelLabel(store)).toBe('快速（actual）');
  add(store, { model: 'actual', modelPresetId: ModelPresetId.Ultimate }, 'm2'); expect(modelLabel(store, 'm2')).toBe('旗舰（actual）');
});

it('emits a new history revision after a capability upgrade without changing sealed events', () => {
  const { store } = fixture(); store.remove('desktopInputRun:run'); add(store, { model: 'actual' });
  const original = message(store), sealed = store.pending('s');
  store.setReplyModelLabelSupported(true);
  const upgraded = message(store);
  expect(upgraded.modelLabel).toBe('actual'); expect(BigInt(upgraded.revision)).toBeGreaterThan(BigInt(original.revision));
  expect(store.pending('s').slice(0, sealed.length)).toEqual(sealed);
});

it('relabels live and historical replies when the verified native tier arrives after publication', () => {
  const { store, db } = nativeFixture(); priorUser(store, { ...cronMetadata(0) });
  add(store, { remoteRunId: undefined, ...cronMetadata(1), model: 'deepseek-flash' });
  const before = live(store, 'm', replyModelPresetNames(), true); expect(before.payload.modelLabel).toBe('deepseek-flash');
  store.transaction(() => db.prepare("UPDATE cowork_messages SET metadata=? WHERE id='u'").run(JSON.stringify({ ...cronMetadata(0), modelPresetId: ModelPresetId.Balanced })));
  expect(modelLabel(store)).toBe('快速（deepseek-flash）');
  expect(BigInt(live(store, 'm', replyModelPresetNames(), true).sourceObjectRevision)).toBeGreaterThan(BigInt(before.sourceObjectRevision));
});


it('bounds user metadata before parsing and revises dependent labels when it crosses that limit', () => {
  const { store, db } = nativeFixture(); priorUser(store, { remoteRunId: 'run' });
  add(store, { model: 'actual' });
  const base = { remoteRunId: 'run', modelPresetId: ModelPresetId.Balanced, unused: '' };
  const raw = JSON.stringify({ ...base, unused: 'x'.repeat(ReplyModelMetadataBytes - Buffer.byteLength(JSON.stringify(base))) });
  expect(Buffer.byteLength(raw)).toBe(ReplyModelMetadataBytes);
  const update = (metadata: string) => store.transaction(() => db.prepare("UPDATE cowork_messages SET metadata=? WHERE id='u'").run(metadata));
  update(raw); expect(modelLabel(store)).toBe('快速（actual）');
  const before = live(store, 'm', replyModelPresetNames(), true).sourceObjectRevision;
  update(raw.replace('"unused":"', '"unused":"x'));
  expect(modelLabel(store)).toBe('actual');
  const after = live(store, 'm', replyModelPresetNames(), true).sourceObjectRevision;
  expect(BigInt(after)).toBeGreaterThan(BigInt(before));
  update(raw.replace('"unused":"', '"unused":"xx'));
  expect(live(store, 'm', replyModelPresetNames(), true).sourceObjectRevision).toBe(after);
});
