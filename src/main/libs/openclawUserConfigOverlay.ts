import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

// The CommonJS parser module: json5's ESM entry only has a default export,
// which the bundled and tsc-compiled main process would resolve differently.
import parseJson5 from 'json5/lib/parse';

import { DECISION_MODEL_PLUGIN_ID } from '../../shared/decisionModel/constants';
import {
  OPENCLAW_MODEL_COMPAT_PLUGIN_ID,
  OPENCLAW_PLUGIN_INDEX_MANAGED_KEYS,
} from '../../shared/openclawEngine/constants';
import {
  OPENCLAW_USER_CONFIG_FILE_NAME,
  OPENCLAW_USER_CONFIG_STORE_KEY,
  OpenClawUserConfigState,
  type OpenClawUserConfigStatus,
  OpenClawUserConfigSuspendReason,
} from '../../shared/openclawUserConfig/constants';

/**
 * User overrides for the generated openclaw.json.
 *
 * LobsterAI renders openclaw.json from its own state on every sync, so manual
 * edits to that file are lost. Overrides in `openclaw.user.json` are merged on
 * top of each rendered config instead (JSON Merge Patch, RFC 7396). Because
 * the renderer copies runtime-owned sections back from the file, an override
 * the user deletes would otherwise linger there; the paths each sync applied
 * are recorded and removed from the base before the next render.
 */

type JsonObject = Record<string, unknown>;
type ConfigPath = readonly string[];

const MAX_USER_CONFIG_BYTES = 1024 * 1024;
const MAX_FAILURE_DETAIL_LENGTH = 2000;
const LOG_TAG = '[OpenClawUserOverlay]';
const INCLUDE_KEY = '$include';
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Plugins whose entries carry LobsterAI callbacks, proxy tokens, or policy. */
const LOBSTERAI_INTERNAL_PLUGIN_IDS = [
  'lobster-model-routing',
  OPENCLAW_MODEL_COMPAT_PLUGIN_ID,
  // OPENCLAW_MEMORY_CORE_PLUGIN_ID; importing it would load the whole config sync.
  'memory-core',
  DECISION_MODEL_PLUGIN_ID,
  'ask-user-question',
  'lobster-media-generation',
] as const;

/** Paths the LobsterAI <-> gateway contract depends on. Overrides there are ignored. */
const PROTECTED_PATHS: readonly ConfigPath[] = [
  ['meta'],
  ['gateway', 'auth'],
  ['gateway', 'mode'],
  ['gateway', 'port'],
  ['agents', 'defaults', 'sessionStore'],
  ['plugins', 'slots', 'memory'],
  ...OPENCLAW_PLUGIN_INDEX_MANAGED_KEYS.map(key => ['plugins', key]),
  ...LOBSTERAI_INTERNAL_PLUGIN_IDS.map(id => ['plugins', 'entries', id]),
];

/**
 * Lists LobsterAI fills itself. Overrides add members instead of replacing
 * them: a non-empty plugins.allow is a strict allowlist, so replacing it would
 * unload every bundled plugin.
 */
const UNION_ARRAY_PATHS: readonly ConfigPath[] = [
  ['plugins', 'allow'],
  ['plugins', 'load', 'paths'],
];

/** LobsterAI writes plugins.allow sorted and reads it back from the file. */
const SORTED_UNION_PATH: ConfigPath = ['plugins', 'allow'];

const USER_CONFIG_TEMPLATE = `// LobsterAI merges this file into openclaw.json every time it syncs the engine config.
// LobsterAI 每次同步引擎配置时，都会把这个文件合并进 openclaw.json。
//
// - Objects merge key by key; arrays and other values replace.
//   对象逐项合并，数组和其他值整体替换。
// - Set a key to null to remove it.
//   把某一项设为 null 即删除该项。
// - plugins.allow and plugins.load.paths are added to LobsterAI's own lists.
//   plugins.allow 和 plugins.load.paths 会追加到 LobsterAI 自己的列表中。
// - gateway.auth/mode/port, meta, agents.defaults.sessionStore and LobsterAI's
//   internal plugins are managed by LobsterAI; overrides there are ignored.
//   gateway.auth/mode/port、meta、agents.defaults.sessionStore 和 LobsterAI
//   内部插件由 LobsterAI 管理，写在这里会被忽略。
// - Comments and trailing commas are allowed (JSON5).
//   支持注释和尾逗号（JSON5）。
//
// Example / 示例:
// {
//   agents: { defaults: { blockStreamingDefault: "on" } },
// }
{
}
`;

