/**
 * IM Slice
 * Redux slice for IM gateway state management
 */

import { createSlice, PayloadAction } from '@reduxjs/toolkit';

import type {
  DingTalkInstanceConfig,
  DingTalkMultiInstanceConfig,
  DingTalkOpenClawConfig,
  DiscordInstanceConfig,
  DiscordMultiInstanceConfig,
  DiscordOpenClawConfig,
  EmailInstanceConfig,
  EmailMultiInstanceConfig,
  FeishuInstanceConfig,
  FeishuMultiInstanceConfig,
  FeishuOpenClawConfig,
  IMGatewayConfig,
  IMGatewayStatus,
  IMSettings,
  NeteaseBeeChanConfig,
  NimConfig,
  NimInstanceConfig,
  NimMultiInstanceConfig,
  PopoOpenClawConfig,
  QQInstanceConfig,
  QQMultiInstanceConfig,
  QQOpenClawConfig,
  TelegramInstanceConfig,
  TelegramMultiInstanceConfig,
  TelegramOpenClawConfig,
  WecomInstanceConfig,
  WecomMultiInstanceConfig,
  WecomOpenClawConfig,
  WeixinOpenClawConfig,
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
    /** @deprecated Use setDingTalkInstanceConfig instead */
    setDingTalkConfig: (state, action: PayloadAction<Partial<DingTalkOpenClawConfig>>) => {
      // Backward compat: update first instance if exists
      const first = state.config.dingtalk.instances[0];
      if (first) {
        Object.assign(first, action.payload);
      }
    },
    setDingTalkInstances: (state, action: PayloadAction<DingTalkInstanceConfig[]>) => {
      state.config.dingtalk = { instances: action.payload };
    },
    setDingTalkMultiInstanceConfig: (state, action: PayloadAction<DingTalkMultiInstanceConfig>) => {
      state.config.dingtalk = action.payload;
    },
    setDingTalkInstanceConfig: (state, action: PayloadAction<{ instanceId: string; config: Partial<DingTalkOpenClawConfig> }>) => {
      const inst = state.config.dingtalk.instances.find(i => i.instanceId === action.payload.instanceId);
      if (inst) Object.assign(inst, action.payload.config);
    },
    addDingTalkInstance: (state, action: PayloadAction<DingTalkInstanceConfig>) => {
      state.config.dingtalk.instances.push(action.payload);
    },
    removeDingTalkInstance: (state, action: PayloadAction<string>) => {
      state.config.dingtalk.instances = state.config.dingtalk.instances.filter(
        i => i.instanceId !== action.payload
      );
    },
    /** @deprecated Use setFeishuInstanceConfig instead */
    setFeishuConfig: (state, action: PayloadAction<Partial<FeishuOpenClawConfig>>) => {
      // Backward compat: update first instance if exists
      const first = state.config.feishu.instances[0];
      if (first) {
        Object.assign(first, action.payload);
      }
    },
    setFeishuInstances: (state, action: PayloadAction<FeishuInstanceConfig[]>) => {
      state.config.feishu = { instances: action.payload };
    },
    setFeishuMultiInstanceConfig: (state, action: PayloadAction<FeishuMultiInstanceConfig>) => {
      state.config.feishu = action.payload;
    },
    setFeishuInstanceConfig: (state, action: PayloadAction<{ instanceId: string; config: Partial<FeishuOpenClawConfig> }>) => {
      const inst = state.config.feishu.instances.find(i => i.instanceId === action.payload.instanceId);
      if (inst) Object.assign(inst, action.payload.config);
    },
    addFeishuInstance: (state, action: PayloadAction<FeishuInstanceConfig>) => {
      state.config.feishu.instances.push(action.payload);
    },
    removeFeishuInstance: (state, action: PayloadAction<string>) => {
      state.config.feishu.instances = state.config.feishu.instances.filter(
        i => i.instanceId !== action.payload
      );
    },
    /** @deprecated Use setTelegramInstanceConfig instead */
    setTelegramOpenClawConfig: (state, action: PayloadAction<Partial<TelegramOpenClawConfig>>) => {
      const first = state.config.telegram.instances[0];
      if (first) {
        Object.assign(first, action.payload);
      }
    },
    setTelegramInstances: (state, action: PayloadAction<TelegramInstanceConfig[]>) => {
      state.config.telegram = { instances: action.payload };
    },
    setTelegramMultiInstanceConfig: (state, action: PayloadAction<TelegramMultiInstanceConfig>) => {
      state.config.telegram = action.payload;
    },
    setTelegramInstanceConfig: (state, action: PayloadAction<{ instanceId: string; config: Partial<TelegramOpenClawConfig> }>) => {
      const inst = state.config.telegram.instances.find(i => i.instanceId === action.payload.instanceId);
      if (inst) Object.assign(inst, action.payload.config);
    },
    addTelegramInstance: (state, action: PayloadAction<TelegramInstanceConfig>) => {
      state.config.telegram.instances.push(action.payload);
    },
    removeTelegramInstance: (state, action: PayloadAction<string>) => {
      state.config.telegram.instances = state.config.telegram.instances.filter(
        i => i.instanceId !== action.payload
      );
    },
    /** @deprecated Use setQQInstanceConfig instead */
    setQQConfig: (state, action: PayloadAction<Partial<QQOpenClawConfig>>) => {
      // Backward compat: update first instance if exists
      const first = state.config.qq.instances[0];
      if (first) {
        Object.assign(first, action.payload);
      }
    },
    setQQInstances: (state, action: PayloadAction<QQInstanceConfig[]>) => {
      state.config.qq = { instances: action.payload };
    },
    setQQMultiInstanceConfig: (state, action: PayloadAction<QQMultiInstanceConfig>) => {
      state.config.qq = action.payload;
    },
    setQQInstanceConfig: (state, action: PayloadAction<{ instanceId: string; config: Partial<QQOpenClawConfig> }>) => {
      const inst = state.config.qq.instances.find(i => i.instanceId === action.payload.instanceId);
      if (inst) Object.assign(inst, action.payload.config);
    },
    addQQInstance: (state, action: PayloadAction<QQInstanceConfig>) => {
      state.config.qq.instances.push(action.payload);
    },
    removeQQInstance: (state, action: PayloadAction<string>) => {
      state.config.qq.instances = state.config.qq.instances.filter(
        i => i.instanceId !== action.payload
      );
    },
    /** @deprecated Use setDiscordInstanceConfig instead */
    setDiscordConfig: (state, action: PayloadAction<Partial<DiscordOpenClawConfig>>) => {
      const first = state.config.discord.instances[0];
      if (first) {
        Object.assign(first, action.payload);
      }
    },
    setDiscordInstances: (state, action: PayloadAction<DiscordInstanceConfig[]>) => {
      state.config.discord = { instances: action.payload };
    },
    setDiscordMultiInstanceConfig: (state, action: PayloadAction<DiscordMultiInstanceConfig>) => {
      state.config.discord = action.payload;
    },
    setDiscordInstanceConfig: (state, action: PayloadAction<{ instanceId: string; config: Partial<DiscordOpenClawConfig> }>) => {
      const inst = state.config.discord.instances.find(i => i.instanceId === action.payload.instanceId);
      if (inst) Object.assign(inst, action.payload.config);
    },
    addDiscordInstance: (state, action: PayloadAction<DiscordInstanceConfig>) => {
      state.config.discord.instances.push(action.payload);
    },
    removeDiscordInstance: (state, action: PayloadAction<string>) => {
      state.config.discord.instances = state.config.discord.instances.filter(
        i => i.instanceId !== action.payload
      );
    },
    /** @deprecated Use setNimInstanceConfig instead */
    setNimConfig: (state, action: PayloadAction<Partial<NimConfig>>) => {
      const first = state.config.nim.instances[0];
      if (first) {
        Object.assign(first, action.payload);
      }
    },
    setNimInstances: (state, action: PayloadAction<NimInstanceConfig[]>) => {
      state.config.nim = { instances: action.payload };
    },
    setNimMultiInstanceConfig: (state, action: PayloadAction<NimMultiInstanceConfig>) => {
      state.config.nim = action.payload;
    },
    setNimInstanceConfig: (state, action: PayloadAction<{ instanceId: string; config: Partial<NimConfig> }>) => {
      const inst = state.config.nim.instances.find(i => i.instanceId === action.payload.instanceId);
      if (inst) Object.assign(inst, action.payload.config);
    },
    addNimInstance: (state, action: PayloadAction<NimInstanceConfig>) => {
      state.config.nim.instances.push(action.payload);
    },
    removeNimInstance: (state, action: PayloadAction<string>) => {
      state.config.nim.instances = state.config.nim.instances.filter(
        i => i.instanceId !== action.payload
      );
    },
    setNeteaseBeeChanConfig: (state, action: PayloadAction<Partial<NeteaseBeeChanConfig>>) => {
      state.config['netease-bee'] = { ...state.config['netease-bee'], ...action.payload };
    },
    /** @deprecated Use setWecomInstanceConfig instead */
    setWecomConfig: (state, action: PayloadAction<Partial<WecomOpenClawConfig>>) => {
      // Backward compat: update first instance if exists
      const first = state.config.wecom.instances[0];
      if (first) {
        Object.assign(first, action.payload);
      }
    },
    setWecomInstances: (state, action: PayloadAction<WecomInstanceConfig[]>) => {
      state.config.wecom = { instances: action.payload };
    },
    setWecomMultiInstanceConfig: (state, action: PayloadAction<WecomMultiInstanceConfig>) => {
      state.config.wecom = action.payload;
    },
    setWecomInstanceConfig: (state, action: PayloadAction<{ instanceId: string; config: Partial<WecomOpenClawConfig> }>) => {
      const inst = state.config.wecom.instances.find(i => i.instanceId === action.payload.instanceId);
      if (inst) Object.assign(inst, action.payload.config);
    },
    addWecomInstance: (state, action: PayloadAction<WecomInstanceConfig>) => {
      state.config.wecom.instances.push(action.payload);
    },
    removeWecomInstance: (state, action: PayloadAction<string>) => {
      state.config.wecom.instances = state.config.wecom.instances.filter(
        i => i.instanceId !== action.payload
      );
    },
    setPopoConfig: (state, action: PayloadAction<Partial<PopoOpenClawConfig>>) => {
      state.config.popo = { ...state.config.popo, ...action.payload };
    },
    setWeixinConfig: (state, action: PayloadAction<Partial<WeixinOpenClawConfig>>) => {
      state.config.weixin = { ...state.config.weixin, ...action.payload };
    },
    setEmailInstances: (state, action: PayloadAction<EmailInstanceConfig[]>) => {
      state.config.email = { instances: action.payload };
    },
    setEmailMultiInstanceConfig: (state, action: PayloadAction<EmailMultiInstanceConfig>) => {
      state.config.email = action.payload;
    },
    setEmailInstanceConfig: (state, action: PayloadAction<{ instanceId: string; config: Partial<EmailInstanceConfig> }>) => {
      const inst = state.config.email.instances.find(i => i.instanceId === action.payload.instanceId);
      if (inst) Object.assign(inst, action.payload.config);
    },
    addEmailInstance: (state, action: PayloadAction<EmailInstanceConfig>) => {
      state.config.email.instances.push(action.payload);
    },
    removeEmailInstance: (state, action: PayloadAction<string>) => {
      state.config.email.instances = state.config.email.instances.filter(
        i => i.instanceId !== action.payload,
      );
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
  setDingTalkInstances,
  setDingTalkMultiInstanceConfig,
  setDingTalkInstanceConfig,
  addDingTalkInstance,
  removeDingTalkInstance,
  setFeishuConfig,
  setFeishuInstances,
  setFeishuMultiInstanceConfig,
  setFeishuInstanceConfig,
  addFeishuInstance,
  removeFeishuInstance,
  setTelegramOpenClawConfig,
  setTelegramInstances,
  setTelegramMultiInstanceConfig,
  setTelegramInstanceConfig,
  addTelegramInstance,
  removeTelegramInstance,
  setQQConfig,
  setQQInstances,
  setQQMultiInstanceConfig,
  setQQInstanceConfig,
  addQQInstance,
  removeQQInstance,
  setDiscordConfig,
  setDiscordInstances,
  setDiscordMultiInstanceConfig,
  setDiscordInstanceConfig,
  addDiscordInstance,
  removeDiscordInstance,
  setNimConfig,
  setNimInstances,
  setNimMultiInstanceConfig,
  setNimInstanceConfig,
  addNimInstance,
  removeNimInstance,
  setNeteaseBeeChanConfig,
  setWecomConfig,
  setWecomInstances,
  setWecomMultiInstanceConfig,
  setWecomInstanceConfig,
  addWecomInstance,
  removeWecomInstance,
  setPopoConfig,
  setWeixinConfig,
  setEmailInstances,
  setEmailMultiInstanceConfig,
  setEmailInstanceConfig,
  addEmailInstance,
  removeEmailInstance,
  setIMSettings,
  setStatus,
  setLoading,
  setError,
  clearError,
} = imSlice.actions;

export default imSlice.reducer;
