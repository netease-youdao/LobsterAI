import { describe, expect, test, vi } from 'vitest';

import { AuthLoginFailureReason } from '../../../shared/auth/constants';
import { EmbeddedLoginService } from './embeddedLoginService';
import { EmbeddedLoginError, type EmbeddedLoginCompletion } from './embeddedLoginWindow';
import type { NavigationPolicy } from './loginUrlPolicy';

const CODE = '0f8fad5b-d9cb-469f-a165-70867728950e';
const transaction = { state: 'expected-state', codeVerifier: 'verifier', codeChallenge: 'challenge' };

interface ExchangeResult {
  success: boolean;
  error?: string;
  user?: { userId: string };
}

function harness(completion: Promise<EmbeddedLoginCompletion>) {
  const focus = vi.fn();
  const openWindow = vi.fn((_url: string, _policy: NavigationPolicy) => ({ result: completion, focus }));
  const exchange = vi.fn(async (_code: string, _verifier: string): Promise<ExchangeResult> => ({
    success: true,
    user: { userId: '7' },
  }));
  const service = new EmbeddedLoginService<ExchangeResult>({
    resolveLoginUrl: async () => 'https://lobsterai.youdao.com/portal#/login',
    createTransaction: () => transaction,
    allowedTopLevelOrigins: () => ['https://lobsterai-server.youdao.com'],
    openWindow,
    exchange,
  });
  return { service, openWindow, exchange, focus };
}

describe('EmbeddedLoginService', () => {
  test('opens the login page with the transaction and exchanges a valid completion', async () => {
    const h = harness(Promise.resolve({ code: CODE, state: 'expected-state' }));

    await expect(h.service.login()).resolves.toEqual({ success: true, user: { userId: '7' } });

    const [url, policy] = h.openWindow.mock.calls[0];
    expect(url).toContain('transport=embedded');
    expect(url).toContain('state=expected-state');
    expect(url).toContain('code_challenge=challenge');
    expect([...policy.allowedTopLevelOrigins]).toEqual([
      'https://lobsterai.youdao.com',
      'https://lobsterai-server.youdao.com',
    ]);
    expect(h.exchange).toHaveBeenCalledWith(CODE, 'verifier');
  });

  test('rejects a completion with another state or a malformed code without exchanging it', async () => {
    const wrongState = harness(Promise.resolve({ code: CODE, state: 'other' }));
    const badCode = harness(Promise.resolve({ code: 'not-a-code', state: 'expected-state' }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(wrongState.service.login()).resolves.toEqual({
      success: false,
      reason: AuthLoginFailureReason.InvalidCompletion,
    });
    await expect(badCode.service.login()).resolves.toEqual({
      success: false,
      reason: AuthLoginFailureReason.InvalidCompletion,
    });
    expect(wrongState.exchange).not.toHaveBeenCalled();
    expect(badCode.exchange).not.toHaveBeenCalled();
  });

  test('reports how the window ended', async () => {
    const h = harness(Promise.reject(new EmbeddedLoginError(AuthLoginFailureReason.Cancelled)));

    await expect(h.service.login()).resolves.toEqual({ success: false, reason: AuthLoginFailureReason.Cancelled });
  });

  test('marks a rejected exchange', async () => {
    const h = harness(Promise.resolve({ code: CODE, state: 'expected-state' }));
    h.exchange.mockResolvedValue({ success: false, error: 'Exchange failed: 500' });

    await expect(h.service.login()).resolves.toEqual({
      success: false,
      reason: AuthLoginFailureReason.ExchangeFailed,
      error: 'Exchange failed: 500',
    });
  });

  test('runs one login at a time and focuses the open window', async () => {
    let complete!: (value: EmbeddedLoginCompletion) => void;
    const h = harness(new Promise(resolve => { complete = resolve; }));

    const first = h.service.login();
    await vi.waitFor(() => expect(h.openWindow).toHaveBeenCalledTimes(1));
    const second = h.service.login();
    complete({ code: CODE, state: 'expected-state' });

    expect(second).toBe(first);
    expect(h.focus).toHaveBeenCalledTimes(1);
    await first;
    expect(h.openWindow).toHaveBeenCalledTimes(1);
  });
});
