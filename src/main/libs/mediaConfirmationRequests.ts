import { randomUUID } from 'crypto';

import {
  ConfirmationBehavior,
  MediaConfirmationAction,
  type MediaConfirmationCommand,
  type MediaConfirmationEvent,
  MediaConfirmationOutcome,
  MediaConfirmationPolicy,
  MediaConfirmationReason,
  type MediaConfirmationResponse,
  type MediaConfirmationState,
  MediaConfirmationStatus,
} from '../../shared/media/confirmation';
import type { AskUserRequest } from './mcpBridgeServer';

export interface RecoverableMediaConfirmation {
  isCurrent: () => boolean;
  refresh: () => Promise<AskUserRequest['questions']>;
  onEvent: (event: MediaConfirmationEvent) => void;
  signal?: AbortSignal;
}

interface Pending {
  request: AskUserRequest & { mediaConfirmation: MediaConfirmationState };
  options: RecoverableMediaConfirmation;
  resolve: (response: MediaConfirmationResponse) => void;
  startedAt: number;
  displayed: boolean;
  reviewTimer?: ReturnType<typeof setTimeout>;
  retentionTimer?: ReturnType<typeof setTimeout>;
  detachAbort?: () => void;
}

/** A soft expiry invalidates consent, not the request. Nothing submits until a fresh explicit answer. */
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
          createdAt: startedAt,
          expiresAt: startedAt + MediaConfirmationPolicy.RetentionMs,
          questions,
          sessionKey,
          mediaConfirmation: {
            kind: MediaConfirmationPolicy.Kind,
            revision: 0,
            sequence: 0,
            status: MediaConfirmationStatus.Waiting,
            retainedUntil: startedAt + MediaConfirmationPolicy.RetentionMs,
          },
        },
        options,
        resolve,
        startedAt,
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

  private expireReview(entry: Pending): void {
    if (
      !this.current(entry) ||
      entry.request.mediaConfirmation.status !== MediaConfirmationStatus.Visible
    )
      return;
    clearTimeout(entry.reviewTimer);
    entry.request = {
      ...entry.request,
      mediaConfirmation: {
        ...entry.request.mediaConfirmation,
        status: MediaConfirmationStatus.Expired,
      },
    };
    this.event(entry, MediaConfirmationOutcome.Expired, MediaConfirmationReason.Expired);
    this.publish(entry);
  }

  private finish(
    entry: Pending,
    outcome: MediaConfirmationOutcome,
    reason?: MediaConfirmationReason,
    response?: MediaConfirmationResponse,
  ): void {
    if (!this.pending.delete(entry.request.requestId)) return;
    clearTimeout(entry.reviewTimer);
    clearTimeout(entry.retentionTimer);
    entry.detachAbort?.();
    this.event(entry, outcome, reason);
    try {
      this.callbacks.dismiss(entry.request.requestId);
    } catch (error) {
      console.warn('[MediaConfirmation] Failed to dismiss confirmation:', error);
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
    if (state.status === MediaConfirmationStatus.Visible && state.expiresAt! <= this.now())
      this.expireReview(entry);
    if (command.action === MediaConfirmationAction.Shown) {
      if (state.status !== MediaConfirmationStatus.Waiting) return true;
      entry.displayed = true;
      entry.request = {
        ...entry.request,
        mediaConfirmation: {
          ...entry.request.mediaConfirmation,
          status: MediaConfirmationStatus.Visible,
          expiresAt: this.now() + MediaConfirmationPolicy.ReviewMs,
        },
      };
      entry.reviewTimer = setTimeout(
        () => this.expireReview(entry),
        MediaConfirmationPolicy.ReviewMs,
      );
      this.event(entry, MediaConfirmationOutcome.Shown);
      this.publish(entry);
      return true;
    }
    if (command.action === MediaConfirmationAction.Renew) {
      if (entry.request.mediaConfirmation.status !== MediaConfirmationStatus.Expired) return false;
      entry.request = {
        ...entry.request,
        mediaConfirmation: {
          ...entry.request.mediaConfirmation,
          status: MediaConfirmationStatus.Refreshing,
        },
      };
      this.publish(entry);
      try {
        const questions = await entry.options.refresh();
        if (!this.current(entry)) return false;
        entry.request = {
          ...entry.request,
          questions,
          mediaConfirmation: {
            ...entry.request.mediaConfirmation,
            revision: state.revision + 1,
            status: MediaConfirmationStatus.Waiting,
            expiresAt: undefined,
          },
        };
        this.event(entry, MediaConfirmationOutcome.Renewed);
        this.publish(entry);
        return true;
      } catch {
        if (!this.current(entry)) return false;
        entry.request = {
          ...entry.request,
          mediaConfirmation: {
            ...entry.request.mediaConfirmation,
            status: MediaConfirmationStatus.Expired,
          },
        };
        this.event(
          entry,
          MediaConfirmationOutcome.RefreshFailed,
          MediaConfirmationReason.RefreshFailed,
        );
        this.publish(entry);
        return false;
      }
    }
    if (command.action !== MediaConfirmationAction.Respond) return false;
    const response = command.response;
    if (response?.behavior === ConfirmationBehavior.Deny) {
      this.finish(entry, MediaConfirmationOutcome.Denied, MediaConfirmationReason.UserCancelled);
      return true;
    }
    if (entry.request.mediaConfirmation.status !== MediaConfirmationStatus.Visible) return false;
    const question = entry.request.questions[0];
    const valid =
      entry.request.questions.length === 1 &&
      response?.behavior === ConfirmationBehavior.Allow &&
      !response.skippedQuestionIds?.length &&
      response.answers?.[question.question] === question.options[0]?.label;
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
    this.finish(entry, MediaConfirmationOutcome.Allowed, undefined, {
      behavior: ConfirmationBehavior.Allow,
      answers: response.answers,
    });
    return true;
  }
}
