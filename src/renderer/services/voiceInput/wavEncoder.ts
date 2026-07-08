const writeString = (view: DataView, offset: number, value: string): void => {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
};

export const mergeAudioChunks = (chunks: Float32Array[]): Float32Array => {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  chunks.forEach((chunk) => {
    merged.set(chunk, offset);
    offset += chunk.length;
  });
  return merged;
};

export const resampleLinear = (
  input: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number,
): Float32Array => {
  if (sourceSampleRate === targetSampleRate) {
    return input;
  }
  const ratio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const sourceIndex = i * ratio;
    const leftIndex = Math.floor(sourceIndex);
    const rightIndex = Math.min(leftIndex + 1, input.length - 1);
    const fraction = sourceIndex - leftIndex;
    const left = input[leftIndex] ?? 0;
    const right = input[rightIndex] ?? left;
    output[i] = left + (right - left) * fraction;
  }
  return output;
};

export const encodePcm16Bytes = (samples: Float32Array): Uint8Array => {
  const bytesPerSample = 2;
  const output = new Uint8Array(samples.length * bytesPerSample);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += bytesPerSample;
  }
  return output;
};

export const buildPcm16WavHeader = (
  sampleRate: number,
  dataSize = 0xffffffff,
): Uint8Array => {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, dataSize === 0xffffffff ? 0xffffffff : 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  return new Uint8Array(buffer);
};

