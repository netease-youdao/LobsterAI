import type {
  DeliveryMode,
  SessionTarget,
  WakeMode,
  TaskStatus,
} from './constants';

export interface ScheduleAt {
  kind: 'at';
  at: string;
}

export interface ScheduleEvery {
  kind: 'every';
  everyMs: number;
  anchorMs?: number;
}

export interface ScheduleCron {
  kind: 'cron';
  expr: string;
  tz?: string;
  staggerMs?: number;
}

export type Schedule = ScheduleAt | ScheduleEvery | ScheduleCron;

export interface AgentTurnPayload {
  kind: 'agentTurn';
  message: string;
  timeoutSeconds?: number;
  model?: string;
}

export interface SystemEventPayload {
  kind: 'systemEvent';
  text: string;
}

export type ScheduledTaskPayload = AgentTurnPayload | SystemEventPayload;

export interface ScheduledTaskDelivery {
  mode: DeliveryMode;
  channel?: string;
  to?: string;
  accountId?: string;
  bestEffort?: boolean;
}

export type TaskLastStatus = TaskStatus | null;

export interface TaskState {
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  lastStatus: TaskLastStatus;
  lastError: string | null;
  lastDurationMs: number | null;
  runningAtMs: number | null;
  consecutiveErrors: number;
}

export interface ScheduledTask {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: Schedule;
  sessionTarget: SessionTarget;
  wakeMode: WakeMode;
  payload: ScheduledTaskPayload;
  delivery: ScheduledTaskDelivery;
  agentId: string | null;
  sessionKey: string | null;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  sessionId: string | null;
  sessionKey: string | null;
  status: TaskStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
}

export interface ScheduledTaskRunWithName extends ScheduledTaskRun {
  taskName: string;
}

export interface ScheduledTaskInput {
  name: string;
  description: string;
  enabled: boolean;
  schedule: Schedule;
  sessionTarget: SessionTarget;
  wakeMode: WakeMode;
  payload: ScheduledTaskPayload;
  delivery?: ScheduledTaskDelivery;
  agentId?: string | null;
  sessionKey?: string | null;
}

export interface ScheduledTaskStatusEvent {
  taskId: string;
  state: TaskState;
}

export interface ScheduledTaskRunEvent {
  run: ScheduledTaskRunWithName;
}

export interface ScheduledTaskChannelOption {
  value: string;
  label: string;
  /** For multi-instance platforms (feishu, dingtalk, qq), the account ID that
   *  identifies a specific bot instance.  Passed as `delivery.accountId` so the
   *  channel plugin can call `LarkClient.fromCfg(cfg, accountId)` instead of
   *  falling back to the `default` account. */
  accountId?: string;
}

export interface ScheduledTaskConversationOption {
  conversationId: string;
  platform: string;
  coworkSessionId: string;
  lastActiveAt: number;
}

export type ScheduledTaskViewMode = 'list' | 'create' | 'edit' | 'detail';