export type OpenClawUserConfigLeaf =
  | { path: string[]; value: unknown }
  | { path: string[]; members: unknown[] };

export type OpenClawUserConfigParseResult =
  | { ok: true; patch: JsonObject }
  | { ok: false; error: string };

export const OpenClawUserConfigFailureOutcome = {
  None: 'none',
  /** Overrides were withheld; resync to deliver the config without them. */
  Suspended: 'suspended',
  /** The config failed without overrides too; resync to put them back. */
  Restored: 'restored',
} as const;
export type OpenClawUserConfigFailureOutcome =
  typeof OpenClawUserConfigFailureOutcome[keyof typeof OpenClawUserConfigFailureOutcome];

/** What a single config render needs; created once per sync. */
export interface OpenClawUserConfigSyncSession {
  /** The config file with overrides the user removed taken back out. */
  generationBaseRaw: string;
  /**
   * Merges this sync's overrides into a rendered config. Top-level keys the
   * renderer does not own are first seeded from the base, so an override of an
   * unmanaged section patches it rather than replacing it.
   */
  apply(config: JsonObject, ownedSections: readonly string[]): {
    config: JsonObject;
    /** Top-level keys the target must own so the merged values and removals win. */
    ownedTopLevelKeys: string[];
  };
}

export interface OpenClawUserConfigOverlaySource {
  begin(baseRaw: string): OpenClawUserConfigSyncSession;
}

export interface OpenClawUserConfigStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

interface PersistedSuspension {
  hash: string;
  reason: OpenClawUserConfigSuspendReason;
  detail?: string;
  at: number;
  /** False until a config without overrides was accepted. */
  verified: boolean;
}

interface PersistedOverlayState {
  enabled?: boolean;
  /** Paths the last render applied; removed from the base when no longer overridden. */
  applied?: OpenClawUserConfigLeaf[];
  /** Last overrides that parsed, used while the file has a syntax error. */
  lastGood?: { patch: JsonObject; hash: string };
  suspension?: PersistedSuspension;
  /** Overrides proven not to cause a rejection; not suspended again. */
  innocentHash?: string;
}

interface OverlayEvaluation {
  enabled: boolean;
  fileExists: boolean;
  parseError?: string;
  /** Overrides from the file (or the last valid version), before toggles apply. */
  candidate: JsonObject;
  candidateHash: string;
  ignoredPaths: string[];
  suspension?: PersistedSuspension;
  /** What this render applies. */
  effective: JsonObject;
}

const isPlainObject = (value: unknown): value is JsonObject => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const samePath = (left: ConfigPath, right: ConfigPath): boolean => (
  left.length === right.length && left.every((segment, index) => segment === right[index])
);

const isPrefix = (prefix: ConfigPath, full: ConfigPath): boolean => (
  prefix.length <= full.length && prefix.every((segment, index) => segment === full[index])
);

const pathsOverlap = (left: ConfigPath, right: ConfigPath): boolean => (
  isPrefix(left, right) || isPrefix(right, left)
);

const isUnionArrayPath = (configPath: ConfigPath): boolean => (
  UNION_ARRAY_PATHS.some(unionPath => samePath(unionPath, configPath))
);

const isProtectedPath = (configPath: ConfigPath): boolean => (
  PROTECTED_PATHS.some(protectedPath => samePath(protectedPath, configPath))
);

/** Replacing an ancestor with a non-object would drop a path LobsterAI needs. */
const guardsRequiredPath = (configPath: ConfigPath): boolean => (
  [...PROTECTED_PATHS, ...UNION_ARRAY_PATHS].some(required => (
    configPath.length < required.length && isPrefix(configPath, required)
  ))
);

const isStringArray = (value: unknown): value is string[] => (
  Array.isArray(value) && value.every(item => typeof item === 'string')
);


export const formatOpenClawUserConfigPath = (configPath: ConfigPath): string => configPath.join('.');

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

export const hashOpenClawUserConfigPatch = (patch: JsonObject): string => (
  crypto.createHash('sha256').update(stableStringify(patch)).digest('hex')
);

