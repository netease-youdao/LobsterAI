import type { SpeechProviderType } from '../config';

type PrepareSpeechUploadOptions = {
  provider: SpeechProviderType;
  blob: Blob;
  mimeType: string;
  fileName: string;
};

type PrepareSpeechUploadResult = {
  audioBase64: string;
  mimeType: string;
  fileName: string;
};

type PrepareSpeechUploadDeps = {
  blobToBase64: (blob: Blob) => Promise<string>;
  convertBlobToWav: (blob: Blob) => Promise<Blob>;
};

function replaceAudioExtension(fileName: string, nextExtension: string): string {
  return fileName.replace(/\.[a-z0-9]+$/i, nextExtension);
}

function encodeWavPcm16(channelData: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const dataLength = channelData.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let index = 0; index < channelData.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, channelData[index]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += bytesPerSample;
  }

  return buffer;
}

function downmixToMono(audioBuffer: AudioBuffer): Float32Array {
  if (audioBuffer.numberOfChannels === 1) {
    return audioBuffer.getChannelData(0);
  }

  const monoData = new Float32Array(audioBuffer.length);
  for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex += 1) {
    const channelData = audioBuffer.getChannelData(channelIndex);
    for (let sampleIndex = 0; sampleIndex < channelData.length; sampleIndex += 1) {
      monoData[sampleIndex] += channelData[sampleIndex] / audioBuffer.numberOfChannels;
    }
  }
  return monoData;
}

function getAudioContextConstructor(): typeof AudioContext {
  const ctor = window.AudioContext || (window as typeof window & {
    webkitAudioContext?: typeof AudioContext;
  }).webkitAudioContext;

  if (!ctor) {
    throw new Error('AudioContext is not available');
  }

  return ctor;
}

async function convertRecordedBlobToWav(blob: Blob): Promise<Blob> {
  const AudioContextCtor = getAudioContextConstructor();
  const audioContext = new AudioContextCtor();

  try {
    const sourceBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(sourceBuffer.slice(0));
    const monoData = downmixToMono(audioBuffer);
    const wavBuffer = encodeWavPcm16(monoData, audioBuffer.sampleRate);
    return new Blob([wavBuffer], { type: 'audio/wav' });
  } finally {
    await audioContext.close().catch(() => {});
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Failed to read recording'));
        return;
      }
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read recording'));
    reader.readAsDataURL(blob);
  });
}

const defaultDeps: PrepareSpeechUploadDeps = {
  blobToBase64,
  convertBlobToWav: convertRecordedBlobToWav,
};

export async function prepareSpeechUpload(
  options: PrepareSpeechUploadOptions,
  deps: PrepareSpeechUploadDeps = defaultDeps
): Promise<PrepareSpeechUploadResult> {
  const targetBlob = options.provider === 'glm'
    ? await deps.convertBlobToWav(options.blob)
    : options.blob;
  const targetMimeType = options.provider === 'glm' ? 'audio/wav' : options.mimeType;
  const targetFileName = options.provider === 'glm'
    ? replaceAudioExtension(options.fileName, '.wav')
    : options.fileName;

  return {
    audioBase64: await deps.blobToBase64(targetBlob),
    mimeType: targetMimeType,
    fileName: targetFileName,
  };
}
