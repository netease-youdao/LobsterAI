import { describe, expect, test } from 'vitest';

import { CoworkSystemMessageKind, ModelReconnectStatus } from '../../../common/coworkSystemMessages';
import { t } from '../../i18n';
import { ModelRetryPhase } from './constants';
import {
  applyModelRetryEvent,
  buildModelReconnectMetadata,
  getModelReconnectContent,
  type ModelReconnectState,
  parseModelRetryEvent,
  resolveModelReconnectErrorOverride,
} from './modelReconnect';

const retrying = (overrides: Partial<ModelReconnectState> = {}): ModelReconnectState => ({
  messageId: 'msg-reconnect',
  status: ModelReconnectStatus.Retrying,
  attempt: 2,
  maxAttempts: 5,
  startedAt: 100,
  error: 'terminated',
  errorCode: 'UND_ERR_SOCKET',
  ...overrides,
});

describe('parseModelRetryEvent', () => {
  test('reads a retry event', () => {
    expect(parseModelRetryEvent({
      phase: 'retrying',
      attempt: 1,
      maxAttempts: 5,
      delayMs: 1033.4,
      error: ' terminated ',
      errorCode: 'UND_ERR_SOCKET',
    })).toEqual({
      phase: ModelRetryPhase.Retrying,
      attempt: 1,
      maxAttempts: 5,
      delayMs: 1033,
      error: 'terminated',
      errorCode: 'UND_ERR_SOCKET',
    });
  });

  test.each([
    ['a missing payload', undefined],
    ['an unknown phase', { phase: 'started', attempt: 1, maxAttempts: 5 }],
    ['a missing attempt', { phase: 'retrying', maxAttempts: 5 }],
    ['a zero budget', { phase: 'retrying', attempt: 1, maxAttempts: 0 }],
    ['an array', [{ phase: 'retrying', attempt: 1, maxAttempts: 5 }]],
  ])('rejects %s', (_label, data) => {
    expect(parseModelRetryEvent(data)).toBeNull();
  });
});

describe('applyModelRetryEvent', () => {
  test('a later attempt of the same drop keeps its row', () => {
    const next = applyModelRetryEvent(retrying(), {
      phase: ModelRetryPhase.Retrying,
      attempt: 3,
      maxAttempts: 5,
    }, 900);

    expect(next).toMatchObject({ messageId: 'msg-reconnect', attempt: 3, startedAt: 100 });
  });

  test('a drop after the row settled starts a new row', () => {
    const next = applyModelRetryEvent(retrying({ status: ModelReconnectStatus.Recovered }), {
      phase: ModelRetryPhase.Retrying,
      attempt: 1,
      maxAttempts: 5,
    }, 900);

    expect(next).toMatchObject({ messageId: null, attempt: 1, startedAt: 900 });
  });

  test('exhaustion marks the row failed', () => {
    const next = applyModelRetryEvent(retrying(), {
      phase: ModelRetryPhase.Exhausted,
      attempt: 5,
      maxAttempts: 5,
    }, 900);

    expect(next.status).toBe(ModelReconnectStatus.Failed);
    expect(next.messageId).toBe('msg-reconnect');
  });
});

describe('reconnect row content', () => {
  test('metadata carries the attempt and closes once settled', () => {
    expect(buildModelReconnectMetadata(retrying(), 'run-1', 500)).toEqual({
      kind: CoworkSystemMessageKind.ModelReconnect,
      status: ModelReconnectStatus.Retrying,
      attempt: 2,
      maxAttempts: 5,
      runId: 'run-1',
      startedAt: 100,
      errorCode: 'UND_ERR_SOCKET',
    });
    expect(buildModelReconnectMetadata(
      retrying({ status: ModelReconnectStatus.Recovered }),
      'run-1',
      500,
    )).toMatchObject({ completedAt: 500 });
  });

  test('fallback text follows the status', () => {
    expect(getModelReconnectContent(retrying())).toBe('Reconnecting 2/5');
    expect(getModelReconnectContent(retrying({ status: ModelReconnectStatus.Failed, attempt: 5 })))
      .toBe('Reconnect failed after 5 attempts');
  });
});

describe('resolveModelReconnectErrorOverride', () => {
  const incompleteTurn = "⚠️ Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying.";

  test.each([
    ['the incomplete-turn warning', incompleteTurn],
    ['the response timeout', 'LLM request timed out.'],
  ])('replaces %s after reconnects ran out', (_label, rawErrorMessage) => {
    const override = resolveModelReconnectErrorOverride(
      retrying({ status: ModelReconnectStatus.Failed, attempt: 5 }),
      rawErrorMessage,
    );

    expect(override?.errorMessage).toBe(t('coworkErrorModelStreamInterrupted', { attempts: 5 }));
    expect(override?.detailRawErrorMessage).toBe(
      `${rawErrorMessage}\nreconnectAttempts=5/5 streamError=terminated code=UND_ERR_SOCKET`,
    );
  });

  test('replaces the last retry\'s own failure after reconnects ran out', () => {
    const override = resolveModelReconnectErrorOverride(
      retrying({ status: ModelReconnectStatus.Failed, attempt: 5 }),
      'LLM request failed.',
    );

    expect(override?.errorMessage).toBe(t('coworkErrorModelStreamInterrupted', { attempts: 5 }));
  });

  test('keeps a different error while a reconnect is pending', () => {
    expect(resolveModelReconnectErrorOverride(retrying(), '401 invalid api key')).toBeNull();
  });

  test('keeps the error after the reconnect recovered', () => {
    expect(resolveModelReconnectErrorOverride(
      retrying({ status: ModelReconnectStatus.Recovered }),
      incompleteTurn,
    )).toBeNull();
  });

  test('keeps the error when the turn never dropped', () => {
    expect(resolveModelReconnectErrorOverride(undefined, incompleteTurn)).toBeNull();
  });
});
