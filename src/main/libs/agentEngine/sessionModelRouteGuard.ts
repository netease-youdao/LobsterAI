import { OpenClawProviderId } from '../../../shared/providers/constants';
import { t } from '../../i18n';

/**
 * A model the user picked must never be silently replaced by a plan model:
 * plan runs spend plan quota and fail with plan-only errors ("free quota used
 * up") that make no sense for a custom provider. This happens when the gateway
 * runs a config LobsterAI did not author, e.g. one it restored from a backup.
 */

type ModelRef = { provider: string; model: string };

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const readText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export function parseProviderModelRef(ref: string | null | undefined): ModelRef | null {
  const trimmed = ref?.trim() ?? '';
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

/** `sessions.patch` reports the session's effective model as `resolved.{modelProvider,model}`. */
export function readResolvedSessionModelRef(patchResult: unknown): ModelRef | null {
  if (!isRecord(patchResult) || !isRecord(patchResult.resolved)) return null;
  const provider = readText(patchResult.resolved.modelProvider);
  const model = readText(patchResult.resolved.model);
  return provider && model ? { provider, model } : null;
}

const isPlanProvider = (provider: string): boolean => provider === OpenClawProviderId.LobsteraiServer;

/** The user selected a non-plan model, but the gateway resolved or ran a plan model. */
export function isPlanModelSubstitution(requestedModelRef: string, actualProvider: string | null | undefined): boolean {
  const requested = parseProviderModelRef(requestedModelRef);
  const actual = actualProvider?.trim() ?? '';
  return Boolean(requested && actual && !isPlanProvider(requested.provider) && isPlanProvider(actual));
}

export const SessionModelRouteVerdict = {
  /** The gateway resolved the requested model, or did not report one. */
  Ok: 'ok',
  /** Resolved differently, e.g. a provider alias; worth a log, not a block. */
  Mismatch: 'mismatch',
  /** A plan model stands in for the user's selection; sending must stop. */
  PlanSubstitution: 'planSubstitution',
} as const;
export type SessionModelRouteVerdict = typeof SessionModelRouteVerdict[keyof typeof SessionModelRouteVerdict];

export function checkSessionModelRoute(
  requestedModelRef: string,
  patchResult: unknown,
): { verdict: SessionModelRouteVerdict; resolvedModelRef?: string } {
  const resolved = readResolvedSessionModelRef(patchResult);
  if (!resolved) return { verdict: SessionModelRouteVerdict.Ok };
  const resolvedModelRef = `${resolved.provider}/${resolved.model}`;
  if (resolvedModelRef === requestedModelRef.trim()) {
    return { verdict: SessionModelRouteVerdict.Ok, resolvedModelRef };
  }
  return {
    verdict: isPlanModelSubstitution(requestedModelRef, resolved.provider)
      ? SessionModelRouteVerdict.PlanSubstitution
      : SessionModelRouteVerdict.Mismatch,
    resolvedModelRef,
  };
}

export class SessionModelRouteError extends Error {
  constructor(
    readonly requestedModelRef: string,
    readonly resolvedModelRef: string,
  ) {
    super(t('coworkErrorModelRoutedToPlan', {
      requested: requestedModelRef,
      resolved: parseProviderModelRef(resolvedModelRef)?.model ?? resolvedModelRef,
    }));
    this.name = 'SessionModelRouteError';
  }
}

/**
 * A run that failed on a plan model although the user picked another model
 * would otherwise surface the plan's own error, e.g. an upgrade prompt.
 */
export function resolvePlanModelSubstitutionErrorOverride(
  requestedModelRef: string | null | undefined,
  rawErrorMessage: string,
  metadata: { provider?: string; model?: string } | undefined,
): { errorMessage: string; detailRawErrorMessage: string } | null {
  const requested = requestedModelRef?.trim() ?? '';
  const actualProvider = metadata?.provider?.trim() ?? '';
  if (!requested || !isPlanModelSubstitution(requested, actualProvider)) return null;
  const actualModel = metadata?.model?.trim() ?? '';
  const actualRef = actualModel ? `${actualProvider}/${actualModel}` : actualProvider;
  return {
    errorMessage: t('coworkErrorRunUsedPlanModel', {
      requested,
      actual: actualModel || actualProvider,
    }),
    detailRawErrorMessage: `${rawErrorMessage}\nRequested model: ${requested}. Model that ran: ${actualRef}.`,
  };
}
