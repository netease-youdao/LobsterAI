export const OpenExternalUrlError = {
  NonString: 'non-string',
  Empty: 'empty',
  TooLong: 'too-long',
  MissingScheme: 'missing-scheme',
  UnsupportedProtocol: 'unsupported-protocol',
  InvalidUrl: 'invalid-url',
} as const;
export type OpenExternalUrlError = typeof OpenExternalUrlError[keyof typeof OpenExternalUrlError];

export type OpenExternalSafeResult =
  | { ok: true; url: string }
  | { ok: false; error: OpenExternalUrlError };

export const OPEN_EXTERNAL_URL_MAX_LENGTH = 8192;

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

/**
 * Validate a URL before handing it to Electron's shell.openExternal.
 *
 * The allowlist is intentionally small and case-insensitive. A scheme is
 * required so protocol-relative and scheme-less strings cannot reach the OS
 * URL handler.
 */
export function openExternalSafe(input: unknown): OpenExternalSafeResult {
  if (typeof input !== 'string') {
    return { ok: false, error: OpenExternalUrlError.NonString };
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: OpenExternalUrlError.Empty };
  }
  if (trimmed.length > OPEN_EXTERNAL_URL_MAX_LENGTH) {
    return { ok: false, error: OpenExternalUrlError.TooLong };
  }
  if (CONTROL_CHAR_RE.test(trimmed)) {
    return { ok: false, error: OpenExternalUrlError.InvalidUrl };
  }
  if (!SCHEME_RE.test(trimmed)) {
    return { ok: false, error: OpenExternalUrlError.MissingScheme };
  }

  const protocol = trimmed.slice(0, trimmed.indexOf(':') + 1).toLowerCase();
  if (!ALLOWED_PROTOCOLS.has(protocol)) {
    return { ok: false, error: OpenExternalUrlError.UnsupportedProtocol };
  }

  try {
    const parsed = new URL(trimmed);
    return { ok: true, url: parsed.href };
  } catch {
    return { ok: false, error: OpenExternalUrlError.InvalidUrl };
  }
}
