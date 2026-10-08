/**
 * Feature flags for controlling experimental or incomplete features.
 * Toggle these to enable/disable features globally.
 */

/**
 * Whether to enable OpenClaw skill sync (auto-detect + manual sync entry).
 * Deleting a synced skill only removes LobsterAI's copy, so the next sync
 * imports it again; handle that before turning this back on.
 */
export const ENABLE_OPENCLAW_SKILL_SYNC = false;
