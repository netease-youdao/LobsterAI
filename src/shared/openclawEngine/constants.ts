export const OpenClawEngineIpc = {
  GetStatus: 'openclaw:engine:getStatus',
  Install: 'openclaw:engine:install',
  RetryInstall: 'openclaw:engine:retryInstall',
  RestartGateway: 'openclaw:engine:restartGateway',
  RepairGatewayState: 'openclaw:engine:repairGatewayState',
  RepairLoopbackFirewall: 'openclaw:engine:repairLoopbackFirewall',
  OnProgress: 'openclaw:engine:onProgress',
} as const;

export type OpenClawEngineIpc =
  typeof OpenClawEngineIpc[keyof typeof OpenClawEngineIpc];

export const OpenClawGatewayProcessControl = {
  Shutdown: 'lobsterai:gateway:shutdown',
} as const;

export const OpenClawEnginePhase = {
  NotInstalled: 'not_installed',
  Installing: 'installing',
  Ready: 'ready',
  Starting: 'starting',
  Running: 'running',
  Error: 'error',
} as const;

export type OpenClawEnginePhase =
  typeof OpenClawEnginePhase[keyof typeof OpenClawEnginePhase];

/** Native Skill Workshop modes exposed by the automatic skill review setting. */
export const OpenClawSkillReviewMode = {
  Off: 'off',
  Auto: 'auto',
} as const;

export type OpenClawSkillReviewMode =
  typeof OpenClawSkillReviewMode[keyof typeof OpenClawSkillReviewMode];

export const OpenClawGatewayRepairErrorCode = {
  Busy: 'busy',
  ConfigApplyPending: 'config_apply_pending',
  SnapshotFailed: 'snapshot_failed',
} as const;

export type OpenClawGatewayRepairErrorCode =
  typeof OpenClawGatewayRepairErrorCode[keyof typeof OpenClawGatewayRepairErrorCode];

/**
 * openclaw.json `plugins` keys that OpenClaw owns exclusively through its
 * plugin index (SQLite state DB). The gateway tolerates them in the on-disk
 * file via a load-time migration, but the `config.set` RPC rejects them
 * ("plugins.installs is managed by the plugin index and cannot be edited with
 * config set"). Left on disk they turn every hot config delivery into a
 * guaranteed fallback hard restart, so LobsterAI strips them both when
 * writing openclaw.json and from every config.set payload.
 */
export const OPENCLAW_PLUGIN_INDEX_MANAGED_KEYS = ['installs'] as const;

/** Bundled plugin that owns model compatibility and thinking profiles. */
export const OPENCLAW_MODEL_COMPAT_PLUGIN_ID = 'lobsterai-model-compat';

/** Why a task was refused while a config change is still unapplied. */
export const OpenClawConfigApplyPendingReason = {
  /** The change is still being applied, or its effect on the task is unknown. */
  Applying: 'applying',
  /** The task's model runs on settings the running gateway has not applied yet. */
  ModelSettings: 'model_settings',
} as const;

export type OpenClawConfigApplyPendingReason =
  typeof OpenClawConfigApplyPendingReason[keyof typeof OpenClawConfigApplyPendingReason];

export const OpenClawEngineErrorCode = {
  /**
   * resources/cfmind has no runtime entry file. On packaged Windows builds
   * this means the installer never finished unpacking win-resources.tar
   * (typically killed or frozen by security software) and automatic recovery
   * from the leftover archive was not possible.
   */
  RuntimeEntryMissing: 'runtime_entry_missing',
  /** The bundle exists, but required worker implementations are missing or unreadable. */
  RuntimeFilesMissing: 'runtime_files_missing',
  /** A targeted startup migration/recovery failed; retain its source during Quick Repair. */
  StartupCompatibilityFailed: 'startup_compatibility_failed',
  MemoryDreamingMigrationFailed: 'memory_dreaming_migration_failed',
  AgentMediaMigrationRequired: 'agent_media_migration_required',
  PluginVerificationFailed: 'plugin_verification_failed',
  /**
   * The gateway refused readiness because OpenClaw startup migrations left
   * legacy state unresolved. Restarting replays the same migration, so the
   * listed sources must be handled first.
   */
  StartupMigrationRefused: 'startup_migration_refused',
  /**
   * Connections to a listening 127.0.0.1 port of this executable are dropped
   * (Windows Defender Firewall's "Query user" default block). The gateway is
   * the same executable, so it would be unreachable; startup stops until the
   * loopback firewall rule is added or the user retries.
   */
  LoopbackBlocked: 'loopback_blocked',
} as const;

export type OpenClawEngineErrorCode =
  typeof OpenClawEngineErrorCode[keyof typeof OpenClawEngineErrorCode];

/** Result of the elevated "allow local connections" firewall repair. */
export const OpenClawLoopbackRepairOutcome = {
  /** The rule is in place and the loopback self-test passes. */
  Repaired: 'repaired',
  /** The rule is in place, but something else still drops loopback. */
  StillBlocked: 'still_blocked',
  /** The UAC prompt was declined (or no administrator approved it). */
  Cancelled: 'cancelled',
  Failed: 'failed',
  Unsupported: 'unsupported',
} as const;

export type OpenClawLoopbackRepairOutcome =
  typeof OpenClawLoopbackRepairOutcome[keyof typeof OpenClawLoopbackRepairOutcome];

export const OpenClawGatewayFailureKind = {
  HeapOutOfMemory: 'heap_out_of_memory',
} as const;

export type OpenClawGatewayFailureKind =
  typeof OpenClawGatewayFailureKind[keyof typeof OpenClawGatewayFailureKind];

export type OpenClawGatewayFailureSnapshot = {
  generation: number;
  kind: OpenClawGatewayFailureKind;
  detectedAt: number;
  exitCode?: number | null;
};
