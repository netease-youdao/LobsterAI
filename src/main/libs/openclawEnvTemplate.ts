/**
 * OpenClaw substitutes `${UPPER_CASE}` in every openclaw.json string from the
 * gateway env when it loads the config, and reads `$${UPPER_CASE}` as the
 * literal text `${UPPER_CASE}` (src/config/env-substitution.ts in the pinned
 * runtime). Only names matching `[A-Z_][A-Z0-9_]*` and closed by `}` are
 * tokens; every other `$` is left as-is.
 *
 * LobsterAI's own placeholders (provider keys, gateway token) rely on that.
 * Values typed by users must not: a header such as `Bearer ${LOBSTER_APIKEY_X}`
 * would otherwise be filled with a secret from the gateway env.
 */
const OPENCLAW_ENV_TOKEN_RE = /\$\{[A-Z_][A-Z0-9_]*\}/g;

/** Escapes a user-supplied literal so OpenClaw loads it unchanged. */
export function escapeOpenClawEnvTemplate(value: string): string {
  if (!value.includes('${')) return value;
  return value.replace(OPENCLAW_ENV_TOKEN_RE, token => `$${token}`);
}

export function escapeOpenClawEnvTemplateRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, escapeOpenClawEnvTemplate(value)]),
  );
}
