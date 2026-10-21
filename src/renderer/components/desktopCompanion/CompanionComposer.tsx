import type { CoworkBrowserAnnotationMessageBatch } from '@shared/cowork/browserAnnotations';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { buildSessionTitleFromInput } from '../../../common/sessionTitle';
import { PromptAnalyticsSurface } from '../../../shared/analytics/constants';
import type { CoworkSelectedTextSnippet } from '../../../shared/cowork/selectedText';
import { CompanionAnalyticsSource } from '../../../shared/desktopCompanion/analytics';
import {
  DesktopCompanionMainPage,
  DesktopCompanionPanelPlacement,
  DesktopCompanionSize,
  EMPTY_DESKTOP_COMPANION_DRAFT,
} from '../../../shared/desktopCompanion/constants';
import { buildSelectionTaskPrompt } from '../../../shared/desktopCompanion/selectionTaskContext';
import { authService } from '../../services/auth';
import { coworkService } from '../../services/cowork';
import { buildCoworkCapabilitySelection } from '../../services/coworkCapabilitySelection';
import { i18nService } from '../../services/i18n';
import type { RootState } from '../../store';
import { type DraftAttachment, setDraftAttachments, setDraftKitIds, setDraftSkillIds } from '../../store/slices/coworkSlice';
import { clearActiveKits } from '../../store/slices/kitSlice';
import { clearActiveSkills } from '../../store/slices/skillSlice';
import { CoworkCollaborationMode, type CoworkImageAttachment } from '../../types/cowork';
import type { MediaAttachmentRef } from '../../types/mediaGeneration';
import CoworkPromptInput, { type CoworkPromptInputRef } from '../cowork/CoworkPromptInput';
import { buildCoworkStartPlan, COWORK_START_BLOCK_MESSAGE_KEYS, resolveCoworkStartBlock } from '../cowork/coworkStartRequest';
import { useHomeStartContext } from '../cowork/useHomeStartContext';
import Toast, { type ToastEventDetail } from '../Toast';
import { beginCompanionTask } from './analytics';
import { bootstrapCompanionComposer, refreshCompanionComposer } from './companionComposerBootstrap';
import SelectionTaskContextCard from './SelectionTaskContextCard';
import { ComposerExit, useComposerMotion } from './useComposerMotion';
import { useDesktopCompanionState } from './useDesktopCompanionState';
import { useMeasuredSurface } from './useMeasuredSurface';

const t = (key: string) => i18nService.t(key);
/** The composer here starts new tasks, so it shares the home page's draft key. */
const HOME_DRAFT_KEY = '__home__';
const TOAST_MS = 2_200;
const ACTION_TOAST_MS = 6_000;

function isComposerRoom(target: Element | null): boolean {
  return !target || target === document.documentElement || target === document.body
    || (target instanceof HTMLElement && target.dataset.composerRoom === 'true');
}

/**
 * Like the hint bubbles, the card's corner nearest the orb is tight, so it
 * reads as coming out of the character. The context tray is that corner.
 */
const TAIL_CORNER_CLASS: Record<DesktopCompanionPanelPlacement, string> = {
  [DesktopCompanionPanelPlacement.Left]: 'rounded-br-md [&_[data-prompt-context-tray]]:rounded-br-md',
  [DesktopCompanionPanelPlacement.Right]: 'rounded-bl-md [&_[data-prompt-context-tray]]:rounded-bl-md',
  [DesktopCompanionPanelPlacement.Center]: '',
};

/**
 * The desktop companion's quick panel: the home page's own composer in a
 * narrow card beside the orb, or a little below mid-screen when the orb is
 * off. Sending starts a task exactly like the home page does; the card folds
 * into the orb's status strip; recent tasks reopen in a lightweight result card.
 */
