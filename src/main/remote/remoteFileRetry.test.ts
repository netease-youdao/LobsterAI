import { describe, expect, it } from 'vitest';

import { RemoteFileReason } from '../../shared/remote/files';
import { fileRetryAllowed, nextFileRetry, RemoteFileRequestError, RemoteFileRetryPhase } from './remoteFileRetry';

describe('persistent resource retry policy', () => {
  it('backs off without allowing jitter to shorten cooldown or Retry-After', () => {
    let now = 1_000, state;
    for (let attempt = 1; attempt <= 5; attempt++) {
      state = nextFileRetry(state, new RemoteFileRequestError('offline'), now, '1', () => 0);
      expect(state.failures).toBe(attempt);
      expect(state.nextRetryAt - now).toBe([24_000, 48_000, 96_000, 240_000, 900_000][attempt - 1]);
      now = state.nextRetryAt;
    }
    expect(state!.phase).toBe(RemoteFileRetryPhase.Cooldown);
    const restored = JSON.parse(JSON.stringify(state));
    expect(fileRetryAllowed(restored, now - 1, '2')).toBe(false);
    const throttled = nextFileRetry(undefined, new RemoteFileRequestError('rate limit', 429, '3600'), 0, '1', () => 0);
    expect(throttled.nextRetryAt).toBe(3_600_000);
  });
  it('does not turn invalid content, identity or an unknown local failure into unlimited retries', () => {
    for (const error of [new SyntaxError('broken JSON'), new Error(RemoteFileReason.Source),
      new Error(RemoteFileReason.Transfer), new RemoteFileRequestError('forbidden', 403)]) {
      const state = nextFileRetry(undefined, error, 0, '1');
      expect(state.phase).toBe(RemoteFileRetryPhase.Isolated);
      expect(fileRetryAllowed(state, Number.MAX_SAFE_INTEGER, '2')).toBe(false);
    }
  });
  it('waits for dependency changes and preserves an unbounded server delay', () => {
    const waiting = nextFileRetry(undefined, new Error(RemoteFileReason.Type), 0, '1', () => 0);
    expect(waiting.phase).toBe(RemoteFileRetryPhase.Waiting);
    const waitingWithServerDelay = nextFileRetry(undefined,
      new RemoteFileRequestError(RemoteFileReason.Policy, 409, '3600'), 0, '1', () => 0);
    expect(fileRetryAllowed(waitingWithServerDelay, 10, '2')).toBe(false);
    expect(fileRetryAllowed(waiting, 10, '1')).toBe(false);
    expect(fileRetryAllowed(waiting, 10, '2')).toBe(true);
    const delayed = nextFileRetry(undefined, new RemoteFileRequestError('offline', 503, '8640000'), 0, '1', () => 0);
    expect(delayed.nextRetryAt).toBe(8_640_000_000);
    expect(nextFileRetry(undefined, new RemoteFileRequestError('offline', 503, 'invalid'), 0, '1').phase).toBe(RemoteFileRetryPhase.Isolated);
  });
});
