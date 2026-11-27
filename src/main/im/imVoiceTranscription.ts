// Decodes inbound IM voice audio (WeChat SILK v3 / MP3 / WAV / PCM and
// fallback formats via system tools) into 16kHz 16-bit mono PCM and
// transcribes it using LobsterAI's authenticated realtime ASR WebSocket.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  AsrLangType,
  type AsrRealtimeEvent,
  AsrRealtimeEventType,
  type AsrRealtimeSessionRequest,
  type AsrRealtimeSessionResult,
} from '../../shared/asr/constants';

const execFileAsync = promisify(execFile);

export const IM_VOICE_TARGET_SAMPLE_RATE = 16_000;
const PCM16_BYTES_PER_SAMPLE = 2;
const DEFAULT_FRAME_DELAY_MS = 20;
const DEFAULT_OPEN_TIMEOUT_MS = 10_000;
const DEFAULT_FINAL_WAIT_MS = 8_000;
const DEFAULT_QUIET_AFTER_FINAL_MS = 800;
const SYSTEM_DECODE_TIMEOUT_MS = 15_000;

export const WeixinVoiceEncodeType = {
  Pcm: 1,
  Adpcm: 2,
  Feature: 3,
  Speex: 4,
  Amr: 5,
  Silk: 6,
  Mp3: 7,
  OggSpeex: 8,
} as const;

export interface AsrWebSocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

export interface ImVoiceTranscriptionDeps {
  createRealtimeSession: (options?: AsrRealtimeSessionRequest) => Promise<AsrRealtimeSessionResult>;
  webAudioDecode?: (audioBuf: Uint8Array) => Promise<Uint8Array | null>;
  webSocketFactory?: (wsUrl: string) => AsrWebSocketLike;
  frameDelayMs?: number;
  openTimeoutMs?: number;
  finalWaitMs?: number;
  quietAfterFinalMs?: number;
}

export interface ImVoiceDecodeOptions {
  encodeType?: number;
  sampleRate?: number;
  webAudioDecode?: (audioBuf: Uint8Array) => Promise<Uint8Array | null>;
}

export function findSilkHeaderOffset(buf: Uint8Array): number {
  if (buf.byteLength < 7) return -1;
  const searchLen = Math.min(buf.byteLength, 64);
  const head = Buffer.from(buf.buffer, buf.byteOffset, searchLen);
  const idx = head.indexOf('#!SILK', 0, 'ascii');
  if (idx < 0) return -1;
  // Preserve Tencent's leading 0x02 prefix byte when present immediately before "#!SILK".
  return idx > 0 && buf[idx - 1] === 0x02 ? idx - 1 : idx;
}

export function isSilkAudioBuffer(buf: Uint8Array): boolean {
  return findSilkHeaderOffset(buf) >= 0;
}

export function findOpusRawMagicEnd(buf: Uint8Array): number {
  if (buf.byteLength < 11) return -1;
  const searchLen = Math.min(buf.byteLength, 48);
  const head = Buffer.from(buf.buffer, buf.byteOffset, searchLen);
  const idx = head.indexOf('OPUS_RAW_V', 0, 'ascii');
  if (idx < 0) return -1;
  // Advance past version digits (e.g. "OPUS_RAW_V1" -> 11 chars)
  let end = idx + 'OPUS_RAW_V'.length;
  while (end < buf.byteLength && buf[end]! >= 0x30 && buf[end]! <= 0x39) {
    end += 1;
  }
  return end;
}

export function isOpusRawAudioBuffer(buf: Uint8Array): boolean {
  return findOpusRawMagicEnd(buf) > 0;
}

export function isOggOpusAudioBuffer(buf: Uint8Array): boolean {
  if (buf.byteLength < 36) return false;
  const magic = Buffer.from(buf.buffer, buf.byteOffset, 4).toString('ascii');
  if (magic !== 'OggS') return false;
  const headSlice = Buffer.from(buf.buffer, buf.byteOffset, Math.min(buf.byteLength, 128));
  return headSlice.indexOf('OpusHead', 0, 'ascii') >= 0;
}

export function isAmrAudioBuffer(buf: Uint8Array): boolean {
  if (buf.byteLength < 6) return false;
  const magic = Buffer.from(buf.buffer, buf.byteOffset, 6).toString('ascii');
  return magic === '#!AMR\n' || magic === '#!AMR-';
}

export function isWavAudioBuffer(buf: Uint8Array): boolean {
  if (buf.byteLength < 44) return false;
  const header = Buffer.from(buf.buffer, buf.byteOffset, 12).toString('ascii');
  return header.startsWith('RIFF') && header.slice(8, 12) === 'WAVE';
}

export function isMp3AudioBuffer(buf: Uint8Array): boolean {
  if (buf.byteLength < 4) return false;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    return true;
  }
  const b1 = buf[1] ?? 0;
  const b2 = buf[2] ?? 0;
  const syncOk = buf[0] === 0xff && (b1 & 0xe0) === 0xe0;
  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  const bitrateIdx = (b2 >> 4) & 0x0f;
  const sampleRateIdx = (b2 >> 2) & 0x03;
  return (
    syncOk &&
    versionBits !== 0x01 &&
    layerBits !== 0x00 &&
    bitrateIdx !== 0x00 &&
    bitrateIdx !== 0x0f &&
    sampleRateIdx !== 0x03
  );
}

function formatHeaderHex(buf: Uint8Array, maxBytes = 32): string {
  const len = Math.min(buf.byteLength, maxBytes);
  return Buffer.from(buf.buffer, buf.byteOffset, len).toString('hex');
}