export function parseOpenClawUserConfig(raw: string): OpenClawUserConfigParseResult {
  // Windows editors often save a byte order mark.
  const text = raw.replace(/^\uFEFF/, '');
  if (!text.trim()) return { ok: true, patch: {} };
  let value: unknown;
  try {
    value = parseJson5(text);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!isPlainObject(value)) {
    return { ok: false, error: 'The top level of openclaw.user.json must be an object.' };
  }
  return { ok: true, patch: value };
}

export function sanitizeOpenClawUserConfigPatch(patch: JsonObject): { patch: JsonObject; ignoredPaths: string[] } {
  const ignoredPaths: string[] = [];
  const visit = (node: JsonObject, prefix: string[]): JsonObject => {
    const result: JsonObject = {};
    for (const [key, value] of Object.entries(node)) {
      const configPath = [...prefix, key];
      if (key === INCLUDE_KEY || UNSAFE_KEYS.has(key) || isProtectedPath(configPath)) {
        ignoredPaths.push(formatOpenClawUserConfigPath(configPath));
        continue;
      }
      if (isUnionArrayPath(configPath)) {
        if (isStringArray(value)) result[key] = [...value];
        else ignoredPaths.push(formatOpenClawUserConfigPath(configPath));
        continue;
      }
      if (isPlainObject(value)) {
        const child = visit(value, configPath);
        // Keep an explicit `{}`, but not an object emptied by the rules above.
        if (Object.keys(child).length > 0 || Object.keys(value).length === 0) result[key] = child;
        continue;
      }
      if (guardsRequiredPath(configPath)) {
        ignoredPaths.push(formatOpenClawUserConfigPath(configPath));
        continue;
      }
      result[key] = structuredClone(value);
    }
    return result;
  };
  return { patch: visit(patch, []), ignoredPaths };
}

export function applyOpenClawUserConfigPatch(config: JsonObject, patch: JsonObject): JsonObject {
  const merge = (target: unknown, node: JsonObject, prefix: string[]): JsonObject => {
    const result: JsonObject = isPlainObject(target) ? { ...target } : {};
    for (const [key, value] of Object.entries(node)) {
      const configPath = [...prefix, key];
      if (value === null) {
        delete result[key];
      } else if (isUnionArrayPath(configPath) && Array.isArray(value)) {
        const current = Array.isArray(result[key]) ? result[key] as unknown[] : [];
        const added = value.filter(item => !current.some(existing => isDeepStrictEqual(existing, item)));
        const union = [...current, ...added];
        // Keep plugins.allow sorted like LobsterAI writes it, or the next render
        // (which reads the added members back from the file) would differ.
        result[key] = samePath(configPath, SORTED_UNION_PATH) && isStringArray(union) ? union.sort() : union;
      } else if (isPlainObject(value)) {
        result[key] = merge(result[key], value, configPath);
      } else {
        result[key] = structuredClone(value);
      }
    }
    return result;
  };
  return merge(config, patch, []);
}

export function collectOpenClawUserConfigLeaves(patch: JsonObject): OpenClawUserConfigLeaf[] {
  const leaves: OpenClawUserConfigLeaf[] = [];
  const visit = (node: JsonObject, prefix: string[]): void => {
    for (const [key, value] of Object.entries(node)) {
      const configPath = [...prefix, key];
      // A removal leaves nothing behind to take back out.
      if (value === null) continue;
      if (isUnionArrayPath(configPath) && Array.isArray(value)) {
        leaves.push({ path: configPath, members: structuredClone(value) });
      } else if (isPlainObject(value) && Object.keys(value).length > 0) {
        visit(value, configPath);
      } else {
        leaves.push({ path: configPath, value: structuredClone(value) });
      }
    }
  };
  visit(patch, []);
  return leaves;
}

/** Every path the overrides set or remove, for display and diagnostics. */
export function listOpenClawUserConfigPaths(patch: JsonObject): string[] {
  const paths: string[] = [];
  const visit = (node: JsonObject, prefix: string[]): void => {
    for (const [key, value] of Object.entries(node)) {
      const configPath = [...prefix, key];
      if (isPlainObject(value) && Object.keys(value).length > 0 && !isUnionArrayPath(configPath)) {
        visit(value, configPath);
      } else {
        paths.push(formatOpenClawUserConfigPath(configPath));
      }
    }
  };
  visit(patch, []);
  return paths;
}

