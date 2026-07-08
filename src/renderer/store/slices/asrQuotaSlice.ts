import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import { AsrApiCode, type AsrRealtimeSessionData } from '../../../shared/asr/constants';
import { setLoggedOut } from './authSlice';

export const AsrQuotaStatus = {
  Unknown: 'unknown',
  Available: 'available',
  Exhausted: 'exhausted',
} as const;

export type AsrQuotaStatus = typeof AsrQuotaStatus[keyof typeof AsrQuotaStatus];

export interface AsrQuotaState {
  status: AsrQuotaStatus;
  dayKey: string | null;
  usedSecondsToday: number | null;
  remainingSecondsToday: number | null;
  limitSecondsToday: number | null;
  lastUpdatedAt: number | null;
  lastErrorCode: number | null;
}

interface UpdateAsrQuotaFromSessionPayload {
  dayKey: string;
  data: Pick<
    AsrRealtimeSessionData,
    'usedSecondsToday' | 'remainingSecondsToday' | 'limitSecondsToday'
  >;
  updatedAt?: number;
}

interface MarkAsrQuotaExhaustedPayload {
  dayKey: string;
  errorCode?: number;
  updatedAt?: number;
}

const initialState: AsrQuotaState = {
  status: AsrQuotaStatus.Unknown,
  dayKey: null,
  usedSecondsToday: null,
  remainingSecondsToday: null,
  limitSecondsToday: null,
  lastUpdatedAt: null,
  lastErrorCode: null,
};

const resetState = (state: AsrQuotaState): void => {
  state.status = AsrQuotaStatus.Unknown;
  state.dayKey = null;
  state.usedSecondsToday = null;
  state.remainingSecondsToday = null;
  state.limitSecondsToday = null;
  state.lastUpdatedAt = null;
  state.lastErrorCode = null;
};

export const getLocalAsrQuotaDayKey = (date = new Date()): string => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const asrQuotaSlice = createSlice({
  name: 'asrQuota',
  initialState,
  reducers: {
    ensureAsrQuotaFreshForDay(state, action: PayloadAction<string>) {
      if (state.dayKey && state.dayKey !== action.payload) {
        resetState(state);
      }
    },
    resetAsrQuota(state) {
      resetState(state);
    },
    updateAsrQuotaFromSession(state, action: PayloadAction<UpdateAsrQuotaFromSessionPayload>) {
      const { dayKey, data, updatedAt = Date.now() } = action.payload;
      state.dayKey = dayKey;
      state.usedSecondsToday = data.usedSecondsToday;
      state.remainingSecondsToday = data.remainingSecondsToday;
      state.limitSecondsToday = data.limitSecondsToday;
      state.status = data.remainingSecondsToday <= 0
        ? AsrQuotaStatus.Exhausted
        : AsrQuotaStatus.Available;
      state.lastUpdatedAt = updatedAt;
      state.lastErrorCode = null;
    },
    markAsrQuotaExhausted(state, action: PayloadAction<MarkAsrQuotaExhaustedPayload>) {
      const { dayKey, errorCode = AsrApiCode.DailyLimitExceeded, updatedAt = Date.now() } = action.payload;
      state.dayKey = dayKey;
      state.status = AsrQuotaStatus.Exhausted;
      state.remainingSecondsToday = 0;
      state.lastUpdatedAt = updatedAt;
      state.lastErrorCode = errorCode;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(setLoggedOut, resetState);
  },
});

export const {
  ensureAsrQuotaFreshForDay,
  markAsrQuotaExhausted,
  resetAsrQuota,
  updateAsrQuotaFromSession,
} = asrQuotaSlice.actions;

export default asrQuotaSlice.reducer;
