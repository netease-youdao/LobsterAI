import { encode as encodeSilk } from 'silk-wasm';
import { describe, expect, test, vi } from 'vitest';

import {
  AsrLangType,
  AsrRealtimeEventType,
  type AsrRealtimeSessionResult,
} from '../../shared/asr/constants';
import {
  type AsrWebSocketLike,
  buildPcm16WavHeader,
  decodeVoiceToPcm16k,
  IM_VOICE_TARGET_SAMPLE_RATE,
  isMp3AudioBuffer,
  isOggOpusAudioBuffer,
  isOpusRawAudioBuffer,
  isSilkAudioBuffer,
  transcribeImVoiceAttachment,
  transcribePcm16kWithRealtimeAsr,
  WeixinVoiceEncodeType,
} from './imVoiceTranscription';

class FakeAsrWebSocket implements AsrWebSocketLike {
  readyState = 0;
  binaryType = 'arraybuffer';
  sentFrames: Array<string | Uint8Array> = [];
  closed = false;

  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(
    type: string,
    listener: (event: unknown) => void,
    options?: { once?: boolean },
  ): void {
    const wrapped = options?.once
      ? (evt: unknown) => {
          this.removeEventListener(type, wrapped);
          listener(evt);
        }
      : listener;
    let bucket = this.listeners.get(type);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(type, bucket);
    }
    bucket.add(wrapped);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown = {}): void {
    const bucket = this.listeners.get(type);
    if (!bucket) return;
    for (const listener of [...bucket]) {
      listener(event);
    }
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  send(data: string | Uint8Array): void {
    this.sentFrames.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit('close', { code: 1000, wasClean: true });
  }
}

function makeSinePcm16(sampleRate: number, durationSeconds: number, channels = 1): Uint8Array {
  const frameCount = Math.floor(sampleRate * durationSeconds);
  const out = new Uint8Array(frameCount * channels * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < frameCount; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12_000);
    for (let ch = 0; ch < channels; ch += 1) {
      view.setInt16((i * channels + ch) * 2, sample, true);
    }
  }
  return out;
}

function makeStereoWav(sampleRate: number, durationSeconds: number): Uint8Array {
  const pcm = makeSinePcm16(sampleRate, durationSeconds, 2);
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const writeStr = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, pcm.byteLength, true);

  const combined = new Uint8Array(header.byteLength + pcm.byteLength);
  combined.set(header, 0);
  combined.set(pcm, header.byteLength);
  return combined;
}

