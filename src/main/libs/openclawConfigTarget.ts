import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { withoutOpenClawWriteMetadata } from './openclawManagedModelPolicy';
import { safelyReplaceTextFileSync } from './safeFileReplace';

/** The authored baseline and host intent, before any running-Gateway write. */
export type OpenClawConfigTarget = {
  baseRaw: string;
  raw: string;
  /** Complete sections rendered from LobsterAI state, including removals. */
  ownedSections?: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

function parseConfig(raw: string): Record<string, unknown> {
  const value: unknown = raw.trim() ? JSON.parse(raw) : {};
  if (!isRecord(value)) throw new Error('OpenClaw config must be an object');
  return value;
}

export function createOpenClawConfigTarget(
  baseRaw: string,
  generatedRaw: string,
  ownedSections?: string[],
): OpenClawConfigTarget {
  const generated = parseConfig(generatedRaw);
  // Gateway/plugin subtrees include runtime-owned fields and use a three-way merge.
  const sharedSections = new Set(['gateway', 'plugins', 'meta']);
  const sections = ownedSections ?? [...Object.keys(generated), 'bindings', 'mcp', 'channels']
    .filter(key => !sharedSections.has(key));
  const config = { ...parseConfig(baseRaw), ...generated };
  for (const section of sections) {
    if (!Object.hasOwn(generated, section)) delete config[section];
  }
  return {
    baseRaw,
    raw: `${JSON.stringify(config, null, 2)}\n`,
    ownedSections: sections,
  };
}

export function readOpenClawConfigRaw(configPath: string): string {
  try {
    return fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/** Rebase only the host's changes; a new hash must not authorize a stale full snapshot. */
function rebaseValue(base: unknown, target: unknown, current: unknown): unknown {
  if (isDeepStrictEqual(base, target)) return current;
  if (!isRecord(base) || !isRecord(target) || !isRecord(current)) return target;
  const result = { ...current };
  for (const key of new Set([...Object.keys(base), ...Object.keys(target)])) {
    if (!Object.hasOwn(target, key)) {
      delete result[key];
    } else if (!Object.hasOwn(base, key)) {
      // A newly owned object can coexist with unrelated fields added by another writer.
      result[key] = rebaseValue({}, target[key], current[key]);
    } else {
      const value = rebaseValue(base[key], target[key], current[key]);
      if (value === undefined) delete result[key];
      else result[key] = value;
    }
  }
  return result;
}

export function rebaseOpenClawConfigTarget(target: OpenClawConfigTarget, currentRaw: string): string {
  const base = withoutOpenClawWriteMetadata(parseConfig(target.baseRaw));
  const desired = withoutOpenClawWriteMetadata(parseConfig(target.raw));
  const current = parseConfig(currentRaw);
  const rebased = rebaseValue(base, desired, current) as Record<string, unknown>;
  for (const section of target.ownedSections ?? []) {
    if (Object.hasOwn(desired, section)) rebased[section] = desired[section];
    else delete rebased[section];
  }
  return `${JSON.stringify(rebased, null, 2)}\n`;
}

export function sameOpenClawConfigContent(left: string, right: string): boolean {
  try {
    return isDeepStrictEqual(
      withoutOpenClawWriteMetadata(parseConfig(left)),
      withoutOpenClawWriteMetadata(parseConfig(right)),
    );
  } catch {
    return left === right;
  }
}

/** Only call while the child is stopped. Live writes belong to config.apply. */
export function persistOpenClawConfigTarget(configPath: string, target: OpenClawConfigTarget): string {
  const current = readOpenClawConfigRaw(configPath);
  const raw = rebaseOpenClawConfigTarget(target, current);
  if (current && sameOpenClawConfigContent(current, raw)) return current;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  safelyReplaceTextFileSync({ filePath: configPath, content: raw, mode: 0o600, tempLabel: 'config-bootstrap' });
  return raw;
}
