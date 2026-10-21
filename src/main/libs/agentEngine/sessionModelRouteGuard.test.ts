import { describe, expect, test } from 'vitest';

import {
  checkSessionModelRoute,
  isPlanModelSubstitution,
  parseProviderModelRef,
  resolvePlanModelSubstitutionErrorOverride,
  SessionModelRouteError,
  SessionModelRouteVerdict,
} from './sessionModelRouteGuard';

const patchResult = (modelProvider: string, model: string) => ({
  ok: true,
  entry: {},
  resolved: { modelProvider, model },
});

describe('checkSessionModelRoute', () => {
  test('accepts the requested model and patch results without a resolution', () => {
    expect(checkSessionModelRoute('qwen/qwen3.8-max', patchResult('qwen', 'qwen3.8-max')).verdict)
      .toBe(SessionModelRouteVerdict.Ok);
    expect(checkSessionModelRoute('qwen/qwen3.8-max', undefined).verdict).toBe(SessionModelRouteVerdict.Ok);
    expect(checkSessionModelRoute('qwen/qwen3.8-max', { resolved: { modelProvider: 'qwen' } }).verdict)
      .toBe(SessionModelRouteVerdict.Ok);
  });

  test('blocks a plan model standing in for a custom selection', () => {
    expect(checkSessionModelRoute('qwen/qwen3.8-max', patchResult('lobsterai-server', 'qwen3.8-flash'))).toEqual({
      verdict: SessionModelRouteVerdict.PlanSubstitution,
      resolvedModelRef: 'lobsterai-server/qwen3.8-flash',
    });
  });

  test('only reports other differences, such as provider aliases or plan-to-plan changes', () => {
    expect(checkSessionModelRoute('zhipu/glm-5', patchResult('zai', 'glm-5')).verdict)
      .toBe(SessionModelRouteVerdict.Mismatch);
    expect(checkSessionModelRoute('lobsterai-server/qwen3.8-max', patchResult('lobsterai-server', 'qwen3.8-flash')).verdict)
      .toBe(SessionModelRouteVerdict.Mismatch);
    expect(checkSessionModelRoute('lobsterai-server/qwen3.8-max', patchResult('qwen', 'qwen3.8-max')).verdict)
      .toBe(SessionModelRouteVerdict.Mismatch);
  });
});

test('isPlanModelSubstitution needs a provider-qualified non-plan selection', () => {
  expect(isPlanModelSubstitution('qwen/qwen3.8-max', 'lobsterai-server')).toBe(true);
  expect(isPlanModelSubstitution('qwen3.8-max', 'lobsterai-server')).toBe(false);
  expect(isPlanModelSubstitution('lobsterai-server/qwen3.8-max', 'lobsterai-server')).toBe(false);
  expect(isPlanModelSubstitution('qwen/qwen3.8-max', undefined)).toBe(false);
  expect(parseProviderModelRef('openrouter/anthropic/claude-sonnet-5.5'))
    .toEqual({ provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' });
});

test('SessionModelRouteError names both models for the user', () => {
  const error = new SessionModelRouteError('qwen/qwen3.8-max', 'lobsterai-server/qwen3.8-flash');
  expect(error.message).toContain('qwen/qwen3.8-max');
  expect(error.message).toContain('qwen3.8-flash');
  expect(error.message).not.toContain('lobsterai-server');
});

describe('resolvePlanModelSubstitutionErrorOverride', () => {
  test('replaces the plan error when a custom selection ran on a plan model', () => {
    const override = resolvePlanModelSubstitutionErrorOverride(
      'qwen/qwen3.8-max',
      'free quota exhausted',
      { provider: 'lobsterai-server', model: 'qwen3.8-flash' },
    );
    expect(override?.errorMessage).toContain('qwen/qwen3.8-max');
    expect(override?.errorMessage).toContain('qwen3.8-flash');
    expect(override?.detailRawErrorMessage)
      .toBe('free quota exhausted\nRequested model: qwen/qwen3.8-max. Model that ran: lobsterai-server/qwen3.8-flash.');
  });

  test('keeps errors from the selected provider or plan selections untouched', () => {
    expect(resolvePlanModelSubstitutionErrorOverride('qwen/qwen3.8-max', 'x', { provider: 'qwen' })).toBeNull();
    expect(resolvePlanModelSubstitutionErrorOverride('lobsterai-server/qwen3.8-flash', 'x', { provider: 'lobsterai-server' }))
      .toBeNull();
    expect(resolvePlanModelSubstitutionErrorOverride('', 'x', { provider: 'lobsterai-server' })).toBeNull();
    expect(resolvePlanModelSubstitutionErrorOverride('qwen/qwen3.8-max', 'x', undefined)).toBeNull();
  });
});
