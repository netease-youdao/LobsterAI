import { createSlice, PayloadAction } from '@reduxjs/toolkit';

import type { LocalizedQuickAction } from '../../types/quickAction';

interface QuickActionState {
  /** 快捷操作列表（已本地化） */
  actions: LocalizedQuickAction[];
  /** 当前选中的 action ID */
  selectedActionId: string | null;
  /** 当前选中的 prompt ID */
  selectedPromptId: string | null;
  /** 是否正在加载 */
  isLoading: boolean;
}

const initialState: QuickActionState = {
  actions: [],
  selectedActionId: null,
  selectedPromptId: null,
  isLoading: false,
};

const quickActionSlice = createSlice({
  name: 'quickAction',
  initialState,
  reducers: {
    /** 设置快捷操作列表 */
    setActions: (state, action: PayloadAction<LocalizedQuickAction[]>) => {
      state.actions = action.payload;
    },
    /** 选择快捷操作 */
    selectAction: (state, action: PayloadAction<string | null>) => {
      state.selectedActionId = action.payload;
      // 切换 action 时清空 prompt 选择
      state.selectedPromptId = null;
    },
    /** 选择提示词 */
    selectPrompt: (state, action: PayloadAction<string | null>) => {
      state.selectedPromptId = action.payload;
    },
    /** 设置加载状态 */
    setLoading: (state, action: PayloadAction<boolean>) => {
      state.isLoading = action.payload;
    },
    /** 清空选择 */
    clearSelection: (state) => {
      state.selectedActionId = null;
      state.selectedPromptId = null;
    },
  },
});

export const {
  setActions,
  selectAction,
  selectPrompt,
  setLoading,
  clearSelection,
} = quickActionSlice.actions;

export default quickActionSlice.reducer;
