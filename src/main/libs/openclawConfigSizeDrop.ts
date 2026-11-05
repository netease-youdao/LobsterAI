/**
 * OpenClaw treats a config write that leaves less than half of the current
 * pretty-printed bytes as a clobber (`size-drop:` in config/io.write-safety.ts)
 * and rejects it. Signing out legitimately does that to LobsterAI's config: the
 * plan model catalog under `models` is most of the file. LobsterAI renders
 * `models` entirely from its own login and provider state, so a shrink that
 * `models` explains is intended and config.apply may waive the size check
 * (scripts/patches/v2026.8.1/openclaw-config-apply-size-drop-allowance.patch).
 * A shrink anywhere else still meets the guard.
 */

/** Gateway param that waives only the size check; other clobber checks still apply. */
export const OPENCLAW_CONFIG_APPLY_SIZE_DROP_PARAM = 'allowConfigSizeDrop';

/** The only top-level section whose removal legitimately halves the file. */
const HOST_OWNED_SHRINK_SECTION = 'models';

// Mirrors resolveConfigWriteSuspiciousReasons in OpenClaw v2026.8.1.
const OPENCLAW_SIZE_DROP_MIN_BASELINE_BYTES = 512;
const OPENCLAW_SIZE_DROP_RATIO = 0.5;
// The gateway measures its canonical, write-stamped bytes, and config.get
// returns a redacted copy. Claim the waiver a little before the guard trips;
// an unneeded waiver changes nothing.
const SIZE_DROP_ALLOWANCE_RATIO = 0.6;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

function parseConfigRecord(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

const prettyBytes = (value: unknown): number => Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

const dropsBelow = (baselineBytes: number, nextBytes: number, ratio: number): boolean => (
  baselineBytes >= OPENCLAW_SIZE_DROP_MIN_BASELINE_BYTES && nextBytes < Math.floor(baselineBytes * ratio)
);

function withoutHostOwnedShrinkSection(config: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...config };
  delete rest[HOST_OWNED_SHRINK_SECTION];
  return rest;
}

export type OpenClawConfigSizeDropDecision = {
  allow: boolean;
  currentBytes: number;
  nextBytes: number;
};

/**
 * Decide whether replacing the gateway's current config with `nextRaw` needs
 * the size-drop waiver, and whether LobsterAI may claim it. `current` is
 * config.get's `raw` text or, when the gateway withholds that (it returns
 * `raw: null` whenever text redaction is unsafe, e.g. with `${ENV}` refs), its
 * redacted `parsed` object. Unparseable input never claims the waiver.
 */
export function resolveOpenClawConfigSizeDropAllowance(
  current: unknown,
  nextRaw: string,
): OpenClawConfigSizeDropDecision {
  const currentConfig = typeof current === 'string'
    ? parseConfigRecord(current)
    : isRecord(current) ? current : null;
  const next = parseConfigRecord(nextRaw);
  if (!currentConfig || !next) return { allow: false, currentBytes: 0, nextBytes: 0 };
  const currentBytes = prettyBytes(currentConfig);
  const nextBytes = prettyBytes(next);
  if (!dropsBelow(currentBytes, nextBytes, SIZE_DROP_ALLOWANCE_RATIO)) {
    return { allow: false, currentBytes, nextBytes };
  }
  // Everything outside `models` must pass OpenClaw's guard on its own.
  const restSurvives = !dropsBelow(
    prettyBytes(withoutHostOwnedShrinkSection(currentConfig)),
    prettyBytes(withoutHostOwnedShrinkSection(next)),
    OPENCLAW_SIZE_DROP_RATIO,
  );
  return { allow: restSurvives, currentBytes, nextBytes };
}

/** An unpatched gateway rejects the waiver as an unknown config.apply param. */
export function isUnsupportedOpenClawSizeDropAllowance(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`unexpected property '${OPENCLAW_CONFIG_APPLY_SIZE_DROP_PARAM}'`);
}
