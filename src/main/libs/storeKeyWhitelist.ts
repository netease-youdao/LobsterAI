/**
 * Store key whitelist for IPC security
 * 
 * This module defines which keys can be accessed through the store:* IPC channels.
 * Keys not in this list will be rejected by the IPC handlers.
 */

// Keys that can be read from the renderer process
export const READABLE_KEYS = new Set([
  'app_config',
  'providers',
  'theme',
  'language',
  'recent_cwds',
  'window_state',
  'sidebar_width',
  'artifact_panel_width',
  'last_working_directory',
  'onboarding_completed',
  'update_check_time',
  'dismissed_update_version',
]);

// Keys that can be written from the renderer process
export const WRITABLE_KEYS = new Set([
  'app_config',
  'providers',
  'theme',
  'language',
  'recent_cwds',
  'window_state',
  'sidebar_width',
  'artifact_panel_width',
  'last_working_directory',
  'onboarding_completed',
  'update_check_time',
  'dismissed_update_version',
]);

// Keys that can be deleted from the renderer process
export const DELETABLE_KEYS = new Set([
  'providers',
  'recent_cwds',
  'dismissed_update_version',
]);

/**
 * Check if a key is allowed for read operation
 */
export const isKeyReadable = (key: string): boolean => {
  return READABLE_KEYS.has(key);
};

/**
 * Check if a key is allowed for write operation
 */
export const isKeyWritable = (key: string): boolean => {
  return WRITABLE_KEYS.has(key);
};

/**
 * Check if a key is allowed for delete operation
 */
export const isKeyDeletable = (key: string): boolean => {
  return DELETABLE_KEYS.has(key);
};
