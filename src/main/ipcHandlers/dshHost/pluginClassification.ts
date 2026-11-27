// Pure Node helpers for classifying DSH bundle capabilities (native host vs
// hybrid vs DSH Web-only / theme skins) and enriching live `pluginManager`
// bundle snapshots into LobsterAI's plugin list contract.
//
// Zero Electron imports — directly unit-testable under Node Vitest.

import * as fs from 'fs';
import * as path from 'path';

import {
  DshPluginApplicationStatus,
  DshPluginAvailability,
  DshPluginPanelKind,
  DshPluginSurface,
  DshPluginUpdateKind,
  DshPluginUpdateOutcomeKind,
} from '../../../shared/dshEngine/hostConstants';
import type {
  DshLocalizedText,
  DshPluginBundleInfo,
  DshPluginChangeResult,
  DshPluginIncompatibleInfo,
  DshPluginUpdateResult,
} from '../../libs/dsh/dshTypertClient';
import {
  type DshProfilePluginInfo,
  isManagedDshBundle,
} from './pluginOperations';

export interface LocalizedTextMap {
  en?: string;
  zh?: string;
}

export interface DshEnrichedPluginEntry extends DshProfilePluginInfo {
  version?: string;
  title?: LocalizedTextMap;
  description?: LocalizedTextMap;
  icon?: string;
  official?: boolean;
  availability?: DshPluginAvailability;
  update?: DshPluginUpdateKind;
  source?: string;
  removable?: boolean;
  surface: DshPluginSurface;
  isThemePlugin: boolean;
  panelId?: string;
  panelKind?: DshPluginPanelKind;
  panelLabel?: LocalizedTextMap;
  errorCode?: string;
  errorMessage?: string;
  rowCount?: number;
  activeRowCount?: number;
}

export interface DshPluginPanelMetadata {
  panelId?: string;
  panelKind?: DshPluginPanelKind;
  panelLabel?: LocalizedTextMap;
}

export interface DshPluginSurfaceClassification {
  surface: DshPluginSurface;
  hasHostCapability: boolean;
  hasWebClient: boolean;
  isThemePlugin: boolean;
  panelId?: string;
  panelKind?: DshPluginPanelKind;
  panelLabel?: LocalizedTextMap;
  heuristicOnly?: boolean;
}

export interface DshPluginInspectResult {
  ok: boolean;
  status?: 'accepted' | 'refused';
  kind?: 'registry' | 'path' | 'git' | 'tarball';
  name?: string;
  version?: string;
  description?: string;
  bundle?: boolean | null;
  registry?: string | null;
  host?: string;
  problem?: string;
  reason?: string;
  registries?: Array<string | null>;
  surface?: DshPluginSurface;
  isThemePlugin?: boolean;
  heuristicOnly?: boolean;
  error?: string;
}

export interface DshPluginMutationOutcome {
  ok: boolean;
  application?: DshPluginApplicationStatus;
  restartRequired?: boolean;
  restartReason?: string;
  stage?: 'install' | 'enable' | 'remove';
  changed?: boolean;
  enabled?: boolean;
  bundle?: string;
  version?: string;
  errorCode?: string;
  failureKind?: string;
  failedAt?: 'registry' | 'spec-host';
  error?: string;
  pendingBuilds?: string[];
  approvedBuilds?: string[];
  registries?: Array<string | null>;
  incompatible?: DshPluginIncompatibleInfo[];
  exitCode?: number | null;
  output?: string;
  logPath?: string;
  stdout?: string;
  stderr?: string;
  plugins: DshEnrichedPluginEntry[];
}

export interface DshPluginUpdateOutcome {
  ok: boolean;
  outcome: DshPluginUpdateOutcomeKind;
  from: string;
  to: string;
  step?: 'check' | 'remove' | 'install';
  application?: DshPluginApplicationStatus;
  restartRequired?: boolean;
  restartReason?: string;
  errorCode?: string;
  failureKind?: string;
  failedAt?: 'registry' | 'spec-host';
  error?: string;
  pendingBuilds?: string[];
  incompatible?: DshPluginIncompatibleInfo[];
  output?: string;
  logPath?: string;
  restored?: boolean;
  restoreApplication?: DshPluginApplicationStatus;
  restoreError?: string;
  plugins: DshEnrichedPluginEntry[];
}

const THEME_SERVICE_PACKAGE = '@deepseek-ai/dsh-client-ui-theme';
const THEME_HINT_PATTERN =
  /\b(?:theme|themes|skin|skins|palette|color-?scheme|dark-?mode|light-?mode)\b|皮肤|主题|配色|换肤/i;
const WEB_UI_ONLY_NAME_PATTERN = /(?:^|[/-])(?:client-ui|web-ui|web-theme|ui-theme|ui-skin)(?:[/-]|$)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readJsonFileSafe(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function normalizeLocalizedText(value: DshLocalizedText | undefined): LocalizedTextMap | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? { en: trimmed, zh: trimmed } : undefined;
  }
  if (!isRecord(value)) return undefined;
  const en = typeof value.en === 'string' && value.en.trim() ? value.en.trim() : undefined;
  const zh = typeof value.zh === 'string' && value.zh.trim()
    ? value.zh.trim()
    : (typeof value['zh-CN'] === 'string' && value['zh-CN'].trim() ? value['zh-CN'].trim() : undefined);
  if (!en && !zh) return undefined;
  return {
    ...(en ? { en } : {}),
    ...(zh ? { zh } : {}),
  };
}