export default function CompanionComposer() {
  const api = window.electron.desktopCompanion;
  const dispatch = useDispatch();
  const [ready, setReady] = useState(false);
  const { state: companion } = useDesktopCompanionState();
  const [toast, setToast] = useState<ToastEventDetail | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const cardRef = useRef<HTMLDivElement>(null);
  const motionRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<CoworkPromptInputRef>(null);
  const submittingRef = useRef(false);
  const passThroughRef = useRef<boolean | null>(null);
  const start = useHomeStartContext();
  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const skills = useSelector((state: RootState) => state.skill.skills);
  const activeKitIds = useSelector((state: RootState) => state.kit.activeKitIds);
  const installedKits = useSelector((state: RootState) => state.kit.installedKits);
  const marketplaceKits = useSelector((state: RootState) => state.kit.marketplaceKits);
  const mediaSelection = useSelector((state: RootState) => state.cowork.mediaSelection[HOME_DRAFT_KEY]);
  const homePrompt = useSelector((state: RootState) => state.cowork.draftPrompts[HOME_DRAFT_KEY] ?? '');
  const homeAttachments = useSelector((state: RootState) => state.cowork.draftAttachments[HOME_DRAFT_KEY]);
  const visible = companion?.panelVisible ?? false;
  const selectionContext = companion?.draft.selectionContext;
  const placement = companion?.panelPlacement ?? DesktopCompanionPanelPlacement.Left;
  useMeasuredSurface(cardRef, visible);
  const playExit = useComposerMotion(motionRef, ready && visible, placement, companion?.panelOpenRevision ?? 0);

  const showToast = useCallback((value: string | ToastEventDetail) => {
    const detail = typeof value === 'string' ? { message: value } : value;
    if (!detail.message) return;
    setToast(detail);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), detail.actionLabel && detail.onAction ? ACTION_TOAST_MS : TOAST_MS);
  }, []);

  useEffect(() => {
    let active = true;
    void bootstrapCompanionComposer()
      .catch(error => console.error('[CompanionComposer] failed to load the composer state', error))
      .finally(() => { if (active) setReady(true); });
    const onToast = (event: Event) => showToast((event as CustomEvent<string | ToastEventDetail>).detail);
    window.addEventListener('app:showToast', onToast);
    const stops = [
      window.electron.auth.onSessionChanged(event => { void authService.handleSessionChanged(event); }),
    ];
    return () => {
      active = false;
      window.removeEventListener('app:showToast', onToast);
      stops.forEach(stop => stop());
      clearTimeout(toastTimer.current);
    };
  }, [api, showToast]);

  // Each time the panel opens: catch up with settings changed elsewhere and put the caret in the prompt.
  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      passThroughRef.current = null;
      if (ready) {
        void refreshCompanionComposer().catch(error => console.error('[CompanionComposer] failed to refresh settings', error));
        inputRef.current?.focus();
      }
    }
    wasVisible.current = visible;
  }, [ready, visible]);
  useEffect(() => { if (ready && visible) inputRef.current?.focus(); }, [ready, visible]);

  // A hint or a drop on the orb hands over a prompt or files; take them, then clear the hand-off.
  const homePromptRef = useRef(homePrompt);
  const homeAttachmentsRef = useRef(homeAttachments);
  useEffect(() => { homePromptRef.current = homePrompt; }, [homePrompt]);
  useEffect(() => { homeAttachmentsRef.current = homeAttachments; }, [homeAttachments]);
  const draft = companion?.draft;
  useEffect(() => {
    if (!ready || !draft || (!draft.prompt.trim() && draft.attachments.length === 0)) return;
    if (draft.prompt.trim() && !homePromptRef.current.trim()) inputRef.current?.setValue(draft.prompt, 'template');
    if (draft.attachments.length > 0) {
      const incoming: DraftAttachment[] = draft.attachments.map(file => ({
        path: file.path,
        name: file.name,
        isImage: file.isImage,
        isDirectory: file.isDirectory,
      }));
      const merged = new Map([...(homeAttachmentsRef.current ?? []), ...incoming].map(file => [file.path, file]));
      dispatch(setDraftAttachments({ draftKey: HOME_DRAFT_KEY, attachments: [...merged.values()] }));
    }
    void api.setDraft({ ...EMPTY_DESKTOP_COMPANION_DRAFT, selectionContext: draft.selectionContext });
  }, [api, dispatch, draft, ready]);

  const clearSelectionContext = useCallback(async () => {
    if (!selectionContext) return;
    const current = await api.getState();
    // A newer handoff can arrive while a task is starting; keep that new material.
    if (current.draft.selectionContext?.id === selectionContext.id) {
      await api.setDraft({ ...current.draft, selectionContext: undefined });
    }
  }, [api, selectionContext]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      void playExit(ComposerExit.Dismiss).then(() => api.hidePanel());
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [api, playExit]);

  // The window keeps room around the card for the composer's menus; clicks there reach the app behind.
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const passThrough = isComposerRoom(target);
      if (passThrough === passThroughRef.current) return;
      passThroughRef.current = passThrough;
      api.setPanelPassThrough(passThrough);
    };
    // A fast click can arrive before the pass-through IPC takes effect.
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && isComposerRoom(event.target)) {
        void playExit(ComposerExit.Dismiss).then(() => api.hidePanel());
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [api, playExit]);

  const submit = useCallback(async (
    prompt: string,
    skillPrompt?: string,
    imageAttachments?: CoworkImageAttachment[],
    mediaReferences?: MediaAttachmentRef[],
    selectedTextSnippets?: CoworkSelectedTextSnippet[],
    browserAnnotations?: CoworkBrowserAnnotationMessageBatch[],
    collaborationMode: CoworkCollaborationMode = CoworkCollaborationMode.Default,
  ): Promise<boolean> => {
    if (submittingRef.current) return false;
    submittingRef.current = true;
    const finish = beginCompanionTask(CompanionAnalyticsSource.Panel);
    try {
      const engineStatus = await coworkService.loadOpenClawEngineStatus().catch(() => null);
      const block = resolveCoworkStartBlock({
        blockingQuotaReason: start.blockingQuotaReason,
        engineStatus,
        crossesBillingSide: start.startModel.crossesBillingSide,
      });
      if (block) {
        showToast(t(COWORK_START_BLOCK_MESSAGE_KEYS[block]));
        return false;
      }
      const apiConfig = await coworkService.checkApiConfig().catch(() => null);
      if (apiConfig && !apiConfig.hasConfig) {
        // Signing in or adding a model happens in the main window.
        showToast({ message: t('desktopCompanionNeedsModel'), actionLabel: t('desktopCompanionOpenApp'), onAction: () => { void api.openMain(null); } });
        return false;
      }
      const kitIds = [...activeKitIds];
      const plan = buildCoworkStartPlan({
        prompt: buildSelectionTaskPrompt(prompt, selectionContext, t),
        title: buildSessionTitleFromInput(prompt, t('coworkDefaultSessionTitle')),
        skillPrompt,
        configSystemPrompt: start.config.systemPrompt,
        kitIds,
        capabilities: buildCoworkCapabilitySelection([...activeSkillIds], kitIds, skills, installedKits, marketplaceKits),
        collaborationMode,
        cwd: start.workingDirectory,
        agentId: start.currentAgentId,
        modelRef: start.selectedModelRef,
        modelPresetId: start.selectedModel?.presetId,
        thinkingLevel: start.thinkingLevel,
        imageAttachments,
        mediaSelection,
        mediaReferences,
        selectedTextSnippets,
        browserAnnotations,
      });
      const { session, error } = await coworkService.startSession(plan.options);
      if (!session) {
        showToast(error ? t('coworkErrorSessionStartFailed').replace('{error}', error) : t('desktopCompanionRequestFailed'));
        return false;
      }
      finish(true);
      // Beside the orb, the card folds into the strip the orb shows for the task, in the
      // same spot. With no orb on screen there is no strip, so it just closes.
      await playExit(placement === DesktopCompanionPanelPlacement.Center ? ComposerExit.Dismiss : ComposerExit.Handoff);
      dispatch(clearActiveSkills());
      dispatch(clearActiveKits());
      dispatch(setDraftKitIds({ draftKey: HOME_DRAFT_KEY, kitIds: [] }));
      dispatch(setDraftSkillIds({ draftKey: HOME_DRAFT_KEY, skillIds: [] }));
      await clearSelectionContext().catch(error => console.error('[CompanionComposer] failed to clear selection context', error));
      await api.taskStarted(session.id);
      return true;
    } catch (error) {
      console.error('[CompanionComposer] failed to start a task', error);
      showToast(t('desktopCompanionRequestFailed'));
      return false;
    } finally {
      finish(false);
      submittingRef.current = false;
    }
  }, [activeKitIds, activeSkillIds, api, clearSelectionContext, dispatch, installedKits, marketplaceKits, mediaSelection, placement, playExit, selectionContext, showToast, skills, start]);

  const openSkills = useCallback(() => { void api.openMainPage(DesktopCompanionMainPage.Skills); }, [api]);
  const openKits = useCallback(() => { void api.openMainPage(DesktopCompanionMainPage.Kits); }, [api]);

  // The card sits in the window's corner by the orb; the rest of the window is room for menus.
  const cardAlignClass = placement === DesktopCompanionPanelPlacement.Left ? 'items-end' : 'items-start';

  return (
    <div className={`flex h-full w-full flex-col justify-end ${cardAlignClass}`} data-composer-room="true">
      <div
        ref={cardRef}
        className="relative shrink-0"
        style={{ width: DesktopCompanionSize.Composer.width, margin: DesktopCompanionSize.SurfacePad }}
      >
        {/* The home page's background sits behind its composer; out on the desktop the card brings its own. */}
        <div
          ref={motionRef}
          className={`rounded-2xl bg-surface shadow-popover ring-1 ring-black/10 transition-shadow focus-within:ring-primary/25 dark:ring-white/10 ${TAIL_CORNER_CLASS[placement]}`}
        >
          {selectionContext && (
            <SelectionTaskContextCard
              key={selectionContext.id}
              context={selectionContext}
              onRemove={() => {
                void clearSelectionContext().then(() => inputRef.current?.focus())
                  .catch(() => showToast(t('desktopCompanionRequestFailed')));
              }}
            />
          )}
          <CoworkPromptInput
            analyticsSurface={PromptAnalyticsSurface.DesktopCompanion}
            ref={inputRef}
            onSubmit={submit}
            placeholder={t(selectionContext ? 'desktopCompanionTaskContextPlaceholder' : 'coworkPlaceholder')}
            disabled={!ready}
            size="large"
            narrow
            workingDirectory={start.workingDirectory}
            showModelSelector
            showAgentSelector
            onLoginPromptVisibilityChange={api.setPanelLoginVisible}
            onManageSkills={openSkills}
            onManageKits={openKits}
            onGoalCommand={command => submit(command)}
          />
        </div>
        {toast && (
          <Toast
            contained
            message={toast.message}
            actionLabel={toast.actionLabel}
            onAction={toast.onAction}
            closeLabel={t('close')}
            onClose={() => setToast(null)}
          />
        )}
      </div>
    </div>
  );
}
