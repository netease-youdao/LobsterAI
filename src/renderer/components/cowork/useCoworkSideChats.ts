import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import {
  normalizeCoworkBtwQuestion,
  resolveCoworkBtwSelectedTextSnippets,
} from '../../../shared/cowork/btw';
import { COWORK_TEMP_SESSION_ID_PREFIX } from '../../../shared/cowork/constants';
import { formatCoworkImageAttachmentLimit } from '../../../shared/cowork/imageAttachments';
import type { CoworkSelectedTextSnippet } from '../../../shared/cowork/selectedText';
import {
  type CoworkSideChat,
  type CoworkSideChatPermissionRequest,
  type CoworkSideChatPermissionResult,
  CoworkSideChatStatus,
  type CoworkSideChatSummary,
} from '../../../shared/cowork/sideChat';
import { coworkService } from '../../services/cowork';
import {
  CoworkPromptPayloadFailureCode,
  prepareCoworkPromptPayload,
} from '../../services/coworkPromptPayload';
import { coworkSideChatService } from '../../services/coworkSideChat';
import { i18nService } from '../../services/i18n';
import type { AppDispatch, RootState } from '../../store';
import {
  activateArtifactSideChatTab,
  ArtifactSpecialTab,
} from '../../store/slices/artifactSlice';
import type { DraftAttachment } from '../../store/slices/coworkSlice';
import {
  addSideChatAttachment,
  closeSideChatTab,
  openSideChatTab,
  removeSideChatAttachment,
  setActiveSideChatTab,
  setSideChatDraft,
  setSideChatModelSelection,
  setSideChatSelectedTextSnippets,
  type SideChatModelSelection,
} from '../../store/slices/sideChatSlice';
import { SELECTED_TEXT_ERROR_I18N_KEYS } from './artifactPanelChrome';

const EMPTY_SUMMARIES: CoworkSideChatSummary[] = [];
const EMPTY_TAB_IDS: string[] = [];
const EMPTY_SNIPPETS: CoworkSelectedTextSnippet[] = [];
const EMPTY_ATTACHMENTS: DraftAttachment[] = [];
const EMPTY_PERMISSIONS: CoworkSideChatPermissionRequest[] = [];

export interface OpenSideChatTabItem {
  id: string;
  summary: CoworkSideChatSummary;
  unread: boolean;
}

export interface UseCoworkSideChatsOptions {
  sessionId: string | undefined;
  isPanelOpen: boolean;
  activeSpecialPreviewTab: ArtifactSpecialTab;
  hasActiveArtifactPreviewTab: boolean;
  setSessionActiveSpecialPreviewTab: (tab: ArtifactSpecialTab) => void;
  setSessionNewTabPreviewTabOpen: (open: boolean) => void;
  onFallbackAfterClose: () => void;
}

const showToast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

