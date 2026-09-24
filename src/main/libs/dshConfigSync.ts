// Renders LobsterAI provider configuration into the dsh settings file
// ($DSH_HOME/settings.yaml) so a kit-installed dsh boots with the user's
// models already available. Ownership rules:
//   - only providers keyed `lobsterai-<id>` are managed (rewritten each sync);
//     everything else in the file — user-created routes, other namespaces — is
//     preserved byte-for-byte at the data level;
//   - API keys never touch disk: routes reference env vars (apiKeyEnv) that
//     the engine manager injects into the child process, and the inherited
//     process environment is dsh's highest-priority credential layer;
//   - the default model is seeded only while initializing a brand-new dsh home.
//     An existing home belongs to the user (and to any standalone dsh sharing
//     it), so their machine-wide default is never rewritten; a managed route
//     that disappeared is the one exception, repaired instead of left broken.
// Nothing else in the home is touched: no composition patch layer, so every
// shipped provider, tool, and plugin stays exactly as dsh ships it.
// Reasoning-effort/thinking metadata is declared only when the source model
// actually supports it, so dsh's thinking-strength control shows up for
// LobsterAI-managed models without over-claiming: a model whose provider
// declared no thinking capability keeps the pre-existing behavior (no effort
// control, provider default thinking). For supporting models the route carries
// `compat.supportsReasoningEffort` plus per-model `reasoningEfforts` in dsh's
// own schema; wire dialects still vary per upstream, which is why the values
// come from LobsterAI-side metadata (thinkingLevelMap) rather than a blanket
// declaration.
// No Electron imports; callers pass DSH_HOME explicitly.

import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as path from 'path';

import { ApiFormat, ProviderRegistry } from '../../shared/providers/constants';
import { type ModelThinkingConfig } from '../../shared/providers/modelThinking';
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

// The proxy replaces the Authorization header with the real access token, so
// the credential dsh sends is a placeholder that only has to be non-empty.
const DSH_PLAN_API_KEY_PLACEHOLDER = 'proxy-managed';

const PI_AI_NAMESPACE = 'llm-pi-ai';
const DEFAULT_MODEL_NAMESPACE = 'agent-default-model';
const LOCK_TIMEOUT_MS = 2_000;


export interface DshProviderRoute {
  displayName: string;
  apiKeyEnv: string;
  api: 'openai-completions' | 'anthropic-messages';
  baseURL: string;
  /** Reasoning-effort switches, declared only when a model supports thinking. */
  compat?: {
    thinkingFormat?: string;
    supportsReasoningEffort?: boolean;
  };
  models: Array<{
    id: string;
    name: string;
    contextWindow?: number;
    maxTokens?: number;
    input?: Array<'text' | 'image'>;
    /**
     * dsh's per-model effort-to-wire map ({@link https://github.com/deepseek-ai/deepseek-harness}).
     * Absent when the model has no declared thinking capability.
     */
    reasoningEfforts?: Record<string, string | null>;
  }>;
}