/**
 * Extracts an npm package name from a Cordis module specifier
 * (e.g. `@scope/pkg/subpath` -> `@scope/pkg`, `pkg/subpath` -> `pkg`).
 * Returns null for relative (`./...`), builtin (`cordis:...`), or empty specs.
 */
export function extractPackageNameFromModule(moduleName: string): string | null {
  const trimmed = moduleName.trim();
  if (!trimmed || trimmed.startsWith('.') || trimmed.startsWith('/') || trimmed.includes(':')) {
    return null;
  }
  const parts = trimmed.split('/');
  if (trimmed.startsWith('@')) {
    return parts.length >= 2 && parts[0] && parts[1] ? `${parts[0]}/${parts[1]}` : null;
  }
  return parts[0] || null;
}

const HOST_ENTRY_SIGNAL_PATTERN =
  /\b(?:tools|commands|subagent|mcpManager|systemPrompt|llm|webServer|connection\.fetch|fetch\.register)\b/;

const MAX_CLIENT_BUNDLE_INSPECT_BYTES = 4 * 1024 * 1024;
const RESERVED_MAIN_PANEL_IDS = new Set(['conversation', 'plugins']);
const RESERVED_SETTINGS_SECTION_IDS = new Set([
  'general',
  'account',
  'models',
  'plugins',
  'agent-presets',
  'archived-sessions',
]);
const I18N_KEY_PATTERN =
  /^(?:[a-z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*|[A-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)+)$/;

function resolveClientEntryRelPath(manifest: Record<string, unknown>): string | null {
  if (!isRecord(manifest.exports)) return null;
  const clientExport = manifest.exports['./client'];
  if (typeof clientExport === 'string' && clientExport.trim()) {
    return clientExport.trim();
  }
  if (isRecord(clientExport) && typeof clientExport.default === 'string' && clientExport.default.trim()) {
    return clientExport.default.trim();
  }
  return null;
}

function decodeJsStringLiteral(raw: string): string {
  try {
    // Escape unescaped double quotes if the source used single quotes or backticks,
    // then decode standard JS/JSON unicode and escape sequences safely.
    const normalized = raw
      .replace(/\\'/g, "'")
      .replace(/\\`/g, '`')
      .replace(/(?<!\\)"/g, '\\"');
    const parsed: unknown = JSON.parse(`"${normalized}"`);
    return typeof parsed === 'string' ? parsed.trim() : raw.trim();
  } catch {
    return raw
      .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .trim();
  }
}

function resolveIdentifierStringLiteral(source: string, identifier: string): string | null {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declPattern = new RegExp(
    `(?:\\b(?:var|let|const)\\s+|[,;]\\s*)${escaped}\\s*=\\s*(['"\`])([^'"\`\\\\\\r\\n$]+)\\1`,
  );
  const match = declPattern.exec(source);
  return match?.[2] ? decodeJsStringLiteral(match[2]) : null;
}

function normalizeValidPanelId(
  candidate: string | null | undefined,
  reservedIds: ReadonlySet<string> = RESERVED_MAIN_PANEL_IDS,
): string | undefined {
  if (!candidate) return undefined;
  const trimmed = candidate.trim();
  if (!trimmed || reservedIds.has(trimmed)) return undefined;
  if (/[\s\x00-\x1f\x7f]/.test(trimmed)) return undefined;
  return trimmed;
}

function extractSlotPropertyString(
  source: string,
  block: string,
  propName: 'key' | 'id',
): string | null {
  const literalMatch = new RegExp(`\\b${propName}\\s*:\\s*(['"\`])([^'"\`\\\\\\r\\n$]+)\\1`).exec(block);
  if (literalMatch?.[2]) {
    return decodeJsStringLiteral(literalMatch[2]);
  }
  const identMatch = new RegExp(`\\b${propName}\\s*:\\s*([A-Za-z_$][A-Za-z0-9_$]*)`).exec(block);
  if (identMatch?.[1]) {
    return resolveIdentifierStringLiteral(source, identMatch[1]);
  }
  return null;
}

function extractSlotLabel(block: string): LocalizedTextMap | undefined {
  if (!block) return undefined;
  // Match `label: "Text"`, `label: () => "Text"`, or `label: () => fn("Text")`
  // across single, double, and backtick quotes.
  const labelCallMatch =
    /\blabel\s*:\s*(?:\(\s*\)\s*=>\s*)?([A-Za-z_$][A-Za-z0-9_$.]*)\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\\r\n])+)\2/.exec(
      block,
    );
  const labelDirectMatch =
    /\blabel\s*:\s*(?:\(\s*\)\s*=>\s*)?(['"`])((?:\\.|(?!\1)[^\\\r\n])+)\1/.exec(block);
  const rawLabel = labelDirectMatch?.[2] ?? labelCallMatch?.[3];
  const isWrappedCall = !labelDirectMatch && Boolean(labelCallMatch);
  if (!rawLabel) return undefined;
  const decoded = decodeJsStringLiteral(rawLabel);
  if (!decoded || (isWrappedCall && I18N_KEY_PATTERN.test(decoded))) {
    return undefined;
  }
  return { en: decoded, zh: decoded };
}

export function extractPanelMetadataFromClientSource(
  source: string,
  fallbackRowId?: string,
): DshPluginPanelMetadata {
  if (!source) return {};

  let panelId: string | undefined;
  let panelKind: DshPluginPanelKind | undefined;
  let panelLabel: LocalizedTextMap | undefined;

  // 1. Inspect `main` slot registration object block (supports ', ", and tsdown/oxc ` quotes,
  //    as well as arbitrary property ordering such as `{ name: `main`, locale: i, key: Xd }` or `{ key: 'x', name: 'main' }`).
  const mainEntryMatch =
    /\{[^{}]{0,200}\bname\s*:\s*(['"`])main\1[^}]{0,300}/.exec(source)
    ?? /\bname\s*:\s*(['"`])main\1[^}]{0,300}/.exec(source);
  const mainBlock = mainEntryMatch?.[0] ?? '';

  const rawMainKey = mainBlock ? extractSlotPropertyString(source, mainBlock, 'key') : null;
  if (rawMainKey) {
    panelId = normalizeValidPanelId(rawMainKey, RESERVED_MAIN_PANEL_IDS);
  }

  // 2. Inspect `sidebar.panellist` registration block (`id` and optional `label`).
  const sidebarEntryMatch =
    /\{[^{}]{0,200}\bname\s*:\s*(['"`])sidebar\.panellist\1[^}]{0,400}/.exec(source)
    ?? /\bname\s*:\s*(['"`])sidebar\.panellist\1[^}]{0,400}/.exec(source);
  const sidebarBlock = sidebarEntryMatch?.[0] ?? '';

  const rawSidebarId = !panelId && sidebarBlock
    ? extractSlotPropertyString(source, sidebarBlock, 'id')
    : null;
  if (rawSidebarId) {
    panelId = normalizeValidPanelId(rawSidebarId, RESERVED_MAIN_PANEL_IDS);
  }

  const hasMainPanelRegistration =
    Boolean(panelId)
    || (!rawMainKey && !rawSidebarId && (
      Boolean(mainBlock)
      || Boolean(sidebarBlock)
      || /\bslots\.inject\s*\(\s*(['"`])(?:main|sidebar\.panellist)\1/.test(source)
    ));

  if (!panelId && hasMainPanelRegistration && fallbackRowId) {
    panelId = normalizeValidPanelId(fallbackRowId, RESERVED_MAIN_PANEL_IDS);
  }

  if (panelId) {
    panelKind = DshPluginPanelKind.Main;
    panelLabel = extractSlotLabel(sidebarBlock);
  } else {
    // 3. Inspect `settings.section` registration block for plugins whose dedicated
    //    UI is contributed as a DSH Settings tab (e.g. `dsh-pocket`).
    const settingsEntryMatch =
      /\{[^{}]{0,200}\bname\s*:\s*(['"`])settings\.section\1[^}]{0,400}/.exec(source)
      ?? /\bname\s*:\s*(['"`])settings\.section\1[^}]{0,400}/.exec(source);
    const settingsBlock = settingsEntryMatch?.[0] ?? '';

    const rawSettingsId = settingsBlock
      ? extractSlotPropertyString(source, settingsBlock, 'id')
      : null;
    if (rawSettingsId) {
      panelId = normalizeValidPanelId(rawSettingsId, RESERVED_SETTINGS_SECTION_IDS);
    }

    const hasSettingsSectionRegistration =
      Boolean(panelId)
      || (!rawSettingsId && (
        Boolean(settingsBlock)
        || /\bslots\.inject\s*\(\s*(['"`])settings\.section\1/.test(source)
      ));

    if (!panelId && hasSettingsSectionRegistration && fallbackRowId) {
      panelId = normalizeValidPanelId(fallbackRowId, RESERVED_SETTINGS_SECTION_IDS);
    }

    if (panelId) {
      panelKind = DshPluginPanelKind.SettingsSection;
      panelLabel = extractSlotLabel(settingsBlock);
    }
  }

  return {
    ...(panelId ? { panelId, ...(panelKind ? { panelKind } : {}) } : {}),
    ...(panelLabel ? { panelLabel } : {}),
  };
}

function detectClientPanelMetadata(
  pkgDir: string | null,
  manifest: Record<string, unknown>,
  fallbackRowId?: string,
): DshPluginPanelMetadata {
  if (!pkgDir) return {};
  const clientRel = resolveClientEntryRelPath(manifest);
  if (!clientRel) return {};
  const clientPath = path.resolve(pkgDir, clientRel);
  if (!clientPath.startsWith(path.resolve(pkgDir))) return {};
  try {
    if (!fs.existsSync(clientPath)) return {};
    const stat = fs.statSync(clientPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_CLIENT_BUNDLE_INSPECT_BYTES) {
      return {};
    }
    const source = fs.readFileSync(clientPath, 'utf8');
    return extractPanelMetadataFromClientSource(source, fallbackRowId);
  } catch {
    return {};
  }
}

function detectHostEntryCapability(pkgDir: string | null, manifest: Record<string, unknown>): boolean {
  if (!pkgDir) return false;
  let mainRel: string | null = null;
  if (typeof manifest.main === 'string' && manifest.main.trim()) {
    mainRel = manifest.main.trim();
  } else if (isRecord(manifest.exports)) {
    const rootExport = manifest.exports['.'];
    if (typeof rootExport === 'string' && rootExport.trim()) {
      mainRel = rootExport.trim();
    } else if (isRecord(rootExport) && typeof rootExport.default === 'string' && rootExport.default.trim()) {
      mainRel = rootExport.default.trim();
    }
  }
  if (!mainRel) return false;
  const mainPath = path.resolve(pkgDir, mainRel);
  if (!mainPath.startsWith(path.resolve(pkgDir))) return false;
  try {
    if (!fs.existsSync(mainPath)) return false;
    const stat = fs.statSync(mainPath);
    if (!stat.isFile() || stat.size === 0) return false;
    // Read up to 32 KiB to look for Host service/tool/route registrations.
    const fd = fs.openSync(mainPath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(stat.size, 32 * 1024));
      const readBytes = fs.readSync(fd, buf, 0, buf.length, 0);
      const snippet = buf.subarray(0, readBytes).toString('utf8');
      return HOST_ENTRY_SIGNAL_PATTERN.test(snippet);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function readPackageFromRoots(
  pkgName: string,
  nodeModulesRoots: readonly string[],
): { dir: string; manifest: Record<string, unknown> } | null {
  const segments = pkgName.split('/');
  for (const root of nodeModulesRoots) {
    const dir = path.join(root, ...segments);
    const manifest = readJsonFileSafe(path.join(dir, 'package.json'));
    if (manifest) return { dir, manifest };
  }
  return null;
}

function inspectPackageManifestSurface(
  manifest: Record<string, unknown>,
  pkgDir: string | null = null,
): {
  hasWebClient: boolean;
  hasHostCapability: boolean;
  isThemePlugin: boolean;
} {
  const dsh = isRecord(manifest.dsh) ? manifest.dsh : null;
  const client = dsh && isRecord(dsh.client) ? dsh.client : null;
  const platform = typeof client?.platform === 'string' ? client.platform.trim().toLowerCase() : '';
  const hasWebClient = platform === 'web';

  const injectList = Array.isArray(client?.inject)
    ? client.inject.filter((item): item is string => typeof item === 'string')
    : [];
  const deps = isRecord(manifest.dependencies) ? Object.keys(manifest.dependencies) : [];
  const peers = isRecord(manifest.peerDependencies) ? Object.keys(manifest.peerDependencies) : [];

  const referencesThemeService =
    injectList.includes(THEME_SERVICE_PACKAGE)
    || deps.includes(THEME_SERVICE_PACKAGE)
    || peers.includes(THEME_SERVICE_PACKAGE);

  const pkgName = typeof manifest.name === 'string' ? manifest.name : '';
  const pkgDesc = typeof manifest.description === 'string' ? manifest.description : '';
  const isThemePlugin =
    hasWebClient
    && (referencesThemeService || THEME_HINT_PATTERN.test(pkgName) || THEME_HINT_PATTERN.test(pkgDesc));

  const hasHostCapability = !hasWebClient
    || (!isThemePlugin && detectHostEntryCapability(pkgDir, manifest));

  return { hasWebClient, hasHostCapability, isThemePlugin };
}

function extractPatchRowSpecs(
  bundleDir: string,
  manifest: Record<string, unknown>,
): Array<{ rowId?: string; moduleName: string }> {
  const dsh = isRecord(manifest.dsh) ? manifest.dsh : null;
  const bundle = dsh && isRecord(dsh.bundle) ? dsh.bundle : null;
  const rawPatches = typeof bundle?.patch === 'string'
    ? [bundle.patch]
    : Array.isArray(bundle?.patch)
      ? bundle.patch.filter((item): item is string => typeof item === 'string')
      : [];

  const rows: Array<{ rowId?: string; moduleName: string }> = [];
  for (const relPatch of rawPatches) {
    const patchPath = path.resolve(bundleDir, relPatch);
    if (!patchPath.startsWith(path.resolve(bundleDir))) continue;
    try {
      if (!fs.existsSync(patchPath)) continue;
      const content = fs.readFileSync(patchPath, 'utf8');
      let pendingRowId: string | undefined;
      for (const line of content.split(/\r?\n/)) {
        const idMatch = /^\s*(?:-\s*)?id:\s*['"]?([^'"#\r\n]+?)['"]?\s*$/.exec(line);
        if (idMatch?.[1]) {
          pendingRowId = idMatch[1].trim();
          continue;
        }
        const nameMatch = /^\s*(?:-\s*)?name:\s*['"]?([^'"#\r\n]+?)['"]?\s*$/.exec(line);
        if (nameMatch?.[1]) {
          const value = nameMatch[1].trim();
          if (value && !value.startsWith('cordis:')) {
            rows.push({
              ...(pendingRowId ? { rowId: pendingRowId } : {}),
              moduleName: value,
            });
          }
          pendingRowId = undefined;
        }
      }
    } catch {
      // Best-effort static inspection.
    }
  }
  return rows;
}

export function detectThemeOrWebUiHint(
  name?: string,
  description?: string,
): DshPluginSurfaceClassification {
  const textName = (name ?? '').trim();
  const textDesc = (description ?? '').trim();
  const isTheme = THEME_HINT_PATTERN.test(textName) || THEME_HINT_PATTERN.test(textDesc);
  if (isTheme) {
    return {
      surface: DshPluginSurface.WebOnly,
      hasHostCapability: false,
      hasWebClient: true,
      isThemePlugin: true,
      heuristicOnly: true,
    };
  }
  if (WEB_UI_ONLY_NAME_PATTERN.test(textName)) {
    return {
      surface: DshPluginSurface.WebOnly,
      hasHostCapability: false,
      hasWebClient: true,
      isThemePlugin: false,
      heuristicOnly: true,
    };
  }
  return {
    surface: DshPluginSurface.Native,
    hasHostCapability: true,
    hasWebClient: false,
    isThemePlugin: false,
    heuristicOnly: true,
  };
}

/**
 * Classifies whether a DSH bundle provides native Host capabilities, a hybrid
 * of Host + DSH Web panel, or DSH Web-only UI / theme extensions that cannot
 * take effect on LobsterAI's native Electron UI.
 */
export function classifyBundleSurface(options: {
  name?: string;
  description?: string;
  rows?: ReadonlyArray<{ rowId?: string; moduleName: string }>;
  profileDir?: string;
  runtimeDir?: string;
  localDir?: string;
}): DshPluginSurfaceClassification {
  const nodeModulesRoots: string[] = [];
  if (options.localDir) {
    nodeModulesRoots.push(path.join(options.localDir, 'node_modules'));
  }
  if (options.profileDir) {
    nodeModulesRoots.push(path.join(options.profileDir, 'node_modules'));
  }
  if (options.runtimeDir) {
    nodeModulesRoots.push(path.join(options.runtimeDir, 'node_modules'));
  }

  let bundleManifest: Record<string, unknown> | null = null;
  let bundleDir: string | null = null;
  if (options.localDir) {
    bundleDir = options.localDir;
    bundleManifest = readJsonFileSafe(path.join(options.localDir, 'package.json'));
  } else if (options.name) {
    for (const root of nodeModulesRoots) {
      const candidateDir = path.join(root, ...options.name.split('/'));
      const manifest = readJsonFileSafe(path.join(candidateDir, 'package.json'));
      if (manifest) {
        bundleDir = candidateDir;
        bundleManifest = manifest;
        break;
      }
    }
  }

  const rowSpecs: Array<{ rowId?: string; moduleName: string }> =
    options.rows && options.rows.length > 0
      ? options.rows.map((row) => ({ rowId: row.rowId, moduleName: row.moduleName }))
      : (bundleDir && bundleManifest ? extractPatchRowSpecs(bundleDir, bundleManifest) : []);

  let hasHostCapability = false;
  let hasWebClient = false;
  let isThemePlugin = false;
  let inspectedConcreteRows = false;
  let panelId: string | undefined;
  let panelKind: DshPluginPanelKind | undefined;
  let panelLabel: LocalizedTextMap | undefined;

  for (const rowSpec of rowSpecs) {
    const trimmed = rowSpec.moduleName.trim();
    if (!trimmed || trimmed.startsWith('cordis:')) continue;
    inspectedConcreteRows = true;

    const pkgName = extractPackageNameFromModule(trimmed);
    const resolved = pkgName
      ? readPackageFromRoots(pkgName, nodeModulesRoots)
      : (bundleManifest ? { dir: bundleDir ?? '', manifest: bundleManifest } : null);

    if (resolved) {
      const info = inspectPackageManifestSurface(resolved.manifest, resolved.dir || null);
      if (info.hasWebClient) {
        hasWebClient = true;
        if (info.isThemePlugin) {
          isThemePlugin = true;
        } else if (!panelId || panelKind === DshPluginPanelKind.SettingsSection) {
          const panelMeta = detectClientPanelMetadata(
            resolved.dir || null,
            resolved.manifest,
            rowSpec.rowId,
          );
          const shouldAdopt =
            Boolean(panelMeta.panelId)
            && (!panelId || panelMeta.panelKind === DshPluginPanelKind.Main);
          if (shouldAdopt && panelMeta.panelId) {
            panelId = panelMeta.panelId;
            panelKind = panelMeta.panelKind;
            panelLabel = panelMeta.panelLabel;
          } else if (panelMeta.panelLabel && !panelLabel) {
            panelLabel = panelMeta.panelLabel;
          }
        }
      }
      if (info.hasHostCapability) {
        hasHostCapability = true;
      }
    } else if (WEB_UI_ONLY_NAME_PATTERN.test(trimmed)) {
      hasWebClient = true;
      if (THEME_HINT_PATTERN.test(trimmed)) isThemePlugin = true;
    } else {
      hasHostCapability = true;
    }
  }

  if (!inspectedConcreteRows && bundleManifest) {
    const selfInfo = inspectPackageManifestSurface(bundleManifest, bundleDir);
    if (selfInfo.hasWebClient) {
      hasWebClient = true;
      hasHostCapability = selfInfo.hasHostCapability;
      isThemePlugin = selfInfo.isThemePlugin;
      inspectedConcreteRows = true;
      if (!selfInfo.isThemePlugin) {
        const panelMeta = detectClientPanelMetadata(bundleDir, bundleManifest);
        if (panelMeta.panelId) {
          panelId = panelMeta.panelId;
          panelKind = panelMeta.panelKind;
        }
        if (panelMeta.panelLabel) panelLabel = panelMeta.panelLabel;
      }
    } else {
      // Check bundle's own dependencies for theme/client-ui hints when patch has no insert rows.
      const depNames = Object.keys(
        isRecord(bundleManifest.dependencies) ? bundleManifest.dependencies : {},
      );
      if (depNames.includes(THEME_SERVICE_PACKAGE)) {
        hasWebClient = true;
        isThemePlugin = true;
        inspectedConcreteRows = true;
      }
    }
  }

  if (!inspectedConcreteRows) {
    return detectThemeOrWebUiHint(options.name, options.description);
  }

  const panelFields = panelId && !isThemePlugin
    ? {
        panelId,
        ...(panelKind ? { panelKind } : {}),
        ...(panelLabel ? { panelLabel } : {}),
      }
    : {};

  if (hasWebClient && !hasHostCapability) {
    const themeFlag =
      isThemePlugin
      || THEME_HINT_PATTERN.test(options.name ?? '')
      || THEME_HINT_PATTERN.test(options.description ?? '');
    return {
      surface: DshPluginSurface.WebOnly,
      hasHostCapability: false,
      hasWebClient: true,
      isThemePlugin: themeFlag,
      ...(themeFlag ? {} : panelFields),
    };
  }

  if (hasWebClient && hasHostCapability) {
    return {
      surface: DshPluginSurface.Hybrid,
      hasHostCapability: true,
      hasWebClient: true,
      isThemePlugin: false,
      ...panelFields,
    };
  }

  return {
    surface: DshPluginSurface.Native,
    hasHostCapability: true,
    hasWebClient: false,
    isThemePlugin: false,
  };
}

function readLocalPackageLocaleMeta(pkgDir: string): {
  title?: LocalizedTextMap;
  description?: LocalizedTextMap;
  version?: string;
} {
  const pkg = readJsonFileSafe(path.join(pkgDir, 'package.json'));
  const version = typeof pkg?.version === 'string' && pkg.version.trim() ? pkg.version.trim() : undefined;
  const fallbackDesc = typeof pkg?.description === 'string' && pkg.description.trim()
    ? pkg.description.trim()
    : undefined;

  const enLocale = readJsonFileSafe(path.join(pkgDir, 'locale', 'en.json'));
  const zhLocale = readJsonFileSafe(path.join(pkgDir, 'locale', 'zh.json'));
  const enMeta = enLocale && isRecord(enLocale.meta) ? enLocale.meta : null;
  const zhMeta = zhLocale && isRecord(zhLocale.meta) ? zhLocale.meta : null;

  const titleEn = typeof enMeta?.title === 'string' && enMeta.title.trim() ? enMeta.title.trim() : undefined;
  const titleZh = typeof zhMeta?.title === 'string' && zhMeta.title.trim() ? zhMeta.title.trim() : undefined;
  const descEn = typeof enMeta?.description === 'string' && enMeta.description.trim()
    ? enMeta.description.trim()
    : fallbackDesc;
  const descZh = typeof zhMeta?.description === 'string' && zhMeta.description.trim()
    ? zhMeta.description.trim()
    : undefined;

  return {
    ...(version ? { version } : {}),
    ...(titleEn || titleZh ? { title: { ...(titleEn ? { en: titleEn } : {}), ...(titleZh ? { zh: titleZh } : {}) } } : {}),
    ...(descEn || descZh ? { description: { ...(descEn ? { en: descEn } : {}), ...(descZh ? { zh: descZh } : {}) } } : {}),
  };
}

/**
 * Merges live DSH `pluginManager/listBundles` results (when available) with
 * profile manifest fallback entries into LobsterAI's enriched plugin list.
 * Uninstalled & disabled DSH optional/on-demand catalog bundles are excluded
 * from the installed view so users only see what they actually installed plus
 * LobsterAI's managed core bundles (hidden in a collapsed section by the UI).
 */
export function buildEnrichedPluginEntries(options: {
  liveBundles?: readonly DshPluginBundleInfo[] | null;
  fallbackPlugins: readonly DshProfilePluginInfo[];
  profileDir: string;
  runtimeDir?: string;
}): DshEnrichedPluginEntry[] {
  const fallbackByName = new Map(options.fallbackPlugins.map((item) => [item.name, item]));

  if (options.liveBundles && options.liveBundles.length > 0) {
    const entries: DshEnrichedPluginEntry[] = [];
    const seen = new Set<string>();

    for (const bundle of options.liveBundles) {
      const managed = isManagedDshBundle(bundle.name);
      // Skip uninstalled & disabled DSH optional/catalog/unused-app bundles in Installed view.
      if (!bundle.installed && !bundle.enabled) {
        continue;
      }
      seen.add(bundle.name);

      const fallback = fallbackByName.get(bundle.name);
      const title = normalizeLocalizedText(bundle.meta?.title);
      const description =
        normalizeLocalizedText(bundle.meta?.description)
        ?? (bundle.description?.trim() ? { en: bundle.description.trim() } : undefined);

      const surfaceInfo = managed
        ? {
            surface: DshPluginSurface.Native,
            hasHostCapability: true,
            hasWebClient: false,
            isThemePlugin: false,
          }
        : classifyBundleSurface({
            name: bundle.name,
            description: bundle.description ?? description?.en ?? description?.zh,
            rows: bundle.rows,
            profileDir: options.profileDir,
            runtimeDir: options.runtimeDir,
          });

      entries.push({
        name: bundle.name,
        specifier: fallback?.specifier ?? bundle.source ?? 'bundled',
        managed,
        enabled: bundle.enabled,
        ...(bundle.version ? { version: bundle.version } : {}),
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(bundle.meta?.icon ? { icon: bundle.meta.icon } : {}),
        official: bundle.official,
        availability: bundle.availability as DshPluginAvailability,
        ...(bundle.update ? { update: bundle.update as DshPluginUpdateKind } : {}),
        ...(bundle.source ? { source: bundle.source } : {}),
        removable: !managed && bundle.removable,
        surface: surfaceInfo.surface,
        isThemePlugin: surfaceInfo.isThemePlugin,
        ...(surfaceInfo.panelId ? { panelId: surfaceInfo.panelId } : {}),
        ...(surfaceInfo.panelKind ? { panelKind: surfaceInfo.panelKind } : {}),
        ...(surfaceInfo.panelLabel ? { panelLabel: surfaceInfo.panelLabel } : {}),
        ...(bundle.error?.code ? { errorCode: bundle.error.code } : {}),
        ...(bundle.error?.diagnostic ? { errorMessage: bundle.error.diagnostic } : {}),
        rowCount: bundle.rows.length,
        activeRowCount: bundle.rows.filter((row) => Boolean(row.entryId)).length,
      });
    }

    // Preserve any fallback entries missing from liveBundles (e.g. broken manifest rows).
    for (const fallback of options.fallbackPlugins) {
      if (seen.has(fallback.name)) continue;
      entries.push(enrichFallbackEntry(fallback, options.profileDir, options.runtimeDir));
    }

    return entries;
  }

  return options.fallbackPlugins.map((entry) =>
    enrichFallbackEntry(entry, options.profileDir, options.runtimeDir),
  );
}

function enrichFallbackEntry(
  entry: DshProfilePluginInfo,
  profileDir: string,
  runtimeDir?: string,
): DshEnrichedPluginEntry {
  if (entry.managed) {
    return {
      ...entry,
      removable: false,
      surface: DshPluginSurface.Native,
      isThemePlugin: false,
    };
  }

  const pkgDir = path.join(profileDir, 'node_modules', ...entry.name.split('/'));
  const localMeta = fs.existsSync(pkgDir) ? readLocalPackageLocaleMeta(pkgDir) : {};
  const surfaceInfo = classifyBundleSurface({
    name: entry.name,
    description: localMeta.description?.en ?? localMeta.description?.zh,
    profileDir,
    runtimeDir,
  });

  return {
    ...entry,
    ...localMeta,
    removable: true,
    surface: surfaceInfo.surface,
    isThemePlugin: surfaceInfo.isThemePlugin,
    ...(surfaceInfo.panelId ? { panelId: surfaceInfo.panelId } : {}),
    ...(surfaceInfo.panelKind ? { panelKind: surfaceInfo.panelKind } : {}),
    ...(surfaceInfo.panelLabel ? { panelLabel: surfaceInfo.panelLabel } : {}),
  };
}

/**
 * Validates that a `<webview>` URL targets the live loopback DSH host origin
 * before allowing it to bind to the authenticated `persist:dsh-ecosystem` partition.
 */
export function isAllowedDshEmbedWebviewUrl(
  rawUrl: string | null | undefined,
  dshOrigin: string | null | undefined,
): boolean {
  if (!rawUrl || !dshOrigin) return false;
  try {
    const target = new URL(rawUrl.trim());
    const allowed = new URL(dshOrigin.trim());
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
    return target.origin === allowed.origin;
  } catch {
    return false;
  }
}

export function normalizePluginChangeOutcome(
  result: DshPluginChangeResult,
  plugins: DshEnrichedPluginEntry[],
): DshPluginMutationOutcome {
  const application = result.application as DshPluginApplicationStatus;
  const ok =
    application === DshPluginApplicationStatus.Applied
    || application === DshPluginApplicationStatus.RestartRequired
    || application === DshPluginApplicationStatus.Overridden;
  const restartRequired = application === DshPluginApplicationStatus.RestartRequired;
  const incompatible = result.error?.incompatible ?? result.packageResult?.incompatible;
  const output = result.packageResult?.output?.trim() || undefined;
  const errorMessage =
    !ok
      ? (result.error?.diagnostic
        || (result.error?.code ? `Plugin operation failed (${result.error.code})` : undefined)
        || (result.packageResult?.kind ? `Package operation failed (${result.packageResult.kind})` : undefined)
        || output)
      : undefined;

  return {
    ok,
    application,
    restartRequired,
    ...(result.restartReason ? { restartReason: result.restartReason } : {}),
    stage: result.stage,
    changed: result.changed,
    ...(typeof result.enabled === 'boolean' ? { enabled: result.enabled } : {}),
    ...(result.bundle ? { bundle: result.bundle } : {}),
    ...(result.version ? { version: result.version } : {}),
    ...(result.error?.code ? { errorCode: result.error.code } : {}),
    ...(result.packageResult?.kind ? { failureKind: result.packageResult.kind } : {}),
    ...(result.failedAt ? { failedAt: result.failedAt } : {}),
    ...(errorMessage ? { error: errorMessage } : {}),
    ...(result.pendingBuilds && result.pendingBuilds.length > 0
      ? { pendingBuilds: result.pendingBuilds }
      : {}),
    ...(result.approvedBuilds && result.approvedBuilds.length > 0
      ? { approvedBuilds: result.approvedBuilds }
      : {}),
    ...(result.registries && result.registries.length > 0
      ? { registries: [...result.registries] }
      : {}),
    ...(incompatible && incompatible.length > 0 ? { incompatible } : {}),
    ...(result.packageResult?.exitCode !== undefined
      ? { exitCode: result.packageResult.exitCode }
      : {}),
    ...(output ? { output } : {}),
    ...(result.packageResult?.logPath ? { logPath: result.packageResult.logPath } : {}),
    plugins,
  };
}

function isFailedApplication(application: string | undefined): boolean {
  return (
    application === DshPluginApplicationStatus.Failed
    || application === DshPluginApplicationStatus.Cancelled
  );
}

function extractChangeErrorMessage(change: DshPluginChangeResult): string | undefined {
  return (
    change.error?.diagnostic
    || (change.error?.code ? `Plugin operation failed (${change.error.code})` : undefined)
    || (change.packageResult?.kind ? `Package operation failed (${change.packageResult.kind})` : undefined)
    || change.packageResult?.output?.trim()
    || undefined
  );
}

export function normalizePluginUpdateOutcome(
  raw: DshPluginUpdateResult,
  plugins: DshEnrichedPluginEntry[],
): DshPluginUpdateOutcome {
  const result = raw.result;
  const application = result.application as DshPluginApplicationStatus;
  const resultFailed = isFailedApplication(application);
  const restore = raw.restore;
  const restoreApplication = restore
    ? (restore.application as DshPluginApplicationStatus)
    : undefined;
  const restoreFailed = restore !== undefined && isFailedApplication(restoreApplication);

  let ok = false;
  let outcome: DshPluginUpdateOutcomeKind;
  if (raw.step === 'check') {
    outcome = DshPluginUpdateOutcomeKind.CheckRefused;
  } else if (raw.step === 'remove') {
    outcome = DshPluginUpdateOutcomeKind.RemoveFailed;
  } else if (!resultFailed) {
    ok = true;
    outcome =
      application === DshPluginApplicationStatus.RestartRequired
        ? DshPluginUpdateOutcomeKind.RestartRequired
        : DshPluginUpdateOutcomeKind.Applied;
  } else if (!restore) {
    outcome = DshPluginUpdateOutcomeKind.InstallFailedKept;
  } else if (restoreFailed) {
    outcome = DshPluginUpdateOutcomeKind.InstallFailedBroken;
  } else {
    outcome = DshPluginUpdateOutcomeKind.InstallFailedRestored;
  }

  const restartRequired = ok && application === DshPluginApplicationStatus.RestartRequired;
  const incompatible = result.error?.incompatible ?? result.packageResult?.incompatible;
  const failedOutput = [result, restore]
    .map((change) => (change && isFailedApplication(change.application) ? change.packageResult?.output?.trim() : undefined))
    .find((text) => Boolean(text));
  const logPath =
    result.packageResult?.logPath
    ?? (restoreFailed ? restore?.packageResult?.logPath : undefined);
  const errorMessage = !ok ? extractChangeErrorMessage(result) : undefined;
  const restoreError = restoreFailed && restore ? extractChangeErrorMessage(restore) : undefined;

  return {
    ok,
    outcome,
    from: raw.from,
    to: raw.to,
    step: raw.step,
    application,
    restartRequired,
    ...(result.restartReason ? { restartReason: result.restartReason } : {}),
    ...(result.error?.code ? { errorCode: result.error.code } : {}),
    ...(result.packageResult?.kind ? { failureKind: result.packageResult.kind } : {}),
    ...(result.failedAt ? { failedAt: result.failedAt } : {}),
    ...(errorMessage ? { error: errorMessage } : {}),
    ...(result.pendingBuilds && result.pendingBuilds.length > 0
      ? { pendingBuilds: result.pendingBuilds }
      : {}),
    ...(incompatible && incompatible.length > 0 ? { incompatible } : {}),
    ...(failedOutput ? { output: failedOutput } : {}),
    ...(logPath ? { logPath } : {}),
    ...(restore !== undefined ? { restored: !restoreFailed } : {}),
    ...(restoreApplication ? { restoreApplication } : {}),
    ...(restoreError ? { restoreError } : {}),
    plugins,
  };
}

/**
 * Validates an optional npm registry override (`http:` or `https:` URL with no
 * credentials, whitespace, or control characters). Returns `null` when omitted
 * or explicitly `null`, `false` when invalid.
 */
export function validateOptionalRegistryUrl(raw: unknown): string | null | false {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/[\s\x00-\x1f\x7f]/.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    return parsed.href;
  } catch {
    return false;
  }
}

export function resolveLocalPathIfExists(spec: string): string | null {
  const trimmed = spec.trim();
  let candidate: string | null = null;
  if (trimmed.startsWith('file:')) {
    candidate = trimmed.slice('file:'.length);
  } else if (trimmed.startsWith('link:')) {
    candidate = trimmed.slice('link:'.length);
  } else if (path.isAbsolute(trimmed)) {
    candidate = trimmed;
  }
  if (!candidate) return null;
  try {
    const stat = fs.statSync(candidate);
    return stat.isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}
