import { isDeepStrictEqual } from 'node:util';

import { sameOpenClawConfigContent } from './openclawConfigTarget';
import { withoutOpenClawWriteMetadata } from './openclawManagedModelPolicy';

export type OpenClawConfigSnapshot = {
  hash?: unknown;
  valid?: unknown;
  raw?: unknown;
  parsed?: unknown;
  configRevisionHash?: unknown;
  appliedConfigHash?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const MAX_GAP_PATHS = 6;
const MAX_GAP_DEPTH = 3;

function collectDifferingPaths(left: unknown, right: unknown, prefix: string, depth: number, paths: string[]): void {
  if (paths.length >= MAX_GAP_PATHS || isDeepStrictEqual(left, right)) return;
  if (depth >= MAX_GAP_DEPTH || !isRecord(left) || !isRecord(right)) {
    paths.push(prefix || '<root>');
    return;
  }
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    collectDifferingPaths(left[key], right[key], prefix ? `${prefix}.${key}` : key, depth + 1, paths);
  }
}

/**
 * Diagnostics only: why a snapshot does not prove the target applied. Names
 * the failing check and up to six differing config paths, never their values.
 */
export function describeOpenClawConfigApplicationGap(
  snapshot: OpenClawConfigSnapshot,
  targetRaw: string,
): string | undefined {
  if (snapshot.valid !== true) return 'invalid';
  if (typeof snapshot.configRevisionHash !== 'string' || !snapshot.configRevisionHash.trim()
    || snapshot.configRevisionHash !== snapshot.appliedConfigHash) return 'revision';
  try {
    const target: unknown = JSON.parse(targetRaw);
    const observed: unknown = typeof snapshot.raw === 'string' ? JSON.parse(snapshot.raw) : snapshot.parsed;
    if (!isRecord(target) || !isRecord(observed)) return 'content:unavailable';
    const paths: string[] = [];
    collectDifferingPaths(withoutOpenClawWriteMetadata(target), withoutOpenClawWriteMetadata(observed), '', 0, paths);
    return paths.length > 0 ? `content:${paths.join(',')}` : undefined;
  } catch {
    return 'content:unparseable';
  }
}

/** Equal revision tokens alone can describe an old cached config.get response. */
export function isOpenClawConfigApplied(
  snapshot: OpenClawConfigSnapshot,
  targetRaw: string,
  persistedHash?: string,
): boolean {
  if (
    snapshot.valid !== true
    || typeof snapshot.configRevisionHash !== 'string' || !snapshot.configRevisionHash.trim()
    || snapshot.configRevisionHash !== snapshot.appliedConfigHash
  ) return false;
  // The write receipt identifies persisted bytes even when raw contains redactions.
  // Raw and resolved revision tokens are different domains; never compare them.
  if (persistedHash && snapshot.hash === persistedHash) return true;
  try {
    const target: unknown = JSON.parse(targetRaw);
    // v2026.8.1 expands environment references in parsed, then redacts them.
    // raw retains the authored references and can prove the exact target identity.
    // Older snapshots without raw may still provide a comparable parsed object.
    const observed: unknown = typeof snapshot.raw === 'string'
      ? JSON.parse(snapshot.raw) : snapshot.parsed;
    // Never treat redacted values as wildcards: a changed secret must still be delivered.
    return isRecord(target) && isRecord(observed) && isDeepStrictEqual(
      withoutOpenClawWriteMetadata(target),
      withoutOpenClawWriteMetadata(observed),
    );
  } catch {
    return false;
  }
}

const CONFIG_APPLICATION_CHECK_DELAYS_MS = [0, 1_000, 2_000] as const;
export const CONFIG_APPLICATION_CHECK_TIMEOUT_MS = 3_000;

/** Bounded, read-only confirmation after an ambiguous write outcome. */
export async function confirmOpenClawConfigApplied(input: {
  readConfigFile: () => string;
  readSnapshot: () => Promise<OpenClawConfigSnapshot>;
  persistedHash?: string;
  persistedRaw?: string;
}): Promise<boolean> {
  for (const delay of CONFIG_APPLICATION_CHECK_DELAYS_MS) {
    if (delay) await new Promise<void>(resolve => setTimeout(resolve, delay));
    try {
      const before = input.readConfigFile();
      const snapshot = await input.readSnapshot();
      const after = input.readConfigFile();
      const receiptHash = input.persistedRaw && sameOpenClawConfigContent(after, input.persistedRaw)
        ? input.persistedHash : undefined;
      if (before === after && isOpenClawConfigApplied(snapshot, after, receiptHash)) return true;
    } catch {
      // A failed probe is unknown, not proof that the write failed or applied.
    }
  }
  return false;
}
