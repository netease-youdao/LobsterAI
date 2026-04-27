/**
 * Renderer-facing access control for the generic SQLite KV store.
 *
 * Renderer processes can read/write arbitrary keys via the `store:*` IPC bridge
 * that lives in `preload.ts`. A handful of keys store secrets that must only
 * ever be touched by the main process (Bearer tokens, OAuth refresh tokens,
 * GitHub Copilot tokens, etc.). This module centralises the deny-list so the
 * IPC handler in `main.ts` can reject any renderer call that targets those
 * keys, even if a compromised renderer is convinced to issue the call.
 *
 * Exact-match keys cover individual sensitive entries; prefix matches cover
 * key namespaces (e.g. `copilot:` reserved for Copilot-related secrets).
 *
 * Internal main-process code keeps using `getStore().set/get/delete` directly,
 * which bypasses these checks because it never crosses the IPC boundary.
 */

const SENSITIVE_KEY_EXACT = new Set<string>([
  'auth_tokens',
  'github_copilot_github_token',
]);

const SENSITIVE_KEY_PREFIXES: readonly string[] = [
  'copilot:',
  'github_copilot:',
];

export function isSensitiveStoreKey(key: unknown): boolean {
  if (typeof key !== 'string' || key.length === 0) return false;
  if (SENSITIVE_KEY_EXACT.has(key)) return true;
  for (const prefix of SENSITIVE_KEY_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Returns the user-visible reason for blocking a renderer-side store access.
 * Used in `Error.message` so renderer code can surface a stable diagnostic
 * without leaking internal detail about which keys are sensitive.
 */
export function describeSensitiveKeyDenial(channel: string): string {
  return `${channel} blocked: key is reserved for the main process`;
}
