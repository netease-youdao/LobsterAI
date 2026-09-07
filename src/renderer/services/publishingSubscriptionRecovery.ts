import { PublishingRecoveryAnalyticsOutcome } from '@shared/analytics/constants';
import { AccountOwnerKeyPrefix } from '@shared/auth/accountOwner';
import { AuthSubscriptionStatus } from '@shared/auth/constants';
import {
  LibraryCategory,
  LibraryCloudKind,
  LibraryItemKind,
  LibraryLimits,
} from '@shared/library/constants';
import type { LibraryCloudListData } from '@shared/library/types';
import {
  PublishingResourceKind,
  type PublishingResourceKind as PublishingResourceKindValue,
  PublishingSubscriptionRecoveryMode,
} from '@shared/publishing/constants';

import {
  clearPublishingRecoveryAnalyticsState,
  reportPublishingRecoveryResult,
} from '@/components/artifacts/publishingAnalytics';
import { store } from '@/store';

export const PublishingSubscriptionRecoveryCoordinatorEvent = {
  LibraryInvalidated: 'publishingSubscriptionRecovery:libraryInvalidated',
} as const;

export const PublishingSubscriptionRecoveryRefreshOutcome = {
  Pending: 'pending',
  RedeployReady: 'redeploy_ready',
  ResourceUnavailable: 'resource_unavailable',
  Restored: 'restored',
} as const;

export type PublishingSubscriptionRecoveryRefreshOutcome =
  typeof PublishingSubscriptionRecoveryRefreshOutcome[
    keyof typeof PublishingSubscriptionRecoveryRefreshOutcome
  ];

export interface PublishingSubscriptionRecoveryAuthSnapshot {
  ownerAccountKey: string | null;
  accountMode?: string | null;
  subscriptionStatus?: string | null;
}

export interface PublishingSubscriptionRecoveryIntent {
  ownerAccountKey: string;
  resourceKind: PublishingResourceKindValue;
  resourceKey: string;
  recoveryMode: PublishingSubscriptionRecoveryMode;
  traceId: string;
}

export interface PublishingSubscriptionRecoveryTarget
  extends PublishingSubscriptionRecoveryIntent {
  refresh: () => Promise<PublishingSubscriptionRecoveryRefreshOutcome>;
}

interface StoredRecoveryIntent extends PublishingSubscriptionRecoveryIntent {
  createdAt: number;
  focusRefreshArmed: boolean;
}

interface PendingRecoveryResult {
  ownerAccountKey: string;
  resourceKey: string;
  outcome: PublishingRecoveryAnalyticsOutcome;
  reporting: boolean;
}

export interface PublishingSubscriptionRecoveryDependencies {
  now: () => number;
  listCloud: (ownerAccountKey: string) => Promise<{
    success: boolean;
    data?: LibraryCloudListData;
  }>;
  getAuthSnapshot: () => PublishingSubscriptionRecoveryAuthSnapshot;
  emitLibraryInvalidated: (ownerAccountKey: string) => void;
  reportResult: typeof reportPublishingRecoveryResult;
  clearAnalyticsState: typeof clearPublishingRecoveryAnalyticsState;
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}

const INTENT_TTL_MS = 7 * 24 * 60 * 60_000;
const RECOVERY_RETRY_DELAYS_MS = [3_000, 10_000, 30_000] as const;

const isPersonalOwner = (ownerAccountKey: string | null | undefined): ownerAccountKey is string => (
  ownerAccountKey?.startsWith(AccountOwnerKeyPrefix.Personal) === true
);

const isActivePersonalSnapshot = (
  snapshot: PublishingSubscriptionRecoveryAuthSnapshot,
): snapshot is PublishingSubscriptionRecoveryAuthSnapshot & { ownerAccountKey: string } => (
  isPersonalOwner(snapshot.ownerAccountKey)
  && snapshot.accountMode !== 'enterprise'
  && snapshot.subscriptionStatus === AuthSubscriptionStatus.Active
);

const isRecoverableMode = (mode: PublishingSubscriptionRecoveryMode): boolean => (
  mode === PublishingSubscriptionRecoveryMode.Automatic
  || mode === PublishingSubscriptionRecoveryMode.RedeployRequired
);

