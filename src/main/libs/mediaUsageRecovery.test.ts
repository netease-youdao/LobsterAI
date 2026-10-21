import { randomUUID } from 'crypto';
import { expect, test, vi } from 'vitest';

import { UsageAnalytics, UsageEntry, UsageOutcome, UsageStage } from '../../shared/analytics/usage';
import { MediaProtocol, MediaTaskPhase, MediaTaskStatus } from '../../shared/media/constants';
import { MediaSelectionSource, MediaType } from '../../shared/media/defaultPolicy';
import { MediaUsageAnalytics } from './mediaUsageAnalytics';
import { MediaUsageStore } from './mediaUsageStore';

const request = { sessionId: 'private-session', mediaType: MediaType.Video, action: 'generate', callId: 'private-call',
  selectionSource: MediaSelectionSource.Default, policyVersion: 'policy-v1' };
const task = { taskId: 'private-server-task', protocolVersion: MediaProtocol.Durable, status: MediaTaskStatus.Running };

function setup() {
  const values = new Map<string, unknown>();
  const report = vi.fn();
  const state = { owner: 'account-a:1' as string | null, scope: 'account-a:server-a' };
  const context = { taskId: randomUUID(), turnId: randomUUID(), entry: UsageEntry.Direct };
  const store = new MediaUsageStore({
    get: <T>(key: string) => values.get(key) as T | undefined,
    set: (key, value) => { values.set(key, structuredClone(value)); },
  });
  const restart = () => new MediaUsageAnalytics({ report, store,
    getOwner: () => state.owner, getScope: () => state.scope, context: () => context });
  return { values, report, state, context, store, restart, tracker: restart(), events: () => report.mock.calls.map(([event]) => event) };
}

test('an unconfirmed submission never counts as accepted, including repeat tool results', async () => {
  const s = setup();
  for (const details of [
    { status: MediaTaskStatus.Pending, phase: MediaTaskPhase.Verifying },
    { status: MediaTaskStatus.Failed, submissionUnknown: true },
  ]) {
    await s.tracker.run(request, async () => {
      s.tracker.submitting(request.callId, MediaProtocol.Durable, 'video-v1');
      return { isError: details.submissionUnknown, content: [], details };
    });
  }
  expect(s.events().filter(event => event.stage === UsageStage.Start)).toHaveLength(1);
  expect(s.events().filter(event => event.outcome === UsageOutcome.Unknown)).toHaveLength(1);
  expect(s.events().some(event => [UsageStage.Accepted, UsageStage.Generated].includes(event.stage))).toBe(false);
});

test('a snapshot taken before the HTTP acknowledgement recovers the original media job and turn', async () => {
  const s = setup();
  await s.tracker.run(request, async () => {
    s.tracker.submitting(request.callId, MediaProtocol.Durable, 'video-v1');
    // The new process can recover even if the old process never recorded an acknowledgement.
    const recovered = s.restart();
    recovered.accept(request.callId, task);
    recovered.observe(task.taskId, MediaTaskStatus.Succeeded, 1);
    recovered.save(task.taskId, 1, 1);
    s.state.owner = null;
    return { content: [], details: { submissionUnknown: true } };
  });
  s.state.owner = 'account-a:2';
  const restored = s.restart();
  const count = s.events().length;
  restored.accept(request.callId, task);
  restored.observe(task.taskId, MediaTaskStatus.Succeeded, 1);
  restored.save(task.taskId, 1, 1);
  expect(s.events()).toHaveLength(count);
  expect(s.events().map(event => event.stage)).toEqual([
    UsageStage.Start, UsageStage.Submit, UsageStage.Accepted, UsageStage.Generated, UsageStage.Saved,
  ]);
  expect(new Set(s.events().map(event => event.mediaJobId)).size).toBe(1);
  expect(restored.attribution(task.taskId)?.context).toMatchObject(s.context);
  for (const event of s.events()) expect(event).toMatchObject({ ...s.context,
    schemaVersion: UsageAnalytics.MediaSchemaVersion, selectionSource: request.selectionSource, policyVersion: request.policyVersion });
  expect(JSON.stringify(s.events())).not.toMatch(/private|account-a|server-a/);
});

