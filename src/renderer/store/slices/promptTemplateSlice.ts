import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { PromptTemplate } from '../../components/prompt-templates/types';

interface PromptTemplateState {
  templates: PromptTemplate[];
  categories: string[];
  activeCategory: string | null;
  searchQuery: string;
  isLoading: boolean;
  error: string | null;
  variableFillModal: {
    isOpen: boolean;
    templateId: string | null;
  };
}

const initialState: PromptTemplateState = {
  templates: [],
  categories: [],
  activeCategory: null,
  searchQuery: '',
  isLoading: false,
  error: null,
  variableFillModal: {
    isOpen: false,
    templateId: null,
  },
};

const promptTemplateSlice = createSlice({
  name: 'promptTemplate',
  initialState,
  reducers: {
    setTemplates: (state, action: PayloadAction<PromptTemplate[]>) => {
      state.templates = action.payload;
      const cats = new Set<string>();
      for (const t of action.payload) {
        if (t.category) {
          cats.add(t.category);
        }
      }
      state.categories = Array.from(cats).sort();
    },
    setActiveCategory: (state, action: PayloadAction<string | null>) => {
      state.activeCategory = action.payload;
    },
    setSearchQuery: (state, action: PayloadAction<string>) => {
      state.searchQuery = action.payload;
    },
    setLoading: (state, action: PayloadAction<boolean>) => {
      state.isLoading = action.payload;
    },
    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
    },
    openVariableFillModal: (state, action: PayloadAction<string>) => {
      state.variableFillModal = {
        isOpen: true,
        templateId: action.payload,
      };
    },
    closeVariableFillModal: (state) => {
      state.variableFillModal = {
        isOpen: false,
        templateId: null,
      };
    },
  },
});

export const {
  setTemplates,
  setActiveCategory,
  setSearchQuery,
  setLoading,
  setError,
  openVariableFillModal,
  closeVariableFillModal,
} = promptTemplateSlice.actions;

export default promptTemplateSlice.reducer;