export const resolvePublishingSubscriptionRecoveryRefreshOutcome = (input: {
  expectedMode: PublishingSubscriptionRecoveryMode;
  currentMode?: PublishingSubscriptionRecoveryMode;
  isRestored: boolean;
}): PublishingSubscriptionRecoveryRefreshOutcome => {
  if (input.isRestored) return PublishingSubscriptionRecoveryRefreshOutcome.Restored;
  if (input.currentMode === PublishingSubscriptionRecoveryMode.RedeployRequired) {
    return PublishingSubscriptionRecoveryRefreshOutcome.RedeployReady;
  }
  if (input.currentMode === PublishingSubscriptionRecoveryMode.Automatic) {
    return PublishingSubscriptionRecoveryRefreshOutcome.Pending;
  }
  return PublishingSubscriptionRecoveryRefreshOutcome.ResourceUnavailable;
};

const createDefaultDependencies = (): PublishingSubscriptionRecoveryDependencies => ({
  now: Date.now,
  listCloud: async ownerAccountKey => {
    const library = window.electron?.library;
    if (!library) return { success: false };
    return library.listCloud({
      category: LibraryCategory.All,
      favoriteOwnerScope: ownerAccountKey,
      kind: LibraryCloudKind.All,
      pageSize: LibraryLimits.MaxPageSize,
    });
  },
  getAuthSnapshot: () => {
    const auth = store.getState().auth;
    return {
      ownerAccountKey: auth.ownerAccountKey,
      accountMode: auth.quota?.accountMode ?? auth.user?.accountMode,
      subscriptionStatus: auth.quota?.subscriptionStatus,
    };
  },
  emitLibraryInvalidated: ownerAccountKey => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(
      PublishingSubscriptionRecoveryCoordinatorEvent.LibraryInvalidated,
      { detail: { ownerAccountKey } },
    ));
  },
  reportResult: reportPublishingRecoveryResult,
  clearAnalyticsState: clearPublishingRecoveryAnalyticsState,
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: timer => clearTimeout(timer),
});

export class PublishingSubscriptionRecoveryCoordinator {
  private readonly dependencies: PublishingSubscriptionRecoveryDependencies;
  private intent: StoredRecoveryIntent | null = null;
  private readonly targets = new Map<string, PublishingSubscriptionRecoveryTarget>();
  private readonly knownOwnerAccountKeys = new Set<string>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryResolve: (() => void) | null = null;
  private runningOwner: string | null = null;
  private runPromise: Promise<void> | null = null;
  private runGeneration = 0;
  private readonly exhaustedOwners = new Set<string>();
  private observedOwnerAccountKey: string | null = null;
  private readonly pendingResults = new Map<string, PendingRecoveryResult>();

  constructor(dependencies: PublishingSubscriptionRecoveryDependencies = createDefaultDependencies()) {
    this.dependencies = dependencies;
  }

  arm(input: PublishingSubscriptionRecoveryIntent): void {
    if (!isPersonalOwner(input.ownerAccountKey)) return;
    this.knownOwnerAccountKeys.add(input.ownerAccountKey);
    this.exhaustedOwners.delete(input.ownerAccountKey);
    this.pendingResults.delete(this.getResultKey(input.ownerAccountKey, input.resourceKey));
    this.intent = {
      ...input,
      createdAt: this.dependencies.now(),
      focusRefreshArmed: true,
    };
  }

  registerTarget(target: PublishingSubscriptionRecoveryTarget): () => void {
    this.knownOwnerAccountKeys.add(target.ownerAccountKey);
    const key = this.getTargetKey(target.ownerAccountKey, target.resourceKind, target.resourceKey);
    this.targets.set(key, target);
    const snapshot = this.dependencies.getAuthSnapshot();
    if (
      isRecoverableMode(target.recoveryMode)
      && isActivePersonalSnapshot(snapshot)
      && snapshot.ownerAccountKey === target.ownerAccountKey
      && !this.exhaustedOwners.has(target.ownerAccountKey)
    ) {
      void this.startRecovery(snapshot.ownerAccountKey);
    }
    return () => {
      if (this.targets.get(key) === target) this.targets.delete(key);
    };
  }

