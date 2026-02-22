/**
 * IM Slice
 * Redux slice for IM gateway state management
 */

import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type {
  IMGatewayConfig,
  IMGatewayStatus,
  DingTalkConfig,
  FeishuConfig,
  TelegramConfig,
  DiscordConfig,
  NimConfig,
  IMSettings,
} from '../../types/im';
import {
  DEFAULT_IM_CONFIG,
  DEFAULT_IM_STATUS,
} from '../../types/im';

export interface IMState {
  config: IMGatewayConfig;
  status: IMGatewayStatus;
  isLoading: boolean;
  error: string | null;
}

const initialState: IMState = {
  config: DEFAULT_IM_CONFIG,
  status: DEFAULT_IM_STATUS,
  isLoading: false,
  error: null,
};

const imSlice = createSlice({
  name: 'im',
  initialState,
  reducers: {
    setConfig: (state, action: PayloadAction<IMGatewayConfig>) => {
      state.config = action.payload;
    },
    setDingTalkConfig: (state, action: PayloadAction<Partial<DingTalkConfig>>) => {
      state.config.dingtalk = { ...state.config.dingtalk, ...action.payload };
    },
    setFeishuConfig: (state, action: PayloadAction<Partial<FeishuConfig>>) => {
      state.config.feishu = { ...state.config.feishu, ...action.payload };
    },
    setTelegramConfig: (state, action: PayloadAction<Partial<TelegramConfig>>) => {
      state.config.telegram = { ...state.config.telegram, ...action.payload };
    },
    setDiscordConfig: (state, action: PayloadAction<Partial<DiscordConfig>>) => {
      state.config.discord = { ...state.config.discord, ...action.payload };
    },
    setNimConfig: (state, action: PayloadAction<Partial<NimConfig>>) => {
      state.config.nim = { ...state.config.nim, ...action.payload };
    },
    setIMSettings: (state, action: PayloadAction<Partial<IMSettings>>) => {
      state.config.settings = { ...state.config.settings, ...action.payload };
    },
    setStatus: (state, action: PayloadAction<IMGatewayStatus>) => {
      state.status = action.payload;
    },
    setLoading: (state, action: PayloadAction<boolean>) => {
      state.isLoading = action.payload;
    },
    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
    },
    clearError: (state) => {
      state.error = null;
    },
  },
});

export const {
  setConfig,
  setDingTalkConfig,
  setFeishuConfig,
  setTelegramConfig,
  setDiscordConfig,
  setNimConfig,
  setIMSettings,
  setStatus,
  setLoading,
  setError,
  clearError,
} = imSlice.actions;

export default imSlice.reducer;
