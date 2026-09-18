import fs from 'fs';
import path from 'path';

import { OPENCLAW_LEGACY_DISCOVERY_KEY } from '../../shared/openclawEngine/startupCompatibility';
import { LEGACY_PLUGIN_INSTALL_CONFIG_PATH } from './openclawPluginInstallMigration';
import { runStartupMigration, type StartupMigrationRunner } from './openclawStartupStateMigration';
import { safelyReplaceTextFileSync } from './safeFileReplace';

/**
 * Upgrading over data from an older build keeps its openclaw.json: uninstalling
 * on Windows does not remove %APPDATA%, and the no-model config path preserves
 * existing sections. Keys the bundled OpenClaw has since retired then fail strict
 * validation. The legacy session import (`doctor --session-sqlite import`) refuses
 * to run, which blocks startup before the gateway is spawned, and the gateway
 * itself exits for retired keys that OpenClaw has no startup migration for.
 *
 * The bundled CLI's own `config validate --json` names those keys precisely, so
 * removing exactly what it reports as unrecognized repairs data from any older
 * version without LobsterAI having to track OpenClaw's schema retirements.
 */

const CONFIG_VALIDATE_TIMEOUT_MS = 60_000;
// `config validate --json` reports top-level issues under this path.
const ROOT_ISSUE_PATH = '<root>';
const UNRECOGNIZED_KEYS_MESSAGE = /^Unrecognized keys?:\s*(.+)$/;

/**
 * Retired keys that other startup migrations still read. Removing them here
 * would drop what those migrations carry forward: plugin install records move
 * into OpenClaw's plugin index, and bundled discovery moves into machine state.
 */
const MIGRATION_OWNED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  LEGACY_PLUGIN_INSTALL_CONFIG_PATH,
  `plugins.${OPENCLAW_LEGACY_DISCOVERY_KEY}`,
]);

export const OpenClawConfigSelfHealStatus = {
  Skipped: 'skipped',
  Valid: 'valid',
  Healed: 'healed',
  Invalid: 'invalid',
} as const;

export type OpenClawConfigIssue = { path?: string; message?: string };

export type OpenClawConfigSelfHealResult =
  | {
      status: typeof OpenClawConfigSelfHealStatus.Skipped;
      reason: 'missing-openclaw-cli' | 'missing-config' | 'unparseable-validate-output' | 'config-changed';
    }
  | { status: typeof OpenClawConfigSelfHealStatus.Valid }
  | { status: typeof OpenClawConfigSelfHealStatus.Healed; removed: string[]; backupPath: string }
  | {
      status: typeof OpenClawConfigSelfHealStatus.Invalid;
      removed: string[];
      backupPath?: string;
      issues: OpenClawConfigIssue[];
    };

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

/**
 * Walks an issue path such as `tools.loopDetection` or `agents.list.0`. Keys may
 * themselves contain dots (model ids like `qwen3.6-plus`), so each step prefers
 * the longest existing key.
 */
const resolveIssueContainer = (root: Record<string, unknown>, issuePath: string): Record<string, unknown> | null => {
  const segments = issuePath && issuePath !== ROOT_ISSUE_PATH ? issuePath.split('.') : [];
  let current: unknown = root;
  let index = 0;
  while (index < segments.length) {
    if (Array.isArray(current)) {
      const item = Number(segments[index]);
      if (!Number.isInteger(item)) return null;
      current = current[item];
      index += 1;
      continue;
    }
    if (!isPlainObject(current)) return null;
    let matched = false;
    for (let end = segments.length; end > index; end -= 1) {
      const key = segments.slice(index, end).join('.');
      if (Object.hasOwn(current, key)) {
        current = current[key];
        index = end;
        matched = true;
        break;
      }
    }
    if (!matched) return null;
  }
  return isPlainObject(current) ? current : null;
};

/** Removes only the keys OpenClaw reported as unrecognized; other issues are left as reported. */
export function removeUnrecognizedOpenClawConfigKeys(
  config: Record<string, unknown>,
  issues: readonly OpenClawConfigIssue[],
): { config: Record<string, unknown>; removed: string[] } {
  const next = structuredClone(config);
  const removed: string[] = [];
  for (const issue of issues) {
    const match = UNRECOGNIZED_KEYS_MESSAGE.exec((issue.message ?? '').trim());
    if (!match) continue;
    const issuePath = issue.path === ROOT_ISSUE_PATH ? '' : issue.path ?? '';
    const container = resolveIssueContainer(next, issuePath);
    if (!container) continue;
    for (const [, key] of match[1].matchAll(/"([^"]+)"/g)) {
      const keyPath = issuePath ? `${issuePath}.${key}` : key;
      if (MIGRATION_OWNED_CONFIG_KEYS.has(keyPath) || !Object.hasOwn(container, key)) continue;
      delete container[key];
      removed.push(keyPath);
    }
  }
  return { config: next, removed };
}

