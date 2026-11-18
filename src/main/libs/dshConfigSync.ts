// Renders LobsterAI provider configuration into the `web` profile's patch
// layer ($DSH_HOME/profiles/web/cordis.patch.yml) so a kit-installed dsh boots
// with the user's models already available. dsh 0.2 retired the home-wide
// settings.yaml for this per-profile file: a YAML array of loader rows, where
// an `{ id, name, config }` row replaces that plugin entry's whole config.
// Ownership rules:
//   - only the `llm-pi-ai` and `agent-default-model` rows are written, and in
//     the former only providers keyed `lobsterai-<id>` are managed (rewritten
//     each sync); every other row, user-created route, and `!!js` expression is
//     preserved at the data level;
//   - API keys never touch disk: routes reference env vars (apiKeyEnv) that
//     the engine manager injects into the child process, and the inherited
//     process environment is dsh's highest-priority credential layer;
//   - the default model is seeded only while initializing a brand-new profile.
//     An existing profile belongs to the user (and to any standalone dsh
//     sharing the home), so their default is never rewritten; a managed route
//     that disappeared is the one exception, repaired instead of left broken;
//   - a settings.yaml an older dsh left behind has these two sections folded in
//     here. dsh would import them itself on boot, but its import is a merge
//     that cannot drop a managed route, and it lands only after the first boot
//     has settled. The document's other sections stay for that import.
// Nothing else in the home is touched, so every shipped provider, tool, and
// plugin stays exactly as dsh ships it.
// Reasoning-effort/thinking metadata is deliberately not declared yet; wire
// dialects differ per upstream and over-claiming breaks requests mid-turn.
// No Electron imports; callers pass DSH_HOME explicitly.

import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';

import { ApiFormat, ProviderRegistry } from '../../shared/providers/constants';
import type { ProviderConfig } from '../../shared/providers/types';

export const DSH_MANAGED_PROVIDER_PREFIX = 'lobsterai-';

// dsh groups its model picker by display name, so every synced route carries
// this marker: without it a LobsterAI-managed provider is indistinguishable
// from one the user added inside dsh.
export const DSH_MANAGED_LABEL_PREFIX = 'LobsterAI · ';

// Route ids for the built-in billed provider, whose requests go through the
// local token proxy rather than a user-supplied key. One route per wire
// protocol, since a dsh route declares exactly one.
export const DSH_PLAN_ROUTE_ID = 'lobsterai-plan';
export const DSH_PLAN_ANTHROPIC_ROUTE_ID = 'lobsterai-plan-anthropic';

// The proxy replaces the Authorization header with the real access token. dsh
// must still present the loopback proxy token; the placeholder only covers a
// proxy started without one.
const DSH_PLAN_API_KEY_PLACEHOLDER = 'proxy-managed';

// `dsh web` runs the profile of the same name.
export const DSH_WEB_PROFILE = 'web';
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml';
// dsh's config editor serializes every patch write on this lock beside the
// profile manifest; holding the same one keeps a concurrent dsh edit safe.
const PROFILE_LOCK_FILENAME = 'package.json.lock';
const LEGACY_SETTINGS_FILENAME = 'settings.yaml';
const LOCK_TIMEOUT_MS = 2_000;

interface DshProfileEntry {
  id: string;
  name: string;
}

// The profile entries we configure. A legacy settings.yaml section carries the
// id of the entry it configured as its name.
const PI_AI_ENTRY: DshProfileEntry = { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' };
const DEFAULT_MODEL_ENTRY: DshProfileEntry = { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model' };

// dsh's entry-list dialect (cordis-plugin-include): JSON-schema YAML in which a
// `!!js` scalar loads as a `{ __jsExpr }` node. Reading the patch the same way
// lets a user row carrying an expression survive our rewrite unchanged.
const DSH_JS_EXPRESSION = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown) => typeof data === 'string',
  construct: (data: string) => ({ __jsExpr: data }),
  predicate: (data: object) => data instanceof Object && '__jsExpr' in data,
  represent: (data: object) => (data as { __jsExpr: string }).__jsExpr,
});
const PROFILE_PATCH_SCHEMA = yaml.JSON_SCHEMA.extend(DSH_JS_EXPRESSION);


export interface DshProviderRoute {
  displayName: string;
  apiKeyEnv: string;
  api: 'openai-completions' | 'anthropic-messages';
  baseURL: string;
  models: Array<{
    id: string;
    name: string;
    contextWindow?: number;
    maxTokens?: number;
    input?: Array<'text' | 'image'>;
  }>;
}

