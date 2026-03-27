export const AUDIO_WAVE_MULTIPLIERS = [0.35, 0.6, 1, 0.75, 0.45] as const;

export const getWaveScale = (audioLevel: number, multiplier: number): number => {
  return Math.min(1.65, 0.35 + (audioLevel * 1.2 * multiplier));
};
