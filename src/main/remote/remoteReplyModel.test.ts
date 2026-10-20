import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { ModelPresetId } from '../../shared/modelPresets/constants';
import { setLanguage } from '../i18n';
import { projectLiveMessage } from './remoteLiveProjection';
import { replyInputModel, replyModelPresetNames } from './remoteReplyModel';
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
function live(store: RemoteStore, id = 'm', names = replyModelPresetNames()) {
  const revision = store.db.prepare("SELECT revision FROM remote_live_revisions WHERE session_id='s' AND object_id=?").get(id) as { revision: number };
  return projectLiveMessage(store.db, { database: '', localId: 's', sessionId: store.sync('s')!.session_id,
    deviceId: 'pc', owner, objectId: id, revision: String(revision.revision), modelPresetNames: names })!;
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
