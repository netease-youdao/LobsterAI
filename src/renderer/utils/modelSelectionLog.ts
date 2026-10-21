const MAX_LOGGED_KEYS = 200;
const loggedKeys = new Set<string>();

/**
 * Model resolution runs inside render paths, so forward each distinct
 * fallback decision to the main-process log once instead of on every render.
 */
export function logModelSelectionOnce(level: 'debug' | 'warn', key: string, message: string): void {
  if (loggedKeys.has(key)) return;
  if (loggedKeys.size >= MAX_LOGGED_KEYS) loggedKeys.clear();
  loggedKeys.add(key);
  if (level === 'warn') console.warn(`[ModelSelection] ${message}`);
  else console.debug(`[ModelSelection] ${message}`);
  try {
    window.electron?.log?.fromRenderer?.(level, 'ModelSelection', message.slice(0, 1_000));
  } catch {
    // Diagnostics must never interrupt model selection.
  }
}
