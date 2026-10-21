import { describe, expect, test } from 'vitest';

import { MediaProtocol } from '../../shared/media/constants';
import { type MediaGenerationIntent, MediaTaskStore, type MediaTaskTracker } from './mediaTaskStore';

const fixture = () => {
  const values = new Map<string, unknown>();
  const kv = { get: <T>(key: string) => values.get(key) as T | undefined,
    set: (key: string, value: unknown) => { values.set(key, structuredClone(value)); } };
  return { kv, store: new MediaTaskStore(kv) };
};
const task: MediaTaskTracker = { taskId: '123', sessionId: 'session', mediaType: 'image', model: 'model',
  ownerAccountKey: 'owner', accountGeneration: 1, startedAt: 1, pollCount: 0, timeoutMs: 360000,
  serverBaseUrl: 'http://localhost:18879', protocolVersion: MediaProtocol.Durable };
const intent: Omit<MediaGenerationIntent, 'key' | 'createdAt'> = { callKey: 'session:call', ownerAccountKey: 'owner',
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
