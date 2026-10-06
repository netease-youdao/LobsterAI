import { formatCoworkImageAttachmentLimit } from '../../shared/cowork/imageAttachments';
import {
  type CoworkPendingSteer,
  CoworkSteerRejectReason,
  CoworkSteerStatus,
} from '../../shared/cowork/steer';
import { buildCoworkContinuationSystemPrompt } from '../components/cowork/skillSystemPrompt';
import type { AppDispatch, RootState } from '../store';
import {
  removePendingSteer,
  setDraftKitIds,
  setDraftSkillIds,
  updateSteerStatus,
} from '../store/slices/coworkSlice';
import { clearActiveKits } from '../store/slices/kitSlice';
import { clearActiveSkills } from '../store/slices/skillSlice';
import type { CoworkContinueOptions, CoworkSessionStatus } from '../types/cowork';
import { CoworkSessionStatusValue } from '../types/cowork';
import {
  CoworkPromptPayloadFailureCode,
  prepareCoworkPromptPayload,
} from './coworkPromptPayload';
import { i18nService } from './i18n';
import { selectQueuedFollowUp } from './queuedFollowUpSelection';

export const CoworkQueuedFollowUpTrigger = {
  Completed: 'completed',
  Interrupted: 'interrupted',
  IdleClick: 'idle_click',
} as const;
export type CoworkQueuedFollowUpTrigger =
  typeof CoworkQueuedFollowUpTrigger[keyof typeof CoworkQueuedFollowUpTrigger];

interface CoworkQueuedFollowUpCoordinatorDependencies {
  getState: () => RootState;
  dispatch: AppDispatch;
  continueSession: (options: CoworkContinueOptions) => Promise<boolean>;
  stopSession: (sessionId: string) => Promise<boolean>;
  log: (level: 'debug' | 'warn' | 'error', message: string, error?: unknown) => void;
  preparePromptPayload?: typeof prepareCoworkPromptPayload;
}

interface QueuedFollowUpOperation {
  steerId: string;
  cancelled: boolean;
}

export const isQueuedSteerAccountCurrent = (
  queuedSteer: Pick<CoworkPendingSteer, 'ownerAccountKey' | 'accountGeneration'>,
  authState: Pick<RootState['auth'], 'ownerAccountKey' | 'accountGeneration'>,
): boolean => (
  queuedSteer.ownerAccountKey === authState.ownerAccountKey
  && queuedSteer.accountGeneration === authState.accountGeneration
);

export class CoworkQueuedFollowUpCoordinator {
  private readonly inFlightBySessionId = new Map<string, QueuedFollowUpOperation>();
  private readonly startingQueuedTurnSessionIds = new Set<string>();
  private readonly interruptingBySessionId = new Map<string, QueuedFollowUpOperation>();

  constructor(private readonly dependencies: CoworkQueuedFollowUpCoordinatorDependencies) {}

  handleSessionRunning(sessionId: string): void {
    if (!this.startingQueuedTurnSessionIds.delete(sessionId)) return;
    this.dependencies.log(
      'debug',
      `queued follow-up turn entered running state; session=${sessionId}.`,
    );
  }

  handleSessionCompleted(sessionId: string): void {
    if (this.interruptingBySessionId.has(sessionId)) {
      this.dependencies.log(
        'debug',
        `ignored completion while a queued follow-up interrupt is pending; session=${sessionId}.`,
      );
      return;
    }
    if (this.startingQueuedTurnSessionIds.has(sessionId)) {
      this.dependencies.log(
        'debug',
        `ignored stale completion while a queued follow-up turn is starting; session=${sessionId}.`,
      );
      return;
    }
    void this.submit(sessionId, undefined, CoworkQueuedFollowUpTrigger.Completed);
  }

  handleSessionError(sessionId: string): void {
    this.startingQueuedTurnSessionIds.delete(sessionId);
  }

  handleSessionIdle(sessionId: string): void {
    this.startingQueuedTurnSessionIds.delete(sessionId);
  }

  clearSession(sessionId: string): void {
    const inFlight = this.inFlightBySessionId.get(sessionId);
    if (inFlight) inFlight.cancelled = true;
    const interrupting = this.interruptingBySessionId.get(sessionId);
    if (interrupting) interrupting.cancelled = true;
    this.inFlightBySessionId.delete(sessionId);
    this.startingQueuedTurnSessionIds.delete(sessionId);
    this.interruptingBySessionId.delete(sessionId);
  }

