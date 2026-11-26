import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { buildDshImChannelInstances } from '../libs/dsh/dshImConfigTranslator';
import { IMStore } from './imStore';
import { DEFAULT_WECOM_CONFIG } from './types';
import { wecomDuplicateOwners } from './wecomConnections';

let db: Database.Database;
let store: IMStore;
const first = { ...DEFAULT_WECOM_CONFIG, instanceId: 'z', instanceName: 'First', enabled: true, botId: 'bot', secret: 'secret' };
const second = { ...first, instanceId: 'a', instanceName: 'Second', botId: ' bot ' };

beforeEach(() => {
  db = new Database(':memory:');
  store = new IMStore(db);
});
afterEach(() => db.close());

test('rejects a new duplicate without partial writes and accepts an explicit handover in either order', () => {
  store.setWecomInstanceConfig(first.instanceId, first);
  store.setWecomInstanceConfig(second.instanceId, { ...second, enabled: false });
  expect(() => store.setWecomInstanceConfig(second.instanceId, { enabled: true })).toThrow('First');
  expect(() => store.setConfig({ wecom: { instances: [{ ...first, instanceName: 'Renamed' }, second] } })).toThrow('Renamed');
  expect(store.getWecomInstances().map(i => [i.instanceName, i.enabled])).toEqual([['First', true], ['Second', false]]);
  store.setWecomMultiInstanceConfig({ instances: [second, { ...first, enabled: false }] });
  expect(store.getWecomInstances().map(i => i.enabled)).toEqual([false, true]);
});

test('reconciles imported duplicates in creation order, preserves their rows and activates the next owner on disable', () => {
  const insert = db.prepare('INSERT INTO im_config VALUES (?, ?, 1)');
  for (const instance of [first, second]) insert.run(`wecom:${instance.instanceId}`, JSON.stringify(instance));
  const desired = () => buildDshImChannelInstances({ imConfig: { wecom: store.getWecomMultiInstanceConfig() } });
  expect(desired().map(i => [i.instanceId, i.enabled])).toEqual([['z', true], ['a', false]]);
  store.setWecomMultiInstanceConfig({ instances: [second, first] });
  expect(store.getWecomInstances().map(i => i.enabled)).toEqual([true, true]);
  store.setWecomInstanceConfig(first.instanceId, { enabled: false });
  expect(desired().map(i => [i.instanceId, i.enabled])).toEqual([['z', false], ['a', true]]);
});

test('only active WebSocket accounts compete for a subscription', () => {
  const exceptions = [
    null, { ...first, enabled: false }, { ...first, secret: '' },
    { ...first, webhookUrl: 'https://example.test/hook' }, { ...first, corpId: 'corp' },
  ];
  expect([...wecomDuplicateOwners([...exceptions, first, { ...second, secret: '', corpSecret: 'secret' }])])
    .toEqual([['a', 'First']]);
});
