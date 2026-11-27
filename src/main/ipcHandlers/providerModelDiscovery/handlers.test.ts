import { ipcMain } from 'electron';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  ModelDiscoveryErrorCode,
  ProviderDiscoveryProtocol,
  ProviderModelDiscoveryIpcChannel,
} from '../../../shared/providers';
import { registerProviderModelDiscoveryHandlers } from './handlers';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  session: { defaultSession: { fetch: vi.fn() } },
}));

describe('registerProviderModelDiscoveryHandlers', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockReset();
  });

  test('registers IPC handler and delegates to injected fetch', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ data: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    registerProviderModelDiscoveryHandlers({ fetch: fetchMock });

    expect(ipcMain.handle).toHaveBeenCalledTimes(1);
    const [channel, handler] = vi.mocked(ipcMain.handle).mock.calls[0];
    expect(channel).toBe(ProviderModelDiscoveryIpcChannel.Discover);

    const result = await handler({} as Electron.IpcMainInvokeEvent, {
      baseUrl: 'https://api.deepseek.com',
      apiProtocol: ProviderDiscoveryProtocol.OpenAICompletions,
      apiKey: 'sk-test',
    });

    expect(result).toEqual({
      ok: true,
      models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('rejects malformed requests before issuing network calls', async () => {
    const fetchMock = vi.fn();
    registerProviderModelDiscoveryHandlers({ fetch: fetchMock });
    const handler = vi.mocked(ipcMain.handle).mock.calls[0][1];

    const result = await handler({} as Electron.IpcMainInvokeEvent, {
      baseUrl: '',
      apiProtocol: 'invalid-protocol',
    });

    expect(result).toMatchObject({
      ok: false,
      code: ModelDiscoveryErrorCode.InvalidBaseUrl,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
