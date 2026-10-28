import { expect, test, vi } from 'vitest';

import { UsageAnalytics, UsageOutcome, UsageStage } from '../../shared/analytics/usage';
import {
  MediaConfirmationOutcome as Outcome,
  MediaConfirmationReason as Reason,
} from '../../shared/media/confirmation';
import { mediaServerFailureFields } from '../../shared/media/usage';
import { MediaUsageAnalytics } from './mediaUsageAnalytics';

test('renewals stay in one media job and soft expiry is not a cancelled acceptance', async () => {
  const report = vi.fn();
  const tracker = new MediaUsageAnalytics({
    getOwner: () => 'owner',
    context: () => undefined,
    report,
  });
  await tracker.run(
    { sessionId: 'session', mediaType: 'video', action: 'generate', callId: 'call' },
    async () => {
      for (const [outcome, count] of [
        [Outcome.Requested, 0],
        [Outcome.Shown, 0],
        [Outcome.Expired, 0],
        [Outcome.Renewed, 1],
        [Outcome.Shown, 1],
        [Outcome.Allowed, 1],
      ] as const) {
        const event = {
          outcome,
          count,
          durationMs: 120000,
          failureCode: outcome === Outcome.Expired ? Reason.Expired : undefined,
        };
        tracker.confirmationEvent('call', event, 'video-model');
        tracker.confirmationEvent('call', event, 'video-model');
      }
      tracker.submitting('call', 2, 'video-model');
      return { content: [], details: { taskId: 'task', status: 'running' } };
    },
  );
  const events = report.mock.calls.map(([event]) => event);
  expect(new Set(events.map(event => event.mediaJobId)).size).toBe(1);
  expect(events.every(event => event.schemaVersion === UsageAnalytics.MediaSchemaVersion)).toBe(
    true,
  );
  expect(events.filter(event => event.stage === UsageStage.Confirmation)).toHaveLength(6);
  expect(events.filter(event => event.stage === UsageStage.Accepted)).toEqual([
    expect.objectContaining({ outcome: UsageOutcome.Succeeded }),
  ]);
  expect(events.find(event => event.outcome === Outcome.Expired)).toMatchObject({
    failureStage: UsageStage.Confirmation,
    failureCode: Reason.Expired,
    count: 0,
  });
});

test('final timeout keeps its specific cause instead of a user cancellation', async () => {
  const report = vi.fn();
  const tracker = new MediaUsageAnalytics({
    getOwner: () => 'owner',
    context: () => undefined,
    report,
  });
  await tracker.run(
    { sessionId: 'session', mediaType: 'video', action: 'generate', callId: 'call' },
    async () => ({
      isError: true,
      content: [],
      details: {
        status: UsageOutcome.Timeout,
        failureStage: UsageStage.Confirmation,
        failureCode: Reason.NotDisplayed,
      },
    }),
  );
  expect(report.mock.calls.at(-1)?.[0]).toMatchObject({
    stage: UsageStage.Accepted,
    outcome: UsageOutcome.Timeout,
    failureCode: Reason.NotDisplayed,
    failureStage: UsageStage.Confirmation,
  });
});

test('definitive server codes survive wrapper errors and emit only one failed acceptance', async () => {
  const report = vi.fn();
  const tracker = new MediaUsageAnalytics({
    getOwner: () => 'owner',
    context: () => undefined,
    report,
  });
  await tracker.run(
    { sessionId: 'session', mediaType: 'video', action: 'generate', callId: 'call' },
    async () => {
      tracker.reject('call', 40204, mediaServerFailureFields(40204, false));
      return {
        isError: true,
        content: [{ type: 'text', text: 'private response' }],
        details: { status: UsageOutcome.Failed },
      };
    },
  );
  const events = report.mock.calls.map(([event]) => event);
  expect(events.filter(event => event.stage === UsageStage.Accepted)).toEqual([
    expect.objectContaining({
      failureCode: 'quota',
      failureStage: UsageStage.Submit,
      blockedReason: 'server_40204',
    }),
  ]);
  expect(JSON.stringify(events)).not.toContain('private');
});
