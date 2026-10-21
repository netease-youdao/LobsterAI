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

/**
 * Whether to show Expert Plaza entry points in the renderer.
 * Keep catalog, installation and existing Agent behavior available for relaunch.
 */
export const ENABLE_EXPERT_PLAZA_UI = false;
