import { afterEach, describe, expect, test, vi } from 'vitest';

const { startRealtimeVoiceRecordingMock } = vi.hoisted(() => ({
  startRealtimeVoiceRecordingMock: vi.fn(),
}));

vi.mock('./realtimeAudioRecorder', () => ({
  startRealtimeVoiceRecording: startRealtimeVoiceRecordingMock,
}));

import { buildRealtimeAsrAudioFrames, startRealtimeVoiceInput } from './realtimeAsrClient';

const ascii = (bytes: Uint8Array, offset: number, length: number): string => (
  String.fromCharCode(...bytes.slice(offset, offset + length))
);

const makePcmBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = i % 251;
  }
  return bytes;
};

const concat = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

describe('buildRealtimeAsrAudioFrames', () => {
  test('keeps the WAV header inside the first binary frame size limit', () => {
    const pcm = makePcmBytes(8192);
    const result = buildRealtimeAsrAudioFrames({
      chunk: pcm,
      isFirstFrame: true,
      maxBinaryFrameBytes: 6400,
    });

    expect(result.isFirstFrame).toBe(false);
    expect(result.frames.map(frame => frame.byteLength)).toEqual([6400, 1836]);
    expect(result.frames.every(frame => frame.byteLength <= 6400)).toBe(true);
    expect(ascii(result.frames[0], 0, 4)).toBe('RIFF');
    expect(ascii(result.frames[0], 8, 4)).toBe('WAVE');
    expect(ascii(result.frames[0], 36, 4)).toBe('data');

    const recoveredPcm = concat([
      result.frames[0].slice(44),
      ...result.frames.slice(1),
    ]);
    expect(recoveredPcm).toEqual(pcm);
  });

  test('splits later PCM chunks without adding another WAV header', () => {
    const pcm = makePcmBytes(15000);
    const result = buildRealtimeAsrAudioFrames({
      chunk: pcm,
      isFirstFrame: false,
      maxBinaryFrameBytes: 6400,
    });

    expect(result.isFirstFrame).toBe(false);
    expect(result.frames.map(frame => frame.byteLength)).toEqual([6400, 6400, 2200]);
    expect(ascii(result.frames[0], 0, 4)).not.toBe('RIFF');
    expect(concat(result.frames)).toEqual(pcm);
  });

  test('normalizes too-small frame limits so splitting still makes progress', () => {
    const pcm = makePcmBytes(4);
    const result = buildRealtimeAsrAudioFrames({
      chunk: pcm,
      isFirstFrame: true,
      maxBinaryFrameBytes: 0,
    });

    expect(result.frames.map(frame => frame.byteLength)).toEqual([45, 3]);
    expect(concat([
      result.frames[0].slice(44),
      ...result.frames.slice(1),
    ])).toEqual(pcm);
  });
});

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'blob';
  closeCalls = 0;

  constructor(public readonly url: string) {
    super();
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  failHandshake(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event('error'));
    const closeEvent = Object.assign(new Event('close'), { code: 1006, wasClean: false });
    this.dispatchEvent(closeEvent);
  }

  send(): void {}

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
  }
}

describe('startRealtimeVoiceInput', () => {
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;

  afterEach(() => {
    vi.restoreAllMocks();
    startRealtimeVoiceRecordingMock.mockReset();
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      globalThis.window = originalWindow;
    }
    globalThis.WebSocket = originalWebSocket;
  });

  test('closes the WebSocket if microphone recording fails to start', async () => {
    const createdSockets: FakeWebSocket[] = [];
    class StubWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        createdSockets.push(this);
        queueMicrotask(() => this.open());
      }
    }
    globalThis.WebSocket = StubWebSocket as unknown as typeof WebSocket;

    const fromRenderer = vi.fn();
    globalThis.window = {
      electron: {
        asr: {
          createRealtimeSession: vi.fn(async () => ({
            success: true,
            data: {
              requestId: 'req-mic-fail',
              wsUrl: 'wss://lobsterai-server.youdao.com/api/asr/realtime/ws?ticket=t1',
              expiresInSeconds: 120,
              chunkIntervalMillis: 200,
              maxSessionSeconds: 600,
              maxConcurrentSessions: 2,
              usedSecondsToday: 0,
              remainingSecondsToday: 600,
              limitSecondsToday: 600,
            },
          })),
        },
        log: { fromRenderer },
      },
    } as unknown as Window & typeof globalThis;

    const micError = new DOMException('Permission denied', 'NotAllowedError');
    startRealtimeVoiceRecordingMock.mockRejectedValueOnce(micError);

    await expect(startRealtimeVoiceInput({
      onText: vi.fn(),
      onError: vi.fn(),
    })).rejects.toBe(micError);

    expect(createdSockets).toHaveLength(1);
    expect(createdSockets[0].closeCalls).toBe(1);
  });

  test('forwards WebSocket handshake failure diagnostics to main log', async () => {
    class StubWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        queueMicrotask(() => this.failHandshake());
      }
    }
    globalThis.WebSocket = StubWebSocket as unknown as typeof WebSocket;

    const fromRenderer = vi.fn();
    globalThis.window = {
      electron: {
        asr: {
          createRealtimeSession: vi.fn(async () => ({
            success: true,
            data: {
              requestId: 'req-ws-fail',
              wsUrl: 'wss://lobsterai-server.youdao.com/api/asr/realtime/ws?ticket=secret-ticket',
              expiresInSeconds: 120,
              chunkIntervalMillis: 200,
              maxSessionSeconds: 600,
              maxConcurrentSessions: 2,
              usedSecondsToday: 0,
              remainingSecondsToday: 600,
              limitSecondsToday: 600,
            },
          })),
        },
        log: { fromRenderer },
      },
    } as unknown as Window & typeof globalThis;

    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(startRealtimeVoiceInput({
      onText: vi.fn(),
      onError: vi.fn(),
    })).rejects.toThrow();

    expect(fromRenderer).toHaveBeenCalledWith(
      'warn',
      'VoiceInput',
      'realtime ASR WebSocket error event; requestId=req-ws-fail',
    );
    expect(fromRenderer).toHaveBeenCalledWith(
      'warn',
      'VoiceInput',
      'realtime ASR WebSocket closed unexpectedly; requestId=req-ws-fail, code=1006, clean=false',
    );
    for (const [, , msg] of fromRenderer.mock.calls) {
      expect(String(msg)).not.toContain('secret-ticket');
    }
  });
});
