import { expect, test } from 'vitest';

import { AsrApiCode } from '../../../shared/asr/constants';
import asrQuotaReducer, {
  AsrQuotaStatus,
  ensureAsrQuotaFreshForDay,
  getLocalAsrQuotaDayKey,
  markAsrQuotaExhausted,
  resetAsrQuota,
  updateAsrQuotaFromSession,
} from './asrQuotaSlice';

test('formats local ASR quota day key', () => {
  expect(getLocalAsrQuotaDayKey(new Date(2026, 5, 15, 23, 59))).toBe('2026-06-15');
});

test('updates quota from a successful realtime session', () => {
  const state = asrQuotaReducer(undefined, updateAsrQuotaFromSession({
    dayKey: '2026-06-15',
    updatedAt: 100,
    data: {
      usedSecondsToday: 60,
      remainingSecondsToday: 1140,
      limitSecondsToday: 1200,
    },
  }));

  expect(state.status).toBe(AsrQuotaStatus.Available);
  expect(state.dayKey).toBe('2026-06-15');
  expect(state.usedSecondsToday).toBe(60);
  expect(state.remainingSecondsToday).toBe(1140);
  expect(state.limitSecondsToday).toBe(1200);
  expect(state.lastUpdatedAt).toBe(100);
  expect(state.lastErrorCode).toBeNull();
});

test('marks zero remaining quota as exhausted', () => {
  const state = asrQuotaReducer(undefined, updateAsrQuotaFromSession({
    dayKey: '2026-06-15',
    data: {
      usedSecondsToday: 1200,
      remainingSecondsToday: 0,
      limitSecondsToday: 1200,
    },
  }));

  expect(state.status).toBe(AsrQuotaStatus.Exhausted);
});

test('records exhausted quota from server errors', () => {
  const state = asrQuotaReducer(undefined, markAsrQuotaExhausted({
    dayKey: '2026-06-15',
    errorCode: AsrApiCode.DailyLimitExceeded,
    updatedAt: 200,
  }));

  expect(state.status).toBe(AsrQuotaStatus.Exhausted);
  expect(state.dayKey).toBe('2026-06-15');
  expect(state.remainingSecondsToday).toBe(0);
  expect(state.lastUpdatedAt).toBe(200);
  expect(state.lastErrorCode).toBe(AsrApiCode.DailyLimitExceeded);
});

test('lazily resets stale quota when the day changes', () => {
  const exhausted = asrQuotaReducer(undefined, markAsrQuotaExhausted({
    dayKey: '2026-06-15',
    updatedAt: 200,
  }));
  const sameDay = asrQuotaReducer(exhausted, ensureAsrQuotaFreshForDay('2026-06-15'));
  const nextDay = asrQuotaReducer(sameDay, ensureAsrQuotaFreshForDay('2026-06-16'));

  expect(sameDay.status).toBe(AsrQuotaStatus.Exhausted);
  expect(nextDay).toEqual(asrQuotaReducer(undefined, resetAsrQuota()));
});
