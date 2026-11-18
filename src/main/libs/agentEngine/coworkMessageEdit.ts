import { randomUUID } from 'node:crypto';

import {
  CoworkMessageEditPhase,
  type CoworkMessageEditRequest,
  type CoworkMessageVersionSwitchRequest,
} from '../../../shared/cowork/messageEdit';
import { CoworkTurnOutcome } from '../../../shared/cowork/turnOutcome';
import type { CoworkMessage, CoworkStore } from '../../coworkStore';
import { t } from '../../i18n';
import type { CoworkMessageEditOperation } from '../coworkMessageEditStore';
import { type CoworkGatewayPosition, endsAtForkPoint } from '../coworkMessageVersionStore';
import { extractGatewayMessageText } from '../openclawHistory';
import { stripOpenClawLocalTimeContextFooter } from '../openclawLocalTimeContextPrompt';
import { OpenClawGatewayMethod } from './constants';
import { parseSubagentGatewayHistoryMessages } from './subagent/historyParser';
import type { CoworkContinueOptions } from './types';

export interface EditHistoryMessage {
  role?: string;
  content?: unknown;
  timestamp?: number;
  __openclaw?: { id?: string; idempotencyKey?: string; truncated?: boolean };
}

export interface EditHistory {
  sessionId?: string;
  messages: EditHistoryMessage[];
  hasMore?: boolean;
  nextOffset?: number;
  pendingInputs?: { total?: number };
  sessionInfo?: { activeLeafEntryId?: string; hasActiveRun?: boolean };
}

interface EditDeps {
  store: CoworkStore;
  request: <T>(method: string, params: Record<string, unknown>) => Promise<T>;
  resolveSessionKey: (sessionId: string) => string | null;
  isBusy: (sessionId: string) => boolean;
  reset: (sessionId: string) => void;
  send: (sessionId: string, prompt: string, options: CoworkContinueOptions) => Promise<void>;
}

export function matchesEditRun(message: EditHistoryMessage, runId: string): boolean {
  const key = message.__openclaw?.idempotencyKey;
  // Native turn admission appends :user to chat.send's idempotency key.
  return message.role === 'user' && (key === runId || key === `${runId}:user`);
}

const historyEntryIds = (messages: EditHistoryMessage[]): string[] => messages.flatMap(message =>
  message.__openclaw?.id ? [message.__openclaw.id] : []);

function isExpectedPrefix(history: EditHistory, operation: CoworkMessageEditOperation): boolean {
  return JSON.stringify(historyEntryIds(history.messages)) === JSON.stringify(operation.prefixEntryIds);
}

/** Whether the gateway shows that position: its fork point when it has one, otherwise its branch tip. */
function showsPosition(history: EditHistory, position: CoworkGatewayPosition): boolean {
  return position.cutEntryId !== undefined
    ? endsAtForkPoint(historyEntryIds(history.messages), position.cutEntryId)
    : history.sessionInfo?.activeLeafEntryId === position.leafEntryId;
}

/** The user message right after a fork point on the active path, which a rewind cuts back to that point. */
function entryAfterForkPoint(history: EditHistory, forkEntryId: string): string | undefined {
  const entries = history.messages.filter(message => message.__openclaw?.id);
  const forkIndex = forkEntryId ? entries.findIndex(message => message.__openclaw?.id === forkEntryId) : -1;
  if (forkEntryId && forkIndex < 0) return undefined;
  const next = entries[forkIndex + 1];
  return next?.role === 'user' ? next.__openclaw?.id : undefined;
}

function gatewayActivePath(history: EditHistory) {
  return { leafEntryId: history.sessionInfo?.activeLeafEntryId || undefined, entryIds: historyEntryIds(history.messages) };
}

function legacyPrompt(message: EditHistoryMessage): string {
  const text = stripOpenClawLocalTimeContextFooter(extractGatewayMessageText(message));
  const marker = '[Current user request]\n';
  const index = text.lastIndexOf(marker);
  return (index < 0 ? text : text.slice(index + marker.length)).trim();
}