/** The billed built-in provider, resolved against the running token proxy. */
export interface DshPlanProviderInput {
  /** Loopback token-proxy origin plus version prefix, e.g. http://127.0.0.1:1234/v1 */
  baseUrl: string;
  /** Loopback proxy token; passed to dsh through its process env only. */
  apiKey?: string | null;
  /** Localized product name for the plan (the caller owns i18n). */
  displayName: string;
  models: Array<{
    modelId: string;
    modelName?: string;
    apiFormat?: string;
    supportsImage?: boolean;
    contextWindow?: number;
    maxTokens?: number;
  }>;
}

export interface DshManagedSettings {
  routes: Record<string, DshProviderRoute>;
  envVars: Record<string, string>;
  skipped: Array<{ providerId: string; reason: string }>;
  defaultModel: { provider: string; model: string } | null;
}

// dsh's web UI enforces ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ for route ids; matching
// it keeps managed entries editable there.
export function sanitizeDshRouteId(providerId: string): string {
  const cleaned = providerId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '');
  return `${DSH_MANAGED_PROVIDER_PREFIX}${cleaned || 'provider'}`;
}

// Matches deriveKeyRef in dsh's models settings UI so the credential slot is
// recognized there: route id upper-cased, non-alphanumerics collapsed to '_'.
export function deriveDshApiKeyEnvRef(routeId: string): string {
  return `${routeId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

export function mapApiFormatToDshProtocol(apiFormat: string | undefined): DshProviderRoute['api'] | null {
  if (apiFormat === ApiFormat.Anthropic) return 'anthropic-messages';
  // LobsterAI's OpenAI-format providers are overwhelmingly third-party
  // compatible endpoints; chat-completions is the universally supported wire.
  if (apiFormat === ApiFormat.OpenAI || apiFormat === undefined) return 'openai-completions';
  return null;
}

export function renderDshManagedSettings(
  providers: Record<string, ProviderConfig>,
  options: {
    preferredDefault?: { providerId: string; modelId: string };
    planProvider?: DshPlanProviderInput | null;
  } = {}
): DshManagedSettings {
  const routes: Record<string, DshProviderRoute> = {};
  const envVars: Record<string, string> = {};
  const skipped: Array<{ providerId: string; reason: string }> = [];

  // The billed plan goes first so it heads the picker and wins the default.
  const planRouteIds = renderPlanRoutes(options.planProvider ?? null, routes, envVars, skipped);

  for (const [providerId, config] of Object.entries(providers)) {
    if (!config || config.enabled === false) {
      skipped.push({ providerId, reason: 'disabled' });
      continue;
    }
    if (config.authType === 'oauth' || (!config.apiKey && config.oauthAccessToken)) {
      skipped.push({ providerId, reason: 'oauth-not-supported' });
      continue;
    }
    const api = mapApiFormatToDshProtocol(config.apiFormat);
    if (!api) {
      skipped.push({ providerId, reason: `unsupported-api-format:${config.apiFormat}` });
      continue;
    }
    const baseURL = (config.baseUrl ?? '').trim();
    if (!baseURL) {
      skipped.push({ providerId, reason: 'missing-base-url' });
      continue;
    }
    const models = (config.models ?? []).filter((model) => typeof model?.id === 'string' && model.id.trim() !== '');
    if (models.length === 0) {
      skipped.push({ providerId, reason: 'no-models' });
      continue;
    }
    const apiKey = (config.apiKey ?? '').trim();
    if (!apiKey) {
      skipped.push({ providerId, reason: 'missing-api-key' });
      continue;
    }

    const routeId = sanitizeDshRouteId(providerId);
    const apiKeyEnv = deriveDshApiKeyEnvRef(routeId);
    envVars[apiKeyEnv] = apiKey;
    routes[routeId] = {
      // Prefer the canonical label ("DeepSeek") over the raw config key
      // ("deepseek"), and mark the entry as LobsterAI-managed.
      displayName:
        DSH_MANAGED_LABEL_PREFIX
        + (config.displayName?.trim() || ProviderRegistry.get(providerId)?.label || providerId),
      apiKeyEnv,
      api,
      baseURL,
      models: models.map((model) => ({
        id: model.id,
        name: model.name?.trim() || model.id,
        ...(typeof model.contextWindow === 'number' && model.contextWindow > 0
          ? { contextWindow: Math.floor(model.contextWindow) }
          : {}),
        ...(typeof model.maxTokens === 'number' && model.maxTokens > 0 ? { maxTokens: Math.floor(model.maxTokens) } : {}),
        ...(model.supportsImage ? { input: ['text', 'image'] as Array<'text' | 'image'> } : {}),
      })),
    };
  }

  let defaultModel: DshManagedSettings['defaultModel'] = null;
  const preferred = options.preferredDefault;
  if (preferred) {
    const routeId = sanitizeDshRouteId(preferred.providerId);
    const route = routes[routeId];
    if (route && route.models.some((model) => model.id === preferred.modelId)) {
      defaultModel = { provider: routeId, model: preferred.modelId };
    }
  }
  // Fall back to the plan: it needs no user key, so it is the one route that
  // always works out of the box.
  if (!defaultModel) {
    for (const routeId of planRouteIds) {
      const firstModel = routes[routeId]?.models[0];
      if (firstModel) {
        defaultModel = { provider: routeId, model: firstModel.id };
        break;
      }
    }
  }
  // Any managed route beats leaving the shipped default in place: once the
  // built-in DeepSeek row is switched off below, `deepseek-official` serves
  // nothing and every new session would open on a dead route. This is reachable
  // whenever the caller's preferred provider was skipped during rendering.
  if (!defaultModel) {
    for (const [routeId, route] of Object.entries(routes)) {
      if (route.models[0]) {
        defaultModel = { provider: routeId, model: route.models[0].id };
        break;
      }
    }
  }

  return { routes, envVars, skipped, defaultModel };
}

function renderPlanRoutes(
  plan: DshPlanProviderInput | null,
  routes: Record<string, DshProviderRoute>,
  envVars: Record<string, string>,
  skipped: Array<{ providerId: string; reason: string }>
): string[] {
  if (!plan) return [];
  const baseURL = plan.baseUrl.trim();
  if (!baseURL) {
    skipped.push({ providerId: DSH_PLAN_ROUTE_ID, reason: 'proxy-not-running' });
    return [];
  }
  const models = plan.models.filter((model) => typeof model?.modelId === 'string' && model.modelId.trim() !== '');
  if (models.length === 0) {
    skipped.push({ providerId: DSH_PLAN_ROUTE_ID, reason: 'no-models' });
    return [];
  }

  const byProtocol: Array<{ routeId: string; api: DshProviderRoute['api']; wants: (apiFormat?: string) => boolean }> = [
    { routeId: DSH_PLAN_ROUTE_ID, api: 'openai-completions', wants: (format) => format !== ApiFormat.Anthropic },
    {
      routeId: DSH_PLAN_ANTHROPIC_ROUTE_ID,
      api: 'anthropic-messages',
      wants: (format) => format === ApiFormat.Anthropic,
    },
  ];

  // When the plan spans both protocols it produces two routes; dsh groups the
  // picker by display name, so the second one must not read as a duplicate.
  const protocolCount = byProtocol.filter(({ wants }) => models.some((model) => wants(model.apiFormat))).length;

  const emitted: string[] = [];
  for (const { routeId, api, wants } of byProtocol) {
    const protocolModels = models.filter((model) => wants(model.apiFormat));
    if (protocolModels.length === 0) continue;
    const apiKeyEnv = deriveDshApiKeyEnvRef(routeId);
    envVars[apiKeyEnv] = plan.apiKey?.trim() || DSH_PLAN_API_KEY_PLACEHOLDER;
    const needsProtocolSuffix = protocolCount > 1 && routeId === DSH_PLAN_ANTHROPIC_ROUTE_ID;
    routes[routeId] = {
      displayName: `${DSH_MANAGED_LABEL_PREFIX}${plan.displayName}${needsProtocolSuffix ? ' (Anthropic)' : ''}`,
      apiKeyEnv,
      api,
      baseURL,
      models: protocolModels.map((model) => ({
        id: model.modelId,
        name: model.modelName?.trim() || model.modelId,
        ...(typeof model.contextWindow === 'number' && model.contextWindow > 0
          ? { contextWindow: Math.floor(model.contextWindow) }
          : {}),
        ...(typeof model.maxTokens === 'number' && model.maxTokens > 0 ? { maxTokens: Math.floor(model.maxTokens) } : {}),
        ...(model.supportsImage ? { input: ['text', 'image'] as Array<'text' | 'image'> } : {}),
      })),
    };
    emitted.push(routeId);
  }
  return emitted;
}

// Takes the sections we own out of a settings.yaml an older dsh left behind.
// Returns null when the document carries neither, so it stays exactly as found
// for dsh's own import. Throws when the document is unreadable; dsh's import
// fails on it too and logs why.
export function splitLegacyDshSettings(text: string): {
  /** The owned sections, keyed by the entry id they configure. */
  owned: Record<string, unknown>;
  /** The rest of the document, or null when nothing else remains. */
  remainder: string | null;
} | null {
  const doc: unknown = yaml.load(text);
  if (doc === null || doc === undefined) return null;
  if (!isRecord(doc)) throw new Error('legacy settings root is not a map');
  const owned: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [section, value] of Object.entries(doc)) {
    if (section === PI_AI_ENTRY.id || section === DEFAULT_MODEL_ENTRY.id) owned[section] = value;
    else rest[section] = value;
  }
  if (Object.keys(owned).length === 0) return null;
  return {
    owned,
    remainder: Object.keys(rest).length > 0 ? yaml.dump(rest, { lineWidth: 120, noRefs: true }) : null,
  };
}

// Pure merge of managed content into a profile patch. `legacy` holds the owned
// sections of a leftover settings.yaml, which win over the profile's rows just
// as they do in dsh's own import. `changed` is false when the merge leaves the
// patch's data as it was, so the caller can skip a rewrite that would only
// drop the file's comments. Throws when the existing patch is unreadable: dsh
// refuses to boot that profile too, and replacing it would destroy every row
// the user wrote.
export function mergeDshProfilePatchText(
  existingText: string | null,
  managed: DshManagedSettings,
  options: { seedDefaultModel?: boolean; legacy?: Record<string, unknown> } = {}
): {
  text: string;
  changed: boolean;
} {
  const original = parseProfilePatch(existingText);
  const rows = [...original];
  const legacy = options.legacy ?? {};

  const piAi = findEntryConfig(rows, PI_AI_ENTRY) ?? {};
  const legacyPiAi = recordOrEmpty(legacy[PI_AI_ENTRY.id]);
  const knownProviders = { ...recordOrEmpty(piAi.providers), ...recordOrEmpty(legacyPiAi.providers) };
  const providers = {
    ...Object.fromEntries(
      Object.entries(knownProviders).filter(([routeId]) => !routeId.startsWith(DSH_MANAGED_PROVIDER_PREFIX))
    ),
    ...managed.routes,
  };
  const { providers: _replaced, ...piAiRest } = { ...piAi, ...legacyPiAi };
  setEntryConfig(rows, PI_AI_ENTRY, Object.keys(providers).length > 0 ? { ...piAiRest, providers } : piAiRest);

  const legacyDefaultSection = legacy[DEFAULT_MODEL_ENTRY.id];
  const legacyDefault = isRecord(legacyDefaultSection) ? legacyDefaultSection : undefined;
  const storedDefault = legacyDefault ?? findEntryConfig(rows, DEFAULT_MODEL_ENTRY);
  const seedable = options.seedDefaultModel === true && storedDefault === undefined;
  if (managed.defaultModel && (seedable || isDanglingManagedRoute(storedDefault?.provider, managed))) {
    setEntryConfig(rows, DEFAULT_MODEL_ENTRY, {
      provider: managed.defaultModel.provider,
      model: managed.defaultModel.model,
    });
  } else if (legacyDefault) {
    setEntryConfig(rows, DEFAULT_MODEL_ENTRY, { ...findEntryConfig(rows, DEFAULT_MODEL_ENTRY), ...legacyDefault });
  }

  if (isDeepStrictEqual(rows, original)) return { text: existingText ?? '', changed: false };
  // js-yaml drops comments; keep at least the explanatory header dsh writes.
  const header = existingText?.match(/^(?:[ \t]*#[^\n]*\n)+/)?.[0] ?? '';
  return {
    text: header + yaml.dump(rows, { schema: PROFILE_PATCH_SCHEMA, lineWidth: 120, noRefs: true }),
    changed: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function parseProfilePatch(text: string | null): unknown[] {
  if (text === null || text.trim() === '') return [];
  const parsed: unknown = yaml.load(text, { schema: PROFILE_PATCH_SCHEMA });
  if (parsed === null || parsed === undefined) return [];
  if (!Array.isArray(parsed)) throw new Error('dsh profile patch is not a YAML sequence');
  return parsed;
}

// The row dsh's config editor reads and writes for an entry: the last one with
// its id, skipping insert lists and rows that point the id at another plugin.
function findEntryRowIndex(rows: unknown[], entry: DshProfileEntry): number {
  return rows.findLastIndex(
    (row) =>
      isRecord(row)
      && row.id === entry.id
      && !('insert' in row)
      && (row.name === undefined || row.name === entry.name)
  );
}

function findEntryConfig(rows: unknown[], entry: DshProfileEntry): Record<string, unknown> | undefined {
  const index = findEntryRowIndex(rows, entry);
  const config = index >= 0 ? (rows[index] as Record<string, unknown>).config : undefined;
  return isRecord(config) ? config : undefined;
}

// Sets an entry's config the way dsh's config editor does: on its row,
// appending one when there is none. An empty config clears the row's config,
// and a row left with nothing but its identity is dropped.
function setEntryConfig(rows: unknown[], entry: DshProfileEntry, config: Record<string, unknown>): void {
  const index = findEntryRowIndex(rows, entry);
  const empty = Object.keys(config).length === 0;
  if (index < 0) {
    if (!empty) rows.push({ id: entry.id, name: entry.name, config });
    return;
  }
  const { config: _previous, ...row } = rows[index] as Record<string, unknown>;
  if (!empty) rows[index] = { ...row, config };
  else if (Object.keys(row).some((key) => key !== 'id' && key !== 'name')) rows[index] = row;
  else rows.splice(index, 1);
}

// A default pointing at one of our own routes that no longer exists can never
// serve; anything else — including dsh's shipped default — is the user's and
// is left alone.
function isDanglingManagedRoute(storedProvider: unknown, managed: DshManagedSettings): boolean {
  if (typeof storedProvider !== 'string' || storedProvider === '') return false;
  return storedProvider.startsWith(DSH_MANAGED_PROVIDER_PREFIX) && !(storedProvider in managed.routes);
}

// Writes the merged patch under dsh's own coordination protocol: the profile
// lock, temp file + rename, 0600/0700 modes. Callers normally run this before
// the dsh child spawns, but the lock keeps a concurrent dsh edit safe. The
// profile's other files are dsh's to create; it never overwrites a patch that
// already exists.
export async function writeDshManagedSettings(dshHome: string, managed: DshManagedSettings): Promise<{
  patchPath: string;
  warnings: string[];
}> {
  const profileDir = path.join(dshHome, 'profiles', DSH_WEB_PROFILE);
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const patchPath = path.join(profileDir, PROFILE_PATCH_FILENAME);
  const legacyPath = path.join(dshHome, LEGACY_SETTINGS_FILENAME);
  const warnings: string[] = [];

  await withLock(path.join(profileDir, PROFILE_LOCK_FILENAME), () => {
    const existingText = readTextFile(patchPath);
    const legacyText = readTextFile(legacyPath);
    let legacy: ReturnType<typeof splitLegacyDshSettings> = null;
    if (legacyText !== null) {
      try {
        legacy = splitLegacyDshSettings(legacyText);
      } catch (error) {
        warnings.push(`legacy ${LEGACY_SETTINGS_FILENAME} is unreadable and left for dsh: ${(error as Error).message}`);
      }
    }

    const { text, changed } = mergeDshProfilePatchText(existingText, managed, {
      // A profile with neither a patch nor a legacy document is one we are
      // initializing, so the default model is ours to seed; an existing one
      // already belongs to the user.
      seedDefaultModel: existingText === null && legacyText === null,
      legacy: legacy?.owned,
    });
    if (changed) writeFileAtomic(patchPath, text);

    if (!legacy) return;
    // The owned sections now live in the patch. Anything else stays for dsh's
    // import; an emptied document is retired under the name dsh gives it.
    if (legacy.remainder === null) fs.renameSync(legacyPath, `${legacyPath}.imported`);
    else writeFileAtomic(legacyPath, legacy.remainder);
  });

  return { patchPath, warnings };
}

function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function writeFileAtomic(filePath: string, text: string): void {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.rmSync(tempPath, { force: true });
  fs.writeFileSync(tempPath, text, { flag: 'wx', mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

async function withLock(lockPath: string, operation: () => void): Promise<void> {
  await acquireLock(lockPath);
  try {
    operation();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let backoffMs = 20;
  for (;;) {
    try {
      // dsh records its pid the same way, so either side can tell a live
      // holder from one that exited.
      fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      return;
    } catch {
      // dsh takes over a lock whose writer has exited, and so must we: on
      // Windows the engine stops dsh with TerminateProcess, so a dsh stopped
      // mid-edit leaves its lock behind and would keep every later sync out.
      if (lockHolderExited(lockPath)) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring dsh profile lock at ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 200);
    }
  }
}

function lockHolderExited(lockPath: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
