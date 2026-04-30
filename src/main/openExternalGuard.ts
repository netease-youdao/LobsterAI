import { shell } from 'electron';

/**
 * URL validation guard for `shell.openExternal()`.
 *
 * `shell.openExternal()` hands a URL to the OS, which may resolve schemes
 * the desktop user did not opt into:
 *   - `file:`  → opens local files in the default viewer (data exfiltration
 *                / sensitive-file probing via model-generated markdown).
 *   - `javascript:` / `data:` / `vbscript:` → may execute in the default
 *                browser depending on platform/version.
 *   - `cmd:` / `ms-*:` / `intent:` / `chrome:` etc → trigger system actions.
 *
 * The renderer surface that flows into this is wide: tray menu links,
 * settings buttons, IM guide URLs, model-generated markdown links opened
 * from chat output, MiniMax/GitHub Copilot device-flow verification URLs,
 * update download URLs. All legitimate callers use http(s) or mailto, so
 * we deliberately allow only those three schemes and reject everything
 * else with a `[Shell]` warning. The reject path returns a stable, opaque
 * reason so renderer UIs can surface a single "unsafe link" toast without
 * caring about the exact scheme.
 */

const ALLOWED_SCHEMES: ReadonlySet<string> = new Set([
  'http:',
  'https:',
  'mailto:',
]);

/**
 * Validation result. Uses a flat shape (rather than a discriminated union)
 * because `electron-tsconfig.json` does not enable `strictNullChecks`, so
 * union narrowing on `ok` would not work for callers in the main process.
 */
export interface ExternalUrlValidation {
  ok: boolean;
  sanitizedUrl?: string;
  scheme?: string;
  reason?: string;
}

export function validateExternalUrl(rawUrl: unknown): ExternalUrlValidation {
  if (typeof rawUrl !== 'string') {
    return { ok: false, reason: 'invalid-input' };
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty-url' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'malformed-url' };
  }

  const scheme = parsed.protocol.toLowerCase();
  if (!ALLOWED_SCHEMES.has(scheme)) {
    return { ok: false, reason: 'scheme-not-allowed', scheme };
  }

  // For mailto we keep the original string (URL re-encoding can lose
  // intentional formatting in subject/body parts); for http(s) we use the
  // normalized URL which strips trailing whitespace and resolves edge cases.
  const sanitizedUrl = scheme === 'mailto:' ? trimmed : parsed.toString();
  return { ok: true, sanitizedUrl, scheme };
}

export interface SafeOpenExternalResult {
  ok: boolean;
  error?: string;
  reason?: string;
  scheme?: string;
}

/**
 * Wraps `shell.openExternal()` with the guard above. The `caller` tag is
 * included in the warning log only, so we can attribute blocked attempts
 * to a specific main-process site (e.g. `auth:login`, `windowOpenHandler`,
 * `shell:openExternal`).
 */
export async function safeOpenExternal(
  rawUrl: unknown,
  caller: string,
): Promise<SafeOpenExternalResult> {
  const validation = validateExternalUrl(rawUrl);
  if (!validation.ok) {
    const reason = validation.reason ?? 'unknown';
    const schemeTag = validation.scheme ? ` scheme=${validation.scheme}` : '';
    console.warn(`[Shell] blocked openExternal from ${caller} reason=${reason}${schemeTag}`);
    return {
      ok: false,
      error: 'Refused to open URL: unsupported scheme',
      reason,
      scheme: validation.scheme,
    };
  }

  const sanitizedUrl = validation.sanitizedUrl ?? '';
  try {
    await shell.openExternal(sanitizedUrl);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.warn(`[Shell] openExternal failed from ${caller}: ${message}`);
    return { ok: false, error: message, reason: 'openExternal-threw' };
  }
}
