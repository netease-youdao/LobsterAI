/**
 * Test: Deleting a running session must abort the gateway run.
 *
 * This test verifies the fix for GitHub issue #734:
 * Before the fix, deleting a running session only called onSessionDeleted()
 * which purges local caches but does NOT send chat.abort to the gateway.
 * The fix adds a stopSession() call before onSessionDeleted().
 *
 * Since main.ts IPC handlers require Electron, we test the underlying
 * runtime adapter behaviour: stopSession() must call chat.abort on the
 * gateway client when an active turn exists.
 */
import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const originalModuleLoad = Module._load;

Module._load = function patchedModuleLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getAppPath: () => process.cwd(),
        getPath: () => process.cwd(),
      },
      BrowserWindow: {
        getAllWindows: () => [],
      },
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const { OpenClawRuntimeAdapter } = require('../dist-electron/main/libs/agentEngine/openclawRuntimeAdapter.js');

function createMockStore() {
  return {
    sessions: new Map(),
    getSession(id) { return this.sessions.get(id) ?? null; },
    addSession() {},
    updateSession() {},
    deleteSession() {},
    getConfig() {
      return { executionMode: 'local' };
    },
    getSessionMessages() { return []; },
    addMessage() {},
    updateMessage() {},
    getLatestCwd() { return ''; },
    getRecentCwds() { return []; },
  };
}

test('stopSession sends chat.abort when an active turn exists', async () => {
  const store = createMockStore();
  const adapter = new OpenClawRuntimeAdapter(store);

  // Simulate a connected gateway client with a mock request method
  let abortCalled = false;
  let abortArgs = null;
  const mockClient = {
    request(method, params) {
      if (method === 'chat.abort') {
        abortCalled = true;
        abortArgs = params;
      }
      return Promise.resolve();
    },
  };

  // Inject the mock gateway client
  adapter.gatewayClient = mockClient;

  // Simulate an active turn for the session
  const sessionId = 'test-session-1';
  const sessionKey = 'agent:main:test:key';
  const runId = 'run-abc-123';
  adapter.activeTurns.set(sessionId, {
    sessionKey,
    runId,
    stopRequested: false,
    messageId: 'msg-1',
    turnToken: 0,
    isChannelTurn: false,
    pendingUserSync: false,
  });

  // Call stopSession — this should trigger chat.abort
  adapter.stopSession(sessionId);

  // Wait for the async abort request
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(abortCalled, true, 'chat.abort should be called when stopping a session with an active turn');
  assert.equal(abortArgs.sessionKey, sessionKey, 'abort should target the correct sessionKey');
  assert.equal(abortArgs.runId, runId, 'abort should target the correct runId');
});

test('stopSession is safe to call when no active turn exists', () => {
  const store = createMockStore();
  const adapter = new OpenClawRuntimeAdapter(store);

  // Should not throw even without an active turn
  assert.doesNotThrow(() => {
    adapter.stopSession('non-existent-session');
  });
});

test('onSessionDeleted does NOT send chat.abort (pre-fix behaviour)', async () => {
  const store = createMockStore();
  const adapter = new OpenClawRuntimeAdapter(store);

  let abortCalled = false;
  const mockClient = {
    request(method) {
      if (method === 'chat.abort') {
        abortCalled = true;
      }
      return Promise.resolve();
    },
  };
  adapter.gatewayClient = mockClient;

  const sessionId = 'test-session-2';
  adapter.activeTurns.set(sessionId, {
    sessionKey: 'agent:main:test:key2',
    runId: 'run-def-456',
    stopRequested: false,
    messageId: 'msg-2',
    turnToken: 0,
    isChannelTurn: false,
    pendingUserSync: false,
  });

  // onSessionDeleted only cleans up local state, does NOT abort
  adapter.onSessionDeleted(sessionId);

  await new Promise((resolve) => setTimeout(resolve, 50));

  // This documents the design gap that #734 identified.
  // The fix is in main.ts where stopSession() is called BEFORE onSessionDeleted().
  assert.equal(abortCalled, false,
    'onSessionDeleted alone should NOT call chat.abort — the abort must happen via stopSession before delete');
});
