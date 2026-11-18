// User-authored OpenClaw config overrides. LobsterAI regenerates openclaw.json
// on every sync; `openclaw.user.json` next to it is merged on top so manual
// changes survive. Shared by main, preload, and renderer.

/** Lives in the same directory as the generated openclaw.json. */
export const OPENCLAW_USER_CONFIG_FILE_NAME = 'openclaw.user.json';

/** kv store key holding the toggle, applied overrides, and suspension state. */
export const OPENCLAW_USER_CONFIG_STORE_KEY = 'openclaw_user_config_overlay';

export const OpenClawUserConfigIpc = {
  GetStatus: 'openclaw:userConfig:getStatus',
  SetEnabled: 'openclaw:userConfig:setEnabled',
  OpenFile: 'openclaw:userConfig:openFile',
  RevealFile: 'openclaw:userConfig:revealFile',
  Apply: 'openclaw:userConfig:apply',
} as const;
export type OpenClawUserConfigIpc = typeof OpenClawUserConfigIpc[keyof typeof OpenClawUserConfigIpc];

export const OpenClawUserConfigState = {
  /** No override file yet. */
  Missing: 'missing',
  /** The user switched overrides off. */
  Disabled: 'disabled',
  /** Overrides are merged into openclaw.json. */
  Active: 'active',
  /** The file does not parse; the last valid overrides stay in effect. */
  ParseError: 'parse_error',
  /** Overrides are withheld until the file changes or the user applies again. */
  Suspended: 'suspended',
} as const;
export type OpenClawUserConfigState = typeof OpenClawUserConfigState[keyof typeof OpenClawUserConfigState];

export const OpenClawUserConfigSuspendReason = {
  /** OpenClaw rejected the config while the overrides were applied. */
  ConfigInvalid: 'config_invalid',
  /** Quick Repair returns the engine to LobsterAI's own config. */
  Repair: 'repair',
} as const;
export type OpenClawUserConfigSuspendReason =
  typeof OpenClawUserConfigSuspendReason[keyof typeof OpenClawUserConfigSuspendReason];

export interface OpenClawUserConfigStatus {
  enabled: boolean;
  state: OpenClawUserConfigState;
  filePath: string;
  /** Dotted paths the overrides set or remove in openclaw.json. */
  overriddenPaths: string[];
  /** Dotted paths in the file that LobsterAI must own and therefore ignores. */
  ignoredPaths: string[];
  /** Parse error detail, e.g. JSON5 line and column. */
  parseError?: string;
  suspension?: {
    reason: OpenClawUserConfigSuspendReason;
    /** OpenClaw's own message, when it rejected the config. */
    detail?: string;
    at: number;
  };
}

export interface OpenClawUserConfigActionResult {
  success: boolean;
  status: OpenClawUserConfigStatus;
  error?: string;
}
