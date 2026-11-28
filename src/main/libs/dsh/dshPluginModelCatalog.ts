// Pure Node helpers for extracting third-party DSH plugin models from
// `session/modelCatalog` and validating plugin model references at turn time.
//
// Zero Electron imports — directly unit-testable under Node Vitest.

import { OpenClawProviderId } from '../../../shared/providers/constants';
import {
  type ModelThinkingConfig,
  ModelThinkingLevel,
  type ModelThinkingOption,
  OpenClawThinkingLevel,
  parseModelThinkingLevel,
  parseOpenClawThinkingLevel,
} from '../../../shared/providers/modelThinking';

export interface DshPluginModelReasoningEffort {
  id: string;
  name?: string;
  description?: string;
}

export interface DshPluginModelEntry {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  description?: string;
  badge?: string;
  reasoningEfforts?: DshPluginModelReasoningEffort[];
  defaultReasoningEffort?: string;
}

export interface DshPluginModelGroup {
  providerId: string;
  providerName: string;
  models: DshPluginModelEntry[];
}

export interface DshPluginModelFailure {
  providerId: string;
  providerName: string;
  message: string;
}

export interface DshPluginModelCatalogSnapshot {
  groups: DshPluginModelGroup[];
  models: DshPluginModelEntry[];
  failures: DshPluginModelFailure[];
  fetchedAt: number;
}

export interface RawDshModelCatalog {
  groups?: ReadonlyArray<{
    id?: unknown;
    name?: unknown;
    models?: ReadonlyArray<Record<string, unknown>>;
  }>;
  failures?: ReadonlyArray<{
    id?: unknown;
    name?: unknown;
    message?: unknown;
  }>;
}

