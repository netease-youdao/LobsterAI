import { afterEach, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => process.cwd(), getVersion: () => 'test' },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { ConfigWorkloadState } from '../openclawConfigObservation';
import { AgentLifecyclePhase } from './constants';
import { OpenClawRuntimeAdapter } from './openclawRuntimeAdapter';

const KEY = 'agent:main:moltbot-popo:synthetic:direct:user';

function setup() {
  const session = { id: 'synthetic-session', status: 'completed', messages: [] };
  const records = new Map<string, unknown>();
  const store = {
    getSession: () => session,
    updateSession: (_id: string, patch: object) => Object.assign(session, patch),
    remote: {
      get: <T>(key: string): T | null => records.has(key) ? structuredClone(records.get(key)) as T : null,
      put: (key: string, value: unknown) => { records.set(key, structuredClone(value)); },
      entries: <T>(prefix: string) => [...records]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value: structuredClone(value) as T })),
      transaction: <T>(operation: () => T): T => operation(),
      run: () => null,
      owner: () => null,
    },
    remoteCreationOwner: () => null,
    canReadSession: () => true,
  };
  const adapter = new OpenClawRuntimeAdapter(store as never, {} as never, {}, {
    listSubagentRuns: () => [],
  } as never) as any;
  adapter.channelSessionSync = {
    clearCache: () => {},
    onSessionDeleted: () => {},
    isChannelSessionKey: (key: string) => key === KEY,
    isCurrentBindingKey: () => true,
    resolveOrCreateSession: () => session.id,
  };
  return { adapter, session };
}

function lifecycle(adapter: any, phase: string, runId = 'current-run') {
  adapter.handleGatewayEvent({ event: 'sessions.changed', payload: { sessionKey: KEY, runId, phase } });
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

test('row 7: authoritative active poll blocks config restart without manufacturing an ActiveTurn', () => {
  const { adapter, session } = setup();
  adapter.syncChannelSessionRunStatus({
    coworkSessionId: session.id, openClawSessionKey: KEY, row: { hasActiveRun: true, status: 'running' },
  });
  expect(session.status).toBe('running');
  expect(adapter.hasActiveSessions()).toBe(false);
  expect(adapter.getConfigRestartWorkloadSnapshot()).toMatchObject({
    state: ConfigWorkloadState.Busy, activeTurns: 0, im: { pollActive: 1 },
  });
  adapter.syncChannelSessionRunStatus({
    coworkSessionId: session.id, openClawSessionKey: KEY, row: { hasActiveRun: false, status: 'done' },
  });
  expect(adapter.getConfigRestartWorkloadSnapshot().im.activeSessions).toBe(0);
});

test('row 7: native lifecycle preparation blocks config restart before stream events', () => {
  const { adapter } = setup();
  lifecycle(adapter, AgentLifecyclePhase.Start);
  expect(adapter.hasActiveSessions()).toBe(false);
  expect(adapter.getConfigRestartWorkloadSnapshot()).toMatchObject({
    state: ConfigWorkloadState.Busy, activeTurns: 0, im: { lifecycleActive: 1 },
  });
  lifecycle(adapter, AgentLifecyclePhase.End, 'old-run');
  expect(adapter.getConfigRestartWorkloadSnapshot().im.activeSessions).toBe(1);
  lifecycle(adapter, AgentLifecyclePhase.End);
  expect(adapter.getConfigRestartWorkloadSnapshot().im.activeSessions).toBe(0);
});

test.each(['stopSession', 'onSessionDeleted', 'clearChannelSessionCache', 'disconnectGatewayClient'])(
  '%s clears IM restart evidence and invalidates an in-flight poll', method => {
    const { adapter, session } = setup();
    lifecycle(adapter, AgentLifecyclePhase.Start);
    const workloadPollRevision = adapter.configRestartImWorkloads.beginPoll();
    adapter[method](session.id);
    adapter.syncChannelSessionRunStatus({
      coworkSessionId: session.id, openClawSessionKey: KEY,
      row: { hasActiveRun: true }, workloadPollRevision,
    });
    expect(adapter.getConfigRestartWorkloadSnapshot().im.activeSessions).toBe(0);
  },
);

test('a repeated active poll renews evidence even when the UI status was already running', () => {
  vi.useFakeTimers();
  const { adapter, session } = setup();
  const options = { coworkSessionId: session.id, openClawSessionKey: KEY, row: { hasActiveRun: true } };
  adapter.syncChannelSessionRunStatus(options);
  vi.advanceTimersByTime(90_000);
  adapter.syncChannelSessionRunStatus(options);
  vi.advanceTimersByTime(90_000);
  expect(adapter.getConfigRestartWorkloadSnapshot().im.pollActive).toBe(1);
});

test('historical running rows cannot create busy evidence; expired lifecycle is unknown', () => {
  vi.useFakeTimers();
  const { adapter, session } = setup();
  adapter.agentTimeoutSeconds = 1;
  adapter.syncChannelSessionRunStatus({
    coworkSessionId: session.id, openClawSessionKey: KEY, row: { status: 'running' },
  });
  expect(adapter.getConfigRestartWorkloadSnapshot().state).toBe(ConfigWorkloadState.Unknown);
  lifecycle(adapter, AgentLifecyclePhase.Start);
  vi.advanceTimersByTime(61_001);
  expect(adapter.getConfigRestartWorkloadSnapshot()).toMatchObject({
    state: ConfigWorkloadState.Unknown, im: { activeSessions: 0, staleSessions: 1 },
  });
});

test('desktop activity remains protective independently of IM terminal events', () => {
  const { adapter } = setup();
  adapter.activeTurns.set('desktop-session', {});
  lifecycle(adapter, AgentLifecyclePhase.Start);
  lifecycle(adapter, AgentLifecyclePhase.Error);
  expect(adapter.hasActiveSessions()).toBe(true);
  expect(adapter.getConfigRestartWorkloadSnapshot()).toMatchObject({
    state: ConfigWorkloadState.Busy, activeTurns: 1, im: { activeSessions: 0 },
  });
});

test('events delivered by a retired connection cannot revive IM evidence', async () => {
  const { adapter } = setup();
  let callbacks: any;
  class Client {
    constructor(options: unknown) { callbacks = options; }
    start() {}
    stop() {}
    async request() { return {}; }
  }
  adapter.loadGatewayClientCtor = async () => Client;
  await adapter.createGatewayClient({ clientEntryPath: 'synthetic-client' });
  adapter.disconnectGatewayClient();
  callbacks.onEvent({
    event: 'sessions.changed', payload: { sessionKey: KEY, runId: 'old-connection', phase: AgentLifecyclePhase.Start },
  });
  expect(adapter.getConfigRestartWorkloadSnapshot().im.activeSessions).toBe(0);
});