  submitSelected(sessionId: string, steerId: string): Promise<boolean> {
    if (this.getSessionStatus(sessionId) === CoworkSessionStatusValue.Running) {
      this.dependencies.log(
        'debug',
        `rerouted queued follow-up click through active-turn interruption; `
        + `session=${sessionId}; id=${steerId}.`,
      );
      return this.interruptAndSubmit(sessionId, steerId);
    }
    return this.submit(sessionId, steerId, CoworkQueuedFollowUpTrigger.IdleClick);
  }

  async interruptAndSubmit(sessionId: string, steerId: string): Promise<boolean> {
    const sessionStatus = this.getSessionStatus(sessionId);
    if (sessionStatus && sessionStatus !== CoworkSessionStatusValue.Running) {
      this.dependencies.log(
        'debug',
        `submitted queued follow-up without interruption because the session is no longer running; `
        + `session=${sessionId}; id=${steerId}; status=${sessionStatus}.`,
      );
      return this.submit(sessionId, steerId, CoworkQueuedFollowUpTrigger.IdleClick);
    }
    if (this.interruptingBySessionId.has(sessionId) || this.inFlightBySessionId.has(sessionId)) {
      this.dependencies.log(
        'debug',
        `ignored duplicate queued follow-up interrupt; session=${sessionId}; id=${steerId}.`,
      );
      return false;
    }

    const queuedSteer = selectQueuedFollowUp(
      this.dependencies.getState().cowork.pendingSteers[sessionId] ?? [],
      steerId,
    );
    if (!queuedSteer) {
      this.dependencies.log(
        'warn',
        `ignored queued follow-up interrupt because the item is missing; session=${sessionId}; id=${steerId}.`,
      );
      return false;
    }
    if (!this.isQueuedSteerCurrent(queuedSteer)) {
      this.removeQueuedSteerIfUnchanged(queuedSteer);
      this.dependencies.log(
        'warn',
        `discarded queued follow-up interrupt because the authenticated account changed; `
        + `session=${sessionId}; id=${steerId}.`,
      );
      return false;
    }

    const operation: QueuedFollowUpOperation = { steerId, cancelled: false };
    this.interruptingBySessionId.set(sessionId, operation);
    try {
      const stopped = await this.dependencies.stopSession(sessionId);
      if (
        !stopped
        || operation.cancelled
        || !this.isQueuedSteerCurrent(queuedSteer)
      ) {
        if (!this.isQueuedSteerCurrent(queuedSteer)) {
          this.removeQueuedSteerIfUnchanged(queuedSteer);
        }
        return false;
      }
      return await this.submit(sessionId, steerId, CoworkQueuedFollowUpTrigger.Interrupted);
    } catch (error) {
      this.dependencies.log(
        'error',
        `failed to interrupt the active turn for a queued follow-up; `
        + `session=${sessionId}; id=${steerId}.`,
        error,
      );
      return false;
    } finally {
      if (this.interruptingBySessionId.get(sessionId) === operation) {
        this.interruptingBySessionId.delete(sessionId);
      }
    }
  }

