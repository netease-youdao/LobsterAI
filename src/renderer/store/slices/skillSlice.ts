import { createSlice, PayloadAction } from '@reduxjs/toolkit';

import { Skill } from '../../types/skill';

interface SkillState {
  skills: Skill[];
  activeSkillIds: string[]; // Currently selected skills for conversation (multi-select)
}

const initialState: SkillState = {
  skills: [],
  activeSkillIds: [],
};

const skillSlice = createSlice({
  name: 'skill',
  initialState,
  reducers: {
    setSkills: (state, action: PayloadAction<Skill[]>) => {
      state.skills = action.payload;
      // Remove any active skill IDs that no longer exist
      state.activeSkillIds = state.activeSkillIds.filter(id =>
        action.payload.some(skill => skill.id === id)
      );
    },
    addSkill: (state, action: PayloadAction<Skill>) => {
      state.skills.push(action.payload);
    },
    updateSkill: (state, action: PayloadAction<{ id: string; updates: Partial<Skill> }>) => {
      const index = state.skills.findIndex(s => s.id === action.payload.id);
      if (index !== -1) {
        state.skills[index] = { ...state.skills[index], ...action.payload.updates };
      }
    },
    deleteSkill: (state, action: PayloadAction<string>) => {
      state.skills = state.skills.filter(s => s.id !== action.payload);
      state.activeSkillIds = state.activeSkillIds.filter(id => id !== action.payload);
    },
    toggleSkill: (state, action: PayloadAction<string>) => {
      const skill = state.skills.find(s => s.id === action.payload);
      if (skill) {
        skill.enabled = !skill.enabled;
      }
    },
    toggleActiveSkill: (state, action: PayloadAction<string>) => {
      const index = state.activeSkillIds.indexOf(action.payload);
      if (index === -1) {
        state.activeSkillIds.push(action.payload);
      } else {
        state.activeSkillIds.splice(index, 1);
      }
    },
    setActiveSkillIds: (state, action: PayloadAction<string[]>) => {
      state.activeSkillIds = action.payload;
    },
    clearActiveSkills: (state) => {
      state.activeSkillIds = [];
    },
  },
});

export const {
  setSkills,
  addSkill,
  updateSkill,
  deleteSkill,
  toggleSkill,
  toggleActiveSkill,
  setActiveSkillIds,
  clearActiveSkills,
} = skillSlice.actions;

export default skillSlice.reducer;
