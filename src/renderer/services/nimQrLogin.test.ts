import { describe, expect, test, vi } from 'vitest';

import {
  buildQrPayload,
  isPendingBindResult,
  NimQrLoginErrorCode,
  NimQrLoginStatus,
  normalizeBindResult,
  pollQrLogin,
  startQrLogin,
} from './nimQrLogin';

describe('nimQrLogin helpers', () => {
  test('buildQrPayload returns raw uuid when no template is provided', () => {
    expect(buildQrPayload('uuid-1')).toBe('uuid-1');
  });

  test('buildQrPayload replaces template placeholder', () => {
    expect(buildQrPayload('uuid-1', 'nim://bind?uuid={uuid}')).toBe('nim://bind?uuid=uuid-1');
  });

  test('isPendingBindResult detects not found payload', () => {
    expect(isPendingBindResult({ code: 200, data: 'not found' })).toBe(true);
    expect(isPendingBindResult({ code: 404, msg: 'not found', data: null })).toBe(true);
  });

  test('normalizeBindResult returns credentials from success payload', () => {
    expect(normalizeBindResult({
      code: 200,
      data: {
        appkey: 'app-key',
        accid: 'bot-account',
        token: 'bot-token',
      },
    })).toEqual({
      appKey: 'app-key',
      account: 'bot-account',
      token: 'bot-token',
    });
  });

  test('normalizeBindResult throws on malformed payload', () => {
    expect(() => normalizeBindResult({ code: 200, data: {} })).toThrow(NimQrLoginErrorCode.InvalidPayload);
  });
});

describe('nimQrLogin service', () => {
  test('startQrLogin calls renderer IPC bridge', async () => {
    (globalThis as { window?: unknown }).window = {
      electron: {
        im: {
          nimQrLoginStart: vi.fn().mockResolvedValue({
            uuid: 'uuid-1',
            qrValue: JSON.stringify({ qrCode: 'uuid-1', expireAt: 1234567890 }),
            expiresIn: 180,
            pollInterval: 3000,
            credentialKind: 'split',
            rawData: { qrCode: 'uuid-1', expireAt: 1234567890 },
          }),
        },
      },
    };

    await expect(startQrLogin()).resolves.toEqual({
      uuid: 'uuid-1',
      qrValue: JSON.stringify({ qrCode: 'uuid-1', expireAt: 1234567890 }),
      expiresIn: 180,
      pollInterval: 3000,
      credentialKind: 'split',
      rawData: { qrCode: 'uuid-1', expireAt: 1234567890 },
    });
  });

  test('pollQrLogin returns pending result from IPC bridge', async () => {
    (globalThis as { window?: unknown }).window = {
      electron: {
        im: {
          nimQrLoginPoll: vi.fn().mockResolvedValue({
            status: NimQrLoginStatus.Pending,
          }),
        },
      },
    };

    await expect(pollQrLogin('uuid-1')).resolves.toEqual({
      status: NimQrLoginStatus.Pending,
    });
  });

  test('pollQrLogin returns success result from IPC bridge', async () => {
    (globalThis as { window?: unknown }).window = {
      electron: {
        im: {
          nimQrLoginPoll: vi.fn().mockResolvedValue({
            status: NimQrLoginStatus.Success,
            credentials: {
              appKey: 'app-key',
              account: 'bot-account',
              token: 'bot-token',
            },
          }),
        },
      },
    };

    await expect(pollQrLogin('uuid-1')).resolves.toEqual({
      status: NimQrLoginStatus.Success,
      credentials: {
        appKey: 'app-key',
        account: 'bot-account',
        token: 'bot-token',
      },
    });
  });

  test('pollQrLogin returns failed result from IPC bridge', async () => {
    (globalThis as { window?: unknown }).window = {
      electron: {
        im: {
          nimQrLoginPoll: vi.fn().mockResolvedValue({
            status: NimQrLoginStatus.Failed,
            errorCode: NimQrLoginErrorCode.InvalidPayload,
            error: NimQrLoginErrorCode.InvalidPayload,
          }),
        },
      },
    };

    await expect(pollQrLogin('uuid-1')).resolves.toEqual({
      status: NimQrLoginStatus.Failed,
      errorCode: NimQrLoginErrorCode.InvalidPayload,
      error: NimQrLoginErrorCode.InvalidPayload,
    });
  });

  test('startQrLogin propagates IPC errors', async () => {
    (globalThis as { window?: unknown }).window = {
      electron: {
        im: {
          nimQrLoginStart: vi.fn().mockRejectedValue(new Error('boom')),
        },
      },
    };

    await expect(startQrLogin()).rejects.toThrow('boom');
  });
});