export function buildPcm16WavHeader(sampleRate: number, dataSize = 0xffffffff): Uint8Array {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const writeStr = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, dataSize === 0xffffffff ? 0xffffffff : 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * PCM16_BYTES_PER_SAMPLE, true);
  view.setUint16(32, PCM16_BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  return new Uint8Array(buffer);
}

function resamplePcm16Mono(
  pcm16le: Uint8Array,
  sourceSampleRate: number,
  targetSampleRate: number,
): Uint8Array {
  const sampleCount = Math.floor(pcm16le.byteLength / PCM16_BYTES_PER_SAMPLE);
  if (sampleCount <= 0) return new Uint8Array(0);
  if (sourceSampleRate === targetSampleRate || sourceSampleRate <= 0) {
    return pcm16le.subarray(0, sampleCount * PCM16_BYTES_PER_SAMPLE);
  }

  const srcView = new DataView(pcm16le.buffer, pcm16le.byteOffset, sampleCount * PCM16_BYTES_PER_SAMPLE);
  const ratio = sourceSampleRate / targetSampleRate;
  const outSamples = Math.max(1, Math.round(sampleCount / ratio));
  const out = new Uint8Array(outSamples * PCM16_BYTES_PER_SAMPLE);
  const outView = new DataView(out.buffer);

  for (let i = 0; i < outSamples; i += 1) {
    const srcIdx = i * ratio;
    const leftIdx = Math.floor(srcIdx);
    const rightIdx = Math.min(leftIdx + 1, sampleCount - 1);
    const frac = srcIdx - leftIdx;
    const left = srcView.getInt16(leftIdx * 2, true);
    const right = srcView.getInt16(rightIdx * 2, true);
    const sample = Math.max(-32768, Math.min(32767, Math.round(left + (right - left) * frac)));
    outView.setInt16(i * 2, sample, true);
  }
  return out;
}