  observeAuthSnapshot(snapshot: PublishingSubscriptionRecoveryAuthSnapshot): void {
    if (!snapshot.ownerAccountKey) {
      this.reset();
      return;
    }
    if (!isPersonalOwner(snapshot.ownerAccountKey) || snapshot.accountMode === 'enterprise') {
      this.reset();
      return;
    }
    if (
      (this.observedOwnerAccountKey
        && this.observedOwnerAccountKey !== snapshot.ownerAccountKey)
      || (this.intent && this.intent.ownerAccountKey !== snapshot.ownerAccountKey)
    ) {
      this.reset();
    }
    this.observedOwnerAccountKey = snapshot.ownerAccountKey;
    const hasIntent = this.getCurrentIntent()?.ownerAccountKey === snapshot.ownerAccountKey;
    const hasRecoverableTarget = [...this.targets.values()].some(target => (
      target.ownerAccountKey === snapshot.ownerAccountKey && isRecoverableMode(target.recoveryMode)
    ));
    if (
      isActivePersonalSnapshot(snapshot)
      && !this.exhaustedOwners.has(snapshot.ownerAccountKey)
      && (hasIntent || hasRecoverableTarget)
    ) {
      void this.startRecovery(snapshot.ownerAccountKey);
    }
    if (isActivePersonalSnapshot(snapshot)) this.retryPendingResults(snapshot.ownerAccountKey);
  }

  reconcile(ownerAccountKey: string | null | undefined): void {
    if (!ownerAccountKey || this.exhaustedOwners.has(ownerAccountKey)) return;
    const snapshot = this.dependencies.getAuthSnapshot();
    if (isActivePersonalSnapshot(snapshot) && snapshot.ownerAccountKey === ownerAccountKey) {
      void this.startRecovery(ownerAccountKey);
    }
  }

  consumeFocusRefreshRequest(ownerAccountKey: string | null | undefined): boolean {
    const intent = this.getCurrentIntent();
    if (!intent?.focusRefreshArmed || intent.ownerAccountKey !== ownerAccountKey) return false;
    intent.focusRefreshArmed = false;
    return true;
  }

  clearAnalytics(): void {
    this.pendingResults.clear();
    this.dependencies.clearAnalyticsState();
  }

