import { randomUUID } from 'crypto';

import {
  ConfirmationBehavior,
  MediaConfirmationAction,
  type MediaConfirmationCommand,
  type MediaConfirmationEvent,
  MediaConfirmationGrant,
  type MediaConfirmationKind,
  MediaConfirmationOutcome,
  MediaConfirmationPolicy,
  MediaConfirmationReason,
  type MediaConfirmationResponse,
  type MediaConfirmationState,
  MediaConfirmationStatus,
} from '../../shared/media/confirmation';
import type { AskUserRequest } from './mcpBridgeServer';

export interface RecoverableMediaConfirmation {
  kind?: MediaConfirmationKind;
  isCurrent: () => boolean;
  refresh: () => Promise<AskUserRequest['questions']>;
  onEvent: (event: MediaConfirmationEvent) => void;
  signal?: AbortSignal;
  /**
   * Offers approving the rest of a turn. Approving one request that way also
   * approves the pending requests of the same group at the same quote.
   */
  turnGroup?: string;
}

interface Pending {
  request: AskUserRequest & { mediaConfirmation: MediaConfirmationState };
  options: RecoverableMediaConfirmation;
  resolve: (response: MediaConfirmationResponse) => void;
  startedAt: number;
  /** When the displayed price was read from the model catalogue. */
  quotedAt: number;
  displayed: boolean;
  retentionTimer?: ReturnType<typeof setTimeout>;
  detachAbort?: () => void;
}

/** What the user agreed to pay; a re-read catalogue with the same quote keeps their consent valid. */
export const mediaConfirmationQuote = (questions: AskUserRequest['questions']): string =>
  JSON.stringify(questions.map(question => [
    question.subtitle ?? '', question.video?.estimatedCredits ?? null, question.video?.pricingNote ?? '', question.quoteKey ?? '',
  ]));

/**
 * Paid media consent. There is no short review deadline: a quote older than
 * `QuoteFreshMs` is re-read when the user confirms, submitting at once if the
 * price is unchanged and asking again otherwise. Requests end after `RetentionMs`.
 */
export class MediaConfirmationRequests {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly callbacks: {
      publish: (request: AskUserRequest) => void;
      dismiss: (requestId: string) => void;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.callbacks.now?.() ?? Date.now();
  }

  request(
    questions: AskUserRequest['questions'],
    sessionKey: string | undefined,
    options: RecoverableMediaConfirmation,
  ): Promise<MediaConfirmationResponse> {
    const startedAt = this.now();
    return new Promise(resolve => {
      const entry: Pending = {
        request: {
          requestId: randomUUID(),
          questions,
          sessionKey,
          mediaConfirmation: {
            kind: options.kind ?? MediaConfirmationPolicy.Kind,
            revision: 0,
            sequence: 0,
            status: MediaConfirmationStatus.Waiting,
            retainedUntil: startedAt + MediaConfirmationPolicy.RetentionMs,
            ...(options.turnGroup ? { turnGrant: true } : {}),
          },
        },
        options,
        resolve,
        startedAt,
        quotedAt: startedAt,
        displayed: false,
      };
      this.pending.set(entry.request.requestId, entry);
      this.event(entry, MediaConfirmationOutcome.Requested);
      if (!this.current(entry)) return;
      const abort = () =>
        this.finish(
          entry,
          MediaConfirmationOutcome.Interrupted,
          MediaConfirmationReason.Interrupted,
        );
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener('abort', abort, { once: true });
      entry.detachAbort = () => options.signal?.removeEventListener('abort', abort);
      entry.retentionTimer = setTimeout(
        () => this.expireRetention(entry),
        MediaConfirmationPolicy.RetentionMs,
      );
      this.publish(entry);
    });
  }

  private event(
    entry: Pending,
    outcome: MediaConfirmationOutcome,
    failureCode?: MediaConfirmationReason,
  ): void {
    try {
      entry.options.onEvent({
        outcome,
        failureCode,
        durationMs: Math.max(0, this.now() - entry.startedAt),
        count: entry.request.mediaConfirmation.revision,
      });
    } catch {
      /* Telemetry must never decide whether a paid request can proceed. */
    }
  }

  private publish(entry: Pending): void {
    entry.request = {
      ...entry.request,
      mediaConfirmation: {
        ...entry.request.mediaConfirmation,
        sequence: entry.request.mediaConfirmation.sequence + 1,
      },
    };
    try {
      this.callbacks.publish(entry.request);
    } catch {
      this.finish(entry, MediaConfirmationOutcome.Failed, MediaConfirmationReason.NoRoute);
    }
  }

  private current(entry: Pending): boolean {
    if (this.pending.get(entry.request.requestId) !== entry) return false;
    if (!entry.options.isCurrent()) {
      this.finish(
        entry,
        MediaConfirmationOutcome.Interrupted,
        MediaConfirmationReason.AccountChanged,
      );
      return false;
    }
    if (this.now() >= entry.request.mediaConfirmation.retainedUntil) {
      this.expireRetention(entry);
      return false;
    }
    return true;
  }

  private expireRetention(entry: Pending): void {
    this.finish(
      entry,
      MediaConfirmationOutcome.Timeout,
      entry.displayed ? MediaConfirmationReason.Timeout : MediaConfirmationReason.NotDisplayed,
    );
  }

  private finish(
    entry: Pending,
    outcome: MediaConfirmationOutcome,
    reason?: MediaConfirmationReason,
    response?: MediaConfirmationResponse,
  ): void {
    if (!this.pending.delete(entry.request.requestId)) return;
    clearTimeout(entry.retentionTimer);
    entry.detachAbort?.();
    this.event(entry, outcome, reason);
    try {
      this.callbacks.dismiss(entry.request.requestId);
    } finally {
      entry.resolve(response ?? { behavior: ConfirmationBehavior.Deny, reason });
    }
  }