  private async submit(
    sessionId: string,
    requestedSteerId: string | undefined,
    trigger: CoworkQueuedFollowUpTrigger,
  ): Promise<boolean> {
    if (this.inFlightBySessionId.has(sessionId)) {
      this.dependencies.log(
        'debug',
        `ignored queued follow-up submit because another item is in flight; `
        + `session=${sessionId}; activeId=${this.inFlightBySessionId.get(sessionId)?.steerId}.`,
      );
      return false;
    }

    const state = this.dependencies.getState();
    const queuedSteer = selectQueuedFollowUp(
      state.cowork.pendingSteers[sessionId] ?? [],
      requestedSteerId,
    );
    if (!queuedSteer) {
      if (requestedSteerId) {
        this.dependencies.log(
          'warn',
          `ignored queued follow-up submit because the item is missing; `
          + `session=${sessionId}; id=${requestedSteerId}; trigger=${trigger}.`,
        );
      }
      return false;
    }
    if (!this.isQueuedSteerCurrent(queuedSteer)) {
      this.removeQueuedSteerIfUnchanged(queuedSteer);
      this.dependencies.log(
        'warn',
        `discarded queued follow-up because the authenticated account changed; `
        + `session=${sessionId}; id=${queuedSteer.id}; trigger=${trigger}.`,
      );
      return false;
    }

    const operation: QueuedFollowUpOperation = {
      steerId: queuedSteer.id,
      cancelled: false,
    };
    this.inFlightBySessionId.set(sessionId, operation);
    this.dependencies.log(
      'debug',
      `preparing queued follow-up; session=${sessionId}; id=${queuedSteer.id}; `
      + `trigger=${trigger}; attachments=${queuedSteer.attachments?.length ?? 0}.`,
    );

    try {
      const preparePayload = this.dependencies.preparePromptPayload ?? prepareCoworkPromptPayload;
      const prepared = await preparePayload({
        basePrompt: queuedSteer.text,
        attachments: queuedSteer.attachments ?? [],
        selectedTextSnippets: queuedSteer.selectedTextSnippets ?? [],
        modelSupportsImage: queuedSteer.modelSupportsImage === true,
        readFileAsDataUrl: async (path) => {
          try {
            const result = await window.electron.dialog.readFileAsDataUrl(path);
            if (!result.success || !result.dataUrl) {
              this.dependencies.log(
                'warn',
                `could not rehydrate queued image attachment; `
                + `session=${sessionId}; id=${queuedSteer.id}; path=${path}.`,
              );
            }
            return result;
          } catch (error) {
            this.dependencies.log(
              'warn',
              `queued image attachment rehydration failed; `
              + `session=${sessionId}; id=${queuedSteer.id}; path=${path}.`,
              error,
            );
            throw error;
          }
        },
        fileLabel: i18nService.t('inputFileLabel'),
        folderLabel: i18nService.t('inputFolderLabel'),
      });
      if (operation.cancelled) {
        this.dependencies.log(
          'debug',
          `cancelled queued follow-up because its session was cleared during preparation; `
          + `session=${sessionId}; id=${queuedSteer.id}.`,
        );
        return false;
      }
      if (!this.isQueuedSteerCurrent(queuedSteer)) {
        this.removeQueuedSteerIfUnchanged(queuedSteer);
        this.dependencies.log(
          'warn',
          `discarded queued follow-up because the authenticated account changed during preparation; `
          + `session=${sessionId}; id=${queuedSteer.id}.`,
        );
        return false;
      }
      if (!prepared.success) {
        this.rejectPreparationFailure(queuedSteer, prepared.failure);
        return false;
      }

      const stillQueued = selectQueuedFollowUp(
        this.dependencies.getState().cowork.pendingSteers[sessionId] ?? [],
        queuedSteer.id,
      );
      if (!stillQueued) {
        this.dependencies.log(
          'warn',
          `cancelled queued follow-up submit because the item was removed during preparation; `
          + `session=${sessionId}; id=${queuedSteer.id}.`,
        );
        return false;
      }
      if (
        stillQueued.ownerAccountKey !== queuedSteer.ownerAccountKey
        || stillQueued.accountGeneration !== queuedSteer.accountGeneration
        || !this.isQueuedSteerCurrent(queuedSteer)
      ) {
        this.removeQueuedSteerIfUnchanged(queuedSteer);
        return false;
      }

      this.startingQueuedTurnSessionIds.add(sessionId);
      const sent = await this.dependencies.continueSession({
        sessionId,
        prompt: prepared.payload.finalPrompt,
        systemPrompt: buildCoworkContinuationSystemPrompt(
          queuedSteer.skillPrompt,
          this.dependencies.getState().cowork.config.systemPrompt,
        ),
        activeSkillIds: queuedSteer.activeSkillIds,
        runtimeSkillIds: queuedSteer.runtimeSkillIds,
        kitIds: queuedSteer.kitIds,
        kitReferences: queuedSteer.kitReferences,
        resolvedKitCapabilities: queuedSteer.resolvedKitCapabilities,
        imageAttachments: prepared.payload.imageAttachments,
        mediaSelection: queuedSteer.mediaSelection,
        mediaReferences: prepared.payload.mediaReferences,
        selectedTextSnippets: prepared.payload.selectedTextSnippets,
        browserAnnotations: queuedSteer.browserAnnotations,
      });
      if (operation.cancelled || !this.isQueuedSteerCurrent(queuedSteer)) {
        this.startingQueuedTurnSessionIds.delete(sessionId);
        if (!this.isQueuedSteerCurrent(queuedSteer)) {
          this.removeQueuedSteerIfUnchanged(queuedSteer);
        }
        return false;
      }
      if (!sent) {
        this.startingQueuedTurnSessionIds.delete(sessionId);
        this.dependencies.dispatch(updateSteerStatus({
          sessionId,
          steerId: queuedSteer.id,
          status: CoworkSteerStatus.Rejected,
          error: i18nService.t('coworkSteerRejected'),
          reason: CoworkSteerRejectReason.RuntimeRejected,
        }));
        return false;
      }

      this.dependencies.dispatch(removePendingSteer({ sessionId, steerId: queuedSteer.id }));
      if ((queuedSteer.selectedSkillIds?.length ?? 0) > 0 || (queuedSteer.kitIds?.length ?? 0) > 0) {
        this.dependencies.dispatch(setDraftSkillIds({ draftKey: sessionId, skillIds: [] }));
        this.dependencies.dispatch(setDraftKitIds({ draftKey: sessionId, kitIds: [] }));
        if (this.dependencies.getState().cowork.currentSession?.id === sessionId) {
          this.dependencies.dispatch(clearActiveSkills());
          this.dependencies.dispatch(clearActiveKits());
        }
      }
      this.dependencies.log(
        'debug',
        `submitted queued follow-up; session=${sessionId}; id=${queuedSteer.id}; trigger=${trigger}.`,
      );
      return true;
    } catch (error) {
      this.startingQueuedTurnSessionIds.delete(sessionId);
      this.dependencies.log(
        'error',
        `failed to submit queued follow-up; session=${sessionId}; id=${queuedSteer.id}; trigger=${trigger}.`,
        error,
      );
      if (!this.isQueuedSteerCurrent(queuedSteer)) {
        this.removeQueuedSteerIfUnchanged(queuedSteer);
        return false;
      }
      this.dependencies.dispatch(updateSteerStatus({
        sessionId,
        steerId: queuedSteer.id,
        status: CoworkSteerStatus.Rejected,
        error: error instanceof Error ? error.message : i18nService.t('coworkSteerRejected'),
        reason: CoworkSteerRejectReason.Unknown,
      }));
      return false;
    } finally {
      if (this.inFlightBySessionId.get(sessionId) === operation) {
        this.inFlightBySessionId.delete(sessionId);
      }
    }
  }

