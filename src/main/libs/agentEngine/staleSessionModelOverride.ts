import { OpenClawProviderId } from '../../../shared/providers/constants';
import { parsePrimaryModelRef, type ProviderModelCatalog } from '../openclawAgentModels';

/**
 * A session model override can outlive the provider it points to. Removing or
 * disabling a provider drops it from openclaw.json, but the override stays in
 * the OpenClaw session entry and every run of that session then fails with
 * "Unknown model". LobsterAI writes a model allowlist from the same provider
 * set, so a model outside it can never run.
 */

export const SessionModelOverrideAvailability = {
  Available: 'available',
  /** The provider is no longer configured or enabled. */
  ProviderMissing: 'providerMissing',
  /** The provider is configured but no longer lists the model. */
  ModelMissing: 'modelMissing',
  /** Not judged locally: an empty or bare model id, or a plan model. */
  Unknown: 'unknown',
} as const;
export type SessionModelOverrideAvailability =
  typeof SessionModelOverrideAvailability[keyof typeof SessionModelOverrideAvailability];

export function resolveSessionModelOverrideAvailability(
  modelRef: string,
  catalog: ProviderModelCatalog,
): SessionModelOverrideAvailability {
  const target = parsePrimaryModelRef(modelRef);
  // Plan models come from the signed-in account's catalog, which is empty until
  // it loads; the server model run gate owns that case.
  if (!target || target.providerId === OpenClawProviderId.LobsteraiServer) {
    return SessionModelOverrideAvailability.Unknown;
  }
  const provider = catalog[target.providerId];
  if (!provider) return SessionModelOverrideAvailability.ProviderMissing;
  return provider.models.some(model => model.id === target.modelId)
    ? SessionModelOverrideAvailability.Available
    : SessionModelOverrideAvailability.ModelMissing;
}

export function isStaleSessionModelOverride(availability: SessionModelOverrideAvailability): boolean {
  return availability === SessionModelOverrideAvailability.ProviderMissing
    || availability === SessionModelOverrideAvailability.ModelMissing;
}

export type StaleSessionModelOverrideReset = {
  sessionId: string;
  /** The OpenClaw session whose stored override must go. */
  sessionKey: string;
  modelRef: string;
  availability: SessionModelOverrideAvailability;
  trigger: string;
};

export type StaleSessionModelOverrideResetterDeps = {
  getModelCatalog: () => ProviderModelCatalog | undefined;
  normalizeModelRef: (modelRef: string) => string;
  /** IM sessions pinned to a model, with the OpenClaw session that stores the pin. */
  listChannelSessionModelOverrides: () => Array<{ sessionId: string; modelOverride: string; sessionKey: string }>;
  getSessionModelOverride: (sessionId: string) => string | null;
  /** Sessions with a running turn are left for the next check. */
  isSessionBusy: (sessionId: string) => boolean;
  /** Patches the OpenClaw session back to its agent model unless `shouldPatch` says otherwise. */
  patchModelToAgentDefault: (options: {
    sessionId: string;
    sessionKey: string;
    reason: string;
    shouldPatch: () => boolean;
  }) => Promise<boolean>;
  /** Clears the local override and tells the user the session uses the agent model again. */
  clearLocalModelOverride: (sessionId: string, modelRef: string) => void;
};

/**
 * Moves sessions off a removed or disabled model. OpenClaw runs IM messages
 * from its own session entry without LobsterAI, so the stored override is
 * patched away there before the local override is cleared.
 */
export class StaleSessionModelOverrideResetter {
  private readonly resets = new Map<string, Promise<boolean>>();

  constructor(private readonly deps: StaleSessionModelOverrideResetterDeps) {}

  /** Why the model can no longer run, or null when it can or cannot be judged. */
  findStaleReason(
    modelRef: string,
    catalog?: ProviderModelCatalog,
  ): SessionModelOverrideAvailability | null {
    if (!modelRef) return null;
    try {
      const resolvedCatalog = catalog ?? this.deps.getModelCatalog();
      if (!resolvedCatalog) return null;
      const availability = resolveSessionModelOverrideAvailability(modelRef, resolvedCatalog);
      return isStaleSessionModelOverride(availability) ? availability : null;
    } catch (error) {
      console.warn('[OpenClawRuntime] failed to check a session model against the configured providers:', error);
      return null;
    }
  }

  /** Resolves true once the local override was cleared; never rejects. */
  reset(options: StaleSessionModelOverrideReset): Promise<boolean> {
    const inFlight = this.resets.get(options.sessionId);
    if (inFlight) return inFlight;
    const reset = this.performReset(options).catch((error) => {
      console.warn(`[OpenClawRuntime] failed to reset stale model ${options.modelRef} on session ${options.sessionId}:`, error);
      return false;
    }).finally(() => {
      if (this.resets.get(options.sessionId) === reset) this.resets.delete(options.sessionId);
    });
    this.resets.set(options.sessionId, reset);
    return reset;
  }

  /**
   * Resets IM sessions pinned to a removed or disabled provider or model.
   * Desktop sessions are left alone: the model picker flags their model and
   * a turn falls back before it starts, and a re-enabled provider still works.
   */
  async reconcile(trigger: string): Promise<void> {
    const catalog = this.deps.getModelCatalog();
    if (!catalog) return;
    for (const { sessionId, modelOverride, sessionKey } of this.deps.listChannelSessionModelOverrides()) {
      if (this.deps.isSessionBusy(sessionId)) continue;
      const modelRef = this.deps.normalizeModelRef(modelOverride);
      const availability = this.findStaleReason(modelRef, catalog);
      if (!availability) continue;
      await this.reset({ sessionId, sessionKey, modelRef, availability, trigger });
    }
  }

  private isStillSelected(sessionId: string, modelRef: string, allowEmpty: boolean): boolean {
    const current = this.deps.getSessionModelOverride(sessionId)?.trim() ?? '';
    if (!current) return allowEmpty;
    return this.deps.normalizeModelRef(current) === modelRef;
  }

  private async performReset(options: StaleSessionModelOverrideReset): Promise<boolean> {
    const { sessionId, sessionKey, modelRef, availability, trigger } = options;
    let patched: boolean;
    try {
      patched = await this.deps.patchModelToAgentDefault({
        sessionId,
        sessionKey,
        reason: `stale model override (${trigger})`,
        // A model picked after the check must survive; a local mirror may be empty.
        shouldPatch: () => this.isStillSelected(sessionId, modelRef, true),
      });
    } catch (error) {
      // The local override stays, so the next check retries.
      console.warn(`[OpenClawRuntime] failed to reset stale model ${modelRef} in OpenClaw session ${sessionKey}:`, error);
      return false;
    }
    if (!patched) return false;
    console.warn(
      '[OpenClawRuntime] reset a session model that is no longer configured.',
      `Session ${sessionId}.`,
      `OpenClaw key ${sessionKey}.`,
      `Model ${modelRef}.`,
      `Reason ${availability}.`,
      `Trigger ${trigger}.`,
    );
    const cleared = this.isStillSelected(sessionId, modelRef, false);
    if (cleared) this.deps.clearLocalModelOverride(sessionId, modelRef);
    return cleared;
  }
}