describe('imVoiceTranscription', () => {
  test('decodes Tencent SILK v3 audio directly into 16kHz 16-bit mono PCM', async () => {
    const sourcePcm = makeSinePcm16(24_000, 0.2, 1);
    const encoded = await encodeSilk(sourcePcm, 24_000);
    // Tencent WeChat voice files start with 0x02 followed by "#!SILK_V3".
    expect(isSilkAudioBuffer(encoded.data)).toBe(true);

    const decodedPcm16k = await decodeVoiceToPcm16k(encoded.data, {
      encodeType: WeixinVoiceEncodeType.Silk,
      sampleRate: 24_000,
    });

    // ~0.2s at 16kHz 16-bit mono = 6400 bytes
    expect(decodedPcm16k.byteLength).toBeGreaterThanOrEqual(5_000);
    expect(decodedPcm16k.byteLength % 2).toBe(0);
  });

  test('decodes and downsamples stereo WAV to 16kHz mono PCM16LE', async () => {
    const wav = makeStereoWav(24_000, 0.25);
    const decoded = await decodeVoiceToPcm16k(wav);

    // 0.25s * 16000 samples/sec * 2 bytes/sample = 8000 bytes
    expect(decoded.byteLength).toBe(IM_VOICE_TARGET_SAMPLE_RATE * 0.25 * 2);
  });

  test('decodes WeChat MP3 (encode_type=7) into 16kHz mono PCM16LE via mpg123-decoder', async () => {
    // MPEG-1 Layer III, 32kbps, 44100Hz, mono: 104 bytes per frame (1152 samples)
    const frame = new Uint8Array(104);
    frame[0] = 0xff;
    frame[1] = 0xfb;
    frame[2] = 0x10;
    frame[3] = 0xc4;
    const mp3 = new Uint8Array(frame.byteLength * 4);
    for (let i = 0; i < 4; i += 1) {
      mp3.set(frame, i * frame.byteLength);
    }

    expect(isMp3AudioBuffer(mp3)).toBe(true);
    const decoded = await decodeVoiceToPcm16k(mp3, {
      encodeType: WeixinVoiceEncodeType.Mp3,
    });

    // 4 frames * 1152 samples at 44.1kHz (~104.5ms) -> ~1672 samples at 16kHz -> ~3344 bytes
    expect(decoded.byteLength).toBeGreaterThanOrEqual(3_000);
    expect(decoded.byteLength % 2).toBe(0);
  });

  test('decodes WeChat #!OPUS_RAW_V1 (encode_type=7) packet streams into 16kHz mono PCM16LE', async () => {
    // Exact 16-byte header prefix observed on modern WeChat iLink voice messages:
    // "#!OPUS_RAW_V1" + 0x02 0x01 0x00
    const header = Buffer.from('23214f5055535f5241575f5631020100', 'hex');
    const opusPkt = Buffer.from([0x48, 0x0b, 0xe4, 0x61, 0x12, 0x00]); // WB 20ms SILK-mode mono Opus packet
    const chunks: Buffer[] = [header];
    for (let i = 0; i < 8; i += 1) {
      const lenBuf = Buffer.alloc(2);
      lenBuf.writeUInt16LE(opusPkt.length, 0);
      chunks.push(lenBuf, opusPkt);
    }
    const payload = Buffer.concat(chunks);

    expect(isOpusRawAudioBuffer(payload)).toBe(true);
    const decoded = await decodeVoiceToPcm16k(payload, {
      encodeType: WeixinVoiceEncodeType.Mp3,
      sampleRate: IM_VOICE_TARGET_SAMPLE_RATE,
    });

    // 8 packets * 20ms * 16 samples/ms * 2 bytes/sample = 5120 bytes
    expect(decoded.byteLength).toBe(8 * 320 * 2);
  });

  test('decodes standard Ogg Opus (Feishu / Telegram / Discord voice notes) via opus-decoder', async () => {
    const makeOggPage = (headerType: number, packets: Buffer[], pageSeq: number) => {
      const segTable: number[] = [];
      const bodyChunks: Buffer[] = [];
      for (const pkt of packets) {
        let rem = pkt.length;
        while (rem >= 255) {
          segTable.push(255);
          rem -= 255;
        }
        segTable.push(rem);
        bodyChunks.push(pkt);
      }
      const hdr = Buffer.alloc(27 + segTable.length);
      hdr.write('OggS', 0, 'ascii');
      hdr[4] = 0;
      hdr[5] = headerType;
      hdr.writeUInt32LE(12345, 14);
      hdr.writeUInt32LE(pageSeq, 18);
      hdr[26] = segTable.length;
      for (let i = 0; i < segTable.length; i += 1) {
        hdr[27 + i] = segTable[i]!;
      }
      return Buffer.concat([hdr, ...bodyChunks]);
    };

    const opusHead = Buffer.alloc(19);
    opusHead.write('OpusHead', 0, 'ascii');
    opusHead[8] = 1; // version
    opusHead[9] = 1; // mono
    opusHead.writeUInt16LE(0, 10); // preSkip = 0 for deterministic sample count
    opusHead.writeUInt32LE(16_000, 12);

    const opusTags = Buffer.alloc(16);
    opusTags.write('OpusTags', 0, 'ascii');

    const speechPkt = Buffer.from([0x48, 0x0b, 0xe4, 0x61, 0x12, 0x00]);
    const oggBuf = Buffer.concat([
      makeOggPage(0x02, [opusHead], 0),
      makeOggPage(0x00, [opusTags], 1),
      makeOggPage(0x04, [speechPkt, speechPkt, speechPkt, speechPkt], 2),
    ]);

    expect(isOggOpusAudioBuffer(oggBuf)).toBe(true);
    const decoded = await decodeVoiceToPcm16k(oggBuf);
    // 4 * 20ms * 16 samples/ms * 2 bytes = 2560 bytes
    expect(decoded.byteLength).toBe(4 * 320 * 2);
  });

  test('does not false-match non-MP3 containers labeled encode_type=7 and falls through to webAudioDecode', async () => {
    // Simulate M4A/AAC container where WeChat or an IM channel still reports encode_type=7
    const m4aHeader = Buffer.from('\x00\x00\x00\x1cftypM4A \x00\x00\x02\x00M4A mp42isom', 'binary');
    const payload = Buffer.concat([m4aHeader, Buffer.alloc(4096, 0xab)]);
    expect(isMp3AudioBuffer(payload)).toBe(false);

    const expectedPcm = makeSinePcm16(IM_VOICE_TARGET_SAMPLE_RATE, 0.2, 1);
    const webAudioDecode = vi.fn(async () => expectedPcm);

    const decoded = await decodeVoiceToPcm16k(payload, {
      encodeType: WeixinVoiceEncodeType.Mp3,
      webAudioDecode,
    });

    expect(webAudioDecode).toHaveBeenCalledTimes(1);
    expect(decoded).toEqual(expectedPcm);
  });

  test('streams WAV-prefixed PCM frames to realtime ASR WebSocket and stitches segments', async () => {
    const fakeSocket = new FakeAsrWebSocket();
    const createRealtimeSession = vi.fn(async (): Promise<AsrRealtimeSessionResult> => ({
      success: true,
      data: {
        requestId: 'req-1',
        wsUrl: 'wss://asr.example.test/ws',
        maxSessionSeconds: 60,
        maxConcurrentSessions: 1,
        chunkIntervalMillis: 100,
        usedSecondsToday: 0,
        remainingSecondsToday: 300,
        limitSecondsToday: 300,
      },
    }));

    const pcm16k = makeSinePcm16(IM_VOICE_TARGET_SAMPLE_RATE, 0.25, 1); // 8000 bytes
    const promise = transcribePcm16kWithRealtimeAsr(pcm16k, {
      createRealtimeSession,
      webSocketFactory: () => {
        queueMicrotask(() => {
          fakeSocket.open();
        });
        return fakeSocket;
      },
      frameDelayMs: 0,
      quietAfterFinalMs: 20,
      finalWaitMs: 500,
    });

    // Wait until end marker has been sent, then deliver recognition + closed events
    await vi.waitFor(() => {
      expect(fakeSocket.sentFrames.some((f) => f === JSON.stringify({ end: 'true' }))).toBe(true);
    });

    fakeSocket.emit('message', {
      data: JSON.stringify({
        type: AsrRealtimeEventType.Recognition,
        raw: {
          result: [
            { seg_id: 1, st: { sentence: '今天天气怎么样？', partial: false } },
            { seg_id: 0, st: { sentence: '你好，', partial: false } },
          ],
        },
      }),
    });
    fakeSocket.emit('message', {
      data: JSON.stringify({ type: AsrRealtimeEventType.Closed }),
    });

    const text = await promise;
    expect(text).toBe('你好，今天天气怎么样？');
    expect(createRealtimeSession).toHaveBeenCalledWith({ langType: AsrLangType.ZhChs });

    // First binary frame starts with a 44-byte 16kHz PCM16 WAV header
    const firstFrame = fakeSocket.sentFrames[0];
    expect(firstFrame).toBeInstanceOf(Uint8Array);
    const expectedHeader = buildPcm16WavHeader(IM_VOICE_TARGET_SAMPLE_RATE);
    expect((firstFrame as Uint8Array).subarray(0, 44)).toEqual(expectedHeader);
    expect(fakeSocket.sentFrames[fakeSocket.sentFrames.length - 1]).toBe(JSON.stringify({ end: 'true' }));
    expect(fakeSocket.closed).toBe(true);
  });

  test('propagates ASR error events cleanly and closes the socket', async () => {
    const fakeSocket = new FakeAsrWebSocket();
    const pcm16k = makeSinePcm16(IM_VOICE_TARGET_SAMPLE_RATE, 0.1, 1);

    const promise = transcribeImVoiceAttachment(
      {
        dataBase64: Buffer.from(pcm16k).toString('base64'),
        encodeType: WeixinVoiceEncodeType.Pcm,
        sampleRate: IM_VOICE_TARGET_SAMPLE_RATE,
      },
      {
        createRealtimeSession: async () => ({
          success: true,
          data: {
            requestId: 'req-err',
            wsUrl: 'wss://asr.example.test/ws',
            maxSessionSeconds: 60,
            maxConcurrentSessions: 1,
            chunkIntervalMillis: 200,
            usedSecondsToday: 0,
            remainingSecondsToday: 300,
            limitSecondsToday: 300,
          },
        }),
        webSocketFactory: () => {
          queueMicrotask(() => {
            fakeSocket.open();
            queueMicrotask(() => {
              fakeSocket.emit('message', {
                data: JSON.stringify({
                  type: AsrRealtimeEventType.Error,
                  code: 5001,
                  message: 'Upstream quota exceeded',
                }),
              });
            });
          });
          return fakeSocket;
        },
        frameDelayMs: 0,
      },
    );

    await expect(promise).rejects.toThrow('Upstream quota exceeded');
    expect(fakeSocket.closed).toBe(true);
  });
});