  private getSessionStatus(sessionId: string): CoworkSessionStatus | undefined {
    const state = this.dependencies.getState().cowork;
    if (state.currentSession?.id === sessionId) {
      return state.currentSession.status;
    }
    return state.sessions.find(session => session.id === sessionId)?.status;
  }

  private isQueuedSteerCurrent(queuedSteer: CoworkPendingSteer): boolean {
    return isQueuedSteerAccountCurrent(
      queuedSteer,
      this.dependencies.getState().auth,
    );
  }

  private removeQueuedSteerIfUnchanged(queuedSteer: CoworkPendingSteer): void {
    const current = selectQueuedFollowUp(
      this.dependencies.getState().cowork.pendingSteers[queuedSteer.sessionId] ?? [],
      queuedSteer.id,
    );
    if (
      !current
      || current.ownerAccountKey !== queuedSteer.ownerAccountKey
      || current.accountGeneration !== queuedSteer.accountGeneration
    ) {
      return;
    }
    this.dependencies.dispatch(removePendingSteer({
      sessionId: queuedSteer.sessionId,
      steerId: queuedSteer.id,
    }));
  }

  private rejectPreparationFailure(
    queuedSteer: CoworkPendingSteer,
    failure: { code: string; attachmentName: string; maxBytes?: number },
  ): void {
    const error = failure.code === CoworkPromptPayloadFailureCode.ImageTooLarge
      ? i18nService.t('coworkImageAttachmentTooLarge')
        .replace('{name}', failure.attachmentName)
        .replace('{limit}', formatCoworkImageAttachmentLimit(failure.maxBytes))
      : i18nService.t('coworkImageAttachmentPreviewFailed')
        .replace('{name}', failure.attachmentName);
    this.dependencies.dispatch(updateSteerStatus({
      sessionId: queuedSteer.sessionId,
      steerId: queuedSteer.id,
      status: CoworkSteerStatus.Rejected,
      error,
      reason: CoworkSteerRejectReason.Unknown,
    }));
    this.dependencies.log(
      'warn',
      `rejected queued follow-up during payload preparation; `
      + `session=${queuedSteer.sessionId}; id=${queuedSteer.id}; code=${failure.code}.`,
    );
  }
}