  reset(): void {
    const previousOwnerAccountKeys = new Set(this.knownOwnerAccountKeys);
    if (this.intent?.ownerAccountKey) previousOwnerAccountKeys.add(this.intent.ownerAccountKey);
    if (this.runningOwner) previousOwnerAccountKeys.add(this.runningOwner);
    this.runGeneration += 1;
    this.runningOwner = null;
    this.runPromise = null;
    if (this.retryTimer) {
      this.dependencies.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryResolve?.();
    this.retryResolve = null;
    this.intent = null;
    this.exhaustedOwners.clear();
    this.observedOwnerAccountKey = null;
    this.pendingResults.clear();
    this.targets.clear();
    previousOwnerAccountKeys.forEach(ownerAccountKey => {
      this.dependencies.clearAnalyticsState(ownerAccountKey);
    });
    this.knownOwnerAccountKeys.clear();
  }

  private getCurrentIntent(): StoredRecoveryIntent | null {
    if (!this.intent) return null;
    if (this.intent.createdAt + INTENT_TTL_MS <= this.dependencies.now()) {
      this.reset();
      return null;
    }
    return this.intent;
  }

  private getTargetKey(
    ownerAccountKey: string,
    resourceKind: PublishingResourceKindValue,
    resourceKey: string,
  ): string {
    return `${ownerAccountKey}:${resourceKind}:${resourceKey}`;
  }

  private async startRecovery(ownerAccountKey: string): Promise<void> {
    if (this.runPromise && this.runningOwner === ownerAccountKey) return this.runPromise;
    if (this.runningOwner && this.runningOwner !== ownerAccountKey) this.reset();
    const generation = ++this.runGeneration;
    this.runningOwner = ownerAccountKey;
    const run = this.runRecoveryRound(ownerAccountKey, generation, 0);
    this.runPromise = run;
    try {
      await run;
    } finally {
      if (this.runPromise === run) this.runPromise = null;
    }
  }

  private async runRecoveryRound(
    ownerAccountKey: string,
    generation: number,
    retryIndex: number,
  ): Promise<void> {
    if (!this.isRunCurrent(ownerAccountKey, generation)) return;
    const response = await this.dependencies.listCloud(ownerAccountKey).catch(() => null);
    if (!this.isRunCurrent(ownerAccountKey, generation)) return;
    if (!response?.success || !response.data) {
      if (retryIndex < RECOVERY_RETRY_DELAYS_MS.length) {
        await this.waitForRetry(RECOVERY_RETRY_DELAYS_MS[retryIndex]);
        if (this.isRunCurrent(ownerAccountKey, generation)) {
          await this.runRecoveryRound(ownerAccountKey, generation, retryIndex + 1);
        }
      } else {
        const intent = this.intent?.ownerAccountKey === ownerAccountKey ? this.intent : null;
        if (intent) {
          this.queueResult({
            ownerAccountKey,
            resourceKey: intent.resourceKey,
            outcome: PublishingRecoveryAnalyticsOutcome.RetryExhausted,
          });
          if (this.intent === intent) this.intent = null;
        }
        this.exhaustedOwners.add(ownerAccountKey);
        this.runningOwner = null;
      }
      return;
    }
    this.dependencies.emitLibraryInvalidated(ownerAccountKey);
    const targetOutcomes = await this.refreshTargets(ownerAccountKey, generation);
    if (!this.isRunCurrent(ownerAccountKey, generation)) return;

    const intent = this.intent?.ownerAccountKey === ownerAccountKey ? this.intent : null;
    const intentOutcome = intent
      ? targetOutcomes.get(this.getTargetKey(
          ownerAccountKey,
          intent.resourceKind,
          intent.resourceKey,
        )) ?? this.getCloudIntentOutcome(intent, response.data)
      : undefined;
    const terminalIntent = intentOutcome !== undefined
      && intentOutcome !== PublishingSubscriptionRecoveryRefreshOutcome.Pending;
    if (terminalIntent && intent) {
      this.queueResult({
        ownerAccountKey,
        resourceKey: intent.resourceKey,
        outcome: intentOutcome === PublishingSubscriptionRecoveryRefreshOutcome.Restored
          ? PublishingRecoveryAnalyticsOutcome.Restored
          : intentOutcome === PublishingSubscriptionRecoveryRefreshOutcome.RedeployReady
            ? PublishingRecoveryAnalyticsOutcome.RedeployReady
            : PublishingRecoveryAnalyticsOutcome.ResourceUnavailable,
      });
      this.intent = null;
    }

    const targetStillPending = [...targetOutcomes.values()].some(
      outcome => outcome === PublishingSubscriptionRecoveryRefreshOutcome.Pending,
    );
    const recoveryPending = response.data.recoveryPending === true || targetStillPending;
    if (recoveryPending && retryIndex < RECOVERY_RETRY_DELAYS_MS.length) {
      await this.waitForRetry(RECOVERY_RETRY_DELAYS_MS[retryIndex]);
      if (!this.isRunCurrent(ownerAccountKey, generation)) return;
      await this.runRecoveryRound(ownerAccountKey, generation, retryIndex + 1);
      return;
    }

    if (recoveryPending && intent && this.intent === intent) {
      this.queueResult({
        ownerAccountKey,
        resourceKey: intent.resourceKey,
        outcome: PublishingRecoveryAnalyticsOutcome.RetryExhausted,
      });
    }
    if (recoveryPending) this.exhaustedOwners.add(ownerAccountKey);
    else if (intentOutcome !== undefined) this.exhaustedOwners.delete(ownerAccountKey);
    this.runningOwner = null;
    if (
      intentOutcome !== undefined
      || recoveryPending
    ) {
      if (this.intent?.ownerAccountKey === ownerAccountKey) this.intent = null;
    }
  }

  private async refreshTargets(
    ownerAccountKey: string,
    generation: number,
  ): Promise<Map<string, PublishingSubscriptionRecoveryRefreshOutcome>> {
    const targets = [...this.targets.values()].filter(
      target => target.ownerAccountKey === ownerAccountKey && isRecoverableMode(target.recoveryMode),
    );
    const outcomes = new Map<string, PublishingSubscriptionRecoveryRefreshOutcome>();
    await Promise.all(targets.map(async target => {
      try {
        outcomes.set(
          this.getTargetKey(ownerAccountKey, target.resourceKind, target.resourceKey),
          await target.refresh(),
        );
      } catch {
        outcomes.set(
          this.getTargetKey(ownerAccountKey, target.resourceKind, target.resourceKey),
          PublishingSubscriptionRecoveryRefreshOutcome.Pending,
        );
      }
    }));
    return this.isRunCurrent(ownerAccountKey, generation)
      ? outcomes
      : new Map();
  }

  private getCloudIntentOutcome(
    intent: StoredRecoveryIntent,
    data: LibraryCloudListData,
  ): PublishingSubscriptionRecoveryRefreshOutcome | undefined {
    const item = data.list.find(candidate => (
      candidate.itemId === intent.resourceKey
      && (
        (intent.resourceKind === PublishingResourceKind.File
          && candidate.itemKind === LibraryItemKind.SharedFile)
        || (intent.resourceKind === PublishingResourceKind.Site
          && candidate.itemKind === LibraryItemKind.DeployedSite)
      )
    ));
    if (!item) return undefined;
    return resolvePublishingSubscriptionRecoveryRefreshOutcome({
      expectedMode: intent.recoveryMode,
      currentMode: item.subscriptionRecoveryMode,
      isRestored: item.effectiveAvailable === true && item.accessExpiresAt === null,
    });
  }

  private getResultKey(ownerAccountKey: string, resourceKey: string): string {
    return JSON.stringify([ownerAccountKey, resourceKey]);
  }

  private queueResult(input: Omit<PendingRecoveryResult, 'reporting'>): void {
    const key = this.getResultKey(input.ownerAccountKey, input.resourceKey);
    this.pendingResults.set(key, { ...input, reporting: false });
    this.reportPendingResult(key);
  }

  private retryPendingResults(ownerAccountKey: string): void {
    this.pendingResults.forEach((result, key) => {
      if (result.ownerAccountKey === ownerAccountKey) this.reportPendingResult(key);
    });
  }

  private reportPendingResult(key: string): void {
    const pending = this.pendingResults.get(key);
    if (!pending || pending.reporting) return;
    pending.reporting = true;
    void this.dependencies.reportResult({
      ownerAccountKey: pending.ownerAccountKey,
      resourceKey: pending.resourceKey,
      outcome: pending.outcome,
    }).then(success => {
      if (success && this.pendingResults.get(key) === pending) this.pendingResults.delete(key);
    }).catch(() => undefined).finally(() => {
      if (this.pendingResults.get(key) === pending) pending.reporting = false;
    });
  }

  private waitForRetry(delayMs: number): Promise<void> {
    return new Promise<void>(resolve => {
      this.retryResolve = resolve;
      this.retryTimer = this.dependencies.setTimer(() => {
        this.retryTimer = null;
        this.retryResolve = null;
        resolve();
      }, delayMs);
    });
  }

  private isRunCurrent(ownerAccountKey: string, generation: number): boolean {
    const snapshot = this.dependencies.getAuthSnapshot();
    return generation === this.runGeneration
      && this.runningOwner === ownerAccountKey
      && snapshot.ownerAccountKey === ownerAccountKey
      && isActivePersonalSnapshot(snapshot);
  }
}

export const publishingSubscriptionRecoveryCoordinator =
  new PublishingSubscriptionRecoveryCoordinator();

export const armPublishingSubscriptionRecovery = (
  input: PublishingSubscriptionRecoveryIntent,
): void => publishingSubscriptionRecoveryCoordinator.arm(input);

export const observePublishingSubscriptionRecoveryAuthSnapshot = (
  snapshot: PublishingSubscriptionRecoveryAuthSnapshot,
): void => publishingSubscriptionRecoveryCoordinator.observeAuthSnapshot(snapshot);

export const consumePublishingSubscriptionRecoveryFocusRefresh = (
  ownerAccountKey: string | null | undefined,
): boolean => publishingSubscriptionRecoveryCoordinator.consumeFocusRefreshRequest(
  ownerAccountKey,
);

export const registerPublishingSubscriptionRecoveryTarget = (
  target: PublishingSubscriptionRecoveryTarget,
): (() => void) => publishingSubscriptionRecoveryCoordinator.registerTarget(target);

export const reconcilePublishingSubscriptionRecovery = (
  ownerAccountKey: string | null | undefined,
): void => publishingSubscriptionRecoveryCoordinator.reconcile(ownerAccountKey);

export const clearPublishingSubscriptionRecoveryAnalytics = (): void => {
  publishingSubscriptionRecoveryCoordinator.clearAnalytics();
};
