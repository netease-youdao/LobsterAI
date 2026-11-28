// Main-process ingestion adapter for sessions and turns created or driven
// directly on the local DSH Host by external DSH ecosystem clients (such as
// `dsh-pocket` mobile web, `dsh-media-desk`, or the `dsh` CLI).
//
// Architectural invariants:
// - Cowork SQLite is the cross-device product source of truth; `local_dsh_session_bindings`
//   is strictly device-local metadata (never synced to cloud).
// - External turns are ingested idempotently via monotonic `synced_seq` watermarks,
//   deterministic message IDs, and known local `rpcId` echo suppression.
// - Never runs concurrently with a locally active LobsterAI turn on the same session.
//
// Zero Electron imports — directly unit-testable under Node Vitest.

import {
  CoworkSessionSource,
  type CoworkSessionStatus,
  CoworkSessionStatusValue,
} from '../../../shared/cowork/constants';
import {
  buildCoworkImageAttachmentPreviews,
  type CoworkImageAttachmentPayload,
} from '../../../shared/cowork/imageAttachments';
import { DSH_SESSION_ID_PREFIX } from '../../../shared/dshEngine/hostConstants';
import type { CoworkMessage } from '../../coworkStore';
import { record } from '../dsh/dshSubagentHistory';
import type { DshTypertClient } from '../dsh/dshTypertClient';
import type { LocalDshSessionBindingStore } from '../dsh/localDshSessionBindingStore';
import {
  buildExternalDshMessageId,
  deriveExternalSessionTitle,
  DshExternalMessagePartKind,
  type DshExternalSessionSummaryLike,
  type DshWireImageRef,
  type ExternalCwdAgentCandidate,
  extractExternalStreamChunkDelta,
  extractSessionTitleFromSummary,
  isEligibleExternalDshSummary,
  isExternalFailedAssistantOutcome,
  resolveAgentIdForExternalCwd,
  type TranslatedDshDurableEvent,
  type TranslatedExternalMessage,
  translateDshDurableEvent,
} from './dshExternalEventTranslator';

const MAX_TRACKED_LOCAL_RPC_IDS_PER_SESSION = 200;
const EXTERNAL_EVENT_PAGE_LIMIT = 100;
const MAX_EXTERNAL_HISTORY_PAGES = 10;
const ON_OPEN_RECONCILE_TIMEOUT_MS = 2_500;
const PRE_MIGRATION_TIMESTAMP_GRACE_MS = 1_000;
const MAX_INLINE_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface DshExternalSyncCoworkStorePort {
  getSession(
    sessionId: string,
    messageLimit?: number,
  ): {
    id: string;
    title: string;
    claudeSessionId: string | null;
    status: CoworkSessionStatus;
    cwd: string;
    agentId: string;
    source?: CoworkSessionSource | null;
  } | null | undefined;
  getSessionIdByClaudeSessionId?(claudeSessionId: string): string | null;
  createSession(
    title: string,
    cwd: string,
    systemPrompt?: string,
    executionMode?: 'auto' | 'local' | 'sandbox',
    activeSkillIds?: string[],
    agentId?: string,
    modelOverride?: string,
    options?: { source?: CoworkSessionSource },
  ): { id: string; title: string; cwd: string; agentId: string };
  addMessage(
    sessionId: string,
    message: {
      type: CoworkMessage['type'];
      content: string;
      metadata?: Record<string, unknown>;
    },
    timestamp?: number,
    options?: { id?: string },
  ): CoworkMessage;
  updateMessageContent(
    sessionId: string,
    messageId: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): void;
  updateSession(
    sessionId: string,
    updates: {
      title?: string;
      claudeSessionId?: string | null;
      status?: CoworkSessionStatus;
    },
    options?: { touchUpdatedAt?: boolean },
  ): void;
  hasMessage?(sessionId: string, messageId: string): boolean;
  getMaxMessageTimestamp?(sessionId: string): number | null;
  listAgents?(): ExternalCwdAgentCandidate[];
}

export interface DshExternalSyncRuntimeBridge {
  isLocallyActiveTurn(coworkSessionId: string): boolean;
  isInternalDshSession(dshSessionId: string): boolean;
  registerDshSessionMapping(dshSessionId: string, coworkSessionId: string): void;
  emitMessage(sessionId: string, message: CoworkMessage): void;
  emitMessageUpdate(
    sessionId: string,
    messageId: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): void;
  emitSessionStatus(sessionId: string, status: CoworkSessionStatus): void;
  emitComplete(sessionId: string, claudeSessionId: string): void;
  emitError(sessionId: string, error: string): void;
  notifySessionsChanged(sessionIds: string[]): void;
  registerExternalTurnUsageContext?(params: {
    traceId: string;
    coworkSessionId: string;
    userMessage: string;
    title?: string;
  }): void;
  settleExternalTurnUsage?(coworkSessionId: string): void;
}

export type DshExternalSyncClient = Pick<
  DshTypertClient,
  'listSessions' | 'getSessionEvents' | 'followSession' | 'on' | 'off'
> & Partial<Pick<DshTypertClient, 'isConnected' | 'readSessionAttachment'>>;

export interface DshExternalSessionSyncDeps {
  coworkStore: DshExternalSyncCoworkStorePort;
  bindingStore: LocalDshSessionBindingStore;
  runtimeBridge: DshExternalSyncRuntimeBridge;
  getDefaultCwd: (agentId?: string) => string;
  getDefaultTitle: () => string;
}

interface PassiveFollowState {
  dshSessionId: string;
  coworkSessionId: string | null;
  abortController: AbortController;
  currentThinkingMessageId: string | null;
  currentThinkingText: string;
  currentAssistantMessageId: string | null;
  currentAssistantText: string;
  lastFinalizedThinkingMessageId: string | null;
  lastFinalizedThinkingText: string;
  lastFinalizedAssistantMessageId: string | null;
  lastFinalizedAssistantText: string;
  lastCommittedAssistantSeq: number | null;
  seenRunning: boolean;
}

function formatStoredDshSessionId(dshSessionId: string): string {
  return dshSessionId.startsWith(DSH_SESSION_ID_PREFIX)
    ? dshSessionId
    : `${DSH_SESSION_ID_PREFIX}${dshSessionId}`;
}

function stripDshSessionPrefix(raw: string): string {
  return raw.startsWith(DSH_SESSION_ID_PREFIX)
    ? raw.slice(DSH_SESSION_ID_PREFIX.length)
    : raw;
}

