import { describe, expect, test } from 'vitest';

import { MEDIA_INTENT_BODY_KEY_PREFIX, MEDIA_INTENT_STORE_KEY, MediaProtocol } from '../../shared/media/constants';
import {
  MEDIA_INTENT_RETENTION_MS,
  MEDIA_INTENT_RETRY_WINDOW_MS,
  type MediaGenerationIntentInput,
  MediaTaskStore,
  type MediaTaskTracker,
} from './mediaTaskStore';

const fixture = () => {
  const values = new Map<string, unknown>();
  const clock = { now: Date.now() };
  const kv = { get: <T>(key: string) => values.get(key) as T | undefined,
    set: (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
    delete: (key: string) => { values.delete(key); } };
  const bodyKeys = () => [...values.keys()].filter(key => key.startsWith(MEDIA_INTENT_BODY_KEY_PREFIX));
  return { kv, values, clock, bodyKeys, store: new MediaTaskStore(kv, () => clock.now) };
};
const task: MediaTaskTracker = { taskId: '123', sessionId: 'session', mediaType: 'image', model: 'model',
  ownerAccountKey: 'owner', accountGeneration: 1, startedAt: 1, pollCount: 0, timeoutMs: 360000,
  serverBaseUrl: 'http://localhost:18879', protocolVersion: MediaProtocol.Durable };
const intent: MediaGenerationIntentInput = { callKey: 'session:call', ownerAccountKey: 'owner',
  serverBaseUrl: task.serverBaseUrl!, sessionId: 'session', mediaType: 'image', model: 'model', toolCallId: 'call', requestBody: '{}' };

describe('durable media task recovery', () => {
  test('only treats an unacknowledged request from the current call and account as recoverable', () => {
    const { store, kv } = fixture();
    const pending = store.beginIntent(intent);
    const restored = new MediaTaskStore(kv);
    expect(restored.findUnacknowledgedIntent(intent.callKey, intent.ownerAccountKey, intent.serverBaseUrl)?.key).toBe(pending.key);
    expect(restored.findUnacknowledgedIntent('another-call', intent.ownerAccountKey, intent.serverBaseUrl)).toBeUndefined();
    expect(restored.findUnacknowledgedIntent(intent.callKey, 'another-account', intent.serverBaseUrl)).toBeUndefined();
    expect(restored.findUnacknowledgedIntent(intent.callKey, intent.ownerAccountKey, 'https://another.example')).toBeUndefined();
    store.saveIntent({ ...pending, rejected: true });
    expect(restored.findUnacknowledgedIntent(intent.callKey, intent.ownerAccountKey, intent.serverBaseUrl)).toBeUndefined();
    store.saveIntent({ ...pending, taskId: task.taskId });
    expect(restored.findUnacknowledgedIntent(intent.callKey, intent.ownerAccountKey, intent.serverBaseUrl)).toBeUndefined();
  });
  test('keeps stable intent keys across restarts and rejects changed payloads', () => {
    const { store, kv } = fixture();
    const first = store.beginIntent(intent);
    const restored = new MediaTaskStore(kv);
    expect(restored.beginIntent(intent).key).toBe(first.key);
    expect(() => restored.beginIntent({ ...intent, requestBody: '{"different":true}' })).toThrow();
  });
  test('does not mix accounts, endpoints, or notification completion', () => {
    const { store, kv } = fixture();
    store.save({ ...task, delivered: true });
    store.save({ ...task, ownerAccountKey: 'other' });
    const restored = new MediaTaskStore(kv);
    expect(restored.tasks()).toHaveLength(2);
    expect(restored.delivered(task)).toBe(true);
    expect(restored.delivered({ ...task, ownerAccountKey: 'other' })).toBe(false);
    expect(restored.delivered({ ...task, serverBaseUrl: 'https://production.example' })).toBe(false);
  });
  test('restores ownership of delivered tasks immediately after restart', () => {
    const { store, kv } = fixture();
    store.save({ ...task, delivered: true });
    const restored = new MediaTaskStore(kv);
    expect(restored.findOwnedTask(task.taskId, task.ownerAccountKey, task.serverBaseUrl!))
      .toMatchObject({ taskId: task.taskId, delivered: true, ownerAccountKey: task.ownerAccountKey });
    expect(restored.findOwnedTask(task.taskId, 'other-account', task.serverBaseUrl!)).toBeUndefined();
    expect(restored.findOwnedTask(task.taskId, task.ownerAccountKey, 'https://production.example')).toBeUndefined();
    expect(restored.findOwnedTask('unknown-task', task.ownerAccountKey, task.serverBaseUrl!)).toBeUndefined();
  });
});

describe('media intent request bodies', () => {
  const largeBody = JSON.stringify({ prompt: 'edit', image: 'x'.repeat(1_000_000) });

  test('keeps request bodies out of the intent index until the intent settles', () => {
    const { store, kv, values, bodyKeys } = fixture();
    const pending = store.beginIntent({ ...intent, requestBody: largeBody });
    expect(JSON.stringify(values.get(MEDIA_INTENT_STORE_KEY)).length).toBeLessThan(2_000);
    expect(new MediaTaskStore(kv).intentRequestBody(store.intents()[0])).toBe(largeBody);

    store.saveIntent({ ...pending, lastAttemptAt: 2 });
    expect(store.intentRequestBody(store.intents()[0])).toBe(largeBody);

    store.saveIntent({ ...pending, taskId: task.taskId });
    expect(bodyKeys()).toEqual([]);
    expect(store.intentRequestBody(store.intents()[0])).toBeUndefined();
    // A caller still holding the pre-settlement copy must not bring the body flag back.
    store.saveIntent({ ...pending, taskId: task.taskId, lastAttemptAt: 3 });
    expect(store.intents()[0].hasRequestBody).toBeUndefined();
  });

  test('drops the body of an unacknowledged intent after its retry window and the record after retention', () => {
    const { store, clock, bodyKeys } = fixture();
    const pending = store.beginIntent({ ...intent, requestBody: largeBody });
    clock.now += MEDIA_INTENT_RETRY_WINDOW_MS + 1;
    expect(store.intents().map(item => item.key)).toEqual([pending.key]);
    expect(bodyKeys()).toEqual([]);
    expect(store.intentRequestBody(store.intents()[0])).toBeUndefined();
    clock.now = pending.createdAt + MEDIA_INTENT_RETENTION_MS + 1;
    expect(store.intents()).toEqual([]);
  });

  test('migrates inline request bodies written by older builds', () => {
    const { store, kv, values, clock, bodyKeys } = fixture();
    const legacy = (key: string, createdAt: number, extra: Record<string, unknown>) => ({
      key, callKey: `session:${key}`, ownerAccountKey: 'owner', serverBaseUrl: task.serverBaseUrl, sessionId: 'session',
      mediaType: 'image', model: 'model', toolCallId: key, requestBody: largeBody, createdAt, ...extra,
    });
    values.set(MEDIA_INTENT_STORE_KEY, [
      legacy('pending', clock.now - 1_000, {}),
      legacy('settled', clock.now - 2_000, { taskId: '9' }),
      legacy('expired', clock.now - MEDIA_INTENT_RETENTION_MS - 1, { taskId: '8' }),
    ]);

    const migrated = store.intents();
    expect(migrated.map(item => item.key)).toEqual(['pending', 'settled']);
    expect(JSON.stringify(values.get(MEDIA_INTENT_STORE_KEY))).not.toContain('requestBody"');
    expect(bodyKeys()).toEqual([`${MEDIA_INTENT_BODY_KEY_PREFIX}pending`]);
    expect(store.intentRequestBody(migrated[0])).toBe(largeBody);

    // Replays of a migrated call still match by payload hash.
    const restored = new MediaTaskStore(kv, () => clock.now);
    const replay = { ...intent, callKey: 'session:settled', toolCallId: 'settled' };
    expect(restored.beginIntent({ ...replay, requestBody: largeBody }).key).toBe('settled');
    expect(() => restored.beginIntent({ ...replay, requestBody: '{}' })).toThrow();
  });
});
