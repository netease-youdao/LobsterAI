import { test, expect } from 'vitest';
import { IMStore } from './imStore';

class FakeDb {
  private store: Map<string, string> = new Map();
  writeCount = 0;

  pragma(_name: string) {
    // Report agent_id as already present to skip the ALTER TABLE migration
    return [{ name: 'agent_id' }];
  }

  prepare(sql: string) {
    const self = this;
    return {
      run(...params: unknown[]) {
        if (sql.includes('INSERT') && sql.includes('im_config')) {
          self.store.set(String(params[0]), String(params[1]));
          self.writeCount++;
          return;
        }
        if (sql.includes('UPDATE im_config')) {
          // UPDATE im_config SET value = ?, updated_at = ? WHERE key = ?
          self.store.set(String(params[2]), String(params[0]));
          self.writeCount++;
          return;
        }
        if (sql.includes('DELETE FROM im_config WHERE key = ?')) {
          self.store.delete(String(params[0]));
          self.writeCount++;
          return;
        }
        // CREATE TABLE, ALTER TABLE, etc: count as write
        self.writeCount++;
      },
      get(...params: unknown[]) {
        if (sql.includes('SELECT value FROM im_config WHERE key = ?')) {
          const value = self.store.get(String(params[0]));
          return value !== undefined ? { value } : undefined;
        }
        return undefined;
      },
      all(..._params: unknown[]) {
        return [];
      },
    };
  }
}

test('IMStore persists conversation reply routes by platform and conversation ID', () => {
  const db = new FakeDb();
  const store = new IMStore(db as unknown as ConstructorParameters<typeof IMStore>[0]);

  expect(store.getConversationReplyRoute('dingtalk', '__default__:conv-1')).toBe(null);

  store.setConversationReplyRoute('dingtalk', '__default__:conv-1', {
    channel: 'dingtalk-connector',
    to: 'group:cid-42',
    accountId: '__default__',
  });

  expect(store.getConversationReplyRoute('dingtalk', '__default__:conv-1')).toEqual({
    channel: 'dingtalk-connector',
    to: 'group:cid-42',
    accountId: '__default__',
  });
  expect(store.getConversationReplyRoute('telegram', '__default__:conv-1')).toBe(null);
  expect(db.writeCount >= 2).toBeTruthy();
});
