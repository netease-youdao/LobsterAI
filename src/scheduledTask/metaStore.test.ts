import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { ScheduledTaskMetaStore } from './metaStore';
import { OriginKind, BindingKind } from './constants';

function createMetaStore() {
  const db = new Database(':memory:');
  return new ScheduledTaskMetaStore(db);
}

test('metaStore: ensureTable is idempotent (no error on double init)', () => {
  const db = new Database(':memory:');
  const store1 = new ScheduledTaskMetaStore(db);
  const store2 = new ScheduledTaskMetaStore(db);
  store1.set('t1', { kind: OriginKind.Manual }, { kind: BindingKind.NewSession });
  expect(store2.get('t1')).toBeTruthy();
});

test('metaStore: set + get roundtrip preserves origin and binding', () => {
  const store = createMetaStore();
  const origin = { kind: OriginKind.IM, platform: 'telegram', conversationId: 'chat-123' };
  const binding = { kind: BindingKind.IMSession, platform: 'telegram', conversationId: 'chat-123', sessionId: 'sess-1' };

  store.set('task-1', origin, binding);
  const meta = store.get('task-1');

  expect(meta).toBeTruthy();
  expect(meta!.taskId).toBe('task-1');
  expect(JSON.parse(meta!.origin)).toEqual(origin);
  expect(JSON.parse(meta!.binding)).toEqual(binding);
});

test('metaStore: set overwrites existing record (upsert)', () => {
  const store = createMetaStore();
  store.set('task-1', { kind: OriginKind.Manual }, { kind: BindingKind.NewSession });
  store.set('task-1', { kind: OriginKind.Legacy }, { kind: BindingKind.NewSession });

  const meta = store.get('task-1');
  expect(meta).toBeTruthy();
  expect(JSON.parse(meta!.origin)).toEqual({ kind: OriginKind.Legacy });
});

test('metaStore: get nonexistent returns null', () => {
  const store = createMetaStore();
  expect(store.get('nonexistent')).toBe(null);
});

test('metaStore: delete then get returns null', () => {
  const store = createMetaStore();
  store.set('task-1', { kind: OriginKind.Manual }, { kind: BindingKind.NewSession });
  store.delete('task-1');
  expect(store.get('task-1')).toBe(null);
});

test('metaStore: delete nonexistent does not throw', () => {
  const store = createMetaStore();
  expect(() => store.delete('nonexistent')).not.toThrow();
});

test('metaStore: list returns all records', () => {
  const store = createMetaStore();
  store.set('task-1', { kind: OriginKind.Manual }, { kind: BindingKind.NewSession });
  store.set('task-2', { kind: OriginKind.Legacy }, { kind: BindingKind.NewSession });
  const all = store.list();
  expect(all.length).toBe(2);
  const ids = all.map((m: any) => m.taskId).sort();
  expect(ids).toEqual(['task-1', 'task-2']);
});

test('metaStore: list on empty table returns empty array', () => {
  const store = createMetaStore();
  expect(store.list()).toEqual([]);
});

test('metaStore: origin/binding with special characters survives JSON roundtrip', () => {
  const store = createMetaStore();
  const origin = { kind: OriginKind.IM, platform: 'dingtalk', conversationId: 'acct:user:"peer&1"' };
  const binding = { kind: BindingKind.IMSession, platform: 'dingtalk', conversationId: 'acct:user:"peer&1"' };

  store.set('task-special', origin, binding);
  const meta = store.get('task-special');
  expect(meta).toBeTruthy();
  expect(JSON.parse(meta!.origin)).toEqual(origin);
  expect(JSON.parse(meta!.binding)).toEqual(binding);
});
