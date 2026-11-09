// Observational metadata only. This marker is neither a credential nor proof
// against a client deliberately impersonating the bundled runtime.
export const DSH_INSTANCE_HEADER = 'x-lobsterai-dsh-instance';
export const DSH_OBSERVER_READY_PREFIX = '[LobsterAI DSH Observer] ready ';
export const DSH_ANALYTICS_SCHEMA_VERSION = 1;

export const DshTelemetryStage = {
  Start: 'start',
  Ready: 'ready',
  End: 'end',
} as const;
export type DshTelemetryStage = typeof DshTelemetryStage[keyof typeof DshTelemetryStage];

export const DshRuntimeEndReason = {
  Stop: 'requested_stop',
  Quit: 'app_quit',
  Exit: 'process_exit',
  SpawnFailed: 'spawn_failed',
  StartupFailed: 'startup_failed',
} as const;
export type DshRuntimeEndReason = typeof DshRuntimeEndReason[keyof typeof DshRuntimeEndReason];

export const DshObserverStatus = {
  Unavailable: 'unavailable',
  Prepared: 'prepared',
  Active: 'active',
} as const;
export type DshObserverStatus = typeof DshObserverStatus[keyof typeof DshObserverStatus];

export const DshRequestApi = {
  ChatCompletions: 'chat_completions',
  Messages: 'messages',
} as const;
export type DshRequestApi = typeof DshRequestApi[keyof typeof DshRequestApi];

export const DSH_RUNTIME_SOURCE = 'builtin_dsh';