function parseSessionSummary(raw: unknown): DshExternalSessionSummaryLike | null {
  const rec = record(raw);
  const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId.trim() : '';
  if (!sessionId) return null;
  const projRec = record(rec.projections);
  const valuesRec = record(projRec.values);
  return {
    sessionId,
    ...(typeof rec.updatedAt === 'number' ? { updatedAt: rec.updatedAt } : {}),
    ...(typeof rec.running === 'boolean' ? { running: rec.running } : {}),
    ...(typeof rec.blank === 'boolean' ? { blank: rec.blank } : {}),
    ...(typeof rec.parentSessionId === 'string' && rec.parentSessionId.trim()
      ? { parentSessionId: rec.parentSessionId.trim() }
      : {}),
    ...(typeof rec.origin === 'string' && rec.origin.trim() ? { origin: rec.origin.trim() } : {}),
    ...(typeof rec.cwd === 'string' && rec.cwd.trim() ? { cwd: rec.cwd.trim() } : {}),
    ...(Object.keys(valuesRec).length > 0 || typeof projRec.asOfSeq === 'number'
      ? {
          projections: {
            ...(typeof projRec.asOfSeq === 'number' ? { asOfSeq: projRec.asOfSeq } : {}),
            values: valuesRec,
          },
        }
      : {}),
  };
}

export class DshExternalSessionSync {
  private readonly coworkStore: DshExternalSyncCoworkStorePort;
  private readonly bindingStore: LocalDshSessionBindingStore;
  private readonly runtimeBridge: DshExternalSyncRuntimeBridge;
  private readonly getDefaultCwd: (agentId?: string) => string;
  private readonly getDefaultTitle: () => string;

  private client: DshExternalSyncClient | null = null;
  private detachListeners: Array<() => void> = [];
  private readonly summaryCache = new Map<string, DshExternalSessionSummaryLike>();
  private readonly passiveFollowers = new Map<string, PassiveFollowState>();
  private readonly inFlightReconciles = new Map<string, Promise<void>>();
  private readonly knownLocalRpcIds = new Map<string, Set<string>>();
  private disposed = false;

  constructor(deps: DshExternalSessionSyncDeps) {
    this.coworkStore = deps.coworkStore;
    this.bindingStore = deps.bindingStore;
    this.runtimeBridge = deps.runtimeBridge;
    this.getDefaultCwd = deps.getDefaultCwd;
    this.getDefaultTitle = deps.getDefaultTitle;
  }

  /**
   * Wire live DSH remote session lifecycle listeners and trigger an initial
   * background reconciliation sweep. Safe to call repeatedly across reconnects.
   */
  attachClient(client: DshExternalSyncClient): void {
    if (this.disposed) return;
    if (this.client === client) {
      void this.reconcileAllSessions(client);
      return;
    }

    this.detachClient();
    this.client = client;

    const onAdded = (rawSummary: unknown) => {
      const summary = parseSessionSummary(rawSummary);
      if (!summary) return;
      this.summaryCache.set(summary.sessionId, summary);
      if (!isEligibleExternalDshSummary(summary)) return;
      if (this.runtimeBridge.isInternalDshSession(summary.sessionId)) return;
      const existingCoworkId = this.resolveCoworkSessionId(summary.sessionId);
      if (existingCoworkId && this.runtimeBridge.isLocallyActiveTurn(existingCoworkId)) return;
      if (summary.blank && !existingCoworkId) return;
      if (summary.running) {
        this.ensurePassiveFollow(client, summary.sessionId, existingCoworkId);
      } else {
        void this.reconcileDshSession(client, summary.sessionId, summary);
      }
    };

    const onStatus = (rawSessionId: unknown, rawRunning: unknown) => {
      const dshSessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
      const running = rawRunning === true;
      if (!dshSessionId) return;
      if (this.runtimeBridge.isInternalDshSession(dshSessionId)) return;
      const cached = this.summaryCache.get(dshSessionId);
      if (cached && !isEligibleExternalDshSummary(cached)) return;
      if (cached) {
        this.summaryCache.set(dshSessionId, { ...cached, running });
      }
      const coworkSessionId = this.resolveCoworkSessionId(dshSessionId);
      if (coworkSessionId && this.runtimeBridge.isLocallyActiveTurn(coworkSessionId)) {
        return;
      }
      if (running) {
        this.ensurePassiveFollow(client, dshSessionId, coworkSessionId);
      } else if (!this.passiveFollowers.has(dshSessionId)) {
        void this.reconcileDshSession(client, dshSessionId, cached);
      }
    };

    const onActivity = (rawSessionId: unknown, rawUpdatedAt: unknown) => {
      const dshSessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
      if (!dshSessionId) return;
      if (this.runtimeBridge.isInternalDshSession(dshSessionId)) return;
      const cached = this.summaryCache.get(dshSessionId);
      if (cached && !isEligibleExternalDshSummary(cached)) return;
      if (cached && typeof rawUpdatedAt === 'number') {
        this.summaryCache.set(dshSessionId, { ...cached, blank: false, updatedAt: rawUpdatedAt });
      }
      const coworkSessionId = this.resolveCoworkSessionId(dshSessionId);
      if (coworkSessionId && this.runtimeBridge.isLocallyActiveTurn(coworkSessionId)) {
        return;
      }
      if (this.passiveFollowers.has(dshSessionId)) return;
      void this.reconcileDshSession(client, dshSessionId, this.summaryCache.get(dshSessionId));
    };

    const onRemoved = (rawSessionId: unknown) => {
      const dshSessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
      if (!dshSessionId) return;
      this.summaryCache.delete(dshSessionId);
      this.stopPassiveFollow(dshSessionId);
    };

    const onConnected = () => {
      if (this.client === client) {
        void this.reconcileAllSessions(client);
      }
    };

    client.on('remote:api-session/added', onAdded);
    client.on('remote:api-session/status', onStatus);
    client.on('remote:api-session/activity', onActivity);
    client.on('remote:api-session/removed', onRemoved);
    client.on('connected', onConnected);

    this.detachListeners.push(() => {
      client.off('remote:api-session/added', onAdded);
      client.off('remote:api-session/status', onStatus);
      client.off('remote:api-session/activity', onActivity);
      client.off('remote:api-session/removed', onRemoved);
      client.off('connected', onConnected);
    });

    void this.reconcileAllSessions(client);
  }

  detachClient(): void {
    for (const stop of this.detachListeners) {
      try {
        stop();
      } catch {
        // Ignore listener teardown failures.
      }
    }
    this.detachListeners = [];
    this.stopAllPassiveFollows();
    this.client = null;
  }

  dispose(): void {
    this.disposed = true;
    this.detachClient();
    this.summaryCache.clear();
    this.inFlightReconciles.clear();
    this.knownLocalRpcIds.clear();
  }