function extractWavPcm16Mono(wavBuf: Uint8Array): { pcm16le: Uint8Array; sampleRate: number } {
  const view = new DataView(wavBuf.buffer, wavBuf.byteOffset, wavBuf.byteLength);
  let offset = 12;
  let sampleRate = IM_VOICE_TARGET_SAMPLE_RATE;
  let channels = 1;
  let bitsPerSample = 16;
  let dataSlice: Uint8Array | null = null;

  while (offset + 8 <= wavBuf.byteLength) {
    const id = Buffer.from(wavBuf.buffer, wavBuf.byteOffset + offset, 4).toString('ascii');
    const size = view.getUint32(offset + 4, true);
    const payloadStart = offset + 8;
    const payloadEnd = Math.min(wavBuf.byteLength, payloadStart + size);
    if (id === 'fmt ' && size >= 16) {
      channels = Math.max(1, view.getUint16(payloadStart + 2, true));
      sampleRate = view.getUint32(payloadStart + 4, true);
      bitsPerSample = view.getUint16(payloadStart + 14, true);
    } else if (id === 'data') {
      dataSlice = wavBuf.subarray(payloadStart, payloadEnd);
    }
    offset = payloadStart + size + (size % 2);
  }

  if (!dataSlice || dataSlice.byteLength === 0) {
    throw new Error('WAV audio contains no data chunk');
  }
  if (bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}`);
  }
  if (channels === 1) {
    return { pcm16le: dataSlice, sampleRate };
  }

  const bytesPerFrame = channels * PCM16_BYTES_PER_SAMPLE;
  const frameCount = Math.floor(dataSlice.byteLength / bytesPerFrame);
  const srcView = new DataView(dataSlice.buffer, dataSlice.byteOffset, frameCount * bytesPerFrame);
  const mono = new Uint8Array(frameCount * PCM16_BYTES_PER_SAMPLE);
  const monoView = new DataView(mono.buffer);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      sum += srcView.getInt16(frame * bytesPerFrame + ch * 2, true);
    }
    monoView.setInt16(frame * 2, Math.max(-32768, Math.min(32767, Math.round(sum / channels))), true);
  }
  return { pcm16le: mono, sampleRate };
}

function floatChannelsToPcm16Mono(channelData: Float32Array[]): Uint8Array {
  const frameCount = channelData[0]?.length ?? 0;
  if (channelData.length === 0 || frameCount <= 0) return new Uint8Array(0);
  const channels = channelData.length;
  const out = new Uint8Array(frameCount * PCM16_BYTES_PER_SAMPLE);
  const view = new DataView(out.buffer);
  for (let i = 0; i < frameCount; i += 1) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      sum += channelData[ch]?.[i] ?? 0;
    }
    const clamped = Math.max(-1, Math.min(1, sum / channels));
    const sample = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(i * 2, Math.max(-32768, Math.min(32767, sample)), true);
  }
  return out;
}

function isPlausibleOpusPacket(pkt: Uint8Array): boolean {
  if (pkt.byteLength < 1 || pkt.byteLength > 1275) return false;
  const toc = pkt[0]!;
  const frameCountCode = toc & 0x03;
  if (frameCountCode === 0) {
    return true;
  }
  if (frameCountCode === 1) {
    return (pkt.byteLength - 1) % 2 === 0;
  }
  if (frameCountCode === 2) {
    if (pkt.byteLength < 2) return false;
    const b1 = pkt[1]!;
    if (b1 < 252) return 2 + b1 <= pkt.byteLength;
    if (pkt.byteLength < 3) return false;
    return 3 + b1 + 4 * pkt[2]! <= pkt.byteLength;
  }
  if (pkt.byteLength < 2) return false;
  const m = pkt[1]! & 0x3f;
  return m >= 1 && m <= 48;
}

interface OpusRawCandidate {
  mode: string;
  headerOffset: number;
  packets: Uint8Array[];
  score: number;
}

function scoreOpusPacketStream(
  packets: Uint8Array[],
  exactEof: boolean,
  headerOffset: number,
  minPackets: number,
): number | null {
  if (packets.length < minPackets) return null;
  const tocCounts = new Map<number, number>();
  let maxTocCount = 0;
  let monoCount = 0;

  for (const pkt of packets) {
    if (!isPlausibleOpusPacket(pkt)) return null;
    const toc = pkt[0]!;
    const key = toc & 0xfc;
    const next = (tocCounts.get(key) ?? 0) + 1;
    tocCounts.set(key, next);
    if (next > maxTocCount) maxTocCount = next;
    if ((toc & 0x04) === 0) monoCount += 1;
  }

  const dominantRatio = maxTocCount / packets.length;
  if (packets.length >= 4 && dominantRatio < 0.5) return null;
  const monoRatio = monoCount / packets.length;
  return (exactEof ? 1000 : 850) + dominantRatio * 500 + monoRatio * 100 - headerOffset * 0.5;
}

export function extractOpusRawCandidates(buf: Uint8Array): OpusRawCandidate[] {
  const magicEnd = findOpusRawMagicEnd(buf);
  if (magicEnd < 0) return [];

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const maxHeaderOffset = Math.min(buf.byteLength - 2, magicEnd + 128);
  const minPackets = buf.byteLength > 300 ? 3 : 1;

  type PrefixMode = {
    name: string;
    prefixBytes: number;
    readLen: (offset: number) => number;
    isEofSentinel?: (offset: number, remaining: number) => boolean;
  };

  const isAllZeroOrAllFf = (off: number, rem: number): boolean => {
    if (rem < 1 || rem > 4) return false;
    const first = buf[off];
    if (first !== 0x00 && first !== 0xff) return false;
    for (let i = 1; i < rem; i += 1) {
      if (buf[off + i] !== first) return false;
    }
    return true;
  };

  const modes: PrefixMode[] = [
    {
      name: 'u16le',
      prefixBytes: 2,
      readLen: (off) => view.getUint16(off, true),
      isEofSentinel: isAllZeroOrAllFf,
    },
    {
      name: 'u16be',
      prefixBytes: 2,
      readLen: (off) => view.getUint16(off, false),
      isEofSentinel: isAllZeroOrAllFf,
    },
    {
      name: 'u8',
      prefixBytes: 1,
      readLen: (off) => view.getUint8(off),
      isEofSentinel: (off, rem) => rem === 1 && (buf[off] === 0x00 || buf[off] === 0xff),
    },
    {
      name: 'u32le',
      prefixBytes: 4,
      readLen: (off) => view.getUint32(off, true),
      isEofSentinel: isAllZeroOrAllFf,
    },
    {
      name: 'u32be',
      prefixBytes: 4,
      readLen: (off) => view.getUint32(off, false),
      isEofSentinel: isAllZeroOrAllFf,
    },
    {
      name: 'u16le_meta2',
      prefixBytes: 4,
      readLen: (off) => view.getUint16(off, true),
    },
    {
      name: 'meta2_u16le',
      prefixBytes: 4,
      readLen: (off) => view.getUint16(off + 2, true),
    },
    {
      name: 'u16be_meta2',
      prefixBytes: 4,
      readLen: (off) => view.getUint16(off, false),
    },
    {
      name: 'meta2_u16be',
      prefixBytes: 4,
      readLen: (off) => view.getUint16(off + 2, false),
    },
    {
      name: 'meta1_u16le',
      prefixBytes: 3,
      readLen: (off) => view.getUint16(off + 1, true),
    },
    {
      name: 'u32be_range4',
      prefixBytes: 8,
      readLen: (off) => view.getUint32(off, false),
    },
    {
      name: 'u32le_range4',
      prefixBytes: 8,
      readLen: (off) => view.getUint32(off, true),
    },
  ];

  const scanWithTrailingLimit = (maxTrailingBytes: number): OpusRawCandidate[] => {
    const found: OpusRawCandidate[] = [];
    for (let h = magicEnd; h <= maxHeaderOffset; h += 1) {
      for (const mode of modes) {
        let offset = h;
        const packets: Uint8Array[] = [];
        let valid = true;
        let exactEof = false;

        while (offset < buf.byteLength) {
          const rem = buf.byteLength - offset;
          if (packets.length >= minPackets && mode.isEofSentinel?.(offset, rem)) {
            offset = buf.byteLength;
            break;
          }
          if (maxTrailingBytes > 0 && packets.length >= 10 && rem <= maxTrailingBytes) {
            offset = buf.byteLength;
            break;
          }
          if (rem < mode.prefixBytes) {
            valid = false;
            break;
          }
          const pktLen = mode.readLen(offset);
          if (pktLen < 1 || pktLen > 1275 || offset + mode.prefixBytes + pktLen > buf.byteLength) {
            if (maxTrailingBytes > 0 && packets.length >= 10 && rem <= maxTrailingBytes) {
              offset = buf.byteLength;
              break;
            }
            valid = false;
            break;
          }
          const start = offset + mode.prefixBytes;
          packets.push(buf.subarray(start, start + pktLen));
          offset = start + pktLen;
          if (offset === buf.byteLength) {
            exactEof = true;
          }
        }

        if (!valid || offset !== buf.byteLength) continue;
        const score = scoreOpusPacketStream(
          packets,
          exactEof,
          h,
          maxTrailingBytes > 0 ? Math.max(minPackets, 10) : minPackets,
        );
        if (score !== null) {
          found.push({ mode: mode.name, headerOffset: h, packets, score });
        }
      }

      // RFC 6716 Appendix B self-delimiting single-frame Opus packets: [toc][1-or-2-byte len][frame]
      if (maxTrailingBytes === 0) {
        let offset = h;
        const packets: Uint8Array[] = [];
        let valid = true;
        while (offset < buf.byteLength) {
          if (offset + 2 > buf.byteLength) {
            valid = false;
            break;
          }
          const toc = buf[offset]!;
          if ((toc & 0x03) !== 0) {
            valid = false;
            break;
          }
          const b1 = buf[offset + 1]!;
          let frameLen = b1;
          let hdrBytes = 2;
          if (b1 >= 252) {
            if (offset + 3 > buf.byteLength) {
              valid = false;
              break;
            }
            frameLen = b1 + 4 * buf[offset + 2]!;
            hdrBytes = 3;
          }
          if (frameLen > 1274 || offset + hdrBytes + frameLen > buf.byteLength) {
            valid = false;
            break;
          }
          const rebuilt = new Uint8Array(1 + frameLen);
          rebuilt[0] = toc;
          rebuilt.set(buf.subarray(offset + hdrBytes, offset + hdrBytes + frameLen), 1);
          packets.push(rebuilt);
          offset += hdrBytes + frameLen;
        }
        if (valid && offset === buf.byteLength) {
          const score = scoreOpusPacketStream(packets, true, h, minPackets);
          if (score !== null) {
            found.push({ mode: 'rfc6716_self_delim', headerOffset: h, packets, score });
          }
        }
      }
    }
    return found;
  };

  let candidates = scanWithTrailingLimit(0);
  if (candidates.length === 0) {
    candidates = scanWithTrailingLimit(8);
  }

  // Fallback: fixed-size CBR Opus frames if no length-prefixed layout matched
  if (candidates.length === 0) {
    for (let h = magicEnd; h <= Math.min(buf.byteLength - 20, magicEnd + 32); h += 1) {
      const bodyLen = buf.byteLength - h;
      for (let frameSize = 20; frameSize <= 160; frameSize += 1) {
        if (bodyLen % frameSize !== 0) continue;
        const count = bodyLen / frameSize;
        if (count < minPackets || count > 6000) continue;
        const firstToc = buf[h]! & 0xfc;
        let sameToc = 0;
        const packets: Uint8Array[] = [];
        for (let i = 0; i < count; i += 1) {
          const pkt = buf.subarray(h + i * frameSize, h + (i + 1) * frameSize);
          if ((pkt[0]! & 0xfc) === firstToc) sameToc += 1;
          packets.push(pkt);
        }
        if (sameToc / count < 0.9) continue;
        const score = scoreOpusPacketStream(packets, true, h, minPackets);
        if (score !== null) {
          candidates.push({ mode: `cbr_${frameSize}`, headerOffset: h, packets, score: score - 200 });
        }
      }
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

async function decodeOpusRawToPcm16k(audioBuf: Uint8Array): Promise<Uint8Array | null> {
  const candidates = extractOpusRawCandidates(audioBuf);
  if (candidates.length === 0) {
    console.warn(
      `[ImVoice] OPUS_RAW header detected, but no packet framing matched EOF (bytes=${audioBuf.byteLength}, header48=${formatHeaderHex(audioBuf, 48)})`,
    );
    return null;
  }

  const { OpusDecoder } = await import('opus-decoder');
  const decoder = new OpusDecoder({ sampleRate: IM_VOICE_TARGET_SAMPLE_RATE });
  await decoder.ready;

  try {
    for (const candidate of candidates.slice(0, 5)) {
      await decoder.reset();
      const views = candidate.packets.map(
        (pkt) => new Uint8Array(pkt.buffer, pkt.byteOffset, pkt.byteLength),
      );
      const decoded = decoder.decodeFrames(views);
      const errorCount = Array.isArray(decoded?.errors) ? decoded.errors.length : 0;
      const maxAllowedErrors = Math.max(1, Math.floor(candidate.packets.length * 0.05));
      if (
        decoded?.channelData?.length &&
        decoded.samplesDecoded >= 320 &&
        errorCount <= maxAllowedErrors
      ) {
        const monoPcm16 = floatChannelsToPcm16Mono(decoded.channelData);
        const pcm16k = resamplePcm16Mono(monoPcm16, decoded.sampleRate, IM_VOICE_TARGET_SAMPLE_RATE);
        console.log(
          `[ImVoice] Decoded OPUS_RAW (${candidate.mode}, headerOffset=${candidate.headerOffset}, packets=${candidate.packets.length}, errors=${errorCount}) -> pcmBytes=${pcm16k.byteLength}`,
        );
        return pcm16k;
      }
    }
    console.warn(
      `[ImVoice] OPUS_RAW candidates (${candidates.length}) failed libopus validation; top=${candidates[0]?.mode}@${String(candidates[0]?.headerOffset)} header48=${formatHeaderHex(audioBuf, 48)}`,
    );
    return null;
  } finally {
    decoder.free();
  }
}

function extractOggOpusPackets(buf: Uint8Array): { packets: Uint8Array[]; preSkip48k: number } {
  const packets: Uint8Array[] = [];
  let preSkip48k = 312;
  let offset = 0;
  let pendingChunks: Uint8Array[] = [];

  while (offset + 27 <= buf.byteLength) {
    if (
      buf[offset] !== 0x4f ||
      buf[offset + 1] !== 0x67 ||
      buf[offset + 2] !== 0x67 ||
      buf[offset + 3] !== 0x53
    ) {
      break;
    }
    const headerType = buf[offset + 5]!;
    const pageSegments = buf[offset + 26]!;
    if (offset + 27 + pageSegments > buf.byteLength) break;

    if ((headerType & 0x01) === 0 && pendingChunks.length > 0) {
      pendingChunks = [];
    }

    let dataPos = offset + 27 + pageSegments;
    for (let i = 0; i < pageSegments; i += 1) {
      const segLen = buf[offset + 27 + i]!;
      if (dataPos + segLen > buf.byteLength) {
        dataPos = buf.byteLength;
        break;
      }
      if (segLen > 0) {
        pendingChunks.push(buf.subarray(dataPos, dataPos + segLen));
      }
      dataPos += segLen;

      if (segLen < 255) {
        const pkt =
          pendingChunks.length === 1
            ? pendingChunks[0]!
            : Buffer.concat(pendingChunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
        pendingChunks = [];
        if (pkt.byteLength >= 8) {
          const prefix8 = Buffer.from(pkt.buffer, pkt.byteOffset, 8).toString('ascii');
          if (prefix8 === 'OpusHead') {
            if (pkt.byteLength >= 12) {
              const hv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
              preSkip48k = hv.getUint16(10, true);
            }
            continue;
          }
          if (prefix8 === 'OpusTags') {
            continue;
          }
        }
        if (pkt.byteLength > 0) {
          packets.push(pkt);
        }
      }
    }
    offset = dataPos;
  }

  return { packets, preSkip48k };
}

async function decodeOggOpusToPcm16k(audioBuf: Uint8Array): Promise<Uint8Array | null> {
  const { packets, preSkip48k } = extractOggOpusPackets(audioBuf);
  if (packets.length === 0) return null;

  const { OpusDecoder } = await import('opus-decoder');
  const preSkip16k = Math.max(0, Math.round(preSkip48k / 3));
  const decoder = new OpusDecoder({
    sampleRate: IM_VOICE_TARGET_SAMPLE_RATE,
    preSkip: preSkip16k,
  });
  await decoder.ready;
  try {
    const views = packets.map((p) => new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
    const decoded = decoder.decodeFrames(views);
    const errorCount = Array.isArray(decoded?.errors) ? decoded.errors.length : 0;
    const maxAllowedErrors = Math.max(1, Math.floor(packets.length * 0.05));
    if (
      !decoded?.channelData?.length ||
      decoded.samplesDecoded <= 0 ||
      errorCount > maxAllowedErrors
    ) {
      return null;
    }
    const monoPcm16 = floatChannelsToPcm16Mono(decoded.channelData);
    return resamplePcm16Mono(monoPcm16, decoded.sampleRate, IM_VOICE_TARGET_SAMPLE_RATE);
  } finally {
    decoder.free();
  }
}

async function decodeMp3ToPcm16k(audioBuf: Uint8Array): Promise<Uint8Array | null> {
  const { MPEGDecoder } = await import('mpg123-decoder');
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    const view = new Uint8Array(audioBuf.buffer, audioBuf.byteOffset, audioBuf.byteLength);
    const decoded = decoder.decode(view);
    const errorCount = Array.isArray(decoded?.errors) ? decoded.errors.length : 0;
    if (
      !decoded?.channelData?.length ||
      decoded.samplesDecoded < 576 ||
      decoded.sampleRate <= 0 ||
      (errorCount > 0 && decoded.samplesDecoded < errorCount * 2304)
    ) {
      return null;
    }
    const monoPcm16 = floatChannelsToPcm16Mono(decoded.channelData);
    return resamplePcm16Mono(monoPcm16, decoded.sampleRate, IM_VOICE_TARGET_SAMPLE_RATE);
  } finally {
    decoder.free();
  }
}

function guessAudioExtension(audioBuf: Uint8Array, encodeType?: number): string {
  const ascii = Buffer.from(audioBuf.buffer, audioBuf.byteOffset, Math.min(audioBuf.byteLength, 16)).toString('ascii');
  if (ascii.startsWith('#!AMR')) return '.amr';
  if (ascii.startsWith('OggS')) return '.ogg';
  if (ascii.startsWith('fLaC')) return '.flac';
  if (ascii.startsWith('caff')) return '.caf';
  if (ascii.includes('ftyp')) return '.m4a';
  if (audioBuf.byteLength >= 2 && audioBuf[0] === 0xff && (audioBuf[1] & 0xf6) === 0xf0) return '.aac';
  if (isMp3AudioBuffer(audioBuf)) return '.mp3';
  if (encodeType === WeixinVoiceEncodeType.Amr) return '.amr';
  if (encodeType === WeixinVoiceEncodeType.OggSpeex) return '.ogg';
  if (encodeType === WeixinVoiceEncodeType.Speex) return '.spx';
  if (encodeType === WeixinVoiceEncodeType.Mp3) return '.mp3';
  return '.audio';
}

async function decodeWithSystemTools(
  audioBuf: Uint8Array,
  encodeType?: number,
): Promise<Uint8Array | null> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lobsterai-im-voice-'));
  const inPath = path.join(tmpDir, `input${guessAudioExtension(audioBuf, encodeType)}`);
  const outWavPath = path.join(tmpDir, 'output.wav');
  const outPcmPath = path.join(tmpDir, 'output.pcm');

  try {
    await fs.writeFile(inPath, audioBuf);

    if (process.platform === 'darwin') {
      try {
        await execFileAsync(
          '/usr/bin/afconvert',
          ['-f', 'WAVE', '-d', `LEI16@${IM_VOICE_TARGET_SAMPLE_RATE}`, '-c', '1', inPath, outWavPath],
          { timeout: SYSTEM_DECODE_TIMEOUT_MS },
        );
        const wavBytes = await fs.readFile(outWavPath);
        if (isWavAudioBuffer(wavBytes)) {
          const { pcm16le, sampleRate } = extractWavPcm16Mono(wavBytes);
          const pcm16k = resamplePcm16Mono(pcm16le, sampleRate, IM_VOICE_TARGET_SAMPLE_RATE);
          if (pcm16k.byteLength >= 640) return pcm16k;
        }
      } catch {
        // Fall through to ffmpeg fallback.
      }
    }

    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          inPath,
          '-f',
          's16le',
          '-acodec',
          'pcm_s16le',
          '-ac',
          '1',
          '-ar',
          String(IM_VOICE_TARGET_SAMPLE_RATE),
          outPcmPath,
        ],
        { timeout: SYSTEM_DECODE_TIMEOUT_MS },
      );
      const pcmBytes = await fs.readFile(outPcmPath);
      if (pcmBytes.byteLength >= 640) {
        return new Uint8Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength);
      }
    } catch {
      // No system audio decoder succeeded.
    }

    return null;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Builds an isolated expression for Chromium `webContents.executeJavaScript`
 * that decodes any Chromium-supported audio container (Ogg Opus, WebM Opus,
 * MP4/M4A/AAC, MP3, FLAC, Ogg Vorbis, WAV) to 16kHz 16-bit mono PCM16LE
 * using `OfflineAudioContext`, returning base64 PCM or `null`.
 */
export function buildBrowserWebAudioDecodeScript(base64Audio: string): string {
  return `(async () => {
    try {
      const b64 = ${JSON.stringify(base64Audio)};
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
      if (!OfflineCtx) return null;
      const probe = new OfflineCtx(1, 1, ${IM_VOICE_TARGET_SAMPLE_RATE});
      const decoded = await probe.decodeAudioData(bytes.buffer.slice(0));
      if (!decoded || decoded.duration <= 0) return null;
      const targetFrames = Math.max(1, Math.ceil(decoded.duration * ${IM_VOICE_TARGET_SAMPLE_RATE}));
      const offline = new OfflineCtx(1, targetFrames, ${IM_VOICE_TARGET_SAMPLE_RATE});
      const src = offline.createBufferSource();
      src.buffer = decoded;
      src.connect(offline.destination);
      src.start(0);
      const rendered = await offline.startRendering();
      const ch = rendered.getChannelData(0);
      if (!ch || ch.length === 0) return null;
      const pcm = new Uint8Array(ch.length * 2);
      const view = new DataView(pcm.buffer);
      for (let i = 0; i < ch.length; i += 1) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        view.setInt16(i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
      }
      const chunks = [];
      const step = 0x8000;
      for (let i = 0; i < pcm.length; i += step) {
        chunks.push(String.fromCharCode(...pcm.subarray(i, i + step)));
      }
      return btoa(chunks.join(''));
    } catch {
      return null;
    }
  })()`;
}

/**
 * Decode an inbound voice buffer (SILK v3, WAV, MP3, Ogg/Opus/AAC/M4A via
 * Chromium WebAudio, AMR/3GP/CAF via system tools, or raw PCM) to 16kHz 16-bit
 * signed little-endian mono PCM bytes ready for LobsterAI's realtime ASR.
 */
export async function decodeVoiceToPcm16k(
  audioBuf: Uint8Array,
  options: ImVoiceDecodeOptions = {},
): Promise<Uint8Array> {
  if (!audioBuf || audioBuf.byteLength === 0) {
    throw new Error('Voice audio payload is empty');
  }

  const headerHex = formatHeaderHex(audioBuf);
  console.log(
    `[ImVoice] Decoding voice payload: bytes=${audioBuf.byteLength}, encodeType=${String(options.encodeType ?? 'unknown')}, sampleRate=${String(options.sampleRate ?? 'unknown')}, header=${headerHex}`,
  );

  // 1. Tencent / standard SILK v3 (magic header "#!SILK" within first 64 bytes)
  const silkOffset = findSilkHeaderOffset(audioBuf);
  if (silkOffset >= 0) {
    const { decode } = await import('silk-wasm');
    const slice = silkOffset > 0 ? audioBuf.subarray(silkOffset) : audioBuf;
    const decoded = await decode(slice, IM_VOICE_TARGET_SAMPLE_RATE);
    if (!decoded?.data || decoded.data.byteLength === 0) {
      throw new Error('SILK audio decoded to empty PCM');
    }
    console.log(`[ImVoice] Decoded via silk-wasm: pcmBytes=${decoded.data.byteLength}`);
    return decoded.data;
  }

  // 2. Tencent WeChat "#!OPUS_RAW_V1" raw Opus packet stream
  if (isOpusRawAudioBuffer(audioBuf)) {
    const opusPcm = await decodeOpusRawToPcm16k(audioBuf);
    if (opusPcm && opusPcm.byteLength > 0) {
      return opusPcm;
    }
  }

  // 3. Standard Ogg Opus container (Feishu / Telegram / Discord / QQ voice notes)
  if (isOggOpusAudioBuffer(audioBuf)) {
    try {
      const oggOpusPcm = await decodeOggOpusToPcm16k(audioBuf);
      if (oggOpusPcm && oggOpusPcm.byteLength > 0) {
        console.log(`[ImVoice] Decoded Ogg Opus via opus-decoder: pcmBytes=${oggOpusPcm.byteLength}`);
        return oggOpusPcm;
      }
    } catch (err) {
      console.warn(
        '[ImVoice] Ogg Opus WASM decode failed, falling through:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // 4. RIFF/WAVE container
  if (isWavAudioBuffer(audioBuf)) {
    const { pcm16le, sampleRate } = extractWavPcm16Mono(audioBuf);
    const out = resamplePcm16Mono(pcm16le, sampleRate, IM_VOICE_TARGET_SAMPLE_RATE);
    console.log(`[ImVoice] Decoded via wav-parser: pcmBytes=${out.byteLength}`);
    return out;
  }

  // 5. Validated MP3 stream (only when magic bytes match ID3 or valid MPEG audio header)
  if (isMp3AudioBuffer(audioBuf)) {
    try {
      const mp3Pcm = await decodeMp3ToPcm16k(audioBuf);
      if (mp3Pcm && mp3Pcm.byteLength > 0) {
        console.log(`[ImVoice] Decoded via mpg123-decoder: pcmBytes=${mp3Pcm.byteLength}`);
        return mp3Pcm;
      }
    } catch (err) {
      console.warn(
        '[ImVoice] mpg123-decoder failed, falling through:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // 6. Chromium OfflineAudioContext (handles WebM Opus, MP4/M4A/AAC, VBR MP3, FLAC, Vorbis; skip AMR)
  if (options.webAudioDecode && !isAmrAudioBuffer(audioBuf)) {
    try {
      const webPcm = await options.webAudioDecode(audioBuf);
      if (webPcm && webPcm.byteLength > 0) {
        console.log(`[ImVoice] Decoded via Chromium OfflineAudioContext: pcmBytes=${webPcm.byteLength}`);
        return webPcm;
      }
    } catch (err) {
      console.warn(
        '[ImVoice] Chromium OfflineAudioContext decode failed, falling through:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // 7. Try silk-wasm as a fast WASM fallback (throws cleanly on non-SILK payloads; skip AMR)
  if (!isAmrAudioBuffer(audioBuf)) {
    try {
      const { decode } = await import('silk-wasm');
      const decoded = await decode(audioBuf, IM_VOICE_TARGET_SAMPLE_RATE);
      if (decoded?.data && decoded.data.byteLength > 0) {
        console.log(`[ImVoice] Decoded via silk-wasm fallback: pcmBytes=${decoded.data.byteLength}`);
        return decoded.data;
      }
    } catch {
      // Continue to system decoder fallback.
    }
  }

  // 6. Raw PCM16LE when explicitly indicated (encode_type=1)
  if (options.encodeType === WeixinVoiceEncodeType.Pcm) {
    const sourceRate =
      typeof options.sampleRate === 'number' && options.sampleRate > 0
        ? options.sampleRate
        : IM_VOICE_TARGET_SAMPLE_RATE;
    const out = resamplePcm16Mono(audioBuf, sourceRate, IM_VOICE_TARGET_SAMPLE_RATE);
    console.log(`[ImVoice] Resampled raw PCM: pcmBytes=${out.byteLength}`);
    return out;
  }

  // 7. System decoder fallback (macOS /usr/bin/afconvert handles AMR, 3GP, CAF, AAC, M4A; or ffmpeg)
  const systemPcm = await decodeWithSystemTools(audioBuf, options.encodeType);
  if (systemPcm && systemPcm.byteLength > 0) {
    console.log(`[ImVoice] Decoded via system audio tool: pcmBytes=${systemPcm.byteLength}`);
    return systemPcm;
  }

  throw new Error(
    `Unsupported voice encoding (encode_type=${String(options.encodeType ?? 'unknown')}, sample_rate=${String(options.sampleRate ?? 'unknown')}, bytes=${audioBuf.byteLength}, header=${headerHex})`,
  );
}

function buildRealtimeAudioFrames(
  pcm16k: Uint8Array,
  maxBinaryFrameBytes: number,
): Uint8Array[] {
  const safeMax = Math.max(45, maxBinaryFrameBytes);
  const frames: Uint8Array[] = [];
  const header = buildPcm16WavHeader(IM_VOICE_TARGET_SAMPLE_RATE);
  let offset = 0;

  while (offset < pcm16k.byteLength) {
    if (frames.length === 0) {
      const firstSliceLen = Math.min(pcm16k.byteLength - offset, Math.max(1, safeMax - header.byteLength));
      const combined = new Uint8Array(header.byteLength + firstSliceLen);
      combined.set(header, 0);
      combined.set(pcm16k.subarray(offset, offset + firstSliceLen), header.byteLength);
      frames.push(combined);
      offset += firstSliceLen;
      continue;
    }
    const len = Math.min(pcm16k.byteLength - offset, safeMax);
    frames.push(pcm16k.subarray(offset, offset + len));
    offset += len;
  }
  return frames;
}

function parseRealtimeEvent(rawData: unknown): AsrRealtimeEvent | null {
  let text = '';
  if (typeof rawData === 'string') {
    text = rawData;
  } else if (rawData instanceof ArrayBuffer) {
    text = Buffer.from(rawData).toString('utf8');
  } else if (ArrayBuffer.isView(rawData)) {
    text = Buffer.from(rawData.buffer, rawData.byteOffset, rawData.byteLength).toString('utf8');
  } else {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as AsrRealtimeEvent;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function defaultWebSocketFactory(wsUrl: string): AsrWebSocketLike {
  const GlobalWebSocket = globalThis.WebSocket as unknown as new (url: string) => AsrWebSocketLike;
  return new GlobalWebSocket(wsUrl);
}

const WS_READY_OPEN = 1;
const WS_READY_CONNECTING = 0;

/**
 * Stream 16kHz PCM16LE audio frames over LobsterAI's realtime ASR WebSocket
 * and return the recognized text.
 */
export async function transcribePcm16kWithRealtimeAsr(
  pcm16k: Uint8Array,
  deps: ImVoiceTranscriptionDeps,
): Promise<string> {
  if (!pcm16k || pcm16k.byteLength === 0) {
    throw new Error('Decoded voice audio is empty');
  }

  const sessionRes = await deps.createRealtimeSession({ langType: AsrLangType.ZhChs });
  if (sessionRes.success === false) {
    throw new Error(sessionRes.message || sessionRes.error || 'Failed to create ASR session');
  }

  const chunkIntervalMillis = sessionRes.data.chunkIntervalMillis || 200;
  const maxBinaryFrameBytes = Math.max(
    45,
    Math.floor(IM_VOICE_TARGET_SAMPLE_RATE * PCM16_BYTES_PER_SAMPLE * (chunkIntervalMillis / 1000)),
  );
  const frames = buildRealtimeAudioFrames(pcm16k, maxBinaryFrameBytes);

  const socket = (deps.webSocketFactory ?? defaultWebSocketFactory)(sessionRes.data.wsUrl);
  socket.binaryType = 'arraybuffer';

  const segments = new Map<number, string>();
  let fallbackText = '';
  let terminalError: Error | null = null;
  let endSent = false;
  let socketClosed = false;
  let resolveFinal: (() => void) | null = null;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | null = null;

  const frameDelayMs = deps.frameDelayMs ?? DEFAULT_FRAME_DELAY_MS;
  const openTimeoutMs = deps.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  const finalWaitMs = deps.finalWaitMs ?? DEFAULT_FINAL_WAIT_MS;
  const quietAfterFinalMs = deps.quietAfterFinalMs ?? DEFAULT_QUIET_AFTER_FINAL_MS;

  const collectText = (): string => {
    if (segments.size === 0) return fallbackText.trim();
    return [...segments.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, text]) => text)
      .join('')
      .trim();
  };

  const finishFinalWait = () => {
    if (quietTimer) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
    if (waitTimer) {
      clearTimeout(waitTimer);
      waitTimer = null;
    }
    if (resolveFinal) {
      const fn = resolveFinal;
      resolveFinal = null;
      fn();
    }
  };

  const scheduleQuietFinish = () => {
    if (!endSent) return;
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(finishFinalWait, quietAfterFinalMs);
    quietTimer.unref?.();
  };

  const closeSocket = () => {
    if (socket.readyState === WS_READY_OPEN || socket.readyState === WS_READY_CONNECTING) {
      try {
        socket.close();
      } catch {
        // Ignore close errors.
      }
    }
  };

  socket.addEventListener('message', (rawEvt) => {
    const data = (rawEvt as { data?: unknown })?.data;
    const message = parseRealtimeEvent(data);
    if (!message) return;

    if (message.type === AsrRealtimeEventType.Error) {
      terminalError = new Error(message.message || `ASR error (${String(message.code ?? 'unknown')})`);
      closeSocket();
      finishFinalWait();
      return;
    }

    if (message.type === AsrRealtimeEventType.Recognition) {
      const results = message.raw?.result;
      if (Array.isArray(results) && results.length > 0) {
        results.forEach((item, index) => {
          const sentence = item.st?.sentence;
          if (typeof sentence !== 'string') return;
          const segId = typeof item.seg_id === 'number' ? item.seg_id : index;
          segments.set(segId, sentence);
        });
        if (results.some((item) => item.st?.partial === false)) {
          scheduleQuietFinish();
        }
      } else if (typeof message.text === 'string') {
        fallbackText = message.text;
      }
      return;
    }

    if (message.type === AsrRealtimeEventType.Closed) {
      finishFinalWait();
    }
  });

  socket.addEventListener('error', () => {
    if (socketClosed) return;
    terminalError = terminalError ?? new Error('Realtime ASR WebSocket error');
    finishFinalWait();
  });

  socket.addEventListener('close', () => {
    socketClosed = true;
    finishFinalWait();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      if (socket.readyState === WS_READY_OPEN) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Realtime ASR WebSocket connection timed out'));
      }, openTimeoutMs);
      timer.unref?.();

      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('Realtime ASR WebSocket failed to connect'));
      };
      const onClose = () => {
        cleanup();
        reject(new Error('Realtime ASR WebSocket closed before open'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onClose);
      };

      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
      socket.addEventListener('close', onClose, { once: true });
    });

    for (const frame of frames) {
      if (terminalError || socketClosed || socket.readyState !== WS_READY_OPEN) break;
      socket.send(frame);
      if (frameDelayMs > 0) {
        await sleep(frameDelayMs);
      }
    }

    if (!terminalError && !socketClosed && socket.readyState === WS_READY_OPEN) {
      endSent = true;
      socket.send(JSON.stringify({ end: 'true' }));
      await new Promise<void>((resolve) => {
        if (socketClosed || terminalError) {
          resolve();
          return;
        }
        resolveFinal = resolve;
        waitTimer = setTimeout(finishFinalWait, finalWaitMs);
        waitTimer.unref?.();
      });
    }
  } finally {
    if (quietTimer) clearTimeout(quietTimer);
    if (waitTimer) clearTimeout(waitTimer);
    closeSocket();
  }

  if (terminalError) {
    throw terminalError;
  }
  const transcript = collectText();
  if (!transcript) {
    throw new Error('ASR returned empty transcript');
  }
  return transcript;
}

export async function transcribeImVoiceAttachment(
  attachment: {
    dataBase64: string;
    encodeType?: number;
    sampleRate?: number;
  },
  deps: ImVoiceTranscriptionDeps,
): Promise<string> {
  const audioBuf = Buffer.from(attachment.dataBase64, 'base64');
  const pcm16k = await decodeVoiceToPcm16k(audioBuf, {
    encodeType: attachment.encodeType,
    sampleRate: attachment.sampleRate,
    webAudioDecode: deps.webAudioDecode,
  });
  return transcribePcm16kWithRealtimeAsr(pcm16k, deps);
}
