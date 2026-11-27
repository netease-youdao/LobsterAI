import { randomUUID } from 'node:crypto';

import {
  CoworkMessageEditPhase,
  type CoworkMessageEditRequest,
  type CoworkMessageVersionSwitchRequest,
} from '../../../shared/cowork/messageEdit';
import { DSH_SESSION_ID_PREFIX } from '../../../shared/dshEngine/hostConstants';
import type { CoworkMessage, CoworkSessionStatus } from '../../coworkStore';
import { t } from '../../i18n';
import type { CoworkMessageEditOperation, CoworkMessageEditStore } from '../coworkMessageEditStore';
import type { CoworkMessageVersionStore } from '../coworkMessageVersionStore';
import type { CoworkContinueOptions } from './types';

interface DshMessageEditDeps {
  edits: CoworkMessageEditStore;
  versions: CoworkMessageVersionStore;
  getSession: (id: string) => { claudeSessionId?: string | null; status?: CoworkSessionStatus } | null | undefined;
  latestUser: (id: string) => CoworkMessage | null;
  isRunning: (id: string) => boolean;
  fork: (id: string, atSeq: number) => Promise<string>;
  send: (id: string, prompt: string, options: CoworkContinueOptions) => Promise<void>;
  bindingChanged: (id: string) => void;
}

export class DshMessageEditCoordinator {
  private readonly lockedSessions = new Set<string>();

  constructor(private readonly deps: DshMessageEditDeps) {}

  pending(sessionId: string): boolean {
    return this.lockedSessions.has(sessionId) || Boolean(this.deps.edits.pending(sessionId));
  }

  assertCanSend(sessionId: string, requestId?: string): void {
    const pending = this.deps.edits.pending(sessionId);
    if ((pending || this.lockedSessions.has(sessionId)) && (!requestId || pending?.runId !== requestId)) {
      throw new Error(t('coworkEditRecoveryNeeded'));
    }
  }

  private idleSession(sessionId: string) {
    const session = this.deps.getSession(sessionId);
    if (!session) throw new Error(t('coworkEditUnsupported'));
    if (this.lockedSessions.has(sessionId) || session.status === 'running' || this.deps.isRunning(sessionId)) {
      throw new Error(t('coworkEditBusy'));
    }
    return session;
  }

  async edit(request: CoworkMessageEditRequest, options: CoworkContinueOptions): Promise<void> {
    const { sessionId, messageId, prompt, removedImageIndexes } = request;
    const session = this.idleSession(sessionId);
    const { edits } = this.deps;
    if (edits.pending(sessionId)) throw new Error(t('coworkEditRecoveryNeeded'));

    this.lockedSessions.add(sessionId);
    let operation: CoworkMessageEditOperation | undefined;
    try {
      const originalSessionId = session.claudeSessionId ?? null;
      const atSeq = originalSessionId?.startsWith(DSH_SESSION_ID_PREFIX)
        ? edits.getDshForkSequence(sessionId, messageId, originalSessionId)
        : undefined;
      // Legacy and inherited messages can resume through the existing local-history bridge.
      const forkedSessionId = atSeq === undefined ? null : await this.deps.fork(sessionId, atSeq);
      operation = {
        operationId: randomUUID(),
        sessionId,
        sessionKey: '',
        messageId,
        prompt,
        removedImageIndexes,
        phase: CoworkMessageEditPhase.Prepared,
        runId: randomUUID(),
        prefixEntryIds: [],
        dsh: { originalSessionId, forkedSessionId },
      };
      edits.prepare(operation);
      edits.truncate(operation);
      this.deps.bindingChanged(sessionId);
      await this.sendReplacement(operation, options);
    } catch (error) {
      const pending = edits.pending(sessionId);
      if (operation && pending?.operationId === operation.operationId) {
        if (pending.phase === CoworkMessageEditPhase.Prepared) edits.cancelPrepared(pending);
        else edits.restore(pending);
        this.deps.bindingChanged(sessionId);
      }
      throw error;
    } finally {
      this.lockedSessions.delete(sessionId);
    }
  }

  private sendReplacement(operation: CoworkMessageEditOperation, options: CoworkContinueOptions): Promise<void> {
    const { sessionId, prompt } = operation;
    return new Promise<void>((resolve, reject) => {
      let accepted = false;
      void this.deps.send(sessionId, prompt, {
        ...options,
        requestId: operation.runId,
        onAccepted: () => {
          const head = this.deps.latestUser(sessionId);
          if (!head) throw new Error(t('coworkEditFailed'));
          this.deps.versions.recordDshEdit(operation, head.id);
          accepted = true;
          resolve();
        },
      }).then(() => {
        if (!accepted) reject(new Error(t('coworkEditFailed')));
      }, error => {
        if (!accepted) reject(error);
        else console.warn('[CoworkEdit] Accepted replacement encountered a turn error:', error);
      });
    });
  }

  recover(sessionId: string, operationId: string): void {
    this.idleSession(sessionId);
    const operation = this.deps.edits.pending(sessionId);
    if (operation?.operationId !== operationId) throw new Error(t('coworkEditChanged'));
    this.deps.edits.restore(operation);
    this.deps.bindingChanged(sessionId);
  }

  switchVersion({ sessionId, messageId, targetIndex }: CoworkMessageVersionSwitchRequest): string {
    this.idleSession(sessionId);
    if (this.deps.edits.pending(sessionId)) throw new Error(t('coworkEditRecoveryNeeded'));
    const head = this.deps.versions.switchDshVersion(sessionId, messageId, targetIndex);
    this.deps.bindingChanged(sessionId);
    return head;
  }
}
