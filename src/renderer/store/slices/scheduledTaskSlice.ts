import { createSlice, PayloadAction } from '@reduxjs/toolkit';

import {
  ScheduledTaskDataStatus,
  type ScheduledTaskDataStatus as ScheduledTaskDataStatusValue,
} from '../../../scheduledTask/constants';
import type {
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskRunWithName,
  ScheduledTaskViewMode,
  TaskState,
} from '../../../scheduledTask/types';

interface ScheduledTaskState {
  tasks: ScheduledTask[];
  selectedTaskId: string | null;
  viewMode: ScheduledTaskViewMode;
  runs: Record<string, ScheduledTaskRun[]>;
  runsHasMore: Record<string, boolean>;
  allRuns: ScheduledTaskRunWithName[];
  allRunsHasMore: boolean;
  taskListStatus: ScheduledTaskDataStatusValue;
  allRunsStatus: ScheduledTaskDataStatusValue;
  taskListError: string | null;
  allRunsError: string | null;
  error: string | null;
}

const initialState: ScheduledTaskState = {
  tasks: [],
  selectedTaskId: null,
  viewMode: 'list',
  runs: {},
  runsHasMore: {},
  allRuns: [],
  allRunsHasMore: false,
  taskListStatus: ScheduledTaskDataStatus.Starting,
  allRunsStatus: ScheduledTaskDataStatus.Starting,
  taskListError: null,
  allRunsError: null,
  error: null,
};

const scheduledTaskSlice = createSlice({
  name: 'scheduledTask',
  initialState,
  reducers: {
    setTaskListStatus(state, action: PayloadAction<ScheduledTaskDataStatusValue>) {
      state.taskListStatus = action.payload;
      if (action.payload !== ScheduledTaskDataStatus.Error) {
        state.taskListError = null;
      }
    },
    setAllRunsStatus(state, action: PayloadAction<ScheduledTaskDataStatusValue>) {
      state.allRunsStatus = action.payload;
      if (action.payload !== ScheduledTaskDataStatus.Error) {
        state.allRunsError = null;
      }
    },
    setTaskListError(state, action: PayloadAction<string>) {
      state.taskListStatus = ScheduledTaskDataStatus.Error;
      state.taskListError = action.payload;
    },
    setAllRunsError(state, action: PayloadAction<string>) {
      state.allRunsStatus = ScheduledTaskDataStatus.Error;
      state.allRunsError = action.payload;
    },
    setError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setTasks(state, action: PayloadAction<ScheduledTask[]>) {
      state.tasks = action.payload;
      state.taskListStatus = ScheduledTaskDataStatus.Ready;
      state.taskListError = null;
    },
    addTask(state, action: PayloadAction<ScheduledTask>) {
      state.tasks.unshift(action.payload);
    },
    updateTask(state, action: PayloadAction<ScheduledTask>) {
      const index = state.tasks.findIndex(t => t.id === action.payload.id);
      if (index !== -1) {
        state.tasks[index] = action.payload;
      }
    },
    removeTask(state, action: PayloadAction<string>) {
      state.tasks = state.tasks.filter(t => t.id !== action.payload);
      if (state.selectedTaskId === action.payload) {
        state.selectedTaskId = null;
        state.viewMode = 'list';
      }
      delete state.runs[action.payload];
      delete state.runsHasMore[action.payload];
      state.allRuns = state.allRuns.filter(r => r.taskId !== action.payload);
    },
    updateTaskState(state, action: PayloadAction<{ taskId: string; taskState: TaskState }>) {
      const task = state.tasks.find(t => t.id === action.payload.taskId);
      if (task) {
        task.state = action.payload.taskState;
      }
    },
    // Optimistic UI: reflect a manual run immediately; the next gateway status
    // poll overwrites this with the real state.
    markTaskRunning(state, action: PayloadAction<string>) {
      const task = state.tasks.find(t => t.id === action.payload);
      if (task && !task.state.runningAtMs) {
        task.state.runningAtMs = Date.now();
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
      action: PayloadAction<{ taskId: string; runs: ScheduledTaskRun[]; hasMore: boolean }>,
    ) {
      state.runs[action.payload.taskId] = action.payload.runs;
      state.runsHasMore[action.payload.taskId] = action.payload.hasMore;
    },
    appendRuns(
      state,
      action: PayloadAction<{ taskId: string; runs: ScheduledTaskRun[]; hasMore: boolean }>,
    ) {
      const { taskId, runs, hasMore } = action.payload;
      if (!state.runs[taskId]) {
        state.runs[taskId] = runs;
      } else {
        const existingIds = new Set(state.runs[taskId].map(r => r.id));
        const newRuns = runs.filter(r => !existingIds.has(r.id));
        state.runs[taskId] = [...state.runs[taskId], ...newRuns];
      }
      state.runsHasMore[taskId] = hasMore;
    },
    addOrUpdateRun(state, action: PayloadAction<ScheduledTaskRun>) {
      const { taskId } = action.payload;
      if (!state.runs[taskId]) {
        state.runs[taskId] = [];
      }
      const existingIndex = state.runs[taskId].findIndex(r => r.id === action.payload.id);
      if (existingIndex !== -1) {
        state.runs[taskId][existingIndex] = action.payload;
      } else {
        state.runs[taskId].unshift(action.payload);
      }
    },
    setAllRuns(
      state,
      action: PayloadAction<{ runs: ScheduledTaskRunWithName[]; hasMore: boolean }>,
    ) {
      state.allRuns = action.payload.runs;
      state.allRunsHasMore = action.payload.hasMore;
      state.allRunsStatus = ScheduledTaskDataStatus.Ready;
      state.allRunsError = null;
    },
    appendAllRuns(
      state,
      action: PayloadAction<{ runs: ScheduledTaskRunWithName[]; hasMore: boolean }>,
    ) {
      state.allRuns = [...state.allRuns, ...action.payload.runs];
      state.allRunsHasMore = action.payload.hasMore;
    },
  },
});

export const {
  setTaskListStatus,
  setAllRunsStatus,
  setTaskListError,
  setAllRunsError,
  setError,
  setTasks,
  addTask,
  updateTask,
  removeTask,
  updateTaskState,
  markTaskRunning,
  selectTask,
  setViewMode,
  setRuns,
  appendRuns,
  addOrUpdateRun,
  setAllRuns,
  appendAllRuns,
} = scheduledTaskSlice.actions;

export default scheduledTaskSlice.reducer;