  /** Called by routing failures, never by renderer approval. */
  deny(
    requestId: string,
    reason: MediaConfirmationReason = MediaConfirmationReason.NoRoute,
  ): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.finish(entry, MediaConfirmationOutcome.Failed, reason);
    return true;
  }

  list(): AskUserRequest[] {
    return [...this.pending.values()]
      .filter(entry => this.current(entry))
      .map(entry => entry.request);
  }

  clear(reason: MediaConfirmationReason = MediaConfirmationReason.Interrupted): void {
    for (const entry of this.pending.values())
      this.finish(entry, MediaConfirmationOutcome.Interrupted, reason);
  }

  async act(command: MediaConfirmationCommand): Promise<boolean> {
    const entry = this.pending.get(command?.requestId);
    if (!entry || !this.current(entry)) return false;
    const state = entry.request.mediaConfirmation;
    if (command.revision !== state.revision) return false;
    if (command.action === MediaConfirmationAction.Shown) {
      if (state.status !== MediaConfirmationStatus.Waiting) return true;
      entry.displayed = true;
      entry.request = {
        ...entry.request,
        mediaConfirmation: { ...state, status: MediaConfirmationStatus.Visible },
      };
      this.event(entry, MediaConfirmationOutcome.Shown);
      this.publish(entry);
      return true;
    }
    if (command.action !== MediaConfirmationAction.Respond) return false;
    const response = command.response;
    if (response?.behavior === ConfirmationBehavior.Deny) {
      this.finish(entry, MediaConfirmationOutcome.Denied, MediaConfirmationReason.UserCancelled);
      return true;
    }
    if (state.status !== MediaConfirmationStatus.Visible) return false;
    const question = entry.request.questions[0];
    const grant = response?.grant ?? MediaConfirmationGrant.Once;
    const valid =
      entry.request.questions.length === 1 &&
      response?.behavior === ConfirmationBehavior.Allow &&
      !response.skippedQuestionIds?.length &&
      response.answers?.[question.question] === question.options[0]?.label &&
      (grant === MediaConfirmationGrant.Once || (grant === MediaConfirmationGrant.Turn && state.turnGrant === true));
    if (!valid) {
      this.finish(
        entry,
        MediaConfirmationOutcome.Denied,
        response?.skippedQuestionIds?.length
          ? MediaConfirmationReason.Skipped
          : MediaConfirmationReason.InvalidAnswer,
      );
      return true;
    }
    if (this.now() - entry.quotedAt < MediaConfirmationPolicy.QuoteFreshMs) {
      this.allow(entry, response);
      return true;
    }
    return this.reprice(entry, response);
  }

  private allow(entry: Pending, response: MediaConfirmationResponse): void {
    if (response.grant !== MediaConfirmationGrant.Turn) {
      this.finish(entry, MediaConfirmationOutcome.Allowed, undefined, {
        behavior: ConfirmationBehavior.Allow,
        answers: response.answers,
      });
      return;
    }
    const quote = mediaConfirmationQuote(entry.request.questions);
    const group = entry.options.turnGroup;
    this.finish(entry, MediaConfirmationOutcome.Allowed, undefined, {
      behavior: ConfirmationBehavior.Allow,
      answers: response.answers,
      grant: MediaConfirmationGrant.Turn,
      quote,
    });
    // The same consent covers requests already queued in this turn, but only at the price the user saw.
    for (const other of [...this.pending.values()]) {
      const question = other.request.questions[0];
      if (!group || other.options.turnGroup !== group || other.request.questions.length !== 1
        || mediaConfirmationQuote(other.request.questions) !== quote || !this.current(other)) continue;
      this.finish(other, MediaConfirmationOutcome.Allowed, undefined, {
        behavior: ConfirmationBehavior.Allow,
        answers: { [question.question]: question.options[0]?.label ?? '' },
        grant: MediaConfirmationGrant.Turn,
        quote,
      });
    }
  }

  /** Re-reads a stale quote at confirmation: an unchanged price submits, a new one needs a fresh answer. */
  private async reprice(entry: Pending, response: MediaConfirmationResponse): Promise<boolean> {
    const previous = entry.request;
    entry.request = {
      ...previous,
      mediaConfirmation: { ...previous.mediaConfirmation, status: MediaConfirmationStatus.Refreshing },
    };
    this.publish(entry);
    let questions: AskUserRequest['questions'];
    try {
      questions = await entry.options.refresh();
    } catch {
      if (!this.current(entry)) return false;
      entry.request = {
        ...entry.request,
        mediaConfirmation: { ...entry.request.mediaConfirmation, status: MediaConfirmationStatus.Visible },
      };
      this.event(entry, MediaConfirmationOutcome.RefreshFailed, MediaConfirmationReason.RefreshFailed);
      this.publish(entry);
      return false;
    }
    if (!this.current(entry)) return false;
    entry.quotedAt = this.now();
    if (mediaConfirmationQuote(questions) === mediaConfirmationQuote(previous.questions)) {
      this.allow(entry, response);
      return true;
    }
    entry.request = {
      ...entry.request,
      questions,
      mediaConfirmation: {
        ...entry.request.mediaConfirmation,
        revision: previous.mediaConfirmation.revision + 1,
        status: MediaConfirmationStatus.Visible,
        repriced: { previousCredits: previous.questions[0]?.video?.estimatedCredits },
      },
    };
    this.event(entry, MediaConfirmationOutcome.Renewed);
    this.publish(entry);
    return true;
  }
}
