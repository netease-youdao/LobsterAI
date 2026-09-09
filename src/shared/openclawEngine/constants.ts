export const OpenClawEngineIpc = {
  GetStatus: 'openclaw:engine:getStatus',
  Install: 'openclaw:engine:install',
  RetryInstall: 'openclaw:engine:retryInstall',
  RestartGateway: 'openclaw:engine:restartGateway',
  RepairGatewayState: 'openclaw:engine:repairGatewayState',
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

export const OpenClawGatewayRepairErrorCode = {
  Busy: 'busy',
  ConfigApplyPending: 'config_apply_pending',
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

export const OpenClawEngineErrorCode = {
  /**
   * resources/cfmind has no runtime entry file. On packaged Windows builds
   * this means the installer never finished unpacking win-resources.tar
   * (typically killed or frozen by security software) and automatic recovery
   * from the leftover archive was not possible.
   */
  RuntimeEntryMissing: 'runtime_entry_missing',
} as const;

export type OpenClawEngineErrorCode =
  typeof OpenClawEngineErrorCode[keyof typeof OpenClawEngineErrorCode];

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
