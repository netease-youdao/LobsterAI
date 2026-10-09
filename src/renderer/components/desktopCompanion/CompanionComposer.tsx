import type { CoworkBrowserAnnotationMessageBatch } from '@shared/cowork/browserAnnotations';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { buildSessionTitleFromInput } from '../../../common/sessionTitle';
import type { CoworkSelectedTextSnippet } from '../../../shared/cowork/selectedText';
import {
  DesktopCompanionSize,
  type DesktopCompanionState,
  EMPTY_DESKTOP_COMPANION_DRAFT,
} from '../../../shared/desktopCompanion/constants';
import { agentService } from '../../services/agent';
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
import { bootstrapCompanionComposer, refreshCompanionComposer } from './companionComposerBootstrap';
import { useMeasuredSurface } from './useMeasuredSurface';

const t = (key: string) => i18nService.t(key);
/** The composer here starts new tasks, so it shares the home page's draft key. */
const HOME_DRAFT_KEY = '__home__';
const TOAST_MS = 2_200;
const ACTION_TOAST_MS = 6_000;

/**
 * The desktop companion's quick panel: the home page's own composer, opened
 * beside the orb. Sending starts a task exactly like the home page does; the
 * orb then follows it and the result opens in the main window.
 */
export default function CompanionComposer() {
  const api = window.electron.desktopCompanion;
  const dispatch = useDispatch();
  const [ready, setReady] = useState(false);
  const [companion, setCompanion] = useState<DesktopCompanionState | null>(null);
  const [toast, setToast] = useState<ToastEventDetail | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const cardRef = useRef<HTMLDivElement>(null);
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
  useMeasuredSurface(cardRef, visible);

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
    void api.getState().then(state => { if (active) setCompanion(state); });
    const onToast = (event: Event) => showToast((event as CustomEvent<string | ToastEventDetail>).detail);
    window.addEventListener('app:showToast', onToast);
    const stops = [
      api.onChanged(setCompanion),
      window.electron.auth.onSessionChanged(() => { void authService.refreshAuthState({ clearOnFailure: false }); }),
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
    void api.setDraft(EMPTY_DESKTOP_COMPANION_DRAFT);
  }, [api, dispatch, draft, ready]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      void api.hidePanel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [api]);

  // The window keeps room above the card for the composer's menus; clicks there reach the app behind.
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const passThrough = !target || target === document.documentElement || target === document.body
        || (target instanceof HTMLElement && target.dataset.composerRoom === 'true');
      if (passThrough === passThroughRef.current) return;
      passThroughRef.current = passThrough;
      api.setPanelPassThrough(passThrough);
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [api]);

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
        prompt,
        title: buildSessionTitleFromInput(prompt, t('coworkDefaultSessionTitle')),
        skillPrompt,
        configSystemPrompt: start.config.systemPrompt,
        kitIds,
        capabilities: buildCoworkCapabilitySelection([...activeSkillIds], kitIds, skills, installedKits, marketplaceKits),
        collaborationMode,
        cwd: start.workingDirectory,
        agentId: start.currentAgentId,
        modelRef: start.selectedModelRef,
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
      dispatch(clearActiveSkills());
      dispatch(clearActiveKits());
      dispatch(setDraftKitIds({ draftKey: HOME_DRAFT_KEY, kitIds: [] }));
      dispatch(setDraftSkillIds({ draftKey: HOME_DRAFT_KEY, skillIds: [] }));
      await api.taskStarted(session.id);
      return true;
    } catch (error) {
      console.error('[CompanionComposer] failed to start a task', error);
      showToast(t('desktopCompanionRequestFailed'));
      return false;
    } finally {
      submittingRef.current = false;
    }
  }, [activeKitIds, activeSkillIds, api, dispatch, installedKits, marketplaceKits, mediaSelection, showToast, skills, start]);

  const openMain = useCallback(() => { void api.openMain(null); }, [api]);

  return (
    <div className="flex h-full w-full flex-col justify-end" data-composer-room="true">
      {/* The home page's background sits behind its composer; out on the desktop the card brings its own. */}
      <div
        ref={cardRef}
        className="rounded-3xl bg-background shadow-popover ring-1 ring-black/5 dark:ring-white/10"
        style={{ width: DesktopCompanionSize.Composer.width, margin: DesktopCompanionSize.SurfacePad }}
      >
        <CoworkPromptInput
          ref={inputRef}
          onSubmit={submit}
          placeholder={t('coworkPlaceholder')}
          disabled={!ready}
          size="large"
          workingDirectory={start.workingDirectory}
          onWorkingDirectoryChange={async (dir: string) => {
            await agentService.updateAgent(start.currentAgentId, { workingDirectory: dir });
          }}
          showFolderSelector
          showModelSelector
          showAgentSelector
          onManageSkills={openMain}
          onManageKits={openMain}
          onGoalCommand={command => submit(command)}
        />
      </div>
      {toast && (
        <Toast
          message={toast.message}
          actionLabel={toast.actionLabel}
          onAction={toast.onAction}
          closeLabel={t('close')}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  );
}
