import type { BeforeSendResponse, OnBeforeSendHeadersListenerDetails, Session, WebRequestFilter } from 'electron';
import { describe, expect, test, vi } from 'vitest';

import { createAsrRealtimeWsOriginStripper } from './realtimeWsOrigin';

type BeforeSendListener = (
  details: OnBeforeSendHeadersListenerDetails,
  callback: (response: BeforeSendResponse) => void,
) => void;

const WS_URL = 'wss://lobsterai-server.youdao.com/api/asr/realtime/ws?ticket=abc123';

describe('createAsrRealtimeWsOriginStripper', () => {
  test('strips Origin header for an authorized ASR WebSocket upgrade from the same webContents', () => {
    const stripper = createAsrRealtimeWsOriginStripper({ now: () => 1_000 });
    stripper.allow(WS_URL, 7, 120);

    const result = stripper.stripOriginIfAuthorized({
      url: WS_URL,
      resourceType: 'webSocket',
      webContentsId: 7,
      requestHeaders: {
        Origin: 'http://localhost:5175',
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Version': '13',
      },
    });

    expect(result).toEqual({
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Version': '13',
    });
  });

  test('strips lowercase origin header and handles ws:// with explicit port', () => {
    const localWsUrl = 'ws://127.0.0.1:8787/api/asr/realtime/ws?ticket=dev-1';
    const stripper = createAsrRealtimeWsOriginStripper({ now: () => 1_000 });
    stripper.allow(localWsUrl, 3, 60);

    const result = stripper.stripOriginIfAuthorized({
      url: localWsUrl,
      resourceType: 'webSocket',
      webContentsId: 3,
      requestHeaders: {
        origin: 'http://localhost:5175',
        Upgrade: 'websocket',
      },
    });

    expect(result).toEqual({ Upgrade: 'websocket' });
  });

  test('leaves Origin untouched for different webContents, ticket, URL, or non-WebSocket resource', () => {
    const stripper = createAsrRealtimeWsOriginStripper({ now: () => 1_000 });
    stripper.allow(WS_URL, 7, 120);
    const headers = { Origin: 'http://localhost:5175', Upgrade: 'websocket' };

    expect(stripper.stripOriginIfAuthorized({
      url: WS_URL,
      resourceType: 'webSocket',
      webContentsId: 8,
      requestHeaders: headers,
    })).toBe(headers);

    expect(stripper.stripOriginIfAuthorized({
      url: 'wss://lobsterai-server.youdao.com/api/asr/realtime/ws?ticket=other',
      resourceType: 'webSocket',
      webContentsId: 7,
      requestHeaders: headers,
    })).toBe(headers);

    expect(stripper.stripOriginIfAuthorized({
      url: 'ws://localhost:5175/',
      resourceType: 'webSocket',
      webContentsId: 7,
      requestHeaders: headers,
    })).toBe(headers);

    expect(stripper.stripOriginIfAuthorized({
      url: WS_URL,
      resourceType: 'xhr',
      webContentsId: 7,
      requestHeaders: headers,
    })).toBe(headers);
  });

  test('stops stripping Origin after the ticket TTL expires', () => {
    let currentTime = 10_000;
    const stripper = createAsrRealtimeWsOriginStripper({ now: () => currentTime });
    stripper.allow(WS_URL, 7, 90);

    currentTime = 10_000 + 89_999;
    expect(stripper.stripOriginIfAuthorized({
      url: WS_URL,
      resourceType: 'webSocket',
      webContentsId: 7,
      requestHeaders: { Origin: 'http://localhost:5175' },
    })).toEqual({});

    currentTime = 10_000 + 90_000;
    const headers = { Origin: 'http://localhost:5175' };
    expect(stripper.stripOriginIfAuthorized({
      url: WS_URL,
      resourceType: 'webSocket',
      webContentsId: 7,
      requestHeaders: headers,
    })).toBe(headers);
  });

  test('ignores non-WebSocket URLs and caps tracked entries by evicting oldest', () => {
    const stripper = createAsrRealtimeWsOriginStripper({ now: () => 1_000 });
    stripper.allow('https://lobsterai-server.youdao.com/api/asr/realtime/ws', 7, 120);
    stripper.allow('not-a-url', 7, 120);

    for (let i = 0; i < 40; i += 1) {
      stripper.allow(`wss://lobsterai-server.youdao.com/api/asr/realtime/ws?ticket=t${i}`, 7, 120);
    }

    const oldHeaders = { Origin: 'http://localhost:5175' };
    expect(stripper.stripOriginIfAuthorized({
      url: 'wss://lobsterai-server.youdao.com/api/asr/realtime/ws?ticket=t0',
      resourceType: 'webSocket',
      webContentsId: 7,
      requestHeaders: oldHeaders,
    })).toBe(oldHeaders);

    expect(stripper.stripOriginIfAuthorized({
      url: 'wss://lobsterai-server.youdao.com/api/asr/realtime/ws?ticket=t39',
      resourceType: 'webSocket',
      webContentsId: 7,
      requestHeaders: { Origin: 'http://localhost:5175', Upgrade: 'websocket' },
    })).toEqual({ Upgrade: 'websocket' });
  });

  test('attaches a webSocket-scoped onBeforeSendHeaders handler to the session', () => {
    const onBeforeSendHeaders = vi.fn();
    const fakeSession = {
      webRequest: { onBeforeSendHeaders },
    } as unknown as Pick<Session, 'webRequest'>;

    const stripper = createAsrRealtimeWsOriginStripper({ now: () => 1_000 });
    stripper.allow(WS_URL, 11, 120);
    stripper.attachToSession(fakeSession);

    expect(onBeforeSendHeaders).toHaveBeenCalledTimes(1);
    const [filter, listener] = onBeforeSendHeaders.mock.calls[0] as [WebRequestFilter, BeforeSendListener];
    expect(filter).toEqual({
      urls: ['ws://*/*', 'wss://*/*'],
      types: ['webSocket'],
    });

    const callback = vi.fn();
    listener({
      id: 1,
      url: WS_URL,
      method: 'GET',
      resourceType: 'webSocket',
      webContentsId: 11,
      referrer: '',
      timestamp: 1_000,
      requestHeaders: {
        Origin: 'http://localhost:5175',
        Upgrade: 'websocket',
      },
    }, callback);

    expect(callback).toHaveBeenCalledWith({
      requestHeaders: { Upgrade: 'websocket' },
    });
  });
});