export function parseOpenClawConfigValidateOutput(
  stdout: string,
): { valid: boolean; issues: OpenClawConfigIssue[] } | null {
  const text = stdout.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { valid?: unknown; issues?: unknown };
    if (typeof parsed.valid !== 'boolean') return null;
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.filter(isPlainObject).map(issue => ({
        path: typeof issue.path === 'string' ? issue.path : undefined,
        message: typeof issue.message === 'string' ? issue.message : undefined,
      }))
      : [];
    return { valid: parsed.valid, issues };
  } catch {
    return null;
  }
}

/**
 * Validates openclaw.json with the bundled CLI and, when it reports unrecognized
 * keys, removes exactly those keys (keeping a backup of the original file) and
 * validates again. Never touches the file for any other kind of issue.
 */
export async function healOpenClawConfigUnrecognizedKeys(params: {
  configPath: string;
  stateDir: string;
  runtimeRoot: string;
  electronNodeRuntimePath: string;
  env: NodeJS.ProcessEnv;
  runner?: StartupMigrationRunner;
  now?: Date;
}): Promise<OpenClawConfigSelfHealResult> {
  const cliPath = path.join(params.runtimeRoot, 'openclaw.mjs');
  if (!fs.existsSync(cliPath)) {
    return { status: OpenClawConfigSelfHealStatus.Skipped, reason: 'missing-openclaw-cli' };
  }
  let raw: string;
  let mode: number;
  try {
    raw = fs.readFileSync(params.configPath, 'utf8');
    mode = fs.statSync(params.configPath).mode & 0o777;
  } catch {
    return { status: OpenClawConfigSelfHealStatus.Skipped, reason: 'missing-config' };
  }

  const runner = params.runner ?? runStartupMigration;
  const validate = async () => {
    const result = await runner(params.electronNodeRuntimePath, [cliPath, 'config', 'validate', '--json'], {
      cwd: params.runtimeRoot,
      env: {
        ...params.env,
        OPENCLAW_HOME: path.dirname(params.stateDir),
        OPENCLAW_STATE_DIR: params.stateDir,
        OPENCLAW_CONFIG_PATH: params.configPath,
        OPENCLAW_SERVICE_REPAIR_POLICY: 'external',
        ELECTRON_RUN_AS_NODE: '1',
      },
      timeoutMs: CONFIG_VALIDATE_TIMEOUT_MS,
    });
    return parseOpenClawConfigValidateOutput(result.stdout);
  };

  const before = await validate();
  if (!before) return { status: OpenClawConfigSelfHealStatus.Skipped, reason: 'unparseable-validate-output' };
  if (before.valid) return { status: OpenClawConfigSelfHealStatus.Valid };

  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      return { status: OpenClawConfigSelfHealStatus.Invalid, removed: [], issues: before.issues };
    }
    config = parsed;
  } catch {
    return { status: OpenClawConfigSelfHealStatus.Invalid, removed: [], issues: before.issues };
  }
  const { config: healed, removed } = removeUnrecognizedOpenClawConfigKeys(config, before.issues);
  if (removed.length === 0) {
    return { status: OpenClawConfigSelfHealStatus.Invalid, removed, issues: before.issues };
  }
  // A concurrent config sync may have rewritten the file while the CLI ran.
  if (fs.readFileSync(params.configPath, 'utf8') !== raw) {
    return { status: OpenClawConfigSelfHealStatus.Skipped, reason: 'config-changed' };
  }

  const stamp = (params.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const backupPath = `${params.configPath}.before-self-heal-${stamp}`;
  fs.writeFileSync(backupPath, raw, { flag: 'wx', mode: 0o600 });
  safelyReplaceTextFileSync({
    filePath: params.configPath,
    content: `${JSON.stringify(healed, null, 2)}\n`,
    mode,
    tempLabel: 'self-heal',
  });

  const after = await validate();
  if (after?.valid) return { status: OpenClawConfigSelfHealStatus.Healed, removed, backupPath };
  return {
    status: OpenClawConfigSelfHealStatus.Invalid,
    removed,
    backupPath,
    issues: after?.issues ?? before.issues,
  };
}
