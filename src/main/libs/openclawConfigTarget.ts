import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  hasRetiredOpenClawWriteMetadata,
  withoutOpenClawWriteMetadata,
  withoutRetiredOpenClawWriteMetadata,
} from './openclawManagedModelPolicy';
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

// Gateway/plugin subtrees include runtime-owned fields and use a three-way merge.
const SHARED_SECTIONS = new Set(['gateway', 'plugins', 'meta']);

/** Top-level sections a rendered config replaces outright, including removals. */
export function resolveOpenClawOwnedSections(
  generated: Record<string, unknown>,
  ownedSections?: string[],
): string[] {
  return ownedSections ?? [...Object.keys(generated), 'bindings', 'mcp', 'channels']
    .filter(key => !SHARED_SECTIONS.has(key));
}

export type OpenClawConfigTargetOptions = {
  /** Content to merge unowned sections from, when it differs from `baseRaw`. */
  mergeBaseRaw?: string;
  /** Further top-level sections to own, e.g. ones user overrides set or remove. */
  extraOwnedSections?: readonly string[];
};

export function createOpenClawConfigTarget(
  baseRaw: string,
  generatedRaw: string,
  ownedSections?: string[],
  options: OpenClawConfigTargetOptions = {},
): OpenClawConfigTarget {
  const generated = parseConfig(generatedRaw);
  const extraSections = (options.extraOwnedSections ?? [])
    .filter(key => !SHARED_SECTIONS.has(key));
  const resolvedSections = resolveOpenClawOwnedSections(generated, ownedSections);
  const sections = extraSections.length > 0
    ? [...new Set([...resolvedSections, ...extraSections])]
    : resolvedSections;
  // `baseRaw` stays the file as read, so a rebase propagates every removal.
  const config = { ...parseConfig(options.mergeBaseRaw ?? baseRaw), ...generated };
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
  // `meta` is shared, so a stamp left by an older build would ride along forever.
  return `${JSON.stringify(withoutRetiredOpenClawWriteMetadata(rebased), null, 2)}\n`;
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

/** Same slot count as OpenClaw's own `.bak` ring (config/backup-rotation.ts). */
const CONFIG_BACKUP_SLOTS = 5;

/** Best effort: losing an old recovery point is better than keeping a stale `.bak`. */
function rotateOpenClawConfigBackups(backupPath: string): void {
  const steps: Array<() => void> = [() => fs.rmSync(`${backupPath}.${CONFIG_BACKUP_SLOTS - 1}`, { force: true })];
  for (let index = CONFIG_BACKUP_SLOTS - 2; index >= 1; index -= 1) {
    steps.push(() => fs.renameSync(`${backupPath}.${index}`, `${backupPath}.${index + 1}`));
  }
  steps.push(() => fs.renameSync(backupPath, `${backupPath}.1`));
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[OpenClawConfig] Failed to rotate config backups: ${backupPath}`, error);
      }
    }
  }
}

/**
 * OpenClaw restores `<config>.bak` when a read looks clobbered against its
 * last-known-good baseline, e.g. the >50% size drop after sign-out removes the
 * plan model catalog. Host writes bypass OpenClaw's backup rotation, so a stale
 * `.bak` would silently bring back an old model/provider setup on every start.
 * Keep the host-approved content there; older backups move down the ring.
 */
export function alignOpenClawConfigBackup(configPath: string, raw: string): boolean {
  const backupPath = `${configPath}.bak`;
  try {
    const backupRaw = readOpenClawConfigRaw(backupPath);
    // Byte-identical, so a restore rewrites exactly what the host wrote.
    if (backupRaw === raw) return false;
    if (backupRaw) rotateOpenClawConfigBackups(backupPath);
    safelyReplaceTextFileSync({ filePath: backupPath, content: raw, mode: 0o600, tempLabel: 'config-backup' });
    return true;
  } catch (error) {
    // The config itself is already on disk; the gateway's startup check reports any restore.
    console.error(`[OpenClawConfig] Failed to align config backup: ${backupPath}`, error);
    return false;
  }
}

/** Only call while the child is stopped. Live writes belong to config.apply. */
export function persistOpenClawConfigTarget(configPath: string, target: OpenClawConfigTarget): string {
  const current = readOpenClawConfigRaw(configPath);
  const raw = rebaseOpenClawConfigTarget(target, current);
  // The content comparison ignores write metadata, retired stamps included.
  if (current && sameOpenClawConfigContent(current, raw)
    && !hasRetiredOpenClawWriteMetadata(parseConfig(current))) {
    alignOpenClawConfigBackup(configPath, current);
    return current;
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  safelyReplaceTextFileSync({ filePath: configPath, content: raw, mode: 0o600, tempLabel: 'config-bootstrap' });
  alignOpenClawConfigBackup(configPath, raw);
  return raw;
}
