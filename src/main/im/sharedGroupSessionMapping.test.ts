import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { RetainedImPlatform as Im } from '../../shared/dshEngine/hostConstants';
import { IMStore } from './imStore';
import type { Platform } from './types';

let db: Database.Database;
let store: IMStore;
const room = 'cidRoom';
const group = 'group:' + room;
const title = '[钉钉] ' + group;
const find = () => store.findSharedGroupMapping(Im.DingTalk, group, room, 'main', title);

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY, agent_id TEXT, title TEXT)');
  store = new IMStore(db);
});
afterEach(() => db.close());

function add(task: string, bot: string, peer: string, sessionTitle: string, agent = 'main', legacyKey?: string) {
  db.prepare('INSERT INTO cowork_sessions VALUES (?, ?, ?)').run(task, agent, sessionTitle);
  store.createSessionMapping(peer, bot as Platform, task, agent, legacyKey);
}

test('adopts the latest identifiable split DSH group, then reuses its typed route after a restart or rename', () => {
  add('first', 'dingtalk:a', room, title);
  add('second', 'dingtalk:b', room, title);
  db.prepare('UPDATE im_session_mappings SET last_active_at = 1 WHERE cowork_session_id = ?').run('first');
  expect(find()?.coworkSessionId).toBe('second');
  store.recordGroupSessionRoute(group, 'dingtalk:a' as Platform, 'second', 'main');
  store.recordGroupSessionRoute(group, 'dingtalk:b' as Platform, 'second', 'main');
  store.recordGroupSessionRoute(group, 'dingtalk:b' as Platform, 'second', 'main');
  db.prepare('UPDATE cowork_sessions SET title = ? WHERE id = ?').run('Project room', 'second');
  store = new IMStore(db);
  expect(find()?.coworkSessionId).toBe('second');
  expect(store.getSessionMapping(room, 'dingtalk:a' as Platform, 'main')?.coworkSessionId).toBe('first');
  expect(store.getSessionMappingByCoworkSessionId('second')?.platform).toBe('dingtalk:b');
});

test('recovers the original lowercased OpenClaw group ahead of a split DSH task', () => {
  add('original', Im.DingTalk, group.toLowerCase(), 'Custom title', 'main', 'agent:main:dingtalk-connector:group:cidroom');
  add('split', 'dingtalk:a', room, title);
  expect(find()?.coworkSessionId).toBe('original');
});

test('QQ unifies confirmed peers across bots and keeps the native mapping for each account', () => {
  const a = 'qq:a' as Platform, b = 'qq:b' as Platform;
  const first = 'group:NativeA', second = 'group:NativeB';
  add('original', a, first, 'Renamed chat');
  add('split', b, second, 'Old split task');
  expect(store.resolveQQGroupPeer(a, first)).toBe(first);
  expect(store.resolveQQGroupPeer(a, first, 'Union')).toBe(first);
  expect(store.resolveQQGroupPeer(b, second, 'Union')).toBe(first);
  const lookup = (agent: string) => store.findSharedGroupMapping(Im.QQ, second, 'NativeB', agent, '', b);
  expect(lookup('main')?.coworkSessionId).toBe('original');
  expect(lookup('expert')).toBeNull();
  store.recordGroupSessionRoute(second, b, 'original', 'main');
  store = new IMStore(db);
  expect(store.resolveQQGroupPeer(b, second)).toBe(first);
  expect(store.getSessionMapping(second, b, 'main')?.coworkSessionId).toBe('original');
  expect(store.getSessionMapping(first, b, 'main')).toBeNull();
  expect(store.resolveQQGroupPeer(b, 'group:third', 'union')).toBe('group:third');
  store.deleteQQInstance('a');
  expect(store.resolveQQGroupPeer(b, second)).toBe(second);
  expect(lookup('main')?.coworkSessionId).toBe('original');
});

test('excludes private chats, topics, other platforms, agents, groups and differently cased DSH peers', () => {
  add('dm', 'dingtalk:a', room, '[钉钉] Alice');
  add('other-agent', 'dingtalk:a', group, title, 'expert');
  add('other-platform', 'wecom:a', group, title);
  add('other-room', 'dingtalk:b', 'group:other', title);
  add('topic', 'dingtalk:c', group + ':thread:x', title);
  add('case', 'dingtalk:d', group.toLowerCase(), title);
  store.createSessionMapping(group, 'dingtalk:deleted' as Platform, 'deleted', 'main');
  expect(find()).toBeNull();
});

test('QQ gives distinct union IDs priority over coincident app-scoped delivery addresses', () => {
  const a = 'qq:a' as Platform, b = 'qq:b' as Platform;
  const peer = 'group:SameNativePeer', label = '[QQ] group:SameNativePeer';
  const firstQueue = store.resolveQQGroupPeer(a, peer, 'UnionA');
  add('group-a', a, peer, label);
  const secondQueue = store.resolveQQGroupPeer(b, peer, 'UnionB');
  expect(secondQueue).not.toBe(firstQueue);
  expect(store.resolveQQGroupPeer(a, peer)).toBe(firstQueue);
  expect(store.findSharedGroupMapping(Im.QQ, peer, 'SameNativePeer', 'main', label, b)).toBeNull();
  add('group-b', b, 'SameNativePeer', label);
  expect(store.findSharedGroupMapping(Im.QQ, peer, 'SameNativePeer', 'main', label, b)?.coworkSessionId).toBe('group-b');
  store.recordGroupSessionRoute(peer, b, 'group-a', 'main');
  expect(store.canReuseQQGroupSession(a, peer, 'group-a')).toBe(true);
  expect(store.canReuseQQGroupSession(b, peer, 'group-a')).toBe(false);
});

test('does not adopt an untyped group from a DingTalk bot using a custom session scope', () => {
  add('custom', 'dingtalk:scoped', room, title);
  db.prepare('INSERT INTO im_config VALUES (?, ?, ?)').run('dingtalk:scoped', JSON.stringify({ groupSessionScope: 'group_sender' }), 1);
  expect(find()).toBeNull();
});
