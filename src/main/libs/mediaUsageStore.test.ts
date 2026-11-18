import { randomUUID } from 'crypto';
import { expect, test, vi } from 'vitest';

import { UsageAnalytics, UsageEntry } from '../../shared/analytics/usage';
import { MediaProtocol } from '../../shared/media/constants';
import { MediaType } from '../../shared/media/defaultPolicy';
import { type MediaUsageRecord, MediaUsageStore } from './mediaUsageStore';

test('snapshots whitelist attribution, expire after seven days and keep a bounded history', () => {
  let now = 1000;
  let persisted: unknown;
  const store = new MediaUsageStore({ get: <T>() => persisted as T, set: (_key, value) => { persisted = value; } }, () => now);
  const record = { id: randomUUID(), scope: 'account:server', aliases: ['call', 'task'], mediaType: MediaType.Image,
    protocolVersion: MediaProtocol.Durable, startedAt: now, accepted: true, terminal: false, saved: false, attemptCount: 0,
    context: { taskId: randomUUID(), turnId: randomUUID(), entry: UsageEntry.Direct, ownerKey: 'secret-owner' },
    prompt: 'secret-prompt', resultUrls: ['secret-url'], filePath: 'secret-path', owner: 'secret-runtime-owner',
    modelId: '/secret-model', policyVersion: 'policy-v1', selectionSource: 'secret-source',
  };
  store.save(record);
  expect(JSON.stringify(persisted)).not.toContain('secret');
  expect(store.find(record.scope, 'task')).toMatchObject({ id: record.id, policyVersion: 'policy-v1' });
  expect(store.find('other-account:server', 'task')).toBeUndefined();
  now += 7 * 24 * 60 * 60_000 + 1;
  expect(store.find(record.scope, 'task')).toBeUndefined();
  for (let i = 0; i <= UsageAnalytics.MaxTrackedItems; i += 1) {
    store.save({ ...record, startedAt: now, id: randomUUID(), aliases: [String(i)] });
  }
  expect(persisted).toHaveLength(UsageAnalytics.MaxTrackedItems);
  expect(store.find(record.scope, '0')).toBeUndefined();
  expect(store.find(record.scope, String(UsageAnalytics.MaxTrackedItems))).toBeDefined();
  store.clear();
  expect(persisted).toEqual([]);
});

test('construction is lazy and malformed or legacy snapshots are ignored', () => {
  const get = vi.fn(<T>() => [null, {}, { id: randomUUID(), protocolVersion: MediaProtocol.Legacy }] as T);
  const store = new MediaUsageStore({ get, set: vi.fn() });
  expect(get).not.toHaveBeenCalled();
  expect(store.find('scope', 'alias')).toBeUndefined();
  expect(() => store.save({} as MediaUsageRecord)).not.toThrow();
});
