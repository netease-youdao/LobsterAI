import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { defaultConfig } from '../../config';

export interface Model {
  id: string;
  name: string;
  provider?: string; // 模型所属的提供商
  providerKey?: string; // 模型所属的提供商 key（用于唯一标识）
  supportsImage?: boolean;
  isServerModel?: boolean; // 是否为服务端套餐模型
  serverApiFormat?: string; // 服务端模型的 API 格式 ("openai" | "anthropic")
}

export function getModelIdentityKey(model: Pick<Model, 'id' | 'providerKey'>): string {
  return `${model.providerKey ?? ''}::${model.id}`;
}

export function isSameModelIdentity(
  modelA: Pick<Model, 'id' | 'providerKey'>,
  modelB: Pick<Model, 'id' | 'providerKey'>
): boolean {
  if (modelA.id !== modelB.id) {
    return false;
  }
  if (modelA.providerKey && modelB.providerKey) {
    return modelA.providerKey === modelB.providerKey;
  }
  // 兼容旧配置：缺失 providerKey 时回退到 id 匹配
  return true;
}

// 从 providers 配置中构建初始可用模型列表
function buildInitialModels(): Model[] {
  const models: Model[] = [];
  if (defaultConfig.providers) {
    Object.entries(defaultConfig.providers).forEach(([providerName, config]) => {
      if (config.enabled && config.models) {
        config.models.forEach(model => {
          models.push({
            id: model.id,
            name: model.name,
            provider: providerName.charAt(0).toUpperCase() + providerName.slice(1),
            providerKey: providerName,
            supportsImage: model.supportsImage ?? false,
          });
        });
      }
    });
  }
  return models.length > 0 ? models : defaultConfig.model.availableModels;
}

// 初始可用模型列表（会在运行时更新）
export let availableModels: Model[] = buildInitialModels();
const defaultModelProvider = defaultConfig.model.defaultModelProvider;

interface ModelState {
  selectedModel: Model;
  availableModels: Model[];
}

const initialState: ModelState = {
  // 使用 config 中的默认模型
  selectedModel: availableModels.find(
    model => model.id === defaultConfig.model.defaultModel
      && (!defaultModelProvider || model.providerKey === defaultModelProvider)
  ) || availableModels[0],
  availableModels: availableModels,
};

const modelSlice = createSlice({
  name: 'model',
  initialState,
  reducers: {
    setSelectedModel: (state, action: PayloadAction<Model>) => {
      state.selectedModel = action.payload;
    },
    setAvailableModels: (state, action: PayloadAction<Model[]>) => {
      // 保留已有的服务端模型，只更新用户自配模型（与 setServerModels 对称）
      const serverModels = state.availableModels.filter(m => m.isServerModel);
      state.availableModels = [...serverModels, ...action.payload];
      // 更新导出的 availableModels
      availableModels = state.availableModels;
      // 同步选中模型信息，确保名称与最新配置一致
      if (state.availableModels.length > 0) {
        const matchedModel = state.availableModels.find(m => isSameModelIdentity(m, state.selectedModel));
        if (matchedModel) {
          state.selectedModel = matchedModel;
        } else {
          // 如果当前选中的模型不在新的可用模型列表中，选择第一个可用模型
          state.selectedModel = state.availableModels[0];
        }
      }
    },
    setServerModels: (state, action: PayloadAction<Model[]>) => {
      // 服务端模型放前面，自配模型保留在后面
      const userModels = state.availableModels.filter(m => !m.isServerModel);
      state.availableModels = [...action.payload, ...userModels];
      availableModels = state.availableModels;
      // 同步选中模型信息（如 supportsImage 等属性可能随服务端更新）
      if (state.availableModels.length > 0) {
        const matchedModel = state.availableModels.find(m => isSameModelIdentity(m, state.selectedModel));
        if (matchedModel) {
          state.selectedModel = matchedModel;
        } else {
          state.selectedModel = state.availableModels[0];
        }
      }
    },
    clearServerModels: (state) => {
      state.availableModels = state.availableModels.filter(m => !m.isServerModel);
      availableModels = state.availableModels;
      // 如果当前选中的是服务端模型，切换到第一个可用模型
      if (state.selectedModel.isServerModel && state.availableModels.length > 0) {
        state.selectedModel = state.availableModels[0];
      }
    },
  },
});

export const { setSelectedModel, setAvailableModels, setServerModels, clearServerModels } = modelSlice.actions;
export default modelSlice.reducer; 