const getAtPath = (root: JsonObject, configPath: ConfigPath): { found: boolean; value?: unknown } => {
  let node: unknown = root;
  for (const segment of configPath) {
    if (!isPlainObject(node) || !Object.hasOwn(node, segment)) return { found: false };
    node = node[segment];
  }
  return { found: true, value: node };
};

const parentAtPath = (root: JsonObject, configPath: ConfigPath): JsonObject | null => {
  let node: unknown = root;
  for (const segment of configPath.slice(0, -1)) {
    if (!isPlainObject(node)) return null;
    node = node[segment];
  }
  return isPlainObject(node) ? node : null;
};

/** Deletes the value and any parent objects that only held it. */
const deleteAtPath = (root: JsonObject, configPath: ConfigPath): void => {
  for (let depth = configPath.length; depth > 0; depth -= 1) {
    const current = configPath.slice(0, depth);
    const parent = parentAtPath(root, current);
    const key = current[current.length - 1];
    if (!parent) return;
    if (depth < configPath.length) {
      const child = parent[key];
      if (!isPlainObject(child) || Object.keys(child).length > 0) return;
    }
    delete parent[key];
  }
};

/**
 * Takes overrides the next render no longer applies back out of `base`. Only
 * values still equal to what was applied are removed, so a value OpenClaw or
 * the user changed since then is left alone. Returns the reverted leaves so the
 * record keeps them until the file no longer contains them.
 */
export function revertOpenClawUserConfigLeaves(
  base: JsonObject,
  applied: readonly OpenClawUserConfigLeaf[],
  nextPatch: JsonObject,
): { base: JsonObject; reverted: OpenClawUserConfigLeaf[] } {
  const nextLeaves = collectOpenClawUserConfigLeaves(nextPatch);
  const result = structuredClone(base);
  const reverted: OpenClawUserConfigLeaf[] = [];
  for (const leaf of applied) {
    const current = getAtPath(result, leaf.path);
    if (!current.found) continue;
    if ('members' in leaf) {
      if (!Array.isArray(current.value)) continue;
      const items: unknown[] = current.value;
      const nextLeaf = nextLeaves.find(next => samePath(next.path, leaf.path));
      const nextMembers = nextLeaf && 'members' in nextLeaf ? nextLeaf.members : [];
      const stale = leaf.members.filter(member => (
        !nextMembers.some(next => isDeepStrictEqual(next, member))
        && items.some(item => isDeepStrictEqual(item, member))
      ));
      if (stale.length === 0) continue;
      const parent = parentAtPath(result, leaf.path);
      if (parent) {
        parent[leaf.path[leaf.path.length - 1]] = items.filter(item => (
          !stale.some(member => isDeepStrictEqual(member, item))
        ));
      }
      reverted.push({ path: [...leaf.path], members: stale });
      continue;
    }
    if (nextLeaves.some(next => pathsOverlap(next.path, leaf.path))) continue;
    if (!isDeepStrictEqual(current.value, leaf.value)) continue;
    deleteAtPath(result, leaf.path);
    reverted.push(leaf);
  }
  return { base: result, reverted };
}

const mergeAppliedRecords = (
  nextLeaves: OpenClawUserConfigLeaf[],
  reverted: OpenClawUserConfigLeaf[],
): OpenClawUserConfigLeaf[] => {
  const merged = nextLeaves.map(leaf => structuredClone(leaf));
  for (const leaf of reverted) {
    const existing = merged.find(candidate => samePath(candidate.path, leaf.path));
    if (!existing) {
      merged.push(leaf);
    } else if ('members' in existing && 'members' in leaf) {
      existing.members.push(...leaf.members.filter(member => (
        !existing.members.some(item => isDeepStrictEqual(item, member))
      )));
    }
  }
  return merged;
};

const passthroughSession = (baseRaw: string): OpenClawUserConfigSyncSession => ({
  generationBaseRaw: baseRaw,
  apply: config => ({ config, ownedTopLevelKeys: [] }),
});

export interface OpenClawUserConfigOverlayDeps {
  /** Directory of the generated openclaw.json. */
  getConfigDir: () => string;
  getStore: () => OpenClawUserConfigStore;
  now?: () => number;
}

export class OpenClawUserConfigOverlay implements OpenClawUserConfigOverlaySource {
  private readonly deps: OpenClawUserConfigOverlayDeps;
  private state: PersistedOverlayState | null = null;
  /** The overrides carried by the most recently rendered config. */
  private lastPrepared: { hash: string; applied: boolean } | null = null;
  private lastLoggedSignature: string | null = null;