/** Fail closed on ambiguous legacy text, incomplete history, or truncated rows. */
export function findEditableEntry(message: CoworkMessage, localUsers: CoworkMessage[], history: EditHistory): EditHistoryMessage | undefined {
  const entryId = message.metadata?.openclawEntryId;
  const runId = message.metadata?.openclawRequestId;
  const candidates = history.messages.filter(entry => entry.role === 'user' && entry.__openclaw?.id);
  if (typeof entryId === 'string') return candidates.find(entry => entry.__openclaw?.id === entryId);
  if (typeof runId === 'string') {
    const matches = candidates.filter(entry => matchesEditRun(entry, runId));
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (history.hasMore || !message.content.trim()) return undefined;
  if (localUsers.filter(entry => entry.type === 'user' && entry.content.trim() === message.content.trim()).length !== 1) return undefined;
  const matches = candidates.filter(entry => !entry.__openclaw?.truncated && legacyPrompt(entry) === message.content.trim());
  const target = matches.length === 1 ? matches[0] : undefined;
  return target && typeof target.timestamp === 'number' && Math.abs(target.timestamp - message.timestamp) < 30_000
    ? target : undefined;
}

/** The gateway refuses transcript changes while a run settles, e.g. just after a stop, and writes nothing. */
const GATEWAY_BUSY_REJECTION = 'while the agent is working';

function belongsToRun(entry: EditHistoryMessage, runId: string): boolean {
  const key = entry.__openclaw?.idempotencyKey;
  return key === runId || Boolean(key?.startsWith(`${runId}:`));
}

/**
 * A turn stopped or failed before the gateway recorded its user message
 * exists only locally, so there is nothing to rewind for it.
 */
export function isUndeliveredTurn(message: CoworkMessage, history: EditHistory): boolean {
  const runId = message.metadata?.openclawRequestId;
  const outcome = message.metadata?.turnOutcome;
  return message.type === 'user' && typeof runId === 'string' && message.metadata?.openclawEntryId === undefined
    && (outcome === CoworkTurnOutcome.Stopped || outcome === CoworkTurnOutcome.Failed)
    && !history.messages.some(entry => belongsToRun(entry, runId));
}

export interface EditBoundary {
  /** Gateway entry to rewind to; absent when nothing from the edited message onward reached the gateway. */
  entry?: EditHistoryMessage;
  /** Local message that entry records. */
  ownerId?: string;
}

/**
 * An edit rewinds to the edited message or, when that never reached the
 * gateway, to the first later message that did. Fails closed on anything ambiguous.
 */
export function resolveEditBoundary(message: CoworkMessage, localMessages: CoworkMessage[], history: EditHistory): EditBoundary | undefined {
  const own = findEditableEntry(message, localMessages, history);
  if (own) return { entry: own, ownerId: message.id };
  const index = localMessages.findIndex(entry => entry.id === message.id);
  if (index < 0 || !isUndeliveredTurn(message, history)) return undefined;
  for (const later of localMessages.slice(index + 1)) {
    if (later.type !== 'user' || isUndeliveredTurn(later, history)) continue;
    const entry = findEditableEntry(later, localMessages, history);
    return entry ? { entry, ownerId: later.id } : undefined;
  }
  return {};
}

export class CoworkMessageEditCoordinator {
  private readonly locks = new Set<string>();

  constructor(private readonly deps: EditDeps) {}

  isLocked(sessionId: string): boolean {
    return this.locks.has(sessionId);
  }

  private async history(sessionKey: string): Promise<EditHistory> {
    let first: EditHistory | undefined;
    let offset: number | undefined;
    const messages: EditHistoryMessage[] = [];
    for (let page = 0; page < 50; page += 1) {
      // Rewind can temporarily rebuild the history index. Never interpret that as empty history.
      let result: EditHistory | undefined;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          result = await this.deps.request<EditHistory>(OpenClawGatewayMethod.ChatHistory, {
            sessionKey, limit: 200, ...(offset === undefined ? {} : { offset }),
          });
          break;
        } catch (error) {
          if (!String(error).includes('rebuilding') || attempt === 7) throw error;
          await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
      if (!result || !Array.isArray(result.messages)) throw new Error(t('coworkEditRecoveryFailed'));
      if (first && (first.sessionId !== result.sessionId
        || first.sessionInfo?.activeLeafEntryId !== result.sessionInfo?.activeLeafEntryId)) {
        throw new Error(t('coworkEditChanged'));
      }
      first ??= result;
      messages.unshift(...result.messages);
      if (!result.hasMore) return { ...first, messages, hasMore: false };
      if (typeof result.nextOffset !== 'number' || result.nextOffset === offset) break;
      offset = result.nextOffset;
    }
    throw new Error(t('coworkEditUnsupported'));
  }

  private assertIdle(sessionId: string, history?: EditHistory): void {
    if (this.deps.isBusy(sessionId) || history?.sessionInfo?.hasActiveRun || history?.pendingInputs?.total) {
      throw new Error(t('coworkEditBusy'));
    }
  }

  async edit(request: CoworkMessageEditRequest, options: CoworkContinueOptions): Promise<void> {
    const { sessionId } = request;
    if (this.locks.has(sessionId)) throw new Error(t('coworkEditBusy'));
    if (this.deps.store.messageEdits.pending(sessionId)) throw new Error(t('coworkEditRecoveryNeeded'));
    this.locks.add(sessionId);
    try {
      await this.finishSwitch(sessionId);
      this.assertIdle(sessionId);
      const session = this.deps.store.getSession(sessionId, 0);
      const message = this.deps.store.getMessage(sessionId, request.messageId);
      const sessionKey = this.deps.resolveSessionKey(sessionId);
      // Goal state is maintained outside the transcript and cannot be rewound with it.
      if (!sessionKey || !session || message?.type !== 'user' || session.scheduledTaskId || session.goal) {
        throw new Error(t('coworkEditUnsupported'));
      }
      // Covers a send that has reserved the session but is still preparing the runtime.
      if (session.status === 'running') throw new Error(t('coworkEditBusy'));
      const history = await this.history(sessionKey);
      this.assertIdle(sessionId, history);
      if (this.deps.store.getSession(sessionId, 0)?.status === 'running') throw new Error(t('coworkEditBusy'));
      const boundary = resolveEditBoundary(message, this.deps.store.getAllConversationMessages(sessionId), history);
      const target = boundary?.entry;
      const entryId = target?.__openclaw?.id;
      // A transcript stopped at a fork point is returned to through a tip, never by switching to that point.
      const path = gatewayActivePath(history);
      const original = this.deps.store.messageVersions?.gatewayPosition(sessionId, path)
        ?? (path.leafEntryId ? { leafEntryId: path.leafEntryId } : undefined);
      const originalLeafId = original?.leafEntryId ?? undefined;
      if (!boundary || (target && (!entryId || !originalLeafId || !history.sessionId))) {
        throw new Error(t('coworkEditUnsupported'));
      }
      if (entryId && boundary.ownerId === message.id) {
        this.deps.store.updateMessage(sessionId, message.id, { metadata: { ...message.metadata, openclawEntryId: entryId } });
      }
      const operation: CoworkMessageEditOperation = {
        operationId: randomUUID(), sessionId, sessionKey, messageId: message.id,
        prompt: request.prompt, entryId, originalLeafId, originalCutEntryId: original?.cutEntryId,
        originalTranscriptId: history.sessionId,
        runId: randomUUID(), phase: CoworkMessageEditPhase.Prepared,
        removedImageIndexes: request.removedImageIndexes,
        // With nothing to rewind, the resend builds on the whole current transcript.
        prefixEntryIds: historyEntryIds(target ? history.messages.slice(0, history.messages.indexOf(target)) : history.messages),
      };
      try {
        this.deps.store.messageEdits.prepare(operation);
      } catch (error) {
        console.warn('[CoworkEdit] could not prepare a safe edit boundary:', error);
        throw new Error(t('coworkEditUnsupported'));
      }
      if (entryId) await this.rewind(operation, history);
      this.deps.store.messageEdits.truncate(operation);
      this.deps.reset(sessionId);
      this.deps.store.messageEdits.setPhase(operation, CoworkMessageEditPhase.Sending);
      await new Promise<void>((resolve, reject) => {
        let accepted = false;
        void this.deps.send(sessionId, request.prompt, {
          ...options,
          messageEditOperationId: operation.operationId,
          requestId: operation.runId,
          onAccepted: () => {
            this.deps.store.messageEdits.setPhase(operation, CoworkMessageEditPhase.Committed);
            this.recordVersion(operation);
            accepted = true;
            resolve();
          },
        }).then(() => {
          if (!accepted) reject(new Error(t('coworkEditFailed')));
        }).catch(error => {
          // Once accepted, ordinary runtime errors belong to the new turn.
          if (!accepted) reject(error);
        });
      });
    } finally {
      this.locks.delete(sessionId);
    }
  }

  private async rewind(operation: CoworkMessageEditOperation, history: EditHistory): Promise<void> {
    try {
      await this.deps.request(OpenClawGatewayMethod.SessionsRewind, { sessionKey: operation.sessionKey, entryId: operation.entryId });
    } catch (error) {
      if (!String(error).includes(GATEWAY_BUSY_REJECTION)) throw error;
      // Neither transcript changed, so there is nothing to recover.
      this.deps.store.messageEdits.cancelPrepared(operation);
      throw new Error(t('coworkEditBusy'));
    }
    const rewound = await this.history(operation.sessionKey);
    if (rewound.sessionId === history.sessionId || !isExpectedPrefix(rewound, operation)) {
      throw new Error(t('coworkEditRecoveryFailed'));
    }
  }

  /** Version bookkeeping must never undo an edit the gateway has already accepted. */
  private recordVersion(operation: CoworkMessageEditOperation): void {
    try {
      const versions = this.deps.store.messageVersions;
      // Without a rewind there is no gateway branch to return to, so the replaced message is not kept.
      if (operation.entryId) versions?.recordEdit(operation);
      else versions?.recordUndeliveredEdit(operation);
    } catch (error) {
      console.warn('[CoworkEdit] could not keep the replaced conversation as a version:', error);
    }
  }

  /**
   * Points the gateway at a position. A fork point stops being a branch tip
   * once another version grows from it, so it is reached by rewinding the
   * message after it, first switching to a tip through it when the current
   * path does not pass through it. Each step is safe to repeat.
   */
  private async moveGateway(sessionKey: string, history: EditHistory, position: CoworkGatewayPosition): Promise<void> {
    const { leafEntryId, cutEntryId } = position;
    if (cutEntryId === undefined) {
      if (leafEntryId === null) throw new Error('A gateway position without a tip needs a fork point.');
      await this.deps.request(OpenClawGatewayMethod.SessionsBranchesSwitch, { sessionKey, leafEntryId });
      return;
    }
    let current = history;
    if (!entryAfterForkPoint(current, cutEntryId) && leafEntryId !== null) {
      if (current.sessionInfo?.activeLeafEntryId !== leafEntryId) {
        await this.deps.request(OpenClawGatewayMethod.SessionsBranchesSwitch, { sessionKey, leafEntryId });
      }
      current = await this.history(sessionKey);
    }
    const entryId = entryAfterForkPoint(current, cutEntryId);
    if (!entryId) throw new Error('The version fork point is not on the active gateway path.');
    await this.deps.request(OpenClawGatewayMethod.SessionsRewind, { sessionKey, entryId });
  }

  /**
   * Completes a recorded version switch: points the gateway at the target
   * branch, then swaps the local conversation. Safe to repeat after a crash.
   */
  private async finishSwitch(sessionId: string): Promise<string | undefined> {
    const versions = this.deps.store.messageVersions;
    const pending = versions?.pendingSwitch(sessionId);
    if (!pending) return undefined;
    const sessionKey = this.deps.resolveSessionKey(sessionId);
    if (!sessionKey) throw new Error(t('coworkVersionSwitchFailed'));
    const target: CoworkGatewayPosition = { leafEntryId: pending.targetLeafEntryId, cutEntryId: pending.targetCutEntryId };
    let history = await this.history(sessionKey);
    this.assertIdle(sessionId, history);
    if (!showsPosition(history, target)) {
      let refusal: unknown;
      try {
        await this.moveGateway(sessionKey, history, target);
      } catch (error) {
        refusal = error;
        console.warn('[CoworkEdit] the gateway refused a version switch:', error);
      }
      // An acknowledgement can be lost, so the transcript decides whether the switch happened.
      history = await this.history(sessionKey);
      if (!showsPosition(history, target)) {
        versions.cancelSwitch(sessionId);
        throw new Error(t(String(refusal).includes(GATEWAY_BUSY_REJECTION) ? 'coworkEditBusy' : 'coworkVersionSwitchFailed'));
      }
    }
    let headMessageId: string | undefined;
    try {
      headMessageId = versions.applySwitch(sessionId);
    } catch (error) {
      console.error('[CoworkEdit] could not show the switched version locally:', error);
      versions.cancelSwitch(sessionId);
      await this.moveGateway(sessionKey, history, { leafEntryId: pending.activeLeafEntryId, cutEntryId: pending.activeCutEntryId })
        .catch((): undefined => undefined);
      throw new Error(t('coworkVersionSwitchFailed'));
    }
    this.deps.reset(sessionId);
    return headMessageId;
  }

  /** Returns the message that heads the version now shown. */
  async switchVersion(request: CoworkMessageVersionSwitchRequest): Promise<string | undefined> {
    const { sessionId } = request;
    if (this.locks.has(sessionId)) throw new Error(t('coworkEditBusy'));
    if (this.deps.store.messageEdits.pending(sessionId)) throw new Error(t('coworkEditRecoveryNeeded'));
    this.locks.add(sessionId);
    try {
      await this.finishSwitch(sessionId);
      this.assertIdle(sessionId);
      const session = this.deps.store.getSession(sessionId, 0);
      const sessionKey = this.deps.resolveSessionKey(sessionId);
      // Goal state is maintained outside the transcript and cannot follow a branch.
      if (!sessionKey || !session || session.scheduledTaskId || session.goal) throw new Error(t('coworkEditUnsupported'));
      if (session.status === 'running') throw new Error(t('coworkEditBusy'));
      const history = await this.history(sessionKey);
      this.assertIdle(sessionId, history);
      try {
        // A resend stopped before the gateway recorded it leaves the path at a fork point, or empty.
        this.deps.store.messageVersions.beginSwitch(sessionId, request.messageId, request.targetIndex, gatewayActivePath(history));
      } catch (error) {
        console.warn('[CoworkEdit] the requested message version is unavailable:', error);
        throw new Error(t('coworkVersionSwitchFailed'));
      }
      return await this.finishSwitch(sessionId);
    } finally {
      this.locks.delete(sessionId);
    }
  }

  /** Finishes a switch that was interrupted before the session takes another message. */
  async reconcileVersionSwitch(sessionId: string): Promise<void> {
    if (this.locks.has(sessionId) || !this.deps.store.messageVersions?.pendingSwitch(sessionId)) return;
    this.locks.add(sessionId);
    try {
      await this.finishSwitch(sessionId);
    } finally {
      this.locks.delete(sessionId);
    }
  }

  async recover(sessionId: string, operationId: string): Promise<void> {
    if (this.locks.has(sessionId)) throw new Error(t('coworkEditBusy'));
    this.locks.add(sessionId);
    try {
      const operation = this.deps.store.messageEdits.pending(sessionId);
      if (!operation || operation.operationId !== operationId) throw new Error(t('coworkEditChanged'));
      const history = await this.history(operation.sessionKey);
      const acceptedIndex = history.messages.findIndex(message => matchesEditRun(message, operation.runId));
      if (acceptedIndex >= 0) {
        // A lost RPC acknowledgement must never cause another send or undo accepted work.
        this.assertIdle(sessionId, history);
        const entryId = history.messages[acceptedIndex].__openclaw?.id;
        if (!entryId || history.messages.slice(acceptedIndex + 1).some(message => message.role === 'user')) {
          throw new Error(t('coworkEditChanged'));
        }
        this.deps.store.messageEdits.commitRecovered(operation,
          parseSubagentGatewayHistoryMessages(history.messages.slice(acceptedIndex + 1)), entryId);
        this.recordVersion(operation);
        this.deps.reset(sessionId);
        return;
      }
      this.assertIdle(sessionId, history);
      // An edit that rewound nothing never moved the gateway, so only the local conversation returns.
      const original: CoworkGatewayPosition = { leafEntryId: operation.originalLeafId ?? null, cutEntryId: operation.originalCutEntryId };
      const moved = Boolean(operation.entryId) && !showsPosition(history, original);
      if (moved && !isExpectedPrefix(history, operation)) {
        throw new Error(t('coworkEditChanged'));
      }
      this.deps.store.messageEdits.setPhase(operation, CoworkMessageEditPhase.Restoring);
      if (moved) {
        await this.moveGateway(operation.sessionKey, history, original);
        const restored = await this.history(operation.sessionKey);
        if (!showsPosition(restored, original)) throw new Error(t('coworkEditRecoveryFailed'));
      }
      this.deps.store.messageEdits.restore(operation);
      this.deps.reset(sessionId);
    } finally {
      this.locks.delete(sessionId);
    }
  }
}
