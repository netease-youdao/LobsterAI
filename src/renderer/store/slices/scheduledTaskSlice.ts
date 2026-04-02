import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type {
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskRunWithName,
  TaskState,
  ScheduledTaskViewMode,
} from '../../../scheduledTask/types';

interface ScheduledTaskState {
  tasks: ScheduledTask[];
  selectedTaskId: string | null;
  viewMode: ScheduledTaskViewMode;
  runs: Record<string, ScheduledTaskRun[]>;
  runsHasMore: Record<string, boolean>;
  allRuns: ScheduledTaskRunWithName[];
  loading: boolean;
  error: string | null;
}

const initialState: ScheduledTaskState = {
  tasks: [],
  selectedTaskId: null,
  viewMode: 'list',
  runs: {},
  runsHasMore: {},
  allRuns: [],
  loading: false,
  error: null,
};

const scheduledTaskSlice = createSlice({
  name: 'scheduledTask',
  initialState,
  reducers: {
    setLoading(state, action: PayloadAction<boolean>) {
      state.loading = action.payload;
    },
    setError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setTasks(state, action: PayloadAction<ScheduledTask[]>) {
      state.tasks = action.payload;
      state.loading = false;
    },
    addTask(state, action: PayloadAction<ScheduledTask>) {
      state.tasks.unshift(action.payload);
    },
    updateTask(state, action: PayloadAction<ScheduledTask>) {
      const index = state.tasks.findIndex((t) => t.id === action.payload.id);
      if (index !== -1) {
        state.tasks[index] = action.payload;
      }
    },
    removeTask(state, action: PayloadAction<string>) {
      state.tasks = state.tasks.filter((t) => t.id !== action.payload);
      if (state.selectedTaskId === action.payload) {
        state.selectedTaskId = null;
        state.viewMode = 'list';
      }
      delete state.runs[action.payload];
      delete state.runsHasMore[action.payload];
      state.allRuns = state.allRuns.filter((r) => r.taskId !== action.payload);
    },
    updateTaskState(
      state,
      action: PayloadAction<{ taskId: string; taskState: TaskState }>
    ) {
      const task = state.tasks.find((t) => t.id === action.payload.taskId);
      if (task) {
        task.state = action.payload.taskState;
      }
    },
    selectTask(state, action: PayloadAction<string | null>) {
      state.selectedTaskId = action.payload;
      state.viewMode = action.payload ? 'detail' : 'list';
    },
    setViewMode(state, action: PayloadAction<ScheduledTaskViewMode>) {
      state.viewMode = action.payload;
    },
    setRuns(
      state,
      action: PayloadAction<{ taskId: string; runs: ScheduledTaskRun[]; hasMore: boolean }>
    ) {
      state.runs[action.payload.taskId] = action.payload.runs;
      state.runsHasMore[action.payload.taskId] = action.payload.hasMore;
    },
    appendRuns(
      state,
      action: PayloadAction<{ taskId: string; runs: ScheduledTaskRun[]; hasMore: boolean }>
    ) {
      const { taskId, runs, hasMore } = action.payload;
      if (!state.runs[taskId]) {
        state.runs[taskId] = runs;
      } else {
        const existingIds = new Set(state.runs[taskId].map((r) => r.id));
        const newRuns = runs.filter((r) => !existingIds.has(r.id));
        state.runs[taskId] = [...state.runs[taskId], ...newRuns];
      }
      state.runsHasMore[taskId] = hasMore;
    },
    addOrUpdateRun(state, action: PayloadAction<ScheduledTaskRun>) {
      const { taskId } = action.payload;
      if (!state.runs[taskId]) {
        state.runs[taskId] = [];
      }
      const existingIndex = state.runs[taskId].findIndex(
        (r) => r.id === action.payload.id
      );
      if (existingIndex !== -1) {
        state.runs[taskId][existingIndex] = action.payload;
      } else {
        state.runs[taskId].unshift(action.payload);
      }
    },
    setAllRuns(state, action: PayloadAction<ScheduledTaskRunWithName[]>) {
      state.allRuns = action.payload;
    },
    appendAllRuns(state, action: PayloadAction<ScheduledTaskRunWithName[]>) {
      state.allRuns = [...state.allRuns, ...action.payload];
    },
  },
});

export const {
  setLoading,
  setError,
  setTasks,
  addTask,
  updateTask,
  removeTask,
  updateTaskState,
  selectTask,
  setViewMode,
  setRuns,
  appendRuns,
  addOrUpdateRun,
  setAllRuns,
  appendAllRuns,
} = scheduledTaskSlice.actions;

export default scheduledTaskSlice.reducer;
