import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  ConfirmationBehavior,
  MediaConfirmationAction as Action,
  type MediaConfirmationEvent,
  MediaConfirmationOutcome as Outcome,
  MediaConfirmationPolicy as Policy,
  MediaConfirmationReason as Reason,
  MediaConfirmationStatus as Status,
} from '../../shared/media/confirmation';
import { MediaConfirmationRequests } from './mediaConfirmationRequests';

const questions = [
  { question: 'Video request', options: [{ label: 'Generate' }, { label: 'Cancel' }] },
];
function setup() {
  let current = true;
  const controller = new AbortController();
  const events: MediaConfirmationEvent[] = [];
  const refresh = vi.fn(async () => [{ ...questions[0], subtitle: 'Updated cost' }]);
  const publish = vi.fn();
  const manager = new MediaConfirmationRequests({ publish, dismiss: vi.fn() });
  const promise = manager.request(questions, 'session', {
    isCurrent: () => current,
    refresh,
    signal: controller.signal,
    onEvent: event => events.push(event),
  });
  const requestId = manager.list()[0].requestId;
  const act = (
    action: Action,
    revision = 0,
    response?: Parameters<typeof manager.act>[0]['response'],
  ) => manager.act({ requestId, revision, action, response });
  const approve = (revision = 0) =>
    act(Action.Respond, revision, {
      behavior: ConfirmationBehavior.Allow,
      answers: { 'Video request': 'Generate' },
    });
  return {
    manager,
    events,
    promise,
    act,
    approve,
    refresh,
    publish,
    controller,
    changeAccount: () => {
      current = false;
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('recoverable video confirmation', () => {
  test('clears all pending requests and timers even if dismissal throws', async () => {
    const failure = new Error('Window closed');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dismiss = vi.fn(() => { throw failure; });
    const manager = new MediaConfirmationRequests({ publish: vi.fn(), dismiss });
    try {
      const pending = [0, 1].map(() => manager.request(questions, 'session', {
        isCurrent: () => true,
        refresh: async () => questions,
        onEvent: vi.fn(),
      }));
      for (const request of manager.list()) {
        await manager.act({ requestId: request.requestId, revision: 0, action: Action.Shown });
      }
      expect(() => manager.clear()).not.toThrow();
      expect(await Promise.all(pending)).toEqual([
        { behavior: ConfirmationBehavior.Deny, reason: Reason.Interrupted },
        { behavior: ConfirmationBehavior.Deny, reason: Reason.Interrupted },
      ]);
      expect(manager.list()).toEqual([]);
      expect(dismiss).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(expect.any(String), failure);
      expect(vi.getTimerCount()).toBe(0);
    } finally { warn.mockRestore(); }
  });

  test('waits for actual display, retains expired input, refreshes cost and requires a fresh explicit approval', async () => {
    const s = setup();
    const resolved = vi.fn();
    void s.promise.then(resolved);
    await vi.advanceTimersByTimeAsync(Policy.ReviewMs + 1);
    expect(s.manager.list()[0].mediaConfirmation?.status).toBe(Status.Waiting);
    expect(s.events.map(event => event.outcome)).toEqual([Outcome.Requested]);
    await s.act(Action.Shown);
    await s.act(Action.Shown);
    await vi.advanceTimersByTimeAsync(Policy.ReviewMs);
    expect(s.manager.list()[0].mediaConfirmation?.status).toBe(Status.Expired);
    expect(s.manager.list()[0].questions).toEqual(questions);
    expect(resolved).not.toHaveBeenCalled();
    expect(await s.approve()).toBe(false);
    expect(await s.act(Action.Renew)).toBe(true);
    expect(s.refresh).toHaveBeenCalledTimes(1);
    expect(s.manager.list()[0].questions[0].subtitle).toBe('Updated cost');
    expect(await s.approve()).toBe(false);
    expect(await s.approve(1)).toBe(false);
    await s.act(Action.Shown, 1);
    expect(await s.approve(1)).toBe(true);
    expect(await s.approve(1)).toBe(false);
    expect(await s.promise).toMatchObject({ behavior: ConfirmationBehavior.Allow });
    expect(s.events.map(event => event.outcome)).toEqual([
      Outcome.Requested,
      Outcome.Shown,
      Outcome.Expired,
      Outcome.Renewed,
      Outcome.Shown,
      Outcome.Allowed,
    ]);
    const sequences = s.publish.mock.calls.map(([request]) => request.mediaConfirmation.sequence);
    expect(sequences.every((value, index) => index === 0 || value > sequences[index - 1])).toBe(
      true,
    );
  });

  test('checks the deadline on answer even if the timer has not run yet', async () => {
    const s = setup();
    await s.act(Action.Shown);
    vi.setSystemTime(Date.now() + Policy.ReviewMs);
    expect(await s.approve()).toBe(false);
    expect(s.manager.list()[0].mediaConfirmation?.status).toBe(Status.Expired);
  });

  test('explicit cancellation still works after soft expiry', async () => {
    const s = setup();
    await s.act(Action.Shown);
    await vi.advanceTimersByTimeAsync(Policy.ReviewMs);
    expect(await s.act(Action.Respond, 0, { behavior: ConfirmationBehavior.Deny })).toBe(true);
    expect(await s.promise).toEqual({
      behavior: ConfirmationBehavior.Deny,
      reason: Reason.UserCancelled,
    });
  });

  test.each([false, true])(
    'retention is bounded and identifies whether the card was displayed: %s',
    async displayed => {
      const s = setup();
      if (displayed) await s.act(Action.Shown);
      await vi.advanceTimersByTimeAsync(Policy.RetentionMs);
      expect(await s.promise).toEqual({
        behavior: ConfirmationBehavior.Deny,
        reason: displayed ? Reason.Timeout : Reason.NotDisplayed,
      });
      expect(s.events.at(-1)?.outcome).toBe(Outcome.Timeout);
      expect(s.manager.list()).toEqual([]);
    },
  );

  test('scope changes invalidate consent and snapshots', async () => {
    const s = setup();
    await s.act(Action.Shown);
    s.changeAccount();
    expect(await s.approve()).toBe(false);
    expect(await s.promise).toMatchObject({ reason: Reason.AccountChanged });
    expect(s.manager.list()).toEqual([]);
  });

  test('refresh failure remains retryable; overlapping renewals only refresh once', async () => {
    const s = setup();
    await s.act(Action.Shown);
    await vi.advanceTimersByTimeAsync(Policy.ReviewMs);
    s.refresh.mockRejectedValueOnce(new Error('private upstream error'));
    expect(await s.act(Action.Renew)).toBe(false);
    expect(s.manager.list()[0].mediaConfirmation?.status).toBe(Status.Expired);
    const next = s.act(Action.Renew);
    expect(await s.act(Action.Renew)).toBe(false);
    expect(await next).toBe(true);
    expect(JSON.stringify(s.events)).not.toContain('private');
  });

  test('a stopped tool cannot be revived by an in-flight refresh', async () => {
    const s = setup();
    await s.act(Action.Shown);
    await vi.advanceTimersByTimeAsync(Policy.ReviewMs);
    let finish!: (value: typeof questions) => void;
    s.refresh.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const renewal = s.act(Action.Renew);
    s.controller.abort();
    finish(questions);
    expect(await renewal).toBe(false);
    expect(await s.promise).toMatchObject({ reason: Reason.Interrupted });
    expect(s.manager.list()).toEqual([]);
  });

  test.each([
    [
      { behavior: ConfirmationBehavior.Allow, answers: { 'Video request': 'free text' } },
      Reason.InvalidAnswer,
    ],
    [{ behavior: ConfirmationBehavior.Allow, skippedQuestionIds: ['q'] }, Reason.Skipped],
  ] as const)('never treats a non-affirmative reply as paid consent', async (response, reason) => {
    const s = setup();
    await s.act(Action.Shown);
    await s.act(Action.Respond, 0, {
      ...response,
      ...('skippedQuestionIds' in response
        ? { skippedQuestionIds: [...response.skippedQuestionIds] }
        : {}),
    });
    expect(await s.promise).toMatchObject({ behavior: ConfirmationBehavior.Deny, reason });
  });

  test('routing failure resolves distinctly and releases timers', async () => {
    const events: MediaConfirmationEvent[] = [];
    const manager = new MediaConfirmationRequests({
      publish: () => {
        throw new Error('No window');
      },
      dismiss: vi.fn(),
    });
    expect(
      await manager.request(questions, undefined, {
        isCurrent: () => true,
        refresh: async () => questions,
        onEvent: event => events.push(event),
      }),
    ).toMatchObject({ reason: Reason.NoRoute });
    expect(events.at(-1)?.outcome).toBe(Outcome.Failed);
    expect(vi.getTimerCount()).toBe(0);
  });
});
