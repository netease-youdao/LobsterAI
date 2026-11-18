import { beforeEach, expect, test, vi } from 'vitest';

import { UsageEntry, UsageOutcome, UsageStage } from '../../shared/analytics/usage';
import type { Artifact } from '../types/artifact';

const mocks = vi.hoisted(() => ({
  report: vi.fn(),
  owner: 'account-a',
  enabled: true,
  state: {
    agent: {
      currentAgentId: 'local-expert',
      agents: [{ id: 'local-expert', source: 'preset', presetId: 'expert-data' }],
    },
    cowork: { currentSession: null as unknown },
  },
}));
vi.mock('../store', () => ({ store: { getState: () => mocks.state } }));
vi.mock('./analyticsIdentity', () => ({
  getAnalyticsIdentitySnapshot: () => ({ userId: mocks.owner }),
}));
vi.mock('./config', () => ({
  configService: { getConfig: () => ({ usageAnalyticsEnabled: mocks.enabled }) },
}));
vi.mock('./logReporter', () => ({ reportYdAnalyzer: mocks.report }));

beforeEach(() => {
  vi.resetModules();
  mocks.report.mockReset();
  mocks.owner = 'account-a';
  mocks.enabled = true;
  mocks.state.cowork.currentSession = null;
});

test('expert draft attribution reaches task submission but does not leak into a second new task', async () => {
  const usage = await import('./usageAnalytics');
  usage.prepareExpertAnalytics('local-expert', 'expert-data', {
    entry: UsageEntry.Starter,
    catalogVersion: 'v1',
  });
  const draft = mocks.report.mock.calls[0][0];
  const context = usage.beginTaskSubmission('local-expert')!;
  expect(context).toMatchObject({
    presetId: 'expert-data',
    journeyId: draft.journeyId,
    entry: UsageEntry.Starter,
    catalogVersion: 'v1',
  });
  usage.finishTaskSubmission(context, 'local-session');
  expect(mocks.report.mock.calls[mocks.report.mock.calls.length - 1]?.[0]).toMatchObject({
    stage: UsageStage.Submit,
    outcome: UsageOutcome.Succeeded,
    turnId: context.turnId,
  });
  expect(usage.beginTaskSubmission('local-expert')).toMatchObject({ entry: UsageEntry.Direct });
  expect(usage.beginTaskSubmission('local-expert')?.journeyId).toBeUndefined();
});

test('continuation restores task attribution from persisted user metadata', async () => {
  const usage = await import('./usageAnalytics');
  const first = usage.beginTaskSubmission('local-expert')!;
  mocks.state.cowork.currentSession = {
    id: 's',
    agentId: 'local-expert',
    messages: [
      { id: 'u', type: 'user', metadata: { usageAnalytics: { ...first, ownerKey: mocks.owner, localSessionId: 's' } } },
    ],
  };
  const next = usage.beginTaskSubmission(undefined, 's')!;
  expect(next.taskId).toBe(first.taskId);
  expect(next.turnId).not.toBe(first.turnId);
  expect(next.entry).toBe(UsageEntry.Continue);
});

test.each(['account', 'optout'])(
  'pending IPC result is discarded after %s change',
  async change => {
    const usage = await import('./usageAnalytics');
    const context = usage.beginTaskSubmission('local-expert');
    mocks.report.mockClear();
    if (change === 'account') mocks.owner = 'account-b';
    else mocks.enabled = false;
    usage.finishTaskSubmission(context, 's');
    expect(mocks.report).not.toHaveBeenCalled();
  },
);

test('artifact events use the producing message turn, deduplicate renders, and omit content and paths', async () => {
  const usage = await import('./usageAnalytics');
  const context = usage.beginTaskSubmission('local-expert')!;
  usage.finishTaskSubmission(context, 's');
  mocks.state.cowork.currentSession = {
    id: 's',
    status: 'completed',
    messages: [
      {
        id: 'u',
        type: 'user',
        metadata: { usageAnalytics: { ...context, ownerKey: mocks.owner, localSessionId: 's' } },
      },
      { id: 'answer', type: 'assistant', metadata: {} },
    ],
  };
  const artifact = {
    id: 'private-path-based-id',
    sessionId: 's',
    messageId: 'answer',
    type: 'image',
    source: 'tool',
    content: 'private bytes',
    filePath: 'D:/private/file.png',
  } as Artifact;
  mocks.report.mockClear();
  usage.reportArtifactDiscovery(artifact);
  usage.reportArtifactDiscovery(artifact);
  expect(mocks.report).toHaveBeenCalledTimes(1);
  expect(mocks.report.mock.calls[0][0]).toMatchObject({
    turnId: context.turnId,
    stage: UsageStage.Discovered,
  });
  expect(JSON.stringify(mocks.report.mock.calls)).not.toContain('private');
  expect(
    usage.getArtifactUsageParams({ ...artifact, messageId: 'unknown-old-message' })
      .attributionKnown,
  ).toBe(false);
});

test('disabled analytics never starts a new journey or submission', async () => {
  const usage = await import('./usageAnalytics');
  mocks.enabled = false;
  usage.prepareExpertAnalytics('a', 'b', { entry: UsageEntry.Picker });
  expect(usage.beginTaskSubmission()).toBeUndefined();
  expect(mocks.report).not.toHaveBeenCalled();
});

test('leaving a draft cannot attribute an unrelated later task to the abandoned journey', async () => {
  const usage = await import('./usageAnalytics');
  usage.prepareExpertAnalytics('local-expert', 'expert-data', { entry: UsageEntry.Plaza });
  usage.resetDraftAnalytics();
  expect(usage.beginTaskSubmission('local-expert')?.journeyId).toBeUndefined();
});
