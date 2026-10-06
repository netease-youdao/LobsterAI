import type { AsrRealtimeSessionData } from '../../../shared/asr/constants';
import { VOICE_INPUT_TARGET_SAMPLE_RATE } from './constants';

export type VoiceInputQuotaSnapshot = Pick<
  AsrRealtimeSessionData,
  'usedSecondsToday' | 'remainingSecondsToday' | 'limitSecondsToday'
>;

const normalizeSeconds = (seconds: number): number => (
  Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : 0
);

export const calculateVoiceInputConsumedSeconds = (outputSampleCount: number): number => {
  if (!Number.isFinite(outputSampleCount) || outputSampleCount <= 0) {
    return 0;
  }
  return Math.ceil(Math.floor(outputSampleCount) / VOICE_INPUT_TARGET_SAMPLE_RATE);
};

export const applyVoiceInputQuotaConsumption = (
  quota: VoiceInputQuotaSnapshot,
  consumedSeconds: number,
): VoiceInputQuotaSnapshot => {
  const availableSeconds = Math.max(0, quota.remainingSecondsToday);
  const appliedSeconds = Math.min(availableSeconds, normalizeSeconds(consumedSeconds));
  return {
    usedSecondsToday: Math.min(
      quota.limitSecondsToday,
      Math.max(0, quota.usedSecondsToday) + appliedSeconds,
    ),
    remainingSecondsToday: availableSeconds - appliedSeconds,
    limitSecondsToday: quota.limitSecondsToday,
  };
};