  recordLocalRequestId(dshSessionId: string, rpcId: string | null | undefined): void {
    const sid = stripDshSessionPrefix(dshSessionId).trim();
    const id = typeof rpcId === 'string' ? rpcId.trim() : '';
    if (!sid || !id) return;
    let set = this.knownLocalRpcIds.get(sid);
    if (!set) {
      set = new Set();
      this.knownLocalRpcIds.set(sid, set);
    }
    set.add(id);
    while (set.size > MAX_TRACKED_LOCAL_RPC_IDS_PER_SESSION) {
      const first = set.values().next().value;
      if (typeof first === 'string') set.delete(first);
      else break;
    }
  }

  recordLocalBinding(
    coworkSessionId: string,
    dshSessionId: string,
    origin: CoworkSessionSource = CoworkSessionSource.Desktop,
  ): void {
    const sid = stripDshSessionPrefix(dshSessionId).trim();
    if (!coworkSessionId || !sid) return;
    try {
      this.bindingStore.upsertBinding({
        coworkSessionId,
        dshSessionId: sid,
        origin,
      });
    } catch (error) {
      console.warn('[DshExternalSync] Failed to record local binding:', error);
    }
  }

  recordCommittedSeq(dshSessionId: string, seq: number | undefined): void {
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return;
    const sid = stripDshSessionPrefix(dshSessionId).trim();
    if (!sid) return;
    try {
      this.bindingStore.advanceSyncedSeq(sid, seq);
    } catch {
      // Best-effort watermark update.
    }
  }

  stopPassiveFollow(dshSessionId: string): void {
    const sid = stripDshSessionPrefix(dshSessionId).trim();
    const active = this.passiveFollowers.get(sid);
    if (!active) return;
    this.passiveFollowers.delete(sid);
    active.abortController.abort();
  }

  stopAllPassiveFollows(): void {
    for (const [sid, state] of this.passiveFollowers.entries()) {
      this.passiveFollowers.delete(sid);
      state.abortController.abort();
    }
  }

  hasActivePassiveFollow(dshSessionId: string): boolean {
    return this.passiveFollowers.has(stripDshSessionPrefix(dshSessionId).trim());
  }

  hasActivePassiveFollowForCoworkSession(coworkSessionId: string): boolean {
    if (!coworkSessionId) return false;
    for (const state of this.passiveFollowers.values()) {
      if (state.coworkSessionId === coworkSessionId) {
        return true;
      }
    }
    return false;
  }

  handleCoworkSessionDeleted(coworkSessionId: string): void {
    if (!coworkSessionId) return;
    for (const [sid, state] of this.passiveFollowers.entries()) {
      if (state.coworkSessionId === coworkSessionId) {
        this.passiveFollowers.delete(sid);
        state.abortController.abort();
      }
    }
    try {
      const binding = this.bindingStore.getByCoworkSessionId(coworkSessionId);
      if (binding) {
        this.stopPassiveFollow(binding.dshSessionId);
        this.knownLocalRpcIds.delete(binding.dshSessionId);
        this.bindingStore.deleteByCoworkSessionId(coworkSessionId);
      }
    } catch {
      // Best-effort cleanup when DB is unavailable or row already cascaded.
    }
  }

  /**
   * Sync title projection updates from DSH `session/control`.
   * On baseline frames, only fill missing/default titles so user-edited desktop
   * titles are preserved; on live incremental updates, apply the new title.
   */
  handleTitleProjection(
    dshSessionId: string,
    rawTitle: unknown,
    options: { isBaseline: boolean },
  ): void {
    if (typeof rawTitle !== 'string') return;
    const title = rawTitle.trim();
    if (!title) return;
    const sid = stripDshSessionPrefix(dshSessionId).trim();
    const coworkSessionId = this.resolveCoworkSessionId(sid);
    if (!coworkSessionId) return;
    const session = this.coworkStore.getSession(coworkSessionId, 0);
    if (!session) return;
    if (session.title === title) return;
    if (options.isBaseline) {
      const defaultTitle = this.getDefaultTitle();
      const isPlaceholderTitle = !session.title.trim() || session.title === defaultTitle;
      if (!isPlaceholderTitle && session.source !== CoworkSessionSource.DshExternal) {
        return;
      }
    }
    this.coworkStore.updateSession(coworkSessionId, { title }, { touchUpdatedAt: false });
    this.runtimeBridge.notifySessionsChanged([coworkSessionId]);
  }

