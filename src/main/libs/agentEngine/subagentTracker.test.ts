import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { SubagentMessageStore } from '../../subagentMessageStore';
import { SubagentRunStore } from '../../subagentRunStore';
import { type GatewayClientLike, SubagentTracker } from './subagentTracker';

let db: BetterSqlite3.Database;
let runStore: SubagentRunStore;
let messageStore: SubagentMessageStore;

const setupDb = (): void => {
  db = new BetterSqlite3(':memory:');
  db.exec(`
    CREATE TABLE subagent_runs (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL,
      session_key TEXT,
      agent_id TEXT,
      task TEXT,
      label TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      created_at INTEGER NOT NULL,
      ended_at INTEGER,
      messages_persisted INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.exec(`
    CREATE TABLE subagent_messages (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      metadata TEXT,
      created_at INTEGER NOT NULL,
      sequence INTEGER NOT NULL DEFAULT 0
    );
  `);
  runStore = new SubagentRunStore(db);
  messageStore = new SubagentMessageStore(db);
};

beforeEach(() => {
  setupDb();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('deleteSubagentRun removes a single run, messages, and gateway transcript', async () => {
  const gatewayClient: GatewayClientLike = {
    request: vi.fn().mockResolvedValue({}),
  };
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);

  runStore.insertSubagentRun({
    id: 'run-1',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-1',
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });
  messageStore.insertMessages('run-1', [{
    id: 'message-1',
    type: 'assistant',
    content: 'done',
    timestamp: 1001,
    sequence: 1,
  }]);

  const deleted = await tracker.deleteSubagentRun('parent-1', 'run-1');

  expect(deleted).toBe(true);
  expect(runStore.getSubagentRun('run-1')).toBeNull();
  expect(messageStore.hasMessages('run-1')).toBe(false);
  expect(gatewayClient.request).toHaveBeenCalledWith(
    'sessions.delete',
    { key: 'agent:main:subagent:run-1', deleteTranscript: true },
    { timeoutMs: 5_000 },
  );
});

test('deleteSubagentRun returns after local deletion without waiting for gateway cleanup', async () => {
  let resolveGatewayDelete: (() => void) | null = null;
  const gatewayDeletePromise = new Promise<void>((resolve) => {
    resolveGatewayDelete = resolve;
  });
  const gatewayClient: GatewayClientLike = {
    request: vi.fn().mockReturnValue(gatewayDeletePromise),
  };
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);

  runStore.insertSubagentRun({
    id: 'run-1',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-1',
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });

  const deleted = await tracker.deleteSubagentRun('parent-1', 'run-1');

  expect(deleted).toBe(true);
  expect(runStore.getSubagentRun('run-1')).toBeNull();
  expect(gatewayClient.request).toHaveBeenCalledTimes(1);

  resolveGatewayDelete?.();
});

test('gateway cleanup retries are capped when delete keeps failing', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const gatewayClient: GatewayClientLike = {
    request: vi.fn().mockRejectedValue(new Error('gateway busy')),
  };
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);

  runStore.insertSubagentRun({
    id: 'run-1',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-1',
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });

  const deleted = await tracker.deleteSubagentRun('parent-1', 'run-1');

  expect(deleted).toBe(true);
  expect(gatewayClient.request).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(5_000);
  expect(gatewayClient.request).toHaveBeenCalledTimes(2);

  await vi.advanceTimersByTimeAsync(10_000);
  expect(gatewayClient.request).toHaveBeenCalledTimes(3);

  await vi.advanceTimersByTimeAsync(20_000);
  expect(gatewayClient.request).toHaveBeenCalledTimes(3);
});

test('deleteSubagentRun refuses to delete a run from another parent session', async () => {
  const tracker = new SubagentTracker(runStore, messageStore, () => null);
  runStore.insertSubagentRun({
    id: 'run-1',
    parentSessionId: 'parent-1',
    sessionKey: null,
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });

  const deleted = await tracker.deleteSubagentRun('parent-2', 'run-1');

  expect(deleted).toBe(false);
  expect(runStore.getSubagentRun('run-1')).not.toBeNull();
});

test('onSessionDeleted removes subagent runs and messages for the parent session', () => {
  const tracker = new SubagentTracker(runStore, messageStore, () => null);
  runStore.insertSubagentRun({
    id: 'run-1',
    parentSessionId: 'parent-1',
    sessionKey: null,
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });
  runStore.insertSubagentRun({
    id: 'run-2',
    parentSessionId: 'parent-2',
    sessionKey: null,
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });
  messageStore.insertMessages('run-1', [{
    id: 'message-1',
    type: 'assistant',
    content: 'done',
    timestamp: 1001,
    sequence: 1,
  }]);

  tracker.onSessionDeleted('parent-1');

  expect(runStore.getSubagentRun('run-1')).toBeNull();
  expect(messageStore.hasMessages('run-1')).toBe(false);
  expect(runStore.getSubagentRun('run-2')).not.toBeNull();
});

test('getSubTaskHistory preserves persisted message timestamps', async () => {
  const gatewayClient: GatewayClientLike = {
    request: vi.fn().mockResolvedValue({ messages: [] }),
  };
  const tracker = new SubagentTracker(runStore, messageStore, () => gatewayClient);
  runStore.insertSubagentRun({
    id: 'run-1',
    parentSessionId: 'parent-1',
    sessionKey: 'agent:main:subagent:run-1',
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
    status: 'done',
    createdAt: 1000,
  });
  messageStore.insertMessages('run-1', [{
    id: 'message-1',
    type: 'assistant',
    content: 'done',
    timestamp: 1001,
    sequence: 1,
  }]);
  runStore.markMessagesPersisted('run-1');

  const messages = await tracker.getSubTaskHistory('parent-1', 'run-1');

  expect(messages).toEqual([{
    id: 'message-1',
    type: 'assistant',
    content: 'done',
    timestamp: 1001,
    metadata: undefined,
  }]);
  expect(gatewayClient.request).not.toHaveBeenCalled();
});

test('deleted subagent run is not reinserted by late spawn results', async () => {
  const tracker = new SubagentTracker(runStore, messageStore, () => null);
  tracker.onToolStart('run-1', {
    agentId: 'worker',
    task: 'inspect files',
    label: 'worker',
  }, 'parent-1');
  tracker.onSpawnResult('run-1', JSON.stringify({
    childSessionKey: 'agent:main:subagent:run-1',
    status: 'running',
  }), {});

  const deleted = await tracker.deleteSubagentRun('parent-1', 'run-1');
  tracker.onSpawnResult('run-1', JSON.stringify({
    childSessionKey: 'agent:main:subagent:run-1',
    status: 'running',
  }), {});

  expect(deleted).toBe(true);
  expect(runStore.getSubagentRun('run-1')).toBeNull();
});
