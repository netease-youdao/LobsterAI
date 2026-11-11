import { randomUUID } from 'node:crypto';

import {
  CoworkMessageEditPhase,
  type CoworkMessageEditRequest,
  type CoworkMessageVersionSwitchRequest,
} from '../../../shared/cowork/messageEdit';
import type { CoworkMessage, CoworkStore } from '../../coworkStore';
import { t } from '../../i18n';
import type { CoworkMessageEditOperation } from '../coworkMessageEditStore';
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
      const target = findEditableEntry(message, this.deps.store.getAllConversationMessages(sessionId), history);
      const entryId = target?.__openclaw?.id;
      const originalLeafId = history.sessionInfo?.activeLeafEntryId;
      if (!entryId || !originalLeafId || !history.sessionId) throw new Error(t('coworkEditUnsupported'));
      this.deps.store.updateMessage(sessionId, message.id, { metadata: { ...message.metadata, openclawEntryId: entryId } });
      const operation: CoworkMessageEditOperation = {
        operationId: randomUUID(), sessionId, sessionKey, messageId: message.id,
        prompt: request.prompt, entryId, originalLeafId, originalTranscriptId: history.sessionId,
        runId: randomUUID(), phase: CoworkMessageEditPhase.Prepared,
        removedImageIndexes: request.removedImageIndexes,
        prefixEntryIds: historyEntryIds(history.messages.slice(0, history.messages.indexOf(target!))),
      };
      try {
        this.deps.store.messageEdits.prepare(operation);
      } catch (error) {
        console.warn('[CoworkEdit] could not prepare a safe edit boundary:', error);
        throw new Error(t('coworkEditUnsupported'));
      }
      await this.deps.request(OpenClawGatewayMethod.SessionsRewind, { sessionKey, entryId });
      const rewound = await this.history(sessionKey);
      if (rewound.sessionId === history.sessionId || !isExpectedPrefix(rewound, operation)) {
        throw new Error(t('coworkEditRecoveryFailed'));
      }
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

  /** Version bookkeeping must never undo an edit the gateway has already accepted. */
  private recordVersion(operation: CoworkMessageEditOperation): void {
    try {
      this.deps.store.messageVersions?.recordEdit(operation);
    } catch (error) {
      console.warn('[CoworkEdit] could not keep the replaced conversation as a version:', error);
    }
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
    let history = await this.history(sessionKey);
    this.assertIdle(sessionId, history);
    if (history.sessionInfo?.activeLeafEntryId !== pending.targetLeafEntryId) {
      try {
        await this.deps.request(OpenClawGatewayMethod.SessionsBranchesSwitch, {
          sessionKey, leafEntryId: pending.targetLeafEntryId,
        });
      } catch (error) {
        console.warn('[CoworkEdit] the gateway refused a version switch:', error);
      }
      // An acknowledgement can be lost, so the transcript decides whether the switch happened.
      history = await this.history(sessionKey);
      if (history.sessionInfo?.activeLeafEntryId !== pending.targetLeafEntryId) {
        versions.cancelSwitch(sessionId);
        throw new Error(t('coworkVersionSwitchFailed'));
      }
    }
    let headMessageId: string | undefined;
    try {
      headMessageId = versions.applySwitch(sessionId);
    } catch (error) {
      console.error('[CoworkEdit] could not show the switched version locally:', error);
      versions.cancelSwitch(sessionId);
      await this.deps.request<unknown>(OpenClawGatewayMethod.SessionsBranchesSwitch, {
        sessionKey, leafEntryId: pending.activeLeafEntryId,
      }).catch((): undefined => undefined);
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
      const activeLeafEntryId = history.sessionInfo?.activeLeafEntryId;
      if (!activeLeafEntryId) throw new Error(t('coworkEditUnsupported'));
      try {
        this.deps.store.messageVersions.beginSwitch(sessionId, request.messageId, request.targetIndex, activeLeafEntryId);
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
      if (history.sessionInfo?.activeLeafEntryId !== operation.originalLeafId && !isExpectedPrefix(history, operation)) {
        throw new Error(t('coworkEditChanged'));
      }
      this.deps.store.messageEdits.setPhase(operation, CoworkMessageEditPhase.Restoring);
      if (history.sessionInfo?.activeLeafEntryId !== operation.originalLeafId) {
        await this.deps.request(OpenClawGatewayMethod.SessionsBranchesSwitch, {
          sessionKey: operation.sessionKey, leafEntryId: operation.originalLeafId,
        });
        const restored = await this.history(operation.sessionKey);
        if (restored.sessionInfo?.activeLeafEntryId !== operation.originalLeafId) throw new Error(t('coworkEditRecoveryFailed'));
      }
      this.deps.store.messageEdits.restore(operation);
      this.deps.reset(sessionId);
    } finally {
      this.locks.delete(sessionId);
    }
  }
}