export function useCoworkSideChats({
  sessionId,
  isPanelOpen,
  activeSpecialPreviewTab,
  hasActiveArtifactPreviewTab,
  setSessionActiveSpecialPreviewTab,
  setSessionNewTabPreviewTabOpen,
  onFallbackAfterClose,
}: UseCoworkSideChatsOptions) {
  const dispatch = useDispatch<AppDispatch>();
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);
  const [promotingSideChatId, setPromotingSideChatId] = useState<string | null>(null);

  const summaries = useSelector((state: RootState) => (
    sessionId ? state.sideChat.summariesByParent[sessionId] ?? EMPTY_SUMMARIES : EMPTY_SUMMARIES
  ));
  const openTabIds = useSelector((state: RootState) => (
    sessionId ? state.sideChat.openTabIdsByParent[sessionId] ?? EMPTY_TAB_IDS : EMPTY_TAB_IDS
  ));
  const activeSideChatId = useSelector((state: RootState) => {
    if (!sessionId) return null;
    const active = state.sideChat.activeTabIdByParent[sessionId];
    if (active) return active;
    const openIds = state.sideChat.openTabIdsByParent[sessionId];
    return openIds && openIds.length > 0 ? openIds[openIds.length - 1] : null;
  });
  const entitiesById = useSelector((state: RootState) => state.sideChat.entitiesById);
  const unreadById = useSelector((state: RootState) => state.sideChat.unreadById);
  const activeSideChat: CoworkSideChat | null = activeSideChatId
    ? entitiesById[activeSideChatId] ?? null
    : null;
  const activeDraft = useSelector((state: RootState) => (
    activeSideChatId ? state.sideChat.draftById[activeSideChatId] ?? '' : ''
  ));
  const activeSelectedTextSnippets = useSelector((state: RootState) => (
    activeSideChatId
      ? state.sideChat.selectedTextSnippetsById[activeSideChatId] ?? EMPTY_SNIPPETS
      : EMPTY_SNIPPETS
  ));
  const activeAttachments = useSelector((state: RootState) => (
    activeSideChatId
      ? state.sideChat.attachmentsById[activeSideChatId] ?? EMPTY_ATTACHMENTS
      : EMPTY_ATTACHMENTS
  ));
  const activeModelSelection = useSelector((state: RootState) => (
    activeSideChatId
      ? state.sideChat.modelSelectionById[activeSideChatId] ?? null
      : null
  ));
  const activePendingPermissions = useSelector((state: RootState) => (
    activeSideChatId
      ? state.sideChat.pendingPermissionsById[activeSideChatId] ?? EMPTY_PERMISSIONS
      : EMPTY_PERMISSIONS
  ));

  useEffect(() => {
    coworkSideChatService.initListeners();
    if (!sessionId || sessionId.startsWith(COWORK_TEMP_SESSION_ID_PREFIX)) return;
    void coworkSideChatService.loadList(sessionId);
  }, [sessionId]);

  useEffect(() => {
    if (!activeSideChatId || entitiesById[activeSideChatId]) return;
    let cancelled = false;
    setLoadingDetailId(activeSideChatId);
    void coworkSideChatService.loadDetail(activeSideChatId).finally(() => {
      if (!cancelled) {
        setLoadingDetailId((current) => (current === activeSideChatId ? null : current));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeSideChatId, entitiesById]);

  const isSideChatViewVisible = Boolean(
    sessionId
    && activeSideChatId
    && isPanelOpen
    && !hasActiveArtifactPreviewTab
    && activeSpecialPreviewTab === ArtifactSpecialTab.SideChat,
  );

  useEffect(() => {
    if (!sessionId || !activeSideChatId || !isSideChatViewVisible) return;
    if (unreadById[activeSideChatId]) {
      dispatch(setActiveSideChatTab({ parentSessionId: sessionId, sideChatId: activeSideChatId }));
    }
  }, [activeSideChatId, dispatch, isSideChatViewVisible, sessionId, unreadById]);

  const openSideChatTabs = useMemo<OpenSideChatTabItem[]>(() => {
    const summaryMap = new Map(summaries.map((item) => [item.id, item]));
    const items: OpenSideChatTabItem[] = [];
    for (const id of openTabIds) {
      const summary = summaryMap.get(id) ?? entitiesById[id];
      if (!summary) continue;
      items.push({
        id,
        summary,
        unread: Boolean(unreadById[id]),
      });
    }
    return items;
  }, [entitiesById, openTabIds, summaries, unreadById]);

  const isSideChatPreviewTabOpen = openSideChatTabs.length > 0;
  // The currently unclosed side chat tab to continue until the user explicitly closes it.
  const reusableOpenSideChatId = openSideChatTabs.some((tab) => tab.id === activeSideChatId)
    ? activeSideChatId
    : openSideChatTabs[openSideChatTabs.length - 1]?.id ?? null;

  const activateSideChatTab = useCallback((sideChatId: string) => {
    if (!sessionId) return;
    dispatch(openSideChatTab({ parentSessionId: sessionId, sideChatId, activate: true }));
    setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.SideChat);
    dispatch(activateArtifactSideChatTab({ sessionId }));
  }, [dispatch, sessionId, setSessionActiveSpecialPreviewTab]);

  const openExistingSideChat = useCallback((sideChatId: string, options?: { fromNewTab?: boolean }) => {
    if (!sessionId) return;
    if (options?.fromNewTab) {
      setSessionNewTabPreviewTabOpen(false);
    }
    dispatch(openSideChatTab({ parentSessionId: sessionId, sideChatId, activate: true }));
    setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.SideChat);
    dispatch(activateArtifactSideChatTab({ sessionId }));
    if (!entitiesById[sideChatId]) {
      void coworkSideChatService.loadDetail(sideChatId);
    }
  }, [dispatch, entitiesById, sessionId, setSessionActiveSpecialPreviewTab, setSessionNewTabPreviewTabOpen]);

  const openNewSideChat = useCallback(async (options?: {
    forkedFromMessageId?: string | null;
    initialSnippets?: CoworkSelectedTextSnippet[];
    title?: string;
    fromNewTab?: boolean;
  }): Promise<CoworkSideChat | null> => {
    if (!sessionId || sessionId.startsWith(COWORK_TEMP_SESSION_ID_PREFIX)) return null;
    const created = await coworkSideChatService.createSideChat({
      parentSessionId: sessionId,
      title: options?.title,
      forkedFromMessageId: options?.forkedFromMessageId ?? null,
      initialSnippets: options?.initialSnippets,
      openTab: true,
    });
    if (!created) return null;
    if (options?.fromNewTab) {
      setSessionNewTabPreviewTabOpen(false);
    }
    setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.SideChat);
    dispatch(activateArtifactSideChatTab({ sessionId }));
    return created;
  }, [dispatch, sessionId, setSessionActiveSpecialPreviewTab, setSessionNewTabPreviewTabOpen]);

  const closeSideChatTabById = useCallback((sideChatId: string) => {
    if (!sessionId) return;
    const wasActive = !hasActiveArtifactPreviewTab
      && activeSpecialPreviewTab === ArtifactSpecialTab.SideChat
      && activeSideChatId === sideChatId;
    const remainingCount = openTabIds.filter((id) => id !== sideChatId).length;
    dispatch(closeSideChatTab({ parentSessionId: sessionId, sideChatId }));
    if (wasActive && remainingCount === 0) {
      onFallbackAfterClose();
    }
  }, [
    activeSideChatId,
    activeSpecialPreviewTab,
    dispatch,
    hasActiveArtifactPreviewTab,
    onFallbackAfterClose,
    openTabIds,
    sessionId,
  ]);

  const openFromSelectedText = useCallback(async (
    snippet: CoworkSelectedTextSnippet,
  ): Promise<{ success: boolean; mode?: 'append' | 'new'; snippets?: CoworkSelectedTextSnippet[]; error?: string }> => {
    if (!sessionId) return { success: false };
    const shouldContinueExisting = Boolean(reusableOpenSideChatId);
    const existingSnippets = shouldContinueExisting ? activeSelectedTextSnippets : [];
    const normalized = resolveCoworkBtwSelectedTextSnippets(
      existingSnippets,
      [snippet],
      shouldContinueExisting,
    );
    if (!normalized.success) {
      showToast(i18nService.t(SELECTED_TEXT_ERROR_I18N_KEYS[normalized.error]));
      return { success: false, error: normalized.error };
    }

    if (shouldContinueExisting && reusableOpenSideChatId) {
      dispatch(setSideChatSelectedTextSnippets({
        sideChatId: reusableOpenSideChatId,
        snippets: normalized.snippets,
      }));
      activateSideChatTab(reusableOpenSideChatId);
      return { success: true, mode: 'append', snippets: normalized.snippets };
    }

    const created = await openNewSideChat({
      forkedFromMessageId: snippet.sourceMessageId ?? null,
      initialSnippets: normalized.snippets,
    });
    if (!created) return { success: false };
    return { success: true, mode: 'new', snippets: normalized.snippets };
  }, [
    activateSideChatTab,
    activeSelectedTextSnippets,
    dispatch,
    openNewSideChat,
    reusableOpenSideChatId,
    sessionId,
  ]);

  const submitBtwCommand = useCallback(async (question: string): Promise<boolean> => {
    if (!sessionId || sessionId.startsWith(COWORK_TEMP_SESSION_ID_PREFIX)) {
      showToast(i18nService.t('coworkBtwRequiresSession'));
      return false;
    }
    const cleaned = normalizeCoworkBtwQuestion(question);
    if (!cleaned) {
      showToast(i18nService.t('coworkBtwEmptyQuestion'));
      return false;
    }

    let targetSideChatId = reusableOpenSideChatId;
    if (targetSideChatId) {
      const existingSummary = openSideChatTabs.find((tab) => tab.id === targetSideChatId)?.summary;
      activateSideChatTab(targetSideChatId);
      if (existingSummary?.status === CoworkSideChatStatus.Running) {
        showToast(i18nService.t('coworkBtwAlreadyPending'));
        return false;
      }
    } else {
      const created = await openNewSideChat();
      if (!created) {
        showToast(i18nService.t('coworkSideChatSendFailed'));
        return false;
      }
      targetSideChatId = created.id;
    }

    const res = await coworkSideChatService.sendMessage({
      parentSessionId: sessionId,
      sideChatId: targetSideChatId,
      prompt: cleaned,
      displayPrompt: cleaned,
      modelOverride: activeModelSelection?.modelOverride ?? undefined,
      thinkingLevel: activeModelSelection?.thinkingLevel,
    });
    if (!res.success) {
      showToast(res.error || i18nService.t('coworkSideChatSendFailed'));
      return false;
    }
    return true;
  }, [
    activateSideChatTab,
    activeModelSelection?.modelOverride,
    activeModelSelection?.thinkingLevel,
    openNewSideChat,
    openSideChatTabs,
    reusableOpenSideChatId,
    sessionId,
  ]);

  const setActiveDraft = useCallback((draft: string) => {
    if (!activeSideChatId) return;
    dispatch(setSideChatDraft({ sideChatId: activeSideChatId, draft }));
  }, [activeSideChatId, dispatch]);

  const setActiveSelectedTextSnippets = useCallback((snippets: CoworkSelectedTextSnippet[]) => {
    if (!activeSideChatId) return;
    dispatch(setSideChatSelectedTextSnippets({ sideChatId: activeSideChatId, snippets }));
  }, [activeSideChatId, dispatch]);

  const addActiveAttachment = useCallback((attachment: DraftAttachment) => {
    if (!activeSideChatId) return;
    dispatch(addSideChatAttachment({ sideChatId: activeSideChatId, attachment }));
  }, [activeSideChatId, dispatch]);

  const removeActiveAttachment = useCallback((path: string) => {
    if (!activeSideChatId) return;
    dispatch(removeSideChatAttachment({ sideChatId: activeSideChatId, path }));
  }, [activeSideChatId, dispatch]);

  const setActiveModelSelection = useCallback((selection: SideChatModelSelection) => {
    if (!activeSideChatId) return;
    dispatch(setSideChatModelSelection({ sideChatId: activeSideChatId, selection }));
  }, [activeSideChatId, dispatch]);

  const sendActiveMessage = useCallback(async (options?: {
    promptOverride?: string;
    modelSupportsImage?: boolean;
  }) => {
    if (!sessionId || !activeSideChatId) return;
    const rawDraft = options?.promptOverride ?? activeDraft;
    const cleaned = normalizeCoworkBtwQuestion(rawDraft);
    if (!cleaned && activeSelectedTextSnippets.length === 0 && activeAttachments.length === 0) {
      showToast(i18nService.t('coworkBtwEmptyQuestion'));
      return;
    }

    const prepared = await prepareCoworkPromptPayload({
      basePrompt: cleaned,
      attachments: activeAttachments,
      selectedTextSnippets: activeSelectedTextSnippets,
      modelSupportsImage: options?.modelSupportsImage ?? false,
      readFileAsDataUrl: (path) => window.electron.dialog.readFileAsDataUrl(path),
      fileLabel: i18nService.t('inputFileLabel'),
      folderLabel: i18nService.t('inputFolderLabel'),
    });

    if (!prepared.success) {
      const { failure } = prepared;
      if (failure.code === CoworkPromptPayloadFailureCode.ImageTooLarge) {
        showToast(
          i18nService.t('coworkImageAttachmentTooLarge')
            .replace('{name}', failure.attachmentName)
            .replace('{limit}', formatCoworkImageAttachmentLimit(failure.maxBytes)),
        );
      } else {
        showToast(
          i18nService.t('coworkImageAttachmentPreviewFailed')
            .replace('{name}', failure.attachmentName),
        );
      }
      return;
    }

    const { payload } = prepared;
    const res = await coworkSideChatService.sendMessage({
      parentSessionId: sessionId,
      sideChatId: activeSideChatId,
      prompt: payload.finalPrompt,
      displayPrompt: payload.finalPrompt,
      selectedTextSnippets: activeSelectedTextSnippets,
      imageAttachments: payload.imageAttachments,
      modelOverride: activeModelSelection?.modelOverride ?? undefined,
      thinkingLevel: activeModelSelection?.thinkingLevel,
    });
    if (!res.success) {
      showToast(res.error || i18nService.t('coworkSideChatSendFailed'));
    }
  }, [
    activeAttachments,
    activeDraft,
    activeModelSelection?.modelOverride,
    activeModelSelection?.thinkingLevel,
    activeSelectedTextSnippets,
    activeSideChatId,
    sessionId,
  ]);

  const stopActiveSideChat = useCallback(() => {
    if (!sessionId || !activeSideChatId) return;
    void coworkSideChatService.stop(sessionId, activeSideChatId);
  }, [activeSideChatId, sessionId]);

  const renameSideChat = useCallback(async (
    sideChatId: string,
    nextTitle: string,
  ): Promise<boolean> => {
    if (!sessionId) return false;
    const trimmed = nextTitle.trim();
    if (!trimmed) return false;
    const ok = await coworkSideChatService.rename(sessionId, sideChatId, trimmed);
    if (!ok) {
      showToast(i18nService.t('coworkSideChatRenameFailed'));
    }
    return ok;
  }, [sessionId]);

  const deleteSideChat = useCallback(async (sideChatId: string): Promise<boolean> => {
    if (!sessionId) return false;
    const wasActive = !hasActiveArtifactPreviewTab
      && activeSpecialPreviewTab === ArtifactSpecialTab.SideChat
      && activeSideChatId === sideChatId;
    const remainingCount = openTabIds.filter((id) => id !== sideChatId).length;
    const ok = await coworkSideChatService.delete(sessionId, sideChatId);
    if (!ok) {
      showToast(i18nService.t('coworkSideChatDeleteFailed'));
      return false;
    }
    if (wasActive && remainingCount === 0) {
      onFallbackAfterClose();
    }
    return true;
  }, [
    activeSideChatId,
    activeSpecialPreviewTab,
    hasActiveArtifactPreviewTab,
    onFallbackAfterClose,
    openTabIds,
    sessionId,
  ]);

  const promoteSideChat = useCallback(async (sideChatId: string): Promise<boolean> => {
    if (!sessionId || promotingSideChatId) return false;
    setPromotingSideChatId(sideChatId);
    try {
      const res = await coworkSideChatService.promote(sessionId, sideChatId);
      if (!res.success || !res.sessionId) {
        const message = res.error?.includes('Cannot fork a running session')
          ? i18nService.t('coworkForkRunningBlocked')
          : (res.error || i18nService.t('coworkSideChatPromoteFailed'));
        showToast(message);
        return false;
      }
      await coworkService.loadSessions();
      await coworkService.loadSession(res.sessionId);
      showToast(i18nService.t('coworkSideChatPromoteSuccess'));
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : i18nService.t('coworkSideChatPromoteFailed'));
      return false;
    } finally {
      setPromotingSideChatId((current) => (current === sideChatId ? null : current));
    }
  }, [promotingSideChatId, sessionId]);

  const respondActivePermission = useCallback(async (
    requestId: string,
    result: CoworkSideChatPermissionResult,
  ): Promise<boolean> => {
    if (!sessionId || !activeSideChatId) return false;
    return coworkSideChatService.respondPermission({
      parentSessionId: sessionId,
      sideChatId: activeSideChatId,
      requestId,
      result,
    });
  }, [activeSideChatId, sessionId]);

  return {
    summaries,
    openSideChatTabs,
    isSideChatPreviewTabOpen,
    activeSideChatId,
    activeSideChat,
    activeDraft,
    activeSelectedTextSnippets,
    activeAttachments,
    activeModelSelection,
    activePendingPermissions,
    promotingSideChatId,
    isLoadingDetail: Boolean(activeSideChatId && loadingDetailId === activeSideChatId && !activeSideChat),
    activateSideChatTab,
    openExistingSideChat,
    openNewSideChat,
    closeSideChatTabById,
    renameSideChat,
    deleteSideChat,
    promoteSideChat,
    openFromSelectedText,
    submitBtwCommand,
    setActiveDraft,
    setActiveSelectedTextSnippets,
    addActiveAttachment,
    removeActiveAttachment,
    setActiveModelSelection,
    sendActiveMessage,
    stopActiveSideChat,
    respondActivePermission,
  };
}