const DEFAULT_EXCLUDED_BUILTIN_PROVIDERS = new Set<string>([
  OpenClawProviderId.LobsteraiServer,
  'deepseek-account',
]);

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseReasoningMeta(raw: unknown): {
  reasoningEfforts?: DshPluginModelReasoningEffort[];
  defaultReasoningEffort?: string;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const rawEfforts = Array.isArray(record.efforts) ? record.efforts : [];
  const efforts: DshPluginModelReasoningEffort[] = [];
  const seen = new Set<string>();
  for (const item of rawEfforts) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const id = trimNonEmptyString(entry.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = trimNonEmptyString(entry.name);
    const description = trimNonEmptyString(entry.description);
    efforts.push({
      id,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    });
  }
  const defaultEffort = trimNonEmptyString(record.defaultEffort);
  return {
    ...(efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
    ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
  };
}

/**
 * Extracts third-party DSH plugin models from DSH's `session/modelCatalog`,
 * excluding providers synced by LobsterAI itself and reserved built-ins.
 */
export function extractDshPluginModels(
  catalog: RawDshModelCatalog | null | undefined,
  lobsterSyncedProviderIds: ReadonlySet<string>,
  options?: {
    excludedBuiltInProviderIds?: ReadonlySet<string>;
    fetchedAt?: number;
  },
): DshPluginModelCatalogSnapshot {
  const fetchedAt = options?.fetchedAt ?? Date.now();
  const excludedBuiltIns = options?.excludedBuiltInProviderIds ?? DEFAULT_EXCLUDED_BUILTIN_PROVIDERS;
  const excludedLower = new Set<string>();
  for (const id of excludedBuiltIns) excludedLower.add(id.trim().toLowerCase());
  for (const id of lobsterSyncedProviderIds) {
    const normalized = id.trim().toLowerCase();
    if (normalized) excludedLower.add(normalized);
  }

  const isExcluded = (providerId: string): boolean => excludedLower.has(providerId.trim().toLowerCase());

  const groups: DshPluginModelGroup[] = [];
  const models: DshPluginModelEntry[] = [];
  const seenProviderIds = new Set<string>();

  for (const rawGroup of catalog?.groups ?? []) {
    const providerId = trimNonEmptyString(rawGroup?.id);
    if (!providerId || isExcluded(providerId) || seenProviderIds.has(providerId)) continue;
    seenProviderIds.add(providerId);

    const providerName = trimNonEmptyString(rawGroup?.name) ?? providerId;
    const groupModels: DshPluginModelEntry[] = [];
    const seenModelIds = new Set<string>();

    for (const rawModel of rawGroup?.models ?? []) {
      if (!rawModel || typeof rawModel !== 'object') continue;
      const modelId = trimNonEmptyString(rawModel.id);
      if (!modelId || seenModelIds.has(modelId)) continue;
      seenModelIds.add(modelId);

      const modelName = trimNonEmptyString(rawModel.name) ?? modelId;
      const description = trimNonEmptyString(rawModel.description);
      const badge = trimNonEmptyString(rawModel.badge);
      const reasoning = parseReasoningMeta(rawModel.reasoning);

      const entry: DshPluginModelEntry = {
        id: modelId,
        name: modelName,
        providerId,
        providerName,
        ...(description ? { description } : {}),
        ...(badge ? { badge } : {}),
        ...reasoning,
      };
      groupModels.push(entry);
      models.push(entry);
    }

    if (groupModels.length > 0) {
      groups.push({ providerId, providerName, models: groupModels });
    }
  }

  const failures: DshPluginModelFailure[] = [];
  for (const rawFailure of catalog?.failures ?? []) {
    const providerId = trimNonEmptyString(rawFailure?.id);
    if (!providerId || isExcluded(providerId)) continue;
    failures.push({
      providerId,
      providerName: trimNonEmptyString(rawFailure?.name) ?? providerId,
      message: trimNonEmptyString(rawFailure?.message) ?? 'Unknown provider error',
    });
  }

  return { groups, models, failures, fetchedAt };
}

/**
 * Splits a `<provider>/<model>` reference while keeping provider IDs verbatim
 * (without applying LobsterAI's built-in provider alias rewriting).
 */
export function parseRawProviderModelRef(
  ref: string | null | undefined,
): { providerId: string; modelId: string } | null {
  if (typeof ref !== 'string') return null;
  const trimmed = ref.trim();
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) return null;
  const providerId = trimmed.slice(0, slashIndex).trim();
  const modelId = trimmed.slice(slashIndex + 1).trim();
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

export function findDshPluginModel(
  snapshot: Pick<DshPluginModelCatalogSnapshot, 'models'> | null | undefined,
  providerId: string,
  modelId: string,
): DshPluginModelEntry | undefined {
  if (!snapshot) return undefined;
  return snapshot.models.find(
    (entry) => entry.providerId === providerId && entry.id === modelId,
  );
}

/**
 * Maps DSH `reasoning.efforts` into LobsterAI's `ModelThinkingConfig` when the
 * plugin model advertises standard reasoning effort levels.
 */
export function buildModelThinkingConfigFromDshEfforts(
  efforts: readonly DshPluginModelReasoningEffort[] | undefined,
  defaultEffort?: string,
): ModelThinkingConfig | undefined {
  if (!efforts || efforts.length === 0) return undefined;
  const options: ModelThinkingOption[] = [];
  const seenLevels = new Set<ModelThinkingLevel>();

  for (const effort of efforts) {
    const level = parseModelThinkingLevel(effort.id);
    if (!level || seenLevels.has(level)) continue;
    const openclawLevel = level === ModelThinkingLevel.Max
      ? OpenClawThinkingLevel.XHigh
      : parseOpenClawThinkingLevel(level);
    if (!openclawLevel) continue;
    seenLevels.add(level);
    options.push({ level, openclawLevel });
  }

  if (options.length === 0) return undefined;
  if (options.length === 1 && options[0]?.level === ModelThinkingLevel.Off) return undefined;

  const parsedDefault = parseModelThinkingLevel(defaultEffort);
  const defaultLevel = parsedDefault && seenLevels.has(parsedDefault)
    ? parsedDefault
    : options[0]!.level;

  return { options, defaultLevel };
}
