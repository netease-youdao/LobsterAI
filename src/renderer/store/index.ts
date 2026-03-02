import { configureStore } from '@reduxjs/toolkit';
import modelReducer from './slices/modelSlice';
import coworkReducer from './slices/coworkSlice';
import skillReducer from './slices/skillSlice';
import mcpReducer from './slices/mcpSlice';
import imReducer from './slices/imSlice';
import quickActionReducer from './slices/quickActionSlice';
import scheduledTaskReducer from './slices/scheduledTaskSlice';

export const store = configureStore({
  reducer: {
    model: modelReducer,
    cowork: coworkReducer,
    skill: skillReducer,
    mcp: mcpReducer,
    im: imReducer,
    quickAction: quickActionReducer,
    scheduledTask: scheduledTaskReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch; 