test('partial delivery can succeed after restart without duplicating generation or the first save attempt', async () => {
  const s = setup();
  await s.tracker.run(request, async () => {
    s.tracker.submitting(request.callId, MediaProtocol.Durable, 'video-v1');
    s.tracker.accept(request.callId, { ...task, status: MediaTaskStatus.Succeeded, resultUrls: ['secret-url-a', 'secret-url-b'] });
    s.tracker.save(task.taskId, 1, 2);
    return { content: [], details: { ...task, status: MediaTaskStatus.Succeeded, assets: [{ filePath: 'private-path' }] } };
  });
  expect(s.events().filter(event => event.stage === UsageStage.Saved)).toHaveLength(0);
  expect(s.events().filter(event => event.stage === UsageStage.DeliveryAttempt)).toEqual([
    expect.objectContaining({ outcome: UsageOutcome.Failed, partial: true, savedCount: 1, outputCount: 2, attemptCount: 1 }),
  ]);
  const restarted = s.restart();
  restarted.observe(task.taskId, MediaTaskStatus.Succeeded, 2);
  restarted.save(task.taskId, 2, 2);
  restarted.save(task.taskId, 2, 2);
  expect(s.events().filter(event => event.stage === UsageStage.Generated)).toHaveLength(1);
  expect(s.events().filter(event => event.stage === UsageStage.Saved)).toEqual([
    expect.objectContaining({ outcome: UsageOutcome.Succeeded, attemptCount: 2, savedCount: 2, outputCount: 2 }),
  ]);
  expect(JSON.stringify([...s.values.values()])).not.toMatch(/secret-url|private-path/);
});

test('cancel API acknowledgement does not override the eventual server terminal state', async () => {
  const s = setup();
  await s.tracker.run(request, async () => ({ content: [], details: task }));
  await s.tracker.run({ ...request, action: 'cancel', taskId: task.taskId }, async () => ({
    content: [], details: { status: MediaTaskStatus.Cancelled },
  }));
  expect(s.events().filter(event => event.stage === UsageStage.Generated)).toHaveLength(0);
  s.tracker.observe(task.taskId, MediaTaskStatus.Succeeded, 1);
  expect(s.events().at(-1)).toMatchObject({ stage: UsageStage.Generated, outcome: UsageOutcome.Succeeded });
});

test('restored correlation is isolated by both account and server', async () => {
  const s = setup();
  await s.tracker.run(request, async () => ({ content: [], details: task }));
  for (const scope of ['account-b:server-a', 'account-a:server-b']) {
    s.state.scope = scope;
    const restarted = s.restart();
    restarted.observe(task.taskId, MediaTaskStatus.Succeeded, 1);
    expect(restarted.attribution(task.taskId)).toBeUndefined();
  }
  expect(s.events().map(event => event.stage)).toEqual([UsageStage.Start, UsageStage.Accepted]);
});

test('opt-out clears persisted attribution and invalidates in-flight results even after opting back in', async () => {
  const s = setup();
  await s.tracker.run(request, async () => {
    s.tracker.submitting(request.callId, MediaProtocol.Durable, 'video-v1');
    s.state.owner = null;
    s.tracker.clear();
    s.state.owner = 'account-a:1';
    return { content: [], details: task };
  });
  s.restart().accept(request.callId, task);
  expect(s.store.find(s.state.scope, request.callId)).toBeUndefined();
  expect(s.events().map(event => event.stage)).toEqual([UsageStage.Start, UsageStage.Submit]);
});

test('storage failures do not change tool results or prevent live analytics', async () => {
  const s = setup();
  vi.spyOn(s.store, 'find').mockImplementation(() => { throw new Error('storage unavailable'); });
  vi.spyOn(s.store, 'save').mockImplementation(() => { throw new Error('storage unavailable'); });
  const result = { content: [], details: task };
  expect(await s.tracker.run(request, async () => result)).toBe(result);
  expect(s.events().map(event => event.stage)).toEqual([UsageStage.Start, UsageStage.Accepted]);
});
