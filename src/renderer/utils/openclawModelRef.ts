import { OpenClawProviderId, ProviderName, ProviderRegistry } from '@shared/providers/constants';

import type { Model } from '../store/slices/modelSlice';
import { logModelSelectionOnce } from './modelSelectionLog';

type ModelRefInput = Pick<Model, 'id' | 'providerKey' | 'openClawProviderId' | 'isServerModel'>;

function resolveModelOpenClawProviderId(model: ModelRefInput): string {
  if (model.isServerModel) {
    return OpenClawProviderId.LobsteraiServer;
  }
  return model.openClawProviderId || ProviderRegistry.getOpenClawProviderId(model.providerKey ?? '');
}

export function toOpenClawModelRef(model: ModelRefInput): string {
  return `${resolveModelOpenClawProviderId(model)}/${model.id}`;
}

/** Plan models bill the LobsterAI plan; every other provider bills the user's own account. */
export const ModelBillingSide = {
  Plan: 'plan',
  Custom: 'custom',
} as const;
export type ModelBillingSide = typeof ModelBillingSide[keyof typeof ModelBillingSide];

export function getModelBillingSide(model: ModelRefInput): ModelBillingSide {
  return resolveModelOpenClawProviderId(model) === OpenClawProviderId.LobsteraiServer
    ? ModelBillingSide.Plan
    : ModelBillingSide.Custom;
}

/** Null for a bare model id, whose provider (and so billing side) is unknown. */
export function getModelRefBillingSide(modelRef: string): ModelBillingSide | null {
  const normalizedRef = modelRef.trim();
  const slashIndex = normalizedRef.indexOf('/');
  if (slashIndex <= 0) return null;
  return normalizedRef.slice(0, slashIndex) === OpenClawProviderId.LobsteraiServer
    ? ModelBillingSide.Plan
    : ModelBillingSide.Custom;
}

export function matchesOpenClawModelRef(
  modelRef: string,
  model: ModelRefInput,
): boolean {
  const normalizedRef = modelRef.trim();
  if (!normalizedRef) return false;
  if (normalizedRef.includes('/')) {
    return normalizedRef === toOpenClawModelRef(model);
  }
  return normalizedRef === model.id;
}

export function resolveOpenClawModelRef<T extends ModelRefInput>(
  modelRef: string,
  availableModels: T[],
): T | null {
  const normalizedRef = modelRef.trim();
  if (!normalizedRef) return null;

  if (normalizedRef.includes('/')) {
    const exact = availableModels.find((model) => toOpenClawModelRef(model) === normalizedRef) ?? null;
    if (exact) return exact;

    logModelSelectionOnce(
      'debug',
      `exact-miss:${normalizedRef}`,
      `exact match failed for ${normalizedRef}; available refs: ${availableModels.map(m => toOpenClawModelRef(m)).join(', ') || 'none'}`,
    );

    const slashIndex = normalizedRef.indexOf('/');
    const providerId = normalizedRef.slice(0, slashIndex);
    const modelId = normalizedRef.slice(slashIndex + 1);

    // OpenAI OAuth provider migration compatibility between older
    // `openai-codex/*` refs and the current `openai/*` refs.
    if (providerId === OpenClawProviderId.OpenAI || providerId === OpenClawProviderId.OpenAICodex) {
      const migratedProviderId = providerId === OpenClawProviderId.OpenAICodex
        ? OpenClawProviderId.OpenAI
        : OpenClawProviderId.OpenAICodex;
      const migratedMatch = availableModels.find((model) => (
        model.id === modelId
        && model.providerKey === ProviderName.OpenAI
        && resolveModelOpenClawProviderId(model) === migratedProviderId
      )) ?? null;
      if (migratedMatch) return migratedMatch;
    }

    // Generic provider fallback: match by model ID if unique. It follows renamed
    // providers, so it must never swap a plan model and a user's own model that
    // share an ID: they bill different accounts.
    const refBillingSide = getModelRefBillingSide(normalizedRef);
    const idMatches = availableModels.filter((model) => model.id === modelId);
    const sameSideMatches = idMatches.filter((model) => getModelBillingSide(model) === refBillingSide);
    if (sameSideMatches.length === 1) {
      logModelSelectionOnce(
        'warn',
        `id-fallback:${normalizedRef}`,
        `provider fallback resolved ${normalizedRef} to ${toOpenClawModelRef(sameSideMatches[0])}`,
      );
      return sameSideMatches[0];
    }
    if (sameSideMatches.length === 0 && idMatches.length > 0) {
      logModelSelectionOnce(
        'warn',
        `id-fallback-blocked:${normalizedRef}`,
        `did not resolve ${normalizedRef} to ${idMatches.map(m => toOpenClawModelRef(m)).join(', ')} across plan and custom billing`,
      );
    }
    return null;
  }

  const matchingModels = availableModels.filter((model) => model.id === normalizedRef);
  return matchingModels.length === 1 ? matchingModels[0] : null;
}