/** The billed built-in provider, resolved against the running token proxy. */
export interface DshPlanProviderInput {
  /** Loopback token-proxy origin plus version prefix, e.g. http://127.0.0.1:1234/v1 */
  baseUrl: string;
  /** Localized product name for the plan (the caller owns i18n). */
  displayName: string;
  models: Array<{
    modelId: string;
    modelName?: string;
    apiFormat?: string;
    supportsImage?: boolean;
    contextWindow?: number;
    maxTokens?: number;
    /** Thinking capability from server model metadata; drives dsh's effort control. */
    supportsThinking?: boolean;
    thinkingConfig?: ModelThinkingConfig;
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

// dsh's reasoning-effort levels for an OpenAI-compatible endpoint. The wire
// value equals the level name (OpenAI's `reasoning_effort` vocabulary), and
// `off` maps to null because closing thinking is the parameter's absence.
const DSH_OPENAI_DEFAULT_REASONING_EFFORTS: Record<string, string | null> = {
  off: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
};

const DSH_THINKING_OFF = 'off';

// A route that declares a reasoning-effort control must also advertise the
// capability, or dsh's dispatch never sends the wire value. Only
// openai-completions takes these compat switches (see pi-ai's compat gates);
// anthropic-messages has no reasoning-effort field, so its routes stay bare.
function renderRouteThinkingCompat(
  api: DshProviderRoute['api'],
  models: DshProviderRoute['models'],
): DshProviderRoute['compat'] | undefined {
  if (api !== 'openai-completions') return undefined;
  const anyEfforts = models.some((model) => model.reasoningEfforts !== undefined);
  return anyEfforts ? { thinkingFormat: 'openai', supportsReasoningEffort: true } : undefined;
}

/**
 * Renders dsh's `reasoningEfforts` from LobsterAI-side thinking metadata.
 *
 * A declared LobsterAI thinking level maps to the same level name on the wire
 * (LobsterAI's OpenClaw sync uses the level name as the wire value), and a
 * LobsterAI level pinned to null (unsupported) is omitted so dsh never offers
 * a control it cannot honor. `off` is written as null: dsh's convention where
 * closing thinking means not sending the parameter at all.
 *
 * @returns the effort map, or undefined when the model has no thinking level
 *   (nothing to declare — dsh falls back to provider default thinking).
 */
function renderDshReasoningEfforts(
  thinkingLevelMap: Record<string, string | null> | undefined,
): Record<string, string | null> | undefined {
  if (!thinkingLevelMap) return undefined;
  const efforts: Record<string, string | null> = {};
  let hasThinkingLevel = false;
  for (const [level, wire] of Object.entries(thinkingLevelMap)) {
    if (wire === null) continue; // pinned unsupported in LobsterAI
    if (level === DSH_THINKING_OFF) {
      efforts.off = null;
      continue;
    }
    efforts[level] = wire;
    hasThinkingLevel = true;
  }
  return hasThinkingLevel ? efforts : undefined;
}

/** Extracts a thinking-level map the user may have declared per model. */
function providerModelThinkingLevelMap(model: NonNullable<ProviderConfig['models']>[number]): Record<string, string | null> | undefined {
  if (model.supportsThinking !== true) return undefined;
  const raw = (model.customParams as Record<string, unknown> | undefined)?.['thinkingLevelMap'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const map: Record<string, string | null> = {};
  for (const [level, wire] of Object.entries(raw as Record<string, unknown>)) {
    if (wire === null || typeof wire === 'string') {
      map[level] = wire as string | null;
    }
  }
  return map;
}

/**
 * dsh's effort map for one provider model, or undefined when the model has no
 * declared thinking capability. Models flagged `supportsThinking` without an
 * explicit level map get the OpenAI-compatible default set, matching how dsh
 * users hand-write the same routes; everything else stays as it was (no
 * control, provider default thinking).
 */
function renderProviderModelReasoningEfforts(model: NonNullable<ProviderConfig['models']>[number]): Record<string, string | null> | undefined {
  const explicit = renderDshReasoningEfforts(providerModelThinkingLevelMap(model));
  if (explicit) return explicit;
  return model.supportsThinking === true ? DSH_OPENAI_DEFAULT_REASONING_EFFORTS : undefined;
}

/** dsh's effort map for one plan (token-proxy) model, from server metadata. */
function renderPlanModelReasoningEfforts(model: DshPlanProviderInput['models'][number]): Record<string, string | null> | undefined {
  if (model.supportsThinking !== true) return undefined;
  if (!model.thinkingConfig || model.thinkingConfig.options.length === 0) return undefined;
  const map: Record<string, string | null> = {};
  for (const option of model.thinkingConfig.options) {
    map[option.openclawLevel] = option.openclawLevel;
  }
  return renderDshReasoningEfforts(map);
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
    const renderedModels = models.map((model) => ({
      id: model.id,
      name: model.name?.trim() || model.id,
      ...(typeof model.contextWindow === 'number' && model.contextWindow > 0
        ? { contextWindow: Math.floor(model.contextWindow) }
        : {}),
      ...(typeof model.maxTokens === 'number' && model.maxTokens > 0 ? { maxTokens: Math.floor(model.maxTokens) } : {}),
      ...(model.supportsImage ? { input: ['text', 'image'] as Array<'text' | 'image'> } : {}),
      // Reasoning effort is an OpenAI-completions wire concept; anthropic
      // routes keep bare models (dsh has no reasoning-effort field there).
      ...(api === 'openai-completions' && renderProviderModelReasoningEfforts(model)
        ? { reasoningEfforts: renderProviderModelReasoningEfforts(model) }
        : {}),
    }));
    routes[routeId] = {
      // Prefer the canonical label ("DeepSeek") over the raw config key
      // ("deepseek"), and mark the entry as LobsterAI-managed.
      displayName:
        DSH_MANAGED_LABEL_PREFIX
        + (config.displayName?.trim() || ProviderRegistry.get(providerId)?.label || providerId),
      apiKeyEnv,
      api,
      baseURL,
      ...(renderRouteThinkingCompat(api, renderedModels)
        ? { compat: renderRouteThinkingCompat(api, renderedModels) }
        : {}),
      models: renderedModels,
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
    envVars[apiKeyEnv] = DSH_PLAN_API_KEY_PLACEHOLDER;
    const needsProtocolSuffix = protocolCount > 1 && routeId === DSH_PLAN_ANTHROPIC_ROUTE_ID;
    const renderedModels = protocolModels.map((model) => ({
      id: model.modelId,
      name: model.modelName?.trim() || model.modelId,
      ...(typeof model.contextWindow === 'number' && model.contextWindow > 0
        ? { contextWindow: Math.floor(model.contextWindow) }
        : {}),
      ...(typeof model.maxTokens === 'number' && model.maxTokens > 0 ? { maxTokens: Math.floor(model.maxTokens) } : {}),
      ...(model.supportsImage ? { input: ['text', 'image'] as Array<'text' | 'image'> } : {}),
      ...(renderPlanModelReasoningEfforts(model)
        ? { reasoningEfforts: renderPlanModelReasoningEfforts(model) }
        : {}),
    }));
    routes[routeId] = {
      displayName: `${DSH_MANAGED_LABEL_PREFIX}${plan.displayName}${needsProtocolSuffix ? ' (Anthropic)' : ''}`,
      apiKeyEnv,
      api,
      baseURL,
      ...(renderRouteThinkingCompat(api, renderedModels)
        ? { compat: renderRouteThinkingCompat(api, renderedModels) }
        : {}),
      models: renderedModels,
    };
    emitted.push(routeId);
  }
  return emitted;
}

// Pure merge of managed content into an existing settings document. Returns
// the new YAML text plus warnings (e.g. unparseable existing content).
export function mergeDshSettingsText(
  existingText: string | null,
  managed: DshManagedSettings,
  options: { seedDefaultModel?: boolean } = {}
): {
  text: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  let doc: Record<string, unknown> = {};
  if (existingText && existingText.trim() !== '') {
    try {
      const parsed = yaml.load(existingText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        doc = parsed as Record<string, unknown>;
      } else if (parsed !== null && parsed !== undefined) {
        warnings.push('existing settings root is not a map; starting from an empty document');
      }
    } catch (error) {
      warnings.push(`existing settings failed to parse and will be replaced: ${(error as Error).message}`);
    }
  }

  const piAi =
    doc[PI_AI_NAMESPACE] && typeof doc[PI_AI_NAMESPACE] === 'object' && !Array.isArray(doc[PI_AI_NAMESPACE])
      ? (doc[PI_AI_NAMESPACE] as Record<string, unknown>)
      : {};
  const existingProviders =
    piAi.providers && typeof piAi.providers === 'object' && !Array.isArray(piAi.providers)
      ? (piAi.providers as Record<string, unknown>)
      : {};

  const preservedProviders = Object.fromEntries(
    Object.entries(existingProviders).filter(([routeId]) => !routeId.startsWith(DSH_MANAGED_PROVIDER_PREFIX))
  );
  const nextProviders = { ...preservedProviders, ...managed.routes };
  if (Object.keys(nextProviders).length > 0) {
    doc[PI_AI_NAMESPACE] = { ...piAi, providers: nextProviders };
  } else if (Object.keys(piAi).length > 0) {
    const { providers: _removed, ...rest } = piAi;
    doc[PI_AI_NAMESPACE] = rest;
  } else {
    delete doc[PI_AI_NAMESPACE];
  }

  if (managed.defaultModel) {
    const stored = doc[DEFAULT_MODEL_NAMESPACE];
    const storedProvider =
      stored && typeof stored === 'object' && !Array.isArray(stored)
        ? (stored as Record<string, unknown>).provider
        : undefined;
    const seedable = options.seedDefaultModel === true && !(DEFAULT_MODEL_NAMESPACE in doc);
    if (seedable || isDanglingManagedRoute(storedProvider, managed)) {
      doc[DEFAULT_MODEL_NAMESPACE] = { provider: managed.defaultModel.provider, model: managed.defaultModel.model };
    }
  }

  return { text: yaml.dump(doc, { lineWidth: 120, noRefs: true }), warnings };
}

// A default pointing at one of our own routes that no longer exists can never
// serve; anything else — including dsh's shipped default — is the user's and
// is left alone.
function isDanglingManagedRoute(storedProvider: unknown, managed: DshManagedSettings): boolean {
  if (typeof storedProvider !== 'string' || storedProvider === '') return false;
  return storedProvider.startsWith(DSH_MANAGED_PROVIDER_PREFIX) && !(storedProvider in managed.routes);
}

// Writes the merged settings with dsh's own coordination protocol: a `wx`
// sibling lock, temp file + rename, 0600/0700 modes. Callers normally run this
// before the dsh child spawns, but the lock keeps a concurrent dsh write safe.
//
// Only settings.yaml is touched. The composition layer stays untouched so the
// home keeps behaving exactly like a stock dsh — same shipped providers, same
// tools, same plugins — whether it is ours or one a standalone dsh also uses.
export async function writeDshManagedSettings(dshHome: string, managed: DshManagedSettings): Promise<{
  settingsPath: string;
  warnings: string[];
}> {
  fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
  const settingsPath = path.join(dshHome, 'settings.yaml');
  // A home without settings is one we are initializing, so the default model
  // is ours to seed; an existing home already belongs to the user.
  const seedDefaultModel = !fs.existsSync(settingsPath);

  const warnings = await writeMergedFile(settingsPath, (existing) =>
    mergeDshSettingsText(existing, managed, { seedDefaultModel })
  );

  return { settingsPath, warnings };
}

async function writeMergedFile(
  filePath: string,
  merge: (existingText: string | null) => { text: string; warnings: string[] }
): Promise<string[]> {
  const lockPath = `${filePath}.lock`;
  await acquireLock(lockPath);
  try {
    let existingText: string | null = null;
    try {
      existingText = fs.readFileSync(filePath, 'utf8');
    } catch {
      existingText = null;
    }
    const { text, warnings } = merge(existingText);
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.rmSync(tempPath, { force: true });
    fs.writeFileSync(tempPath, text, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    return warnings;
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let backoffMs = 20;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring dsh settings lock at ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 200);
    }
  }
}