  /**
   * Called when the user opens a Cowork session in the UI to catch up any
   * offline/missed external DSH events before returning messages.
   */
  async reconcileByCoworkSessionId(coworkSessionId: string): Promise<void> {
    if (this.disposed || !this.client) return;
    if (this.runtimeBridge.isLocallyActiveTurn(coworkSessionId)) return;

    const binding = this.bindingStore.getByCoworkSessionId(coworkSessionId);
    let dshSessionId = binding?.dshSessionId ?? null;
    if (!dshSessionId) {
      const session = this.coworkStore.getSession(coworkSessionId, 0);
      if (session?.claudeSessionId?.startsWith(DSH_SESSION_ID_PREFIX)) {
        dshSessionId = stripDshSessionPrefix(session.claudeSessionId);
      }
    }
    if (!dshSessionId) return;
    if (this.passiveFollowers.has(dshSessionId)) return;

    const client = this.client;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        this.reconcileDshSession(client, dshSessionId, this.summaryCache.get(dshSessionId)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ON_OPEN_RECONCILE_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      console.debug('[DshExternalSync] On-open reconcile skipped:', error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Discover externally created DSH sessions and catch up any known bound
   * sessions that advanced while LobsterAI was disconnected.
   */
  async reconcileAllSessions(client: DshExternalSyncClient): Promise<void> {
    if (this.disposed) return;
    let items: Array<Record<string, unknown>> = [];
    try {
      const response = await client.listSessions();
      items = Array.isArray(response?.items) ? response.items : [];
    } catch (error) {
      console.debug('[DshExternalSync] listSessions during reconcile failed:', error);
      return;
    }

    for (const rawItem of items) {
      if (this.disposed || this.client !== client) break;
      const summary = parseSessionSummary(rawItem);
      if (!summary) continue;
      this.summaryCache.set(summary.sessionId, summary);
      if (!isEligibleExternalDshSummary(summary)) continue;
      if (this.runtimeBridge.isInternalDshSession(summary.sessionId)) continue;

      const existingCoworkId = this.resolveCoworkSessionId(summary.sessionId);
      if (existingCoworkId && this.runtimeBridge.isLocallyActiveTurn(existingCoworkId)) {
        continue;
      }
      if (!existingCoworkId && summary.blank) {
        continue;
      }

      if (summary.running) {
        this.ensurePassiveFollow(client, summary.sessionId, existingCoworkId);
        continue;
      }

      const binding = this.bindingStore.getByDshSessionId(summary.sessionId);
      const asOfSeq = summary.projections?.asOfSeq;
      if (
        existingCoworkId
        && binding
        && binding.syncedSeq >= 0
        && typeof asOfSeq === 'number'
        && asOfSeq <= binding.syncedSeq
      ) {
        // Projection watermark confirms no new durable events exist since last sync.
        const projectedTitle = extractSessionTitleFromSummary(summary);
        if (projectedTitle) {
          this.handleTitleProjection(summary.sessionId, projectedTitle, { isBaseline: true });
        }
        continue;
      }

      await this.reconcileDshSession(client, summary.sessionId, summary);
    }
  }

  private resolveCoworkSessionId(dshSessionId: string): string | null {
    const sid = stripDshSessionPrefix(dshSessionId).trim();
    if (!sid) return null;
    const binding = this.bindingStore.getByDshSessionId(sid);
    if (binding) {
      const existing = this.coworkStore.getSession(binding.coworkSessionId, 0);
      if (existing) {
        this.runtimeBridge.registerDshSessionMapping(sid, binding.coworkSessionId);
        return binding.coworkSessionId;
      }
      // Binding pointed to a deleted Cowork session; clean up stale row.
      this.bindingStore.deleteByDshSessionId(sid);
    }
    const storedId = this.coworkStore.getSessionIdByClaudeSessionId?.(formatStoredDshSessionId(sid)) ?? null;
    if (storedId) {
      this.bindingStore.upsertBinding({
        coworkSessionId: storedId,
        dshSessionId: sid,
        origin: CoworkSessionSource.Desktop,
      });
      this.runtimeBridge.registerDshSessionMapping(sid, storedId);
      return storedId;
    }
    return null;
  }

  private reconcileDshSession(
    client: DshExternalSyncClient,
    dshSessionId: string,
    summary?: DshExternalSessionSummaryLike,
  ): Promise<void> {
    const sid = stripDshSessionPrefix(dshSessionId).trim();
    if (!sid) return Promise.resolve();
    const existingInFlight = this.inFlightReconciles.get(sid);
    if (existingInFlight) return existingInFlight;

    const task = this.doReconcileDshSession(client, sid, summary).finally(() => {
      if (this.inFlightReconciles.get(sid) === task) {
        this.inFlightReconciles.delete(sid);
      }
    });
    this.inFlightReconciles.set(sid, task);
    return task;
  }

  private async doReconcileDshSession(
    client: DshExternalSyncClient,
    dshSessionId: string,
    summary?: DshExternalSessionSummaryLike,
  ): Promise<void> {
    if (this.disposed) return;
    if (this.runtimeBridge.isInternalDshSession(dshSessionId)) return;

    let coworkSessionId = this.resolveCoworkSessionId(dshSessionId);
    if (coworkSessionId && this.runtimeBridge.isLocallyActiveTurn(coworkSessionId)) return;

    const binding = coworkSessionId ? this.bindingStore.getByCoworkSessionId(coworkSessionId) : null;
    const syncedSeq = binding?.syncedSeq ?? -1;

    const rawEvents = await this.fetchEventsAfterSeq(client, dshSessionId, syncedSeq);
    if (rawEvents.length === 0) return;

    // Re-check after async RPC in case LobsterAI took over or created the session concurrently.
    coworkSessionId = this.resolveCoworkSessionId(dshSessionId);
    if (coworkSessionId && this.runtimeBridge.isLocallyActiveTurn(coworkSessionId)) return;

    const translatedEvents = rawEvents.map((ev) => translateDshDurableEvent(dshSessionId, ev));
    const maxObservedSeq = rawEvents.reduce(
      (max, ev) => (typeof ev.seq === 'number' && ev.seq > max ? ev.seq : max),
      syncedSeq,
    );

    if (!coworkSessionId) {
      const hasDisplayableMessage = translatedEvents.some(
        (item) => item.kind === 'messages' && item.messages.length > 0,
      );
      if (!hasDisplayableMessage) {
        return;
      }
      coworkSessionId = this.createExternalCoworkSession(dshSessionId, summary, translatedEvents);
    }

    const preMigrationCutoffTs =
      syncedSeq < 0 && binding !== null
        ? this.coworkStore.getMaxMessageTimestamp?.(coworkSessionId) ?? null
        : null;

    let ingestedAny = false;
    let latestTitle: string | null = null;
    let lastTurnEnd: Extract<TranslatedDshDurableEvent, { kind: 'turnEnd' }> | null = null;

    for (const item of translatedEvents) {
      if (item.seq <= syncedSeq) continue;

      if (item.kind === 'title') {
        latestTitle = item.title;
        continue;
      }
      if (item.kind === 'turnEnd') {
        lastTurnEnd = item;
        continue;
      }
      if (item.kind !== 'messages') continue;

      for (const msg of item.messages) {
        if (this.shouldSkipTranslatedMessage(dshSessionId, coworkSessionId, msg, preMigrationCutoffTs)) {
          continue;
        }
        const persisted = await this.persistExternalMessage(client, dshSessionId, coworkSessionId, msg);
        if (persisted) {
          ingestedAny = true;
          this.runtimeBridge.emitMessage(coworkSessionId, persisted);
        }
      }
    }

    if (maxObservedSeq > syncedSeq) {
      this.bindingStore.advanceSyncedSeq(dshSessionId, maxObservedSeq);
    }

    if (latestTitle) {
      const current = this.coworkStore.getSession(coworkSessionId, 0);
      if (current && current.title !== latestTitle) {
        this.coworkStore.updateSession(coworkSessionId, { title: latestTitle }, { touchUpdatedAt: false });
        ingestedAny = true;
      }
    }

    if (lastTurnEnd && !summary?.running) {
      const nextStatus: CoworkSessionStatus = lastTurnEnd.error
        ? CoworkSessionStatusValue.Error
        : lastTurnEnd.aborted
          ? CoworkSessionStatusValue.Idle
          : CoworkSessionStatusValue.Completed;
      this.coworkStore.updateSession(coworkSessionId, { status: nextStatus });
      this.runtimeBridge.emitSessionStatus(coworkSessionId, nextStatus);
      if (ingestedAny) {
        this.runtimeBridge.settleExternalTurnUsage?.(coworkSessionId);
      }
    }

    if (ingestedAny) {
      this.runtimeBridge.notifySessionsChanged([coworkSessionId]);
    }
  }

  private async fetchEventsAfterSeq(
    client: DshExternalSyncClient,
    dshSessionId: string,
    afterSeq: number,
  ): Promise<Array<Record<string, unknown>>> {
    const pages: Array<Array<Record<string, unknown>>> = [];
    let throughSeq: number | undefined;
    let beforeSeq: number | undefined;

    for (let pageIndex = 0; pageIndex < MAX_EXTERNAL_HISTORY_PAGES; pageIndex += 1) {
      let page: Record<string, unknown>;
      try {
        page = await client.getSessionEvents(
          { kind: 'session', sessionId: dshSessionId },
          {
            maxMessages: EXTERNAL_EVENT_PAGE_LIMIT,
            ...(throughSeq !== undefined ? { throughSeq } : {}),
            ...(beforeSeq !== undefined ? { beforeSeq } : {}),
          },
        );
      } catch {
        break;
      }

      const rawRecords = Array.isArray(page.records) ? page.records : [];
      const events = rawRecords
        .map((entry) => record(record(entry).event))
        .filter((ev) => typeof ev.seq === 'number');
      if (events.length === 0) break;

      const filtered = events.filter((ev) => (ev.seq as number) > afterSeq);
      pages.push(filtered);

      const firstSeq = events[0].seq as number;
      if (!page.hasMore || firstSeq <= afterSeq + 1) break;
      if (beforeSeq !== undefined && firstSeq >= beforeSeq) break;
      beforeSeq = firstSeq;
      if (typeof page.cursor === 'number' && throughSeq === undefined) {
        throughSeq = page.cursor;
      }
    }

    const merged = pages.reverse().flat();
    merged.sort((a, b) => (a.seq as number) - (b.seq as number));
    return merged;
  }

  private createExternalCoworkSession(
    dshSessionId: string,
    summary: DshExternalSessionSummaryLike | undefined,
    translatedEvents: readonly TranslatedDshDurableEvent[],
  ): string {
    const agents = this.coworkStore.listAgents?.() ?? [];
    const agentId = resolveAgentIdForExternalCwd(summary?.cwd, agents);
    const cwd = summary?.cwd?.trim() || this.getDefaultCwd(agentId);
    const title = deriveExternalSessionTitle({
      summary,
      translatedEvents,
      fallbackTitle: this.getDefaultTitle(),
    });
    const created = this.coworkStore.createSession(
      title,
      cwd,
      '',
      'local',
      [],
      agentId,
      '',
      { source: CoworkSessionSource.DshExternal },
    );
    this.coworkStore.updateSession(
      created.id,
      {
        claudeSessionId: formatStoredDshSessionId(dshSessionId),
        status: summary?.running ? CoworkSessionStatusValue.Running : CoworkSessionStatusValue.Completed,
      },
      { touchUpdatedAt: false },
    );
    this.bindingStore.upsertBinding({
      coworkSessionId: created.id,
      dshSessionId,
      syncedSeq: -1,
      origin: CoworkSessionSource.DshExternal,
    });
    this.runtimeBridge.registerDshSessionMapping(dshSessionId, created.id);
    this.runtimeBridge.notifySessionsChanged([created.id]);
    return created.id;
  }

  private shouldSkipTranslatedMessage(
    dshSessionId: string,
    coworkSessionId: string,
    msg: TranslatedExternalMessage,
    preMigrationCutoffTs: number | null,
  ): boolean {
    if (msg.rpcId && this.knownLocalRpcIds.get(dshSessionId)?.has(msg.rpcId)) {
      return true;
    }
    if (this.coworkStore.hasMessage?.(coworkSessionId, msg.id)) {
      return true;
    }
    if (
      preMigrationCutoffTs !== null
      && msg.timestamp <= preMigrationCutoffTs + PRE_MIGRATION_TIMESTAMP_GRACE_MS
    ) {
      return true;
    }
    return false;
  }

  private async resolveImageAttachments(
    client: DshExternalSyncClient,
    dshSessionId: string,
    imageRefs: readonly DshWireImageRef[] | undefined,
  ): Promise<ReturnType<typeof buildCoworkImageAttachmentPreviews>> {
    if (!imageRefs || imageRefs.length === 0) return [];
    const resolved: CoworkImageAttachmentPayload[] = [];

    for (const ref of imageRefs) {
      const mimeType = ref.mediaType || 'image/png';
      const name = ref.name || 'image';
      if (ref.data) {
        const base64 = ref.data.replace(/^data:[^;]+;base64,/, '');
        resolved.push({
          name,
          mimeType,
          base64Data: base64,
        });
        continue;
      }
      if (ref.attachmentId && typeof client.readSessionAttachment === 'function') {
        try {
          const result = await client.readSessionAttachment(dshSessionId, ref.raw);
          if (
            result
            && typeof result.data === 'string'
            && result.data.length > 0
            && result.data.length <= Math.ceil((MAX_INLINE_IMAGE_ATTACHMENT_BYTES * 4) / 3)
          ) {
            const actualMime = typeof result.attachment?.mediaType === 'string'
              ? result.attachment.mediaType
              : mimeType;
            resolved.push({
              name: typeof result.attachment?.name === 'string' ? result.attachment.name : name,
              mimeType: actualMime,
              base64Data: result.data,
            });
          }
        } catch {
          // Non-fatal: keep text content even if attachment read fails.
        }
      }
    }

    return buildCoworkImageAttachmentPreviews(resolved);
  }

  private async persistExternalMessage(
    client: DshExternalSyncClient,
    dshSessionId: string,
    coworkSessionId: string,
    msg: TranslatedExternalMessage,
  ): Promise<CoworkMessage | null> {
    if (this.coworkStore.hasMessage?.(coworkSessionId, msg.id)) {
      return null;
    }
    const imageAttachmentPreviews = msg.imageRefs
      ? await this.resolveImageAttachments(client, dshSessionId, msg.imageRefs)
      : [];
    const metadata: Record<string, unknown> = {
      ...msg.metadata,
      ...(imageAttachmentPreviews.length > 0 ? { imageAttachmentPreviews } : {}),
    };
    const persisted = this.coworkStore.addMessage(
      coworkSessionId,
      {
        type: msg.type,
        content: msg.content,
        metadata,
      },
      msg.timestamp,
      { id: msg.id },
    );
    if (persisted.type === 'user') {
      const llmTrace = record(persisted.metadata?.llmTrace);
      const traceId = typeof llmTrace.traceId === 'string' ? llmTrace.traceId : '';
      if (traceId) {
        const session = this.coworkStore.getSession(coworkSessionId, 0);
        this.runtimeBridge.registerExternalTurnUsageContext?.({
          traceId,
          coworkSessionId,
          userMessage: persisted.content,
          ...(session?.title ? { title: session.title } : {}),
        });
      }
    }
    return persisted;
  }

  private ensurePassiveFollow(
    client: DshExternalSyncClient,
    dshSessionId: string,
    existingCoworkSessionId: string | null,
  ): void {
    if (this.disposed) return;
    if (this.passiveFollowers.has(dshSessionId)) return;
    if (this.runtimeBridge.isInternalDshSession(dshSessionId)) return;
    if (existingCoworkSessionId && this.runtimeBridge.isLocallyActiveTurn(existingCoworkSessionId)) {
      return;
    }

    const abortController = new AbortController();
    const state: PassiveFollowState = {
      dshSessionId,
      coworkSessionId: existingCoworkSessionId,
      abortController,
      currentThinkingMessageId: null,
      currentThinkingText: '',
      currentAssistantMessageId: null,
      currentAssistantText: '',
      lastFinalizedThinkingMessageId: null,
      lastFinalizedThinkingText: '',
      lastFinalizedAssistantMessageId: null,
      lastFinalizedAssistantText: '',
      lastCommittedAssistantSeq: null,
      seenRunning: true,
    };
    this.passiveFollowers.set(dshSessionId, state);

    if (existingCoworkSessionId) {
      this.coworkStore.updateSession(existingCoworkSessionId, { status: CoworkSessionStatusValue.Running });
      this.runtimeBridge.emitSessionStatus(existingCoworkSessionId, CoworkSessionStatusValue.Running);
    }

    const stream = client.followSession<Record<string, unknown>>(
      {
        address: { kind: 'session', sessionId: dshSessionId },
        assistantStream: true,
      },
      abortController.signal,
    );
    void this.consumePassiveFollow(client, state, stream);
  }

  private finalizePassiveThinking(state: PassiveFollowState, seq?: number): void {
    if (!state.coworkSessionId || !state.currentThinkingMessageId) return;
    const msgId = state.currentThinkingMessageId;
    const finalText = state.currentThinkingText;
    const meta: Record<string, unknown> = {
      isThinking: true,
      isStreaming: false,
      dshSessionId: state.dshSessionId,
      externalSource: CoworkSessionSource.DshExternal,
      ...(seq !== undefined ? { seq } : {}),
    };
    this.coworkStore.updateMessageContent(state.coworkSessionId, msgId, finalText, meta);
    this.runtimeBridge.emitMessageUpdate(state.coworkSessionId, msgId, finalText, meta);
    state.lastFinalizedThinkingMessageId = msgId;
    state.lastFinalizedThinkingText = finalText;
    state.currentThinkingMessageId = null;
    state.currentThinkingText = '';
  }

  private finalizePassiveAssistant(state: PassiveFollowState, seq?: number): void {
    if (!state.coworkSessionId || !state.currentAssistantMessageId) return;
    const msgId = state.currentAssistantMessageId;
    const finalText = state.currentAssistantText;
    const meta: Record<string, unknown> = {
      isStreaming: false,
      dshSessionId: state.dshSessionId,
      externalSource: CoworkSessionSource.DshExternal,
      ...(seq !== undefined ? { seq } : {}),
    };
    this.coworkStore.updateMessageContent(state.coworkSessionId, msgId, finalText, meta);
    this.runtimeBridge.emitMessageUpdate(state.coworkSessionId, msgId, finalText, meta);
    state.lastFinalizedAssistantMessageId = msgId;
    state.lastFinalizedAssistantText = finalText;
    state.currentAssistantMessageId = null;
    state.currentAssistantText = '';
  }

  private ensurePassiveStreamingMessage(
    state: PassiveFollowState,
    kind: 'thinking' | 'assistant',
  ): string | null {
    if (!state.coworkSessionId) return null;
    if (kind === 'thinking') {
      if (!state.currentThinkingMessageId) {
        const msg = this.coworkStore.addMessage(state.coworkSessionId, {
          type: 'assistant',
          content: '',
          metadata: {
            isThinking: true,
            isStreaming: true,
            dshSessionId: state.dshSessionId,
            externalSource: CoworkSessionSource.DshExternal,
          },
        });
        state.currentThinkingMessageId = msg.id;
        state.currentThinkingText = '';
        this.runtimeBridge.emitMessage(state.coworkSessionId, msg);
      }
      return state.currentThinkingMessageId;
    }
    if (!state.currentAssistantMessageId) {
      const msg = this.coworkStore.addMessage(state.coworkSessionId, {
        type: 'assistant',
        content: '',
        metadata: {
          isStreaming: true,
          dshSessionId: state.dshSessionId,
          externalSource: CoworkSessionSource.DshExternal,
        },
      });
      state.currentAssistantMessageId = msg.id;
      state.currentAssistantText = '';
      this.runtimeBridge.emitMessage(state.coworkSessionId, msg);
    }
    return state.currentAssistantMessageId;
  }

  private async consumePassiveFollow(
    client: DshExternalSyncClient,
    state: PassiveFollowState,
    stream: AsyncGenerator<Record<string, unknown>, void, void>,
  ): Promise<void> {
    const { dshSessionId } = state;
    try {
      for await (const frame of stream) {
        if (state.abortController.signal.aborted || this.disposed) break;
        if (state.coworkSessionId && this.runtimeBridge.isLocallyActiveTurn(state.coworkSessionId)) {
          break;
        }

        if (frame.type === 'snapshot') {
          await this.handlePassiveSnapshot(client, state, frame);
          continue;
        }

        if (frame.type === 'assistant-stream') {
          this.handlePassiveAssistantStreamFrame(state, frame);
          continue;
        }

        if (frame.type === 'event' || (typeof frame.type === 'string' && frame.type.includes('/'))) {
          const ev = (frame.type === 'event' ? frame.event : frame) as Record<string, unknown> | undefined;
          if (!ev || typeof ev !== 'object') continue;
          const turnEnded = await this.handlePassiveDurableEvent(client, state, ev);
          if (turnEnded) break;
        }
      }
    } catch (error) {
      if (!state.abortController.signal.aborted) {
        console.debug('[DshExternalSync] Passive follow stream ended:', error);
      }
    } finally {
      this.finalizePassiveThinking(state);
      this.finalizePassiveAssistant(state);
      if (this.passiveFollowers.get(dshSessionId) === state) {
        this.passiveFollowers.delete(dshSessionId);
      }
    }
  }

  private async handlePassiveSnapshot(
    client: DshExternalSyncClient,
    state: PassiveFollowState,
    frame: Record<string, unknown>,
  ): Promise<void> {
    const header = record(frame.header);
    if (header.origin === 'subagent' || (typeof header.parentSession === 'string' && header.parentSession.trim())) {
      state.abortController.abort();
      return;
    }

    const headerCwd = typeof header.cwd === 'string' && header.cwd.trim() ? header.cwd.trim() : undefined;
    const projections = record(frame.projections);
    const projValues = record(projections.values);
    const mergedSummary: DshExternalSessionSummaryLike = {
      ...(this.summaryCache.get(state.dshSessionId) ?? { sessionId: state.dshSessionId }),
      ...(headerCwd ? { cwd: headerCwd } : {}),
      running: true,
      ...(Object.keys(projValues).length > 0 ? { projections: { values: projValues } } : {}),
    };
    this.summaryCache.set(state.dshSessionId, mergedSummary);

    const rawRecords = Array.isArray(frame.records) ? frame.records : [];
    const events = rawRecords
      .map((entry) => record(record(entry).event))
      .filter((ev) => typeof ev.seq === 'number');
    const translated = events.map((ev) => translateDshDurableEvent(state.dshSessionId, ev));

    if (!state.coworkSessionId) {
      state.coworkSessionId = this.resolveCoworkSessionId(state.dshSessionId);
    }
    if (!state.coworkSessionId) {
      const hasDisplayable = translated.some((item) => item.kind === 'messages' && item.messages.length > 0);
      if (hasDisplayable) {
        state.coworkSessionId = this.createExternalCoworkSession(state.dshSessionId, mergedSummary, translated);
      }
    }
    if (!state.coworkSessionId) return;

    const binding = this.bindingStore.getByCoworkSessionId(state.coworkSessionId);
    const syncedSeq = binding?.syncedSeq ?? -1;
    const preMigrationCutoffTs =
      syncedSeq < 0 && binding !== null
        ? this.coworkStore.getMaxMessageTimestamp?.(state.coworkSessionId) ?? null
        : null;

    let maxSeq = syncedSeq;
    let ingestedAny = false;
    for (const item of translated) {
      if (item.seq > maxSeq) maxSeq = item.seq;
      if (item.seq <= syncedSeq) continue;
      if (item.kind === 'title') {
        this.handleTitleProjection(state.dshSessionId, item.title, { isBaseline: false });
        continue;
      }
      if (item.kind !== 'messages') continue;
      for (const msg of item.messages) {
        if (this.shouldSkipTranslatedMessage(state.dshSessionId, state.coworkSessionId, msg, preMigrationCutoffTs)) {
          continue;
        }
        const persisted = await this.persistExternalMessage(client, state.dshSessionId, state.coworkSessionId, msg);
        if (persisted) {
          ingestedAny = true;
          this.runtimeBridge.emitMessage(state.coworkSessionId, persisted);
        }
      }
    }
    if (maxSeq > syncedSeq) {
      this.bindingStore.advanceSyncedSeq(state.dshSessionId, maxSeq);
    }
    const snapshotTitle = extractSessionTitleFromSummary(mergedSummary);
    if (snapshotTitle) {
      this.handleTitleProjection(state.dshSessionId, snapshotTitle, { isBaseline: true });
    }
    if (ingestedAny) {
      this.runtimeBridge.notifySessionsChanged([state.coworkSessionId]);
    }
  }

  private handlePassiveAssistantStreamFrame(
    state: PassiveFollowState,
    frame: Record<string, unknown>,
  ): void {
    if (!state.coworkSessionId) return;
    const inner = record(frame.frame);
    const innerType = typeof inner.type === 'string' ? inner.type : '';
    if (innerType === 'chunk') {
      const chunk = record(inner.chunk);
      const deltaText = extractExternalStreamChunkDelta(chunk);
      if (!deltaText) return;
      if (chunk.type === 'text-delta') {
        if (state.currentThinkingMessageId) {
          this.finalizePassiveThinking(state);
        }
        const msgId = this.ensurePassiveStreamingMessage(state, 'assistant');
        if (!msgId) return;
        state.currentAssistantText += deltaText;
        const meta = {
          isStreaming: true,
          dshSessionId: state.dshSessionId,
          externalSource: CoworkSessionSource.DshExternal,
        };
        this.coworkStore.updateMessageContent(state.coworkSessionId, msgId, state.currentAssistantText, meta);
        this.runtimeBridge.emitMessageUpdate(state.coworkSessionId, msgId, state.currentAssistantText, meta);
      } else if (chunk.type === 'reasoning-delta' || chunk.type === 'thinking-delta') {
        const msgId = this.ensurePassiveStreamingMessage(state, 'thinking');
        if (!msgId) return;
        state.currentThinkingText += deltaText;
        const meta = {
          isThinking: true,
          isStreaming: true,
          dshSessionId: state.dshSessionId,
          externalSource: CoworkSessionSource.DshExternal,
        };
        this.coworkStore.updateMessageContent(state.coworkSessionId, msgId, state.currentThinkingText, meta);
        this.runtimeBridge.emitMessageUpdate(state.coworkSessionId, msgId, state.currentThinkingText, meta);
      }
      return;
    }

    if (innerType === 'end') {
      if (isExternalFailedAssistantOutcome(inner.outcome)) {
        state.currentThinkingMessageId = null;
        state.currentThinkingText = '';
        state.currentAssistantMessageId = null;
        state.currentAssistantText = '';
        return;
      }
      const outcome = record(inner.outcome);
      const seq = typeof outcome.seq === 'number' ? outcome.seq : undefined;
      this.finalizePassiveThinking(state, seq);
      this.finalizePassiveAssistant(state, seq);
      state.lastCommittedAssistantSeq = seq ?? null;
    }
  }

  private async handlePassiveDurableEvent(
    client: DshExternalSyncClient,
    state: PassiveFollowState,
    ev: Record<string, unknown>,
  ): Promise<boolean> {
    const translated = translateDshDurableEvent(state.dshSessionId, ev);
    if (translated.seq < 0) return false;

    if (!state.coworkSessionId) {
      state.coworkSessionId = this.resolveCoworkSessionId(state.dshSessionId);
    }
    if (!state.coworkSessionId && translated.kind === 'messages' && translated.messages.length > 0) {
      state.coworkSessionId = this.createExternalCoworkSession(
        state.dshSessionId,
        this.summaryCache.get(state.dshSessionId),
        [translated],
      );
    }
    if (!state.coworkSessionId) return false;

    const binding = this.bindingStore.getByCoworkSessionId(state.coworkSessionId);
    const syncedSeq = binding?.syncedSeq ?? -1;

    if (translated.kind === 'turnStart') {
      state.lastFinalizedThinkingMessageId = null;
      state.lastFinalizedThinkingText = '';
      state.lastFinalizedAssistantMessageId = null;
      state.lastFinalizedAssistantText = '';
      state.lastCommittedAssistantSeq = null;
      this.coworkStore.updateSession(state.coworkSessionId, { status: CoworkSessionStatusValue.Running });
      this.runtimeBridge.emitSessionStatus(state.coworkSessionId, CoworkSessionStatusValue.Running);
      this.bindingStore.advanceSyncedSeq(state.dshSessionId, translated.seq);
      return false;
    }

    if (translated.kind === 'title') {
      this.handleTitleProjection(state.dshSessionId, translated.title, { isBaseline: false });
      this.bindingStore.advanceSyncedSeq(state.dshSessionId, translated.seq);
      return false;
    }

    if (translated.kind === 'turnEnd') {
      this.finalizePassiveThinking(state);
      this.finalizePassiveAssistant(state);
      this.bindingStore.advanceSyncedSeq(state.dshSessionId, translated.seq);
      if (translated.error) {
        this.coworkStore.updateSession(state.coworkSessionId, { status: CoworkSessionStatusValue.Error });
        this.runtimeBridge.emitSessionStatus(state.coworkSessionId, CoworkSessionStatusValue.Error);
        this.runtimeBridge.emitError(state.coworkSessionId, translated.error);
      } else if (translated.aborted) {
        this.coworkStore.updateSession(state.coworkSessionId, { status: CoworkSessionStatusValue.Idle });
        this.runtimeBridge.emitSessionStatus(state.coworkSessionId, CoworkSessionStatusValue.Idle);
      } else {
        this.coworkStore.updateSession(state.coworkSessionId, { status: CoworkSessionStatusValue.Completed });
        this.runtimeBridge.emitSessionStatus(state.coworkSessionId, CoworkSessionStatusValue.Completed);
        this.runtimeBridge.emitComplete(state.coworkSessionId, formatStoredDshSessionId(state.dshSessionId));
      }
      this.runtimeBridge.notifySessionsChanged([state.coworkSessionId]);
      return true;
    }

    if (translated.seq <= syncedSeq) return false;

    if (translated.kind === 'messages') {
      const isAssistantEvent = ev.type === 'assistant/message';
      if (isAssistantEvent) {
        this.applyPassiveAssistantEvent(state, translated.seq, translated.messages);
      } else {
        this.finalizePassiveThinking(state);
        this.finalizePassiveAssistant(state);
        state.lastFinalizedThinkingMessageId = null;
        state.lastFinalizedAssistantMessageId = null;
        state.lastCommittedAssistantSeq = null;
        for (const msg of translated.messages) {
          if (this.shouldSkipTranslatedMessage(state.dshSessionId, state.coworkSessionId, msg, null)) {
            continue;
          }
          const persisted = await this.persistExternalMessage(client, state.dshSessionId, state.coworkSessionId, msg);
          if (persisted) {
            this.runtimeBridge.emitMessage(state.coworkSessionId, persisted);
            if (persisted.type === 'user') {
              this.runtimeBridge.notifySessionsChanged([state.coworkSessionId]);
            }
          }
        }
      }
    }

    this.bindingStore.advanceSyncedSeq(state.dshSessionId, translated.seq);
    return false;
  }

  private applyPassiveAssistantEvent(
    state: PassiveFollowState,
    seq: number,
    messages: readonly TranslatedExternalMessage[],
  ): void {
    if (!state.coworkSessionId) return;
    const thinkingMsg = messages.find((m) => m.metadata.isThinking === true);
    const assistantMsg = messages.find((m) => m.metadata.isThinking !== true);

    if (thinkingMsg) {
      if (state.currentThinkingMessageId) {
        if (!state.currentThinkingText) state.currentThinkingText = thinkingMsg.content;
        this.finalizePassiveThinking(state, seq);
      } else if (state.lastFinalizedThinkingMessageId) {
        if (
          thinkingMsg.content !== state.lastFinalizedThinkingText
          || seq !== state.lastCommittedAssistantSeq
        ) {
          const meta: Record<string, unknown> = {
            ...thinkingMsg.metadata,
            isThinking: true,
            isStreaming: false,
            seq,
          };
          this.coworkStore.updateMessageContent(
            state.coworkSessionId,
            state.lastFinalizedThinkingMessageId,
            thinkingMsg.content,
            meta,
          );
          this.runtimeBridge.emitMessageUpdate(
            state.coworkSessionId,
            state.lastFinalizedThinkingMessageId,
            thinkingMsg.content,
            meta,
          );
        }
      } else if (!this.coworkStore.hasMessage?.(state.coworkSessionId, thinkingMsg.id)) {
        const persisted = this.coworkStore.addMessage(
          state.coworkSessionId,
          { type: 'assistant', content: thinkingMsg.content, metadata: thinkingMsg.metadata },
          thinkingMsg.timestamp,
          { id: thinkingMsg.id },
        );
        this.runtimeBridge.emitMessage(state.coworkSessionId, persisted);
      }
    } else if (state.currentThinkingMessageId) {
      this.finalizePassiveThinking(state, seq);
    }

    if (assistantMsg) {
      if (state.currentAssistantMessageId) {
        if (!state.currentAssistantText) state.currentAssistantText = assistantMsg.content;
        this.finalizePassiveAssistant(state, seq);
      } else if (state.lastFinalizedAssistantMessageId) {
        if (
          assistantMsg.content !== state.lastFinalizedAssistantText
          || seq !== state.lastCommittedAssistantSeq
        ) {
          const meta: Record<string, unknown> = {
            ...assistantMsg.metadata,
            isStreaming: false,
            seq,
          };
          this.coworkStore.updateMessageContent(
            state.coworkSessionId,
            state.lastFinalizedAssistantMessageId,
            assistantMsg.content,
            meta,
          );
          this.runtimeBridge.emitMessageUpdate(
            state.coworkSessionId,
            state.lastFinalizedAssistantMessageId,
            assistantMsg.content,
            meta,
          );
        }
      } else if (!this.coworkStore.hasMessage?.(state.coworkSessionId, assistantMsg.id)) {
        const persisted = this.coworkStore.addMessage(
          state.coworkSessionId,
          { type: 'assistant', content: assistantMsg.content, metadata: assistantMsg.metadata },
          assistantMsg.timestamp,
          { id: assistantMsg.id },
        );
        this.runtimeBridge.emitMessage(state.coworkSessionId, persisted);
      }
    } else if (state.currentAssistantMessageId) {
      this.finalizePassiveAssistant(state, seq);
    }

    state.lastFinalizedThinkingMessageId = null;
    state.lastFinalizedThinkingText = '';
    state.lastFinalizedAssistantMessageId = null;
    state.lastFinalizedAssistantText = '';
    state.lastCommittedAssistantSeq = null;
  }
}

export { buildExternalDshMessageId, DshExternalMessagePartKind };
