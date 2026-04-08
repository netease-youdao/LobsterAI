/**
 * URL protocol validation for shell.openExternal() calls.
 *
 * Prevents arbitrary-protocol attacks (cmd://, powershell://, file://, etc.)
 * by enforcing a strict allowlist of safe protocols before opening any URL
 * in the user's default browser or application.
 *
 * @see https://www.electronjs.org/docs/latest/tutorial/security#15-do-not-use-shellopenexternal-with-untrusted-content
 */

const SAFE_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return SAFE_EXTERNAL_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}