  constructor(deps: OpenClawUserConfigOverlayDeps) {
    this.deps = deps;
  }

  getFilePath(): string {
    return path.join(this.deps.getConfigDir(), OPENCLAW_USER_CONFIG_FILE_NAME);
  }

  /** Creates the commented template when the file does not exist yet. */
  ensureFile(): string {
    const filePath = this.getFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    try {
      fs.writeFileSync(filePath, USER_CONFIG_TEMPLATE, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return filePath;
  }

  begin(baseRaw: string): OpenClawUserConfigSyncSession {
    try {
      return this.beginSession(baseRaw);
    } catch (error) {
      // Overrides are optional; they must never block LobsterAI's own config.
      console.error(`${LOG_TAG} Failed to prepare overrides; rendering without them:`, error);
      this.lastPrepared = { hash: '', applied: false };
      return passthroughSession(baseRaw);
    }
  }

  getStatus(): OpenClawUserConfigStatus {
    const evaluation = this.evaluate();
    const state = (() => {
      if (!evaluation.enabled) return OpenClawUserConfigState.Disabled;
      if (evaluation.suspension) return OpenClawUserConfigState.Suspended;
      if (!evaluation.fileExists) return OpenClawUserConfigState.Missing;
      if (evaluation.parseError) return OpenClawUserConfigState.ParseError;
      return OpenClawUserConfigState.Active;
    })();
    return {
      enabled: evaluation.enabled,
      state,
      filePath: this.getFilePath(),
      overriddenPaths: listOpenClawUserConfigPaths(evaluation.candidate),
      ignoredPaths: evaluation.ignoredPaths,
      ...(evaluation.parseError ? { parseError: evaluation.parseError } : {}),
      ...(evaluation.suspension
        ? {
            suspension: {
              reason: evaluation.suspension.reason,
              ...(evaluation.suspension.detail ? { detail: evaluation.suspension.detail } : {}),
              at: evaluation.suspension.at,
            },
          }
        : {}),
    };
  }

  setEnabled(enabled: boolean): void {
    const state = this.readState();
    // Switching on again is a request to try the overrides again.
    this.writeState({
      ...state,
      enabled,
      ...(enabled ? { suspension: undefined, innocentHash: undefined } : {}),
    });
  }

  /** Clears a suspension so the next sync applies the overrides again. */
  resume(): void {
    const state = this.readState();
    if (!state.suspension && !state.innocentHash) return;
    this.writeState({ ...state, suspension: undefined, innocentHash: undefined });
  }

  /** Quick Repair returns the engine to LobsterAI's config; overrides wait for the user. */
  suspendForRepair(): boolean {
    const evaluation = this.evaluate();
    if (!evaluation.enabled || evaluation.suspension || Object.keys(evaluation.candidate).length === 0) {
      return false;
    }
    this.writeState({
      ...this.readState(),
      suspension: {
        hash: evaluation.candidateHash,
        reason: OpenClawUserConfigSuspendReason.Repair,
        at: this.now(),
        verified: true,
      },
    });
    console.log(`${LOG_TAG} Suspended overrides for Quick Repair`);
    return true;
  }

  /**
   * OpenClaw rejected the latest config. If it carried overrides, withhold
   * them and let the caller resync; if a config without them fails as well,
   * they were not the cause and are restored.
   */
  handleConfigFailure(detail?: string): OpenClawUserConfigFailureOutcome {
    const prepared = this.lastPrepared;
    if (!prepared) return OpenClawUserConfigFailureOutcome.None;
    const state = this.readState();
    const suspension = state.suspension;
    if (suspension && !suspension.verified) {
      if (prepared.applied) return OpenClawUserConfigFailureOutcome.None;
      this.writeState({ ...state, suspension: undefined, innocentHash: suspension.hash });
      console.warn(`${LOG_TAG} Config was rejected without overrides too; restoring them`);
      return OpenClawUserConfigFailureOutcome.Restored;
    }
    if (suspension || !prepared.applied || prepared.hash === state.innocentHash) {
      return OpenClawUserConfigFailureOutcome.None;
    }
    this.writeState({
      ...state,
      suspension: {
        hash: prepared.hash,
        reason: OpenClawUserConfigSuspendReason.ConfigInvalid,
        ...(detail ? { detail: detail.slice(0, MAX_FAILURE_DETAIL_LENGTH) } : {}),
        at: this.now(),
        verified: false,
      },
    });
    console.warn(`${LOG_TAG} OpenClaw rejected the config with overrides applied; suspending them`);
    return OpenClawUserConfigFailureOutcome.Suspended;
  }

  /** OpenClaw accepted the latest config. Confirms a pending suspension. */
  handleConfigAccepted(): void {
    const prepared = this.lastPrepared;
    if (!prepared || prepared.applied) return;
    const state = this.readState();
    if (!state.suspension || state.suspension.verified) return;
    this.writeState({ ...state, suspension: { ...state.suspension, verified: true } });
    console.log(`${LOG_TAG} Config without overrides was accepted; overrides stay suspended`);
  }

  private beginSession(baseRaw: string): OpenClawUserConfigSyncSession {
    const evaluation = this.evaluate();
    let state = this.readState();

    if (!evaluation.fileExists) {
      // A deleted file means no overrides; a later broken file must not revive old ones.
      if (state.lastGood) state = { ...state, lastGood: undefined };
    } else if (!evaluation.parseError && state.lastGood?.hash !== evaluation.candidateHash) {
      state = { ...state, lastGood: { patch: evaluation.candidate, hash: evaluation.candidateHash } };
    }
    // A changed file is a new attempt: lift the suspension and innocence marker.
    if (state.suspension && state.suspension.hash !== evaluation.candidateHash) {
      state = { ...state, suspension: undefined };
    }
    if (state.innocentHash && state.innocentHash !== evaluation.candidateHash) {
      state = { ...state, innocentHash: undefined };
    }

    const effective = evaluation.enabled && !state.suspension ? evaluation.candidate : {};
    let base: JsonObject | null = null;
    try {
      const parsed: unknown = baseRaw.trim() ? JSON.parse(baseRaw) : {};
      base = isPlainObject(parsed) ? parsed : null;
    } catch {
      // A corrupt file is replaced by the render; nothing to take back out.
    }

    let generationBaseRaw = baseRaw;
    let mergeBase: JsonObject = base ?? {};
    let reverted: OpenClawUserConfigLeaf[] = [];
    if (base) {
      const revert = revertOpenClawUserConfigLeaves(base, state.applied ?? [], effective);
      reverted = revert.reverted;
      mergeBase = revert.base;
      if (reverted.length > 0) generationBaseRaw = `${JSON.stringify(revert.base, null, 2)}\n`;
    }

    const nextLeaves = collectOpenClawUserConfigLeaves(effective);
    const applied = mergeAppliedRecords(nextLeaves, reverted);
    if (!isDeepStrictEqual(applied, state.applied ?? [])) state = { ...state, applied };
    this.writeState(state);

    const effectiveHash = hashOpenClawUserConfigPatch(effective);
    const appliesOverrides = Object.keys(effective).length > 0;
    this.lastPrepared = { hash: evaluation.candidateHash, applied: appliesOverrides };
    this.logEvaluation(evaluation, effective, effectiveHash);

    return {
      generationBaseRaw,
      apply: (config, ownedSections) => {
        this.settleReverted(config, nextLeaves, reverted);
        if (!appliesOverrides) return { config, ownedTopLevelKeys: [] };
        const seeded: JsonObject = { ...config };
        for (const key of Object.keys(effective)) {
          if (!Object.hasOwn(seeded, key) && !ownedSections.includes(key) && Object.hasOwn(mergeBase, key)) {
            seeded[key] = mergeBase[key];
          }
        }
        return {
          config: applyOpenClawUserConfigPatch(seeded, effective),
          ownedTopLevelKeys: Object.keys(effective),
        };
      },
    };
  }

  private evaluate(): OverlayEvaluation {
    const state = this.readState();
    const enabled = state.enabled !== false;
    const filePath = this.getFilePath();
    let fileExists = false;
    let parseError: string | undefined;
    let candidate: JsonObject = {};
    let ignoredPaths: string[] = [];

    let raw: string | null = null;
    try {
      const stat = fs.statSync(filePath);
      fileExists = true;
      if (stat.size > MAX_USER_CONFIG_BYTES) {
        parseError = `openclaw.user.json is larger than ${MAX_USER_CONFIG_BYTES} bytes.`;
      } else {
        raw = fs.readFileSync(filePath, 'utf8');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        fileExists = true;
        parseError = error instanceof Error ? error.message : String(error);
      }
    }

    if (raw !== null) {
      const parsed = parseOpenClawUserConfig(raw);
      if ('error' in parsed) {
        parseError = parsed.error;
      } else {
        const sanitized = sanitizeOpenClawUserConfigPatch(parsed.patch);
        candidate = sanitized.patch;
        ignoredPaths = sanitized.ignoredPaths;
      }
    }
    if (parseError) {
      candidate = state.lastGood?.patch ?? {};
    }
    const candidateHash = hashOpenClawUserConfigPatch(candidate);
    const suspension = state.suspension && state.suspension.hash === candidateHash ? state.suspension : undefined;
    return {
      enabled,
      fileExists,
      ...(parseError ? { parseError } : {}),
      candidate,
      candidateHash,
      ignoredPaths,
      ...(suspension ? { suspension } : {}),
      effective: enabled && !suspension ? candidate : {},
    };
  }

  /**
   * A reverted value that the render produces again is LobsterAI's own, not a
   * leftover override; stop tracking it so it is not reverted on every sync.
   */
  private settleReverted(
    rendered: JsonObject,
    nextLeaves: OpenClawUserConfigLeaf[],
    reverted: OpenClawUserConfigLeaf[],
  ): void {
    if (reverted.length === 0) return;
    const removed: OpenClawUserConfigLeaf[] = [];
    let rendersItself = false;
    for (const leaf of reverted) {
      const current = getAtPath(rendered, leaf.path);
      if ('members' in leaf) {
        const renderedMembers = current.found && Array.isArray(current.value) ? current.value : [];
        const gone = leaf.members.filter(member => !renderedMembers.some((item: unknown) => isDeepStrictEqual(item, member)));
        if (gone.length < leaf.members.length) rendersItself = true;
        if (gone.length > 0) removed.push({ path: leaf.path, members: gone });
      } else if (current.found && isDeepStrictEqual(current.value, leaf.value)) {
        rendersItself = true;
      } else {
        removed.push(leaf);
      }
    }
    if (removed.length > 0) {
      console.log(`${LOG_TAG} Removing ${removed.length} override path(s) that no longer apply: ${removed.map(leaf => formatOpenClawUserConfigPath(leaf.path)).join(', ')}`);
    }
    if (rendersItself) {
      this.writeState({ ...this.readState(), applied: mergeAppliedRecords(nextLeaves, removed) });
    }
  }

  private logEvaluation(evaluation: OverlayEvaluation, effective: JsonObject, effectiveHash: string): void {
    const signature = [effectiveHash, evaluation.parseError ?? '', evaluation.ignoredPaths.join(',')].join('|');
    if (signature === this.lastLoggedSignature) return;
    this.lastLoggedSignature = signature;
    if (evaluation.parseError) {
      console.warn(`${LOG_TAG} openclaw.user.json does not parse; keeping the last valid overrides: ${evaluation.parseError}`);
    }
    if (evaluation.ignoredPaths.length > 0) {
      console.warn(`${LOG_TAG} Ignoring overrides of LobsterAI-managed paths: ${evaluation.ignoredPaths.join(', ')}`);
    }
    const paths = listOpenClawUserConfigPaths(effective);
    if (paths.length > 0) {
      console.log(`${LOG_TAG} Applying ${paths.length} override path(s): ${paths.join(', ')}`);
    } else if (Object.keys(evaluation.candidate).length > 0) {
      console.log(`${LOG_TAG} Overrides present but not applied (enabled=${evaluation.enabled} suspended=${!!evaluation.suspension})`);
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private readState(): PersistedOverlayState {
    if (!this.state) {
      const stored = this.deps.getStore().get<PersistedOverlayState>(OPENCLAW_USER_CONFIG_STORE_KEY);
      this.state = isPlainObject(stored) ? stored as PersistedOverlayState : {};
    }
    return this.state;
  }

  private writeState(next: PersistedOverlayState): void {
    const normalized = Object.fromEntries(
      Object.entries(next).filter(([, value]) => value !== undefined),
    ) as PersistedOverlayState;
    if (this.state && isDeepStrictEqual(this.state, normalized)) return;
    this.state = normalized;
    this.deps.getStore().set(OPENCLAW_USER_CONFIG_STORE_KEY, normalized);
  }
}
