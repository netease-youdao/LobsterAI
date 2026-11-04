import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  ConfirmationBehavior,
  MediaConfirmationAction as Action,
  type MediaConfirmationEvent,
  MediaConfirmationGrant as Grant,
  MediaConfirmationKind,
  MediaConfirmationOutcome as Outcome,
  MediaConfirmationPolicy as Policy,
  MediaConfirmationReason as Reason,
  MediaConfirmationStatus as Status,
} from '../../shared/media/confirmation';
import { imageConfirmationQuestions } from '../mediaGenerationConfirmation';
import { mediaConfirmationQuote, MediaConfirmationRequests } from './mediaConfirmationRequests';

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

describe('turn approval for extra images', () => {
  const priced = (costYuan: number) =>
    imageConfirmationQuestions({ pricing: { billingUnit: 'per_image', costYuan } }, key => key);
  const accept = (items: ReturnType<typeof priced>, grant?: Grant) => ({
    behavior: ConfirmationBehavior.Allow,
    answers: { [items[0].question]: items[0].options[0].label },
    ...(grant ? { grant } : {}),
  });
  function imageRequests() {
    const manager = new MediaConfirmationRequests({ publish: vi.fn(), dismiss: vi.fn() });
    const ask = (items: ReturnType<typeof priced>, turnGroup?: string) => {
      const promise = manager.request(items, 'image-session', {
        kind: MediaConfirmationKind.Image, isCurrent: () => true, refresh: async () => items, onEvent: vi.fn(), turnGroup,
      });
      const requestId = manager.list().at(-1)!.requestId;
      return { promise, requestId };
    };
    return { manager, ask };
  }

  test('one turn approval also approves queued requests of the same turn at the same quote', async () => {
    const { manager, ask } = imageRequests();
    const quote = priced(0.22);
    const first = ask(quote, 'turn-a');
    const queued = ask(priced(0.22), 'turn-a');
    const repriced = ask(priced(0.3), 'turn-a');
    const otherTurn = ask(priced(0.22), 'turn-b');
    expect(manager.list()[0].mediaConfirmation?.turnGrant).toBe(true);
    await manager.act({ requestId: first.requestId, revision: 0, action: Action.Shown });
    expect(await manager.act({
      requestId: first.requestId, revision: 0, action: Action.Respond, response: accept(quote, Grant.Turn),
    })).toBe(true);
    const approved = { behavior: ConfirmationBehavior.Allow, grant: Grant.Turn, quote: mediaConfirmationQuote(quote) };
    expect(await first.promise).toMatchObject(approved);
    expect(await queued.promise).toEqual({ ...approved, answers: accept(quote).answers });
    expect(manager.list().map(item => item.requestId)).toEqual([repriced.requestId, otherTurn.requestId]);
  });

  test('a single approval leaves the rest of the turn asking', async () => {
    const { manager, ask } = imageRequests();
    const quote = priced(0.22);
    const first = ask(quote, 'turn-a');
    const queued = ask(priced(0.22), 'turn-a');
    await manager.act({ requestId: first.requestId, revision: 0, action: Action.Shown });
    await manager.act({ requestId: first.requestId, revision: 0, action: Action.Respond, response: accept(quote) });
    const response = await first.promise;
    expect(response).toEqual({ behavior: ConfirmationBehavior.Allow, answers: accept(quote).answers });
    expect(manager.list().map(item => item.requestId)).toEqual([queued.requestId]);
  });

  test('a turn approval is refused where the card did not offer one', async () => {
    const { manager, ask } = imageRequests();
    const quote = priced(0.22);
    const plain = ask(quote);
    expect(manager.list()[0].mediaConfirmation?.turnGrant).toBeUndefined();
    await manager.act({ requestId: plain.requestId, revision: 0, action: Action.Shown });
    await manager.act({ requestId: plain.requestId, revision: 0, action: Action.Respond, response: accept(quote, Grant.Turn) });
    expect(await plain.promise).toEqual({ behavior: ConfirmationBehavior.Deny, reason: Reason.InvalidAnswer });
  });

  test('a turn approval on a stale quote that changed price needs a fresh answer', async () => {
    const manager = new MediaConfirmationRequests({ publish: vi.fn(), dismiss: vi.fn() });
    const initial = priced(0.22);
    const updated = priced(0.25);
    const promise = manager.request(initial, 'image-session', {
      kind: MediaConfirmationKind.Image, isCurrent: () => true, refresh: async () => updated, onEvent: vi.fn(), turnGroup: 'turn-a',
    });
    const requestId = manager.list()[0].requestId;
    await manager.act({ requestId, revision: 0, action: Action.Shown });
    vi.setSystemTime(Date.now() + Policy.QuoteFreshMs);
    await manager.act({ requestId, revision: 0, action: Action.Respond, response: accept(initial, Grant.Turn) });
    expect(manager.list()[0].mediaConfirmation).toMatchObject({ revision: 1, turnGrant: true });
    await manager.act({ requestId, revision: 1, action: Action.Respond, response: accept(updated, Grant.Turn) });
    expect(await promise).toMatchObject({ grant: Grant.Turn, quote: mediaConfirmationQuote(updated) });
  });
});
