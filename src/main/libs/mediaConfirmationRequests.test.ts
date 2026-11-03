import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  ConfirmationBehavior,
  MediaConfirmationAction as Action,
  type MediaConfirmationEvent,
  MediaConfirmationKind,
  MediaConfirmationOutcome as Outcome,
  MediaConfirmationPolicy as Policy,
  MediaConfirmationReason as Reason,
  MediaConfirmationStatus as Status,
} from '../../shared/media/confirmation';
import { imageConfirmationQuestions } from '../mediaGenerationConfirmation';
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

describe('recoverable media confirmation', () => {
  test('an image remains confirmable after 120 seconds and a changed catalogue requires fresh consent', async () => {
    const initial = imageConfirmationQuestions({ pricing: { billingUnit: 'per_image', costYuan: 0.22 } }, key => key);
    const updated = imageConfirmationQuestions({ pricing: { billingUnit: 'per_image', costYuan: 0.25 } }, key => key);
    const manager = new MediaConfirmationRequests({ publish: vi.fn(), dismiss: vi.fn() });
    const resolved = vi.fn();
    const refresh = vi.fn(async () => updated);
    const promise = manager.request(initial, 'image-session', {
      kind: MediaConfirmationKind.Image, isCurrent: () => true, refresh, onEvent: vi.fn(),
    });
    void promise.then(resolved);
    const requestId = manager.list()[0].requestId;
    expect(manager.list()[0].mediaConfirmation?.kind).toBe(MediaConfirmationKind.Image);
    await manager.act({ requestId, revision: 0, action: Action.Shown });
    await vi.advanceTimersByTimeAsync(130_000);
    expect(resolved).not.toHaveBeenCalled();
    const response = { behavior: ConfirmationBehavior.Allow, answers: { [initial[0].question]: initial[0].options[0].label } };
    await manager.act({ requestId, revision: 0, action: Action.Respond, response });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(resolved).not.toHaveBeenCalled();
    expect(manager.list()[0].mediaConfirmation?.revision).toBe(1);
    expect(await manager.act({ requestId, revision: 0, action: Action.Respond, response })).toBe(false);
    await manager.act({ requestId, revision: 1, action: Action.Respond, response });
    expect(await promise).toMatchObject({ behavior: ConfirmationBehavior.Allow });
  });
  test('a fresh quote submits on the first confirmation without re-reading prices', async () => {
    const s = setup();
    await vi.advanceTimersByTimeAsync(Policy.QuoteFreshMs * 3);
    expect(s.manager.list()[0].mediaConfirmation?.status).toBe(Status.Waiting);
    expect(await s.approve()).toBe(false);
    await s.act(Action.Shown);
    await s.act(Action.Shown);
    vi.setSystemTime(1_000_000 + Policy.QuoteFreshMs - 1);
    expect(await s.approve()).toBe(true);
    expect(s.refresh).not.toHaveBeenCalled();
    expect(await s.promise).toMatchObject({ behavior: ConfirmationBehavior.Allow });
    expect(s.events.map(event => event.outcome)).toEqual([Outcome.Requested, Outcome.Shown, Outcome.Allowed]);
  });

  test('a stale quote with an unchanged price submits after the re-check', async () => {
    const s = setup();
    s.refresh.mockResolvedValueOnce(questions);
    await s.act(Action.Shown);
    await vi.advanceTimersByTimeAsync(Policy.QuoteFreshMs * 5);
    expect(s.manager.list()[0].mediaConfirmation?.status).toBe(Status.Visible);
    expect(await s.approve()).toBe(true);
    expect(s.refresh).toHaveBeenCalledTimes(1);
    expect(await s.promise).toMatchObject({ behavior: ConfirmationBehavior.Allow });
    expect(s.publish.mock.calls.at(-1)?.[0].mediaConfirmation.status).toBe(Status.Refreshing);
  });

  test('a changed price needs a fresh answer on the new revision', async () => {
    const s = setup();
    const resolved = vi.fn();
    void s.promise.then(resolved);
    await s.act(Action.Shown);
    vi.setSystemTime(Date.now() + Policy.QuoteFreshMs);
    expect(await s.approve()).toBe(true);
    expect(resolved).not.toHaveBeenCalled();
    const [request] = s.manager.list();
    expect(request.questions[0].subtitle).toBe('Updated cost');
    expect(request.mediaConfirmation).toMatchObject({ revision: 1, status: Status.Visible, repriced: {} });
    expect(await s.approve()).toBe(false);
    expect(await s.approve(1)).toBe(true);
    expect(s.refresh).toHaveBeenCalledTimes(1);
    expect(await s.promise).toMatchObject({ behavior: ConfirmationBehavior.Allow });
    expect(s.events.map(event => event.outcome)).toEqual([
      Outcome.Requested,
      Outcome.Shown,
      Outcome.Renewed,
      Outcome.Allowed,
    ]);
    const sequences = s.publish.mock.calls.map(([item]) => item.mediaConfirmation.sequence);
    expect(sequences.every((value, index) => index === 0 || value > sequences[index - 1])).toBe(true);
  });

  test('cancellation works while the price is being re-checked', async () => {
    const s = setup();
    await s.act(Action.Shown);
    vi.setSystemTime(Date.now() + Policy.QuoteFreshMs);
    let finish!: (value: typeof questions) => void;
    s.refresh.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const confirming = s.approve();
    expect(await s.approve()).toBe(false);
    expect(await s.act(Action.Respond, 0, { behavior: ConfirmationBehavior.Deny })).toBe(true);
    finish(questions);
    expect(await confirming).toBe(false);
    expect(await s.promise).toEqual({ behavior: ConfirmationBehavior.Deny, reason: Reason.UserCancelled });
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

  test('a failed price check keeps the request and can be confirmed again', async () => {
    const s = setup();
    await s.act(Action.Shown);
    vi.setSystemTime(Date.now() + Policy.QuoteFreshMs);
    s.refresh.mockRejectedValueOnce(new Error('private upstream error'));
    expect(await s.approve()).toBe(false);
    expect(s.manager.list()[0].mediaConfirmation?.status).toBe(Status.Visible);
    s.refresh.mockResolvedValueOnce(questions);
    expect(await s.approve()).toBe(true);
    expect(await s.promise).toMatchObject({ behavior: ConfirmationBehavior.Allow });
    expect(s.events.map(event => event.outcome)).toContain(Outcome.RefreshFailed);
    expect(JSON.stringify(s.events)).not.toContain('private');
  });

  test('a stopped tool cannot be revived by an in-flight price check', async () => {
    const s = setup();
    await s.act(Action.Shown);
    vi.setSystemTime(Date.now() + Policy.QuoteFreshMs);
    let finish!: (value: typeof questions) => void;
    s.refresh.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const confirming = s.approve();
    s.controller.abort();
    finish(questions);
    expect(await confirming).toBe(false);
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
