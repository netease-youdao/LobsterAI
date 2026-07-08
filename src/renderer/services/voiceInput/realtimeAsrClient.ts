import {
  AsrApiCode,
  AsrLangType,
  type AsrRealtimeEvent,
  AsrRealtimeEventType,
  type AsrRealtimeSessionData,
} from '../../../shared/asr/constants';
import { VOICE_INPUT_TARGET_SAMPLE_RATE } from './constants';
import { AsrClientError, getFallbackAsrErrorMessage } from './errors';
import {
  type RealtimeVoiceRecordingSession,
  startRealtimeVoiceRecording,
} from './realtimeAudioRecorder';
import { buildPcm16WavHeader } from './wavEncoder';

const REALTIME_FINAL_WAIT_MS = 4_000;
const PCM16_BYTES_PER_SAMPLE = 2;

export interface RealtimeVoiceInputSession {
  stop: () => Promise<string>;
  cancel: () => void;
  maxSessionSeconds: number;
  quota: Pick<
    AsrRealtimeSessionData,
    'usedSecondsToday' | 'remainingSecondsToday' | 'limitSecondsToday'
  >;
}

interface StartRealtimeVoiceInputOptions {
  onText: (text: string) => void;
  onError: (error: unknown) => void;
}

interface RealtimeAudioFrameBuildOptions {
  chunk: Uint8Array;
  isFirstFrame: boolean;
  maxBinaryFrameBytes: number;
}

interface RealtimeAudioFrameBuildResult {
  frames: Uint8Array[];
  isFirstFrame: boolean;
}

const combineHeaderAndChunk = (header: Uint8Array, chunk: Uint8Array): Uint8Array => {
  const combined = new Uint8Array(header.byteLength + chunk.byteLength);
  combined.set(header, 0);
  combined.set(chunk, header.byteLength);
  return combined;
};

export const buildRealtimeAsrAudioFrames = ({
  chunk,
  isFirstFrame,
  maxBinaryFrameBytes,
}: RealtimeAudioFrameBuildOptions): RealtimeAudioFrameBuildResult => {
  const frames: Uint8Array[] = [];
  const safeMaxBinaryFrameBytes = Math.max(45, maxBinaryFrameBytes);
  let nextIsFirstFrame = isFirstFrame;
  let offset = 0;
  while (offset < chunk.byteLength) {
    if (nextIsFirstFrame) {
      const header = buildPcm16WavHeader(VOICE_INPUT_TARGET_SAMPLE_RATE);
      const firstFramePcmBytes = Math.min(
        chunk.byteLength - offset,
        Math.max(1, safeMaxBinaryFrameBytes - header.byteLength),
      );
      const pcmSlice = chunk.slice(offset, offset + firstFramePcmBytes);
      frames.push(combineHeaderAndChunk(header, pcmSlice));
      nextIsFirstFrame = false;
      offset += firstFramePcmBytes;
      continue;
    }

    const frameBytes = Math.min(chunk.byteLength - offset, safeMaxBinaryFrameBytes);
    frames.push(chunk.slice(offset, offset + frameBytes));
    offset += frameBytes;
  }

  return { frames, isFirstFrame: nextIsFirstFrame };
};

class RealtimeRecognitionBuffer {
  private readonly segments = new Map<number, string>();
  private latestFallbackText = '';

  update(event: AsrRealtimeEvent): string {
    const results = event.raw?.result;
    if (Array.isArray(results) && results.length > 0) {
      results.forEach((item, index) => {
        const text = item.st?.sentence;
        if (typeof text !== 'string') return;
        const segmentId = typeof item.seg_id === 'number' ? item.seg_id : index;
        this.segments.set(segmentId, text);
      });
      return this.text;
    }

    if (typeof event.text === 'string') {
      this.latestFallbackText = event.text;
    }
    return this.text;
  }

  get text(): string {
    if (this.segments.size === 0) {
      return this.latestFallbackText;
    }
    return [...this.segments.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, text]) => text)
      .join('');
  }
}

const parseRealtimeMessage = (data: MessageEvent['data']): AsrRealtimeEvent | null => {
  if (typeof data !== 'string') {
    return null;
  }
  const trimmed = data.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as AsrRealtimeEvent;
  } catch {
    return null;
  }
};

const waitForOpen = (socket: WebSocket): Promise<void> => new Promise((resolve, reject) => {
  const cleanup = () => {
    socket.removeEventListener('open', handleOpen);
    socket.removeEventListener('error', handleError);
    socket.removeEventListener('close', handleClose);
  };
  const handleOpen = () => {
    cleanup();
    resolve();
  };
  const handleError = () => {
    cleanup();
    reject(new AsrClientError(getFallbackAsrErrorMessage(AsrApiCode.UpstreamError), AsrApiCode.UpstreamError));
  };
  const handleClose = () => {
    cleanup();
    reject(new AsrClientError(getFallbackAsrErrorMessage(AsrApiCode.UpstreamError), AsrApiCode.UpstreamError));
  };
  socket.addEventListener('open', handleOpen, { once: true });
  socket.addEventListener('error', handleError, { once: true });
  socket.addEventListener('close', handleClose, { once: true });
});

