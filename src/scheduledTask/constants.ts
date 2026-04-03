/**
 * Centralized constants for the scheduledTask module.
 *
 * Every discriminated-union kind value, delivery mode, session target, wake mode,
 * status code, IPC channel name, and magic string lives here as an `as const`
 * object.  Types are derived from these objects so that values and types share
 * a single source of truth.
 *
 * Usage:
 *   import { ScheduleKind, SessionTarget } from './constants';
 *   const s: SessionTarget = SessionTarget.Main;
 */

// ─── Schedule Kind ──────────────────────────────────────────────────────────
export const ScheduleKind = {
  At: 'at',
  Every: 'every',
  Cron: 'cron',
} as const;
export type ScheduleKind = typeof ScheduleKind[keyof typeof ScheduleKind];

// ─── Payload Kind ───────────────────────────────────────────────────────────
export const PayloadKind = {
  AgentTurn: 'agentTurn',
  SystemEvent: 'systemEvent',
} as const;
export type PayloadKind = typeof PayloadKind[keyof typeof PayloadKind];

// ─── Delivery Mode ──────────────────────────────────────────────────────────
export const DeliveryMode = {
  None: 'none',
  Announce: 'announce',
  Webhook: 'webhook',
} as const;
export type DeliveryMode = typeof DeliveryMode[keyof typeof DeliveryMode];

// ─── Delivery Channel (magic values) ────────────────────────────────────────
export const DeliveryChannel = {
  Last: 'last',
} as const;

// ─── Session Target ─────────────────────────────────────────────────────────
export const SessionTarget = {
  Main: 'main',
  Isolated: 'isolated',
} as const;
export type SessionTarget = typeof SessionTarget[keyof typeof SessionTarget];

// ─── Wake Mode ──────────────────────────────────────────────────────────────
export const WakeMode = {
  Now: 'now',
  NextHeartbeat: 'next-heartbeat',
} as const;
export type WakeMode = typeof WakeMode[keyof typeof WakeMode];

// ─── Task Origin Kind ───────────────────────────────────────────────────────
export const OriginKind = {
  Legacy: 'legacy',
  IM: 'im',
  Cowork: 'cowork',
  Manual: 'manual',
} as const;
export type OriginKind = typeof OriginKind[keyof typeof OriginKind];

// ─── Execution Binding Kind ─────────────────────────────────────────────────
export const BindingKind = {
  NewSession: 'new_session',
  UISession: 'ui_session',
  IMSession: 'im_session',
  SessionKey: 'session_key',
} as const;
export type BindingKind = typeof BindingKind[keyof typeof BindingKind];

// ─── Task / Run Status ──────────────────────────────────────────────────────
export const TaskStatus = {
  Success: 'success',
  Error: 'error',
  Skipped: 'skipped',
  Running: 'running',
} as const;
export type TaskStatus = typeof TaskStatus[keyof typeof TaskStatus];

// ─── Gateway Status (OpenClaw wire format) ────────────────────────────────���─
export const GatewayStatus = {
  Ok: 'ok',
  Error: 'error',
  Skipped: 'skipped',
} as const;
export type GatewayStatus = typeof GatewayStatus[keyof typeof GatewayStatus];

// ─── Default Agent ID ───────────────────────────────────────────────────────
export const DefaultAgentId = 'main' as const;

// ─── Policy Run-Behavior Descriptions ───────────────────────────────────────
export const RunBehavior = {
  newSession: 'Creates a new session on each trigger',
  uiSession: 'Runs within the associated UI session',
  imSession: (platform: string) => `Triggers and delivers results via ${platform}`,
  sessionKey: 'Runs with explicit OpenClaw session key',
} as const;

// ─── IPC Channels ───────────────────────────────────────────────────────────
export const IpcChannel = {
  List: 'scheduledTask:list',
  Get: 'scheduledTask:get',
  Create: 'scheduledTask:create',
  Update: 'scheduledTask:update',
  Delete: 'scheduledTask:delete',
  Toggle: 'scheduledTask:toggle',
  RunManually: 'scheduledTask:runManually',
  Stop: 'scheduledTask:stop',
  ListRuns: 'scheduledTask:listRuns',
  CountRuns: 'scheduledTask:countRuns',
  ListAllRuns: 'scheduledTask:listAllRuns',
  ResolveSession: 'scheduledTask:resolveSession',
  ListChannels: 'scheduledTask:listChannels',
  ListChannelConversations: 'scheduledTask:listChannelConversations',
  StatusUpdate: 'scheduledTask:statusUpdate',
  RunUpdate: 'scheduledTask:runUpdate',
  Refresh: 'scheduledTask:refresh',
} as const;

// ─── Migration Keys ─────────────────────────────────────────────────────────
export const MigrationKey = {
  TasksToOpenclaw: 'scheduled_tasks_migrated_to_openclaw_v1',
  RunsToOpenclaw: 'scheduled_task_runs_migrated_to_openclaw_v1',
} as const;
