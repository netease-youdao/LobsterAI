import { beforeEach, describe, expect, test, vi } from 'vitest';

const { registeredHandlers } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      registeredHandlers.set(channel, handler);
    }),
  },
}));

import { AsrApiCode, AsrIpcChannel, AsrLangType } from '../../../shared/asr/constants';
import { registerAsrIpcHandlers } from './handlers';

describe('registerAsrIpcHandlers', () => {
  beforeEach(() => {
    registeredHandlers.clear();
  });

  test('notifies onRealtimeSessionCreated with wsUrl and sender id when session succeeds', async () => {
    const onRealtimeSessionCreated = vi.fn();
    const fetchWithAuth = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: {
        requestId: 'req-1',
        wsUrl: 'wss://lobsterai-server.youdao.com/api/asr/realtime/ws?ticket=t1',
        expiresInSeconds: 180,
        chunkIntervalMillis: 200,
        maxSessionSeconds: 600,
        maxConcurrentSessions: 2,
        usedSecondsToday: 0,
        remainingSecondsToday: 600,
        limitSecondsToday: 600,
      },
    }), { status: 200 }));

    registerAsrIpcHandlers({
      getAuthTokens: () => ({ accessToken: 'a', refreshToken: 'r' }),
      fetchWithAuth,
      getServerApiBaseUrl: () => 'https://lobsterai-server.youdao.com',
      onRealtimeSessionCreated,
    });

    const handler = registeredHandlers.get(AsrIpcChannel.CreateRealtimeSession);
    expect(handler).toBeDefined();
    const result = await handler!({ sender: { id: 42 } }, { langType: AsrLangType.ZhChs });

    expect(result).toMatchObject({ success: true });
    expect(onRealtimeSessionCreated).toHaveBeenCalledExactlyOnceWith(
      'wss://lobsterai-server.youdao.com/api/asr/realtime/ws?ticket=t1',
      42,
      180,
    );
  });

  test('does not notify onRealtimeSessionCreated when session request fails', async () => {
    const onRealtimeSessionCreated = vi.fn();
    registerAsrIpcHandlers({
      getAuthTokens: () => null,
      fetchWithAuth: vi.fn(),
      getServerApiBaseUrl: () => 'https://lobsterai-server.youdao.com',
      onRealtimeSessionCreated,
    });

    const handler = registeredHandlers.get(AsrIpcChannel.CreateRealtimeSession);
    const result = await handler!({ sender: { id: 42 } }, { langType: AsrLangType.ZhChs });

    expect(result).toEqual({
      success: false,
      code: AsrApiCode.Unauthorized,
      error: 'Unauthorized',
    });
    expect(onRealtimeSessionCreated).not.toHaveBeenCalled();
  });
});
