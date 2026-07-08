import { configureStore } from '@reduxjs/toolkit';

import agentReducer from './slices/agentSlice';
import artifactReducer from './slices/artifactSlice';
import asrQuotaReducer from './slices/asrQuotaSlice';
import authReducer from './slices/authSlice';
import coworkReducer from './slices/coworkSlice';
import imReducer from './slices/imSlice';
import kitReducer from './slices/kitSlice';
import mcpReducer from './slices/mcpSlice';
import modelReducer from './slices/modelSlice';
import quickActionReducer from './slices/quickActionSlice';
import scheduledTaskReducer from './slices/scheduledTaskSlice';
import skillReducer from './slices/skillSlice';

export const store = configureStore({
  reducer: {
    model: modelReducer,
    cowork: coworkReducer,
    skill: skillReducer,
    mcp: mcpReducer,
    im: imReducer,
    quickAction: quickActionReducer,
    scheduledTask: scheduledTaskReducer,
    agent: agentReducer,
    asrQuota: asrQuotaReducer,
    auth: authReducer,
    artifact: artifactReducer,
    kit: kitReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch; 
