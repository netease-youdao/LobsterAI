import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { NimQrLoginErrorCode, NimQrLoginStatus } from '../../shared/im/nimQrLogin';
import { pollNimQrLogin, startNimQrLogin } from './nimQrLoginService';

function jsonResponse(payload: unknown): Response {
  return {
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

function setFetchMock(payload: unknown): void {
  global.fetch = vi.fn().mockResolvedValue(jsonResponse(payload)) as unknown as typeof fetch;
}

describe('nimQrLoginService', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
  });

  test('startNimQrLogin accepts qrCode response and computes expiresIn', async () => {
    vi.setSystemTime(new Date('2026-04-17T03:00:00.000Z'));
    setFetchMock({
      code: 200,
      data: {
        qrCode: 'uuid-1',
        expireAt: Date.now() + 30_000,
      },
    });

    await expect(startNimQrLogin()).resolves.toMatchObject({
      uuid: 'uuid-1',
      qrValue: JSON.stringify({
        qrCode: 'uuid-1',
        expireAt: Date.now() + 30_000,
      }),
      credentialKind: 'split',
      rawData: {
        qrCode: 'uuid-1',
      },
    });
  });

  test('pollNimQrLogin returns pending for live not found response shape', async () => {
    setFetchMock({ code: 404, msg: 'not found', data: null });

    await expect(pollNimQrLogin('uuid-1')).resolves.toEqual({
      status: NimQrLoginStatus.Pending,
    });
  });

  test('pollNimQrLogin returns success with normalized credentials', async () => {
    setFetchMock({
      code: 200,
      data: {
        appkey: 'app-key',
        accid: 'account-id',
        token: 'token-value',
      },
    });

    await expect(pollNimQrLogin('uuid-1')).resolves.toEqual({
      status: NimQrLoginStatus.Success,
      credentials: {
        appKey: 'app-key',
        account: 'account-id',
        token: 'token-value',
      },
    });
  });

  test('pollNimQrLogin returns invalid user agent failure', async () => {
    setFetchMock({
      code: 414,
      msg: 'invalid user-agent',
      data: null,
    });

    await expect(pollNimQrLogin('uuid-1')).resolves.toEqual({
      status: NimQrLoginStatus.Failed,
      errorCode: NimQrLoginErrorCode.InvalidUserAgent,
      error: NimQrLoginErrorCode.InvalidUserAgent,
    });
  });
});
