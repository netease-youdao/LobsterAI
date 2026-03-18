import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { IMStore } = require('../dist-electron/main/im/imStore.js');

class FakeDb {
  constructor() {
    this.imConfig = new Map();
  }

  run(sql, params = []) {
    if (sql.includes('INSERT INTO im_config')) {
      this.imConfig.set(String(params[0]), String(params[1]));
      return;
    }

    if (sql.includes('INSERT OR REPLACE INTO im_config')) {
      this.imConfig.set(String(params[0]), String(params[1]));
      return;
    }

    if (sql.includes('DELETE FROM im_config WHERE key = ?')) {
      this.imConfig.delete(String(params[0]));
      return;
    }

    if (sql.includes('DELETE FROM im_config')) {
      this.imConfig.clear();
    }
  }

  exec(sql, params = []) {
    if (sql.includes('SELECT value FROM im_config WHERE key = ?')) {
      const value = this.imConfig.get(String(params[0]));
      return value === undefined ? [] : [{ values: [[value]] }];
    }
    return [];
  }
}

test('IMStore persists conversation reply routes by platform and conversation ID', () => {
  const db = new FakeDb();
  let saveCount = 0;
  const store = new IMStore(db, () => {
    saveCount += 1;
  });

  assert.equal(store.getConversationReplyRoute('dingtalk', '__default__:conv-1'), null);

  store.setConversationReplyRoute('dingtalk', '__default__:conv-1', {
    channel: 'dingtalk-connector',
    to: 'group:cid-42',
    accountId: '__default__',
  });

  assert.deepEqual(store.getConversationReplyRoute('dingtalk', '__default__:conv-1'), {
    channel: 'dingtalk-connector',
    to: 'group:cid-42',
    accountId: '__default__',
  });
  assert.equal(store.getConversationReplyRoute('telegram', '__default__:conv-1'), null);
  assert.ok(saveCount >= 2);
});
