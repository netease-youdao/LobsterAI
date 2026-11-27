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

test('does not adopt an untyped group from a DingTalk bot using a custom session scope', () => {
  add('custom', 'dingtalk:scoped', room, title);
  db.prepare('INSERT INTO im_config VALUES (?, ?, ?)').run('dingtalk:scoped', JSON.stringify({ groupSessionScope: 'group_sender' }), 1);
  expect(find()).toBeNull();
});