export const startRealtimeVoiceInput = async ({
  onText,
  onError,
}: StartRealtimeVoiceInputOptions): Promise<RealtimeVoiceInputSession> => {
  const session = await window.electron.asr.createRealtimeSession({
    // TODO: The current product is China-first. Revisit langType selection for international releases.
    langType: AsrLangType.ZhChs,
  });
  if (!session.success) {
    console.warn(`[VoiceInput] realtime ASR session request failed with code ${session.code ?? 'unknown'} and message: ${session.message || session.error || 'No response message'}`);
    throw new AsrClientError(getFallbackAsrErrorMessage(session.code), session.code);
  }

  const socket = new WebSocket(session.data.wsUrl);
  socket.binaryType = 'arraybuffer';
  const chunkIntervalMillis = session.data.chunkIntervalMillis || 200;
  const maxBinaryFrameBytes = Math.max(
    45,
    Math.floor(VOICE_INPUT_TARGET_SAMPLE_RATE * PCM16_BYTES_PER_SAMPLE * (chunkIntervalMillis / 1000)),
  );
  const recognitionBuffer = new RealtimeRecognitionBuffer();
  let recorder: RealtimeVoiceRecordingSession | null = null;
  let firstAudioFrame = true;
  let closed = false;
  let terminalError: AsrClientError | null = null;
  let resolveFinalWait: (() => void) | null = null;

  const closeSocket = () => {
    if (
      socket.readyState === WebSocket.OPEN
      || socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close();
    }
  };

  const finishFinalWait = () => {
    if (resolveFinalWait) {
      resolveFinalWait();
      resolveFinalWait = null;
    }
  };

  socket.addEventListener('message', (event) => {
    const message = parseRealtimeMessage(event.data);
    if (!message) return;

    if (message.type === AsrRealtimeEventType.Error) {
      console.warn(`[VoiceInput] realtime ASR WebSocket reported error; requestId=${message.requestId || session.data.requestId}, code=${message.code ?? 'unknown'}, message=${message.message || 'No response message'}`);
      terminalError = new AsrClientError(
        getFallbackAsrErrorMessage(message.code),
        message.code,
      );
      recorder?.cancel();
      closeSocket();
      finishFinalWait();
      onError(terminalError);
      return;
    }

    if (message.type === AsrRealtimeEventType.Recognition) {
      const text = recognitionBuffer.update(message).trim();
      if (text) {
        onText(text);
      }
      const hasFinalResult = message.raw?.result?.some(item => item.st?.partial === false) ?? false;
      if (hasFinalResult) {
        finishFinalWait();
      }
      return;
    }

    if (message.type === AsrRealtimeEventType.Closed) {
      finishFinalWait();
    }
  });

  socket.addEventListener('error', () => {
    if (closed) return;
    console.warn(`[VoiceInput] realtime ASR WebSocket error event; requestId=${session.data.requestId}`);
    terminalError = new AsrClientError(
      getFallbackAsrErrorMessage(AsrApiCode.UpstreamError),
      AsrApiCode.UpstreamError,
    );
    recorder?.cancel();
    finishFinalWait();
    onError(terminalError);
  });

  socket.addEventListener('close', (event) => {
    closed = true;
    if (event.code !== 1000) {
      console.warn(`[VoiceInput] realtime ASR WebSocket closed unexpectedly; code=${event.code}, clean=${event.wasClean}`);
    }
    finishFinalWait();
  });

  await waitForOpen(socket);
  if (terminalError) {
    closeSocket();
    throw terminalError;
  }

  const sendBinaryFrame = (payload: Uint8Array) => {
    if (socket.readyState !== WebSocket.OPEN) {
      terminalError = new AsrClientError(
        getFallbackAsrErrorMessage(AsrApiCode.UpstreamError),
        AsrApiCode.UpstreamError,
      );
      recorder?.cancel();
      finishFinalWait();
      onError(terminalError);
      return;
    }
    try {
      socket.send(payload);
    } catch {
      terminalError = new AsrClientError(
        getFallbackAsrErrorMessage(AsrApiCode.UpstreamError),
        AsrApiCode.UpstreamError,
      );
      recorder?.cancel();
      closeSocket();
      finishFinalWait();
      onError(terminalError);
    }
  };

  const sendPcmChunk = (chunk: Uint8Array) => {
    const result = buildRealtimeAsrAudioFrames({
      chunk,
      isFirstFrame: firstAudioFrame,
      maxBinaryFrameBytes,
    });
    firstAudioFrame = result.isFirstFrame;
    for (const frame of result.frames) {
      if (terminalError) break;
      sendBinaryFrame(frame);
    }
  };

  recorder = await startRealtimeVoiceRecording({
    chunkIntervalMillis,
    onPcmChunk: sendPcmChunk,
  });
  if (terminalError) {
    recorder.cancel();
    closeSocket();
    throw terminalError;
  }

  return {
    maxSessionSeconds: session.data.maxSessionSeconds,
    quota: {
      usedSecondsToday: session.data.usedSecondsToday,
      remainingSecondsToday: session.data.remainingSecondsToday,
      limitSecondsToday: session.data.limitSecondsToday,
    },
    stop: async () => {
      try {
        await recorder?.stop();
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ end: 'true' }));
        }
        await new Promise<void>((resolve) => {
          resolveFinalWait = resolve;
          window.setTimeout(resolve, REALTIME_FINAL_WAIT_MS);
        });
      } finally {
        closeSocket();
      }
      if (terminalError) {
        throw terminalError;
      }
      const text = recognitionBuffer.text.trim();
      if (!text) {
        throw new AsrClientError(getFallbackAsrErrorMessage(AsrApiCode.RecognitionFailed), AsrApiCode.RecognitionFailed);
      }
      return text;
    },
    cancel: () => {
      recorder?.cancel();
      closeSocket();
    },
  };
};
