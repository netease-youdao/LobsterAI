import { useCallback, useEffect, useRef, useState } from 'react';

type UseAudioLevelVisualizerOptions = {
  normalizationFactor?: number;
};

export function useAudioLevelVisualizer(options: UseAudioLevelVisualizerOptions = {}) {
  const { normalizationFactor = 85 } = options;
  const [audioLevel, setAudioLevel] = useState(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  const resetVisualizer = useCallback(() => {
    if (animationFrameRef.current != null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    analyserRef.current = null;
    sourceNodeRef.current?.disconnect();
    sourceNodeRef.current = null;
    void audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    setAudioLevel(0);
  }, []);

  const startVisualizer = useCallback((stream: MediaStream) => {
    const AudioContextCtor = window.AudioContext || (window as typeof window & {
      webkitAudioContext?: typeof AudioContext;
    }).webkitAudioContext;
    if (!AudioContextCtor) {
      return;
    }

    const audioContext = new AudioContextCtor();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    const sourceNode = audioContext.createMediaStreamSource(stream);
    sourceNode.connect(analyser);
    audioContextRef.current = audioContext;
    analyserRef.current = analyser;
    sourceNodeRef.current = sourceNode;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      if (!analyserRef.current) {
        return;
      }
      analyserRef.current.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((sum, value) => sum + value, 0) / Math.max(dataArray.length, 1);
      setAudioLevel(Math.min(1, average / normalizationFactor));
      animationFrameRef.current = window.requestAnimationFrame(tick);
    };

    tick();
  }, [normalizationFactor]);

  useEffect(() => () => {
    resetVisualizer();
  }, [resetVisualizer]);

  return {
    audioLevel,
    startVisualizer,
    resetVisualizer,
  };
}
