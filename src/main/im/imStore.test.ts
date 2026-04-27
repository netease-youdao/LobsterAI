import { expect,test } from 'vitest';

import { IMStore } from './imStore';

class FakeDb {
  private store: Map<string, string> = new Map();
  private deletedPlatforms: string[] = [];
  writeCount = 0;

  pragma(_name: string) {
    // Report agent_id as already present to skip the ALTER TABLE migration
    return [{ name: 'agent_id' }];
  }

  prepare(sql: string) {
    return {
      run: (...params: unknown[]) => {
        if (sql.includes('INSERT') && sql.includes('im_config')) {
          this.store.set(String(params[0]), String(params[1]));
          this.writeCount++;
          return;
        }
        if (sql.includes('UPDATE im_config')) {
          // UPDATE im_config SET value = ?, updated_at = ? WHERE key = ?
          this.store.set(String(params[2]), String(params[0]));
          this.writeCount++;
          return;
        }
        if (sql.includes('DELETE FROM im_config WHERE key = ?')) {
          this.store.delete(String(params[0]));
          this.writeCount++;
          return;
        }
        // CREATE TABLE, ALTER TABLE, etc: count as write
        this.writeCount++;
      },
      get: (...params: unknown[]) => {
        if (sql.includes('SELECT value FROM im_config WHERE key = ?')) {
          const value = this.store.get(String(params[0]));
          return value !== undefined ? { value } : undefined;
        }
        return undefined;
      },
      all: (...params: unknown[]) => {
        if (sql.includes('SELECT key, value FROM im_config WHERE key LIKE ?')) {
          const prefix = String(params[0]).replace('%', '');
          return Array.from(this.store.entries())
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, value }));
        }
        return [];
      },
    };
  }

  getValue(key: string) {
    return this.store.get(key);
  }

  getDeletedPlatforms() {
    return this.deletedPlatforms;
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

test('IMStore stores and reads nim instances from nim:{instanceId}', () => {
  const db = new FakeDb();
  const store = new IMStore(db as unknown as ConstructorParameters<typeof IMStore>[0]);

  store.setNimInstanceConfig('nim-1', {
    instanceId: 'nim-1',
    instanceName: 'NIM Bot 1',
    enabled: true,
    appKey: 'app-key',
    account: 'bot-1',
    token: 'token-1',
  });

  const config = store.getNimMultiInstanceConfig();

  expect(config.instances).toHaveLength(1);
  expect(config.instances[0]).toMatchObject({
    instanceId: 'nim-1',
    instanceName: 'NIM Bot 1',
    enabled: true,
    appKey: 'app-key',
    account: 'bot-1',
    token: 'token-1',
  });
});

test('IMStore migrates legacy nim config into a generated nim instance', () => {
  const db = new FakeDb();
  const store = new IMStore(db as unknown as ConstructorParameters<typeof IMStore>[0]);

  store.setNimConfig({
    enabled: true,
    appKey: 'legacy-app',
    account: 'legacy-bot',
    token: 'legacy-token',
  });

  const config = store.getNimMultiInstanceConfig();

  expect(config.instances).toHaveLength(1);
  expect(config.instances[0]).toMatchObject({
    instanceName: 'NIM Bot 1',
    enabled: true,
    appKey: 'legacy-app',
    account: 'legacy-bot',
    token: 'legacy-token',
  });
  expect(config.instances[0].instanceId).toBeTruthy();
  expect(db.getValue(`nim:${config.instances[0].instanceId}`)).toBeTruthy();
});

test('IMStore prefers nim:* records over legacy nim config', () => {
  const db = new FakeDb();
  const store = new IMStore(db as unknown as ConstructorParameters<typeof IMStore>[0]);

  store.setNimConfig({
    enabled: true,
    appKey: 'legacy-app',
    account: 'legacy-bot',
    token: 'legacy-token',
  });
  store.setNimInstanceConfig('nim-2', {
    instanceId: 'nim-2',
    instanceName: 'NIM Bot 2',
    enabled: true,
    appKey: 'new-app',
    account: 'new-bot',
    token: 'new-token',
  });

  const config = store.getNimMultiInstanceConfig();

  expect(config.instances).toHaveLength(1);
  expect(config.instances[0]).toMatchObject({
    instanceId: 'nim-2',
    instanceName: 'NIM Bot 2',
    appKey: 'new-app',
    account: 'new-bot',
  });
});

test('IMStore removes deleted nim instances during multi-instance persistence', () => {
  const db = new FakeDb();
  const store = new IMStore(db as unknown as ConstructorParameters<typeof IMStore>[0]);

  store.setNimInstanceConfig('nim-1', {
    instanceId: 'nim-1',
    instanceName: 'NIM Bot 1',
    enabled: true,
    appKey: 'app-key-1',
    account: 'bot-1',
    token: 'token-1',
  });
  store.setNimInstanceConfig('nim-2', {
    instanceId: 'nim-2',
    instanceName: 'NIM Bot 2',
    enabled: true,
    appKey: 'app-key-2',
    account: 'bot-2',
    token: 'token-2',
  });

  store.setNimMultiInstanceConfig({
    instances: [
      {
        instanceId: 'nim-2',
        instanceName: 'NIM Bot 2',
        enabled: true,
        appKey: 'app-key-2',
        account: 'bot-2',
        token: 'token-2',
      },
    ],
  });

  const config = store.getNimMultiInstanceConfig();

  expect(config.instances).toHaveLength(1);
  expect(config.instances[0]?.instanceId).toBe('nim-2');
  expect(db.getValue('nim:nim-1')).toBeUndefined();
});

test('IMStore does not resurrect deleted nim instances from legacy nim config', () => {
  const db = new FakeDb();
  const store = new IMStore(db as unknown as ConstructorParameters<typeof IMStore>[0]);

  store.setNimConfig({
    enabled: true,
    appKey: 'legacy-app',
    account: 'legacy-bot',
    token: 'legacy-token',
  });

  const migrated = store.getNimMultiInstanceConfig();
  const instanceId = migrated.instances[0]?.instanceId;

  expect(instanceId).toBeTruthy();
  store.deleteNimInstance(instanceId!);

  const config = store.getNimMultiInstanceConfig();

  expect(config.instances).toHaveLength(0);
  expect(db.getValue('nim')).toBeUndefined();
});
