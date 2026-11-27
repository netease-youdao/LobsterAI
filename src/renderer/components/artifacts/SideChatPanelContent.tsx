import {
  ShieldExclamationIcon,
  StopIcon,
} from '@heroicons/react/24/outline';
import { ArrowUpIcon } from '@heroicons/react/24/solid';
import React, {
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSelector } from 'react-redux';

import type { CoworkSelectedTextSnippet } from '../../../shared/cowork/selectedText';
import {
  type CoworkSideChat,
  type CoworkSideChatPermissionRequest,
  type CoworkSideChatPermissionResult,
  CoworkSideChatStatus,
} from '../../../shared/cowork/sideChat';
import { i18nService } from '../../services/i18n';
import type { RootState } from '../../store';
import { AsrQuotaStatus, getLocalAsrQuotaDayKey } from '../../store/slices/asrQuotaSlice';
import type { DraftAttachment } from '../../store/slices/coworkSlice';
import type { SideChatModelSelection } from '../../store/slices/sideChatSlice';
import type {
  CoworkMessage,
  CoworkPermissionRequest,
  CoworkSession,
} from '../../types/cowork';
import { toOpenClawModelRef } from '../../utils/openclawModelRef';
import {
  resolveAgentModelSelection,
  resolveEffectiveModel,
  resolveModelThinkingLevel,
  useAgentSelectedModel,
} from '../cowork/agentModelSelection';
import AttachmentCard from '../cowork/AttachmentCard';
import { isImagePath } from '../cowork/attachmentPaths';
import {
  getClipboardAttachmentFiles,
  getCopiedMessageImageFiles,
} from '../cowork/clipboardAttachments';
import ConversationTurnsView from '../cowork/ConversationTurnsView';
import { QuestionDockCard } from '../cowork/interactions/QuestionDock';
import { permissionDockRequest } from '../cowork/interactions/questionDockModel';
import { hasFileTransfer } from '../cowork/pageFileDrop';
import SelectedTextSnippetBadge from '../cowork/SelectedTextSnippetBadge';
import { formatSideChatApprovalPreview } from '../cowork/sideChatHelpers';
import { useCoworkVoiceInput } from '../cowork/voiceInput/useCoworkVoiceInput';
import VoiceInputButton from '../cowork/voiceInput/VoiceInputButton';
import VoiceInputRecordingStatus from '../cowork/voiceInput/VoiceInputRecordingStatus';
import PromptAddIcon from '../icons/PromptAddIcon';
import SideChatIcon from '../icons/SideChatIcon';
import ModelSelector, {
  type ModelSelectorChangeMeta,
  ModelSelectorGroup,
} from '../ModelSelector';

export interface SideChatPanelContentProps {
  sideChat: CoworkSideChat | null;
  parentSession?: CoworkSession | null;
  loading?: boolean;
  draft: string;
  selectedTextSnippets: CoworkSelectedTextSnippet[];
  attachments: DraftAttachment[];
  modelSelection: SideChatModelSelection | null;
  pendingPermissions: CoworkSideChatPermissionRequest[];
  resolveLocalFilePath?: (href: string, text: string) => string | null;
  onDraftChange: (draft: string) => void;
  onSelectedTextSnippetsChange: (snippets: CoworkSelectedTextSnippet[]) => void;
  onAddAttachment: (attachment: DraftAttachment) => void;
  onRemoveAttachment: (path: string) => void;
  onModelSelectionChange: (selection: SideChatModelSelection) => void;
  onLocateSelectedText?: (sourceMessageId: string) => void;
  onSend: (options?: { promptOverride?: string; modelSupportsImage?: boolean }) => void;
  onStop: () => void;
  onRespondPermission: (
    requestId: string,
    result: CoworkSideChatPermissionResult,
  ) => Promise<boolean> | boolean;
}

const NEAR_BOTTOM_THRESHOLD_PX = 80;
const COMPOSER_MAX_HEIGHT_PX = 128;

const getFileNameFromPath = (filePath: string): string => {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
};

const readFileAsDataUrlFromBrowser = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result === 'string') {
      resolve(reader.result);
    } else {
      reject(new Error('Failed to read file as data URL'));
    }
  };
  reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
  reader.readAsDataURL(file);
});

const SideChatInlineApprovalCard: React.FC<{
  request: CoworkSideChatPermissionRequest;
  queueCount: number;
  onRespond: (
    requestId: string,
    result: CoworkSideChatPermissionResult,
  ) => Promise<boolean> | boolean;
}> = ({ request, queueCount, onRespond }) => {
  const [submitting, setSubmitting] = useState(false);

  const dockRequest = useMemo(() => {
    const coworkPermission: CoworkPermissionRequest = {
      sessionId: request.parentSessionId,
      requestId: request.requestId,
      toolName: request.toolName,
      toolInput: request.toolInput,
      toolUseId: request.toolUseId ?? undefined,
    };
    return permissionDockRequest(coworkPermission);
  }, [request]);

  const previewText = useMemo(
    () => formatSideChatApprovalPreview(request.toolInput),
    [request.toolInput],
  );

  if (dockRequest) {
    return (
      <div className="px-3 pb-2">
        <QuestionDockCard
          key={dockRequest.key}
          request={dockRequest}
          queueCount={queueCount}
          onRespond={async (result) => onRespond(request.requestId, result)}
        />
      </div>
    );
  }

  const handleDecision = async (behavior: 'allow' | 'deny') => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onRespond(request.requestId, { behavior });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="px-3 pb-2">
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2.5 dark:bg-amber-500/[0.08]">
        <div className="flex items-center gap-2">
          <ShieldExclamationIcon className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            {i18nService.t('coworkSideChatApprovalTitle')}
          </span>
          <span className="shrink-0 rounded-md bg-surface-raised px-1.5 py-0.5 font-mono text-[11px] text-secondary">
            {request.toolName}
          </span>
          {queueCount > 1 && (
            <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-300">
              1/{queueCount}
            </span>
          )}
        </div>
        {previewText && (
          <pre className="mt-2 max-h-28 overflow-auto rounded-lg bg-background/80 px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed text-secondary whitespace-pre-wrap break-all">
            {previewText}
          </pre>
        )}
        <div className="mt-2.5 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={() => void handleDecision('deny')}
            className="rounded-lg border border-border bg-background px-2.5 py-1 text-xs font-medium text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:opacity-50"
          >
            {i18nService.t('coworkSideChatApprovalDeny')}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void handleDecision('allow')}
            className="rounded-lg bg-action px-2.5 py-1 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover disabled:opacity-50"
          >
            {i18nService.t('coworkSideChatApprovalAllow')}
          </button>
        </div>
      </div>
    </div>
  );
};

const SideChatPanelContent: React.FC<SideChatPanelContentProps> = ({
  sideChat,
  parentSession,
  loading = false,
  draft,
  selectedTextSnippets,
  attachments,
  modelSelection,
  pendingPermissions,
  resolveLocalFilePath,
  onDraftChange,
  onSelectedTextSnippetsChange,
  onAddAttachment,
  onRemoveAttachment,
  onModelSelectionChange,
  onLocateSelectedText,
  onSend,
  onStop,
  onRespondPermission,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isNearBottomRef = useRef(true);
  const previousSnippetCountRef = useRef(selectedTextSnippets.length);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const [isAddingFile, setIsAddingFile] = useState(false);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const dragDepthRef = useRef(0);

  const availableModels = useSelector((state: RootState) => state.model.availableModels);
  const coworkAgentEngine = useSelector((state: RootState) => state.cowork.config.agentEngine);
  const agents = useSelector((state: RootState) => state.agent.agents);
  const isLoggedIn = useSelector((state: RootState) => state.auth.isLoggedIn);
  const asrQuota = useSelector((state: RootState) => state.asrQuota);

  const parentAgentId = parentSession?.agentId || 'main';
  const parentAgent = agents.find((agent) => agent.id === parentAgentId);
  const parentAgentSelectedModel = useAgentSelectedModel(parentAgentId, parentAgent?.model ?? '');

  const { selectedModel: resolvedSideChatModel } = resolveAgentModelSelection({
    sessionModel: modelSelection ? modelSelection.modelOverride : (parentSession?.modelOverride ?? ''),
    sessionPresetId: modelSelection
      ? (modelSelection.modelPresetId ?? null)
      : (parentSession?.modelPresetId ?? null),
    agentModel: parentAgent?.model ?? '',
    availableModels,
    fallbackModel: parentAgentSelectedModel,
    engine: coworkAgentEngine,
  });

  const effectiveSelectedModel = resolveEffectiveModel({
    sessionId: parentSession?.id,
    agentSelectedModel: resolvedSideChatModel,
    globalSelectedModel: parentAgentSelectedModel,
  });

  const effectiveThinkingLevel = resolveModelThinkingLevel(
    effectiveSelectedModel,
    modelSelection
      ? modelSelection.thinkingLevel
      : (parentSession?.thinkingLevel ?? parentAgent?.thinkingLevel),
  );
  const modelSupportsImage = Boolean(effectiveSelectedModel?.supportsImage);

  const sideChatId = sideChat?.id ?? null;
  const isRunning = sideChat?.status === CoworkSideChatStatus.Running;
  const messages = useMemo<CoworkMessage[]>(
    () => (sideChat?.messages ?? []) as CoworkMessage[],
    [sideChat?.messages],
  );
  const lastMessage = messages[messages.length - 1];
  const lastMessageTailKey = lastMessage ? `${lastMessage.id}:${lastMessage.content.length}` : 'empty';

  const handleVoiceSetValue = useCallback((next: SetStateAction<string>) => {
    const resolved = typeof next === 'function' ? next(draftRef.current) : next;
    onDraftChange(resolved);
  }, [onDraftChange]);

  const handlePersistVoiceDraft = useCallback((_targetKey: string, nextValue: string) => {
    onDraftChange(nextValue);
  }, [onDraftChange]);

  const {
    handleVoiceInput,
    stopVoiceRecordingAndRecognize,
    isVoiceRecording,
    isVoiceRecognizing,
    recordingElapsedSeconds,
  } = useCoworkVoiceInput({
    draftKey: sideChatId ? `side-chat:${sideChatId}` : '__side_chat__',
    value: draft,
    setValue: handleVoiceSetValue,
    textareaRef: inputRef,
    isLoggedIn,
    disabled: isRunning || !sideChat,
    onPersistDraft: handlePersistVoiceDraft,
  });

  const isAsrQuotaExhaustedToday = asrQuota.status === AsrQuotaStatus.Exhausted
    && asrQuota.dayKey === getLocalAsrQuotaDayKey();
  const voiceInputLocksEditing = isVoiceRecording || isVoiceRecognizing;

  const syncTextareaHeight = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    // Never measure scrollHeight on an empty draft: during the right-panel open
    // width transition, placeholder wrapping would falsely expand the box.
    if (!input.value) {
      input.style.height = '';
      return;
    }
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
  }, []);

  useEffect(() => {
    isNearBottomRef.current = true;
    if (sideChatId) {
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [sideChatId]);

  useEffect(() => {
    const prevCount = previousSnippetCountRef.current;
    previousSnippetCountRef.current = selectedTextSnippets.length;
    if (selectedTextSnippets.length > prevCount) {
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [selectedTextSnippets.length]);

  useEffect(() => {
    if (!isNearBottomRef.current) return;
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages.length, lastMessageTailKey, isRunning, pendingPermissions.length]);

  useLayoutEffect(() => {
    syncTextareaHeight();
  }, [draft, sideChatId, syncTextareaHeight]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      syncTextareaHeight();
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [sideChatId, syncTextareaHeight]);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    isNearBottomRef.current = distance <= NEAR_BOTTOM_THRESHOLD_PX;
  }, []);

  const handleSelectFiles = useCallback(async () => {
    if (isAddingFile || isRunning || voiceInputLocksEditing || !sideChat) return;
    setIsAddingFile(true);
    try {
      const result = await window.electron.dialog.selectFiles({
        title: i18nService.t('coworkAddFile'),
      });
      if (!result.success || result.paths.length === 0) return;
      for (const filePath of result.paths) {
        const name = getFileNameFromPath(filePath);
        if (isImagePath(filePath) && modelSupportsImage) {
          try {
            const readResult = await window.electron.dialog.readFileAsDataUrl(filePath);
            if (readResult.success && readResult.dataUrl) {
              onAddAttachment({
                path: filePath,
                name,
                isImage: true,
                dataUrl: readResult.dataUrl,
              });
              continue;
            }
          } catch (error) {
            console.warn('[SideChatPanelContent] failed to read selected image as data URL:', error);
          }
        }
        onAddAttachment({ path: filePath, name });
      }
    } catch (error) {
      console.error('[SideChatPanelContent] failed to select files:', error);
    } finally {
      setIsAddingFile(false);
    }
  }, [isAddingFile, isRunning, modelSupportsImage, onAddAttachment, sideChat, voiceInputLocksEditing]);

  const handleIncomingFiles = useCallback(async (fileList: FileList | File[]) => {
    if (isRunning || voiceInputLocksEditing || !sideChat) return;
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;

    for (const file of files) {
      const nativePath = window.electron.dialog.getPathForFile?.(file)
        || (file as File & { path?: string }).path
        || null;
      const isImage = file.type.startsWith('image/') || isImagePath(file.name);

      if (nativePath && nativePath.trim()) {
        const trimmedPath = nativePath.trim();
        const name = getFileNameFromPath(trimmedPath);
        let isDirectory = false;
        try {
          const stat = await window.electron.dialog.statFile(trimmedPath);
          isDirectory = Boolean(stat.success && stat.isDirectory);
        } catch {
          // Ignore stat failures and treat as file.
        }
        if (isImage && !isDirectory && modelSupportsImage) {
          try {
            const readResult = await window.electron.dialog.readFileAsDataUrl(trimmedPath);
            if (readResult.success && readResult.dataUrl) {
              onAddAttachment({ path: trimmedPath, name, isImage: true, dataUrl: readResult.dataUrl });
              continue;
            }
          } catch {
            // Fall back to regular file path attachment.
          }
        }
        onAddAttachment({ path: trimmedPath, name, isDirectory });
        continue;
      }

      if (isImage) {
        try {
          const dataUrl = await readFileAsDataUrlFromBrowser(file);
          const commaIdx = dataUrl.indexOf(',');
          const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
          const fileName = file.name || `pasted-image-${Date.now()}.png`;
          const saved = await window.electron.dialog.saveInlineFile({
            dataBase64: base64,
            fileName,
            mimeType: file.type || 'image/png',
            cwd: parentSession?.cwd,
          });
          if (saved.success && saved.path) {
            onAddAttachment({
              path: saved.path,
              name: getFileNameFromPath(saved.path),
              isImage: modelSupportsImage,
              ...(modelSupportsImage ? { dataUrl } : {}),
            });
          } else if (modelSupportsImage) {
            onAddAttachment({
              path: `inline:${fileName}:${Date.now()}`,
              name: fileName,
              isImage: true,
              dataUrl,
            });
          }
        } catch (error) {
          console.warn('[SideChatPanelContent] failed to process dropped/pasted image:', error);
        }
      }
    }
  }, [isRunning, modelSupportsImage, onAddAttachment, parentSession?.cwd, sideChat, voiceInputLocksEditing]);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (isRunning || voiceInputLocksEditing) return;
    const files = getClipboardAttachmentFiles(event.clipboardData);
    if (files.length > 0) {
      event.preventDefault();
      void handleIncomingFiles(files);
      return;
    }
    const copiedImages = getCopiedMessageImageFiles(event.clipboardData);
    if (copiedImages.length > 0) {
      void handleIncomingFiles(copiedImages);
    }
  }, [handleIncomingFiles, isRunning, voiceInputLocksEditing]);

  const handleModelChange = useCallback((
    nextModel: typeof effectiveSelectedModel,
    meta: ModelSelectorChangeMeta,
  ) => {
    if (!nextModel) return;
    const selectedModel = meta.group === ModelSelectorGroup.Server
      ? availableModels.find((model) => (
        model.isServerModel
        && model.id === nextModel.id
        && model.accessible !== false
      )) ?? nextModel
      : nextModel;
    const nextThinkingLevel = selectedModel.presetId
      ? meta.thinkingLevel ?? null
      : resolveModelThinkingLevel(selectedModel, meta.thinkingLevel) ?? null;
    onModelSelectionChange({
      modelOverride: toOpenClawModelRef(selectedModel),
      thinkingLevel: nextThinkingLevel,
      modelPresetId: selectedModel.presetId ?? null,
    });
  }, [availableModels, onModelSelectionChange]);

  const handleVoiceButtonClick = useCallback(() => {
    if (!isLoggedIn) {
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t('voiceInputLoginRequired'),
      }));
      return;
    }
    void handleVoiceInput();
  }, [handleVoiceInput, isLoggedIn]);

  const hasSelectedSnippets = selectedTextSnippets.length > 0;
  const hasAttachments = attachments.length > 0;
  const hasComposerContent = hasSelectedSnippets || hasAttachments || /\S/.test(draft);
  const canSubmit = Boolean(sideChat) && (hasComposerContent || isVoiceRecording) && !isRunning && !isVoiceRecognizing;

  const handleSubmit = useCallback(async () => {
    if (isRunning || isVoiceRecognizing || !sideChat) return;
    if (isVoiceRecording) {
      const finalized = await stopVoiceRecordingAndRecognize();
      const effectiveText = finalized ?? draftRef.current;
      if (!hasSelectedSnippets && !hasAttachments && !/\S/.test(effectiveText)) {
        return;
      }
      onSend({ promptOverride: effectiveText, modelSupportsImage });
      return;
    }
    if (!hasComposerContent) return;
    onSend({ modelSupportsImage });
  }, [
    hasAttachments,
    hasComposerContent,
    hasSelectedSnippets,
    isRunning,
    isVoiceRecognizing,
    isVoiceRecording,
    modelSupportsImage,
    onSend,
    sideChat,
    stopVoiceRecordingAndRecognize,
  ]);

  if (loading && !sideChat) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-background">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
      </div>
    );
  }

  if (!sideChat) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center bg-background px-8 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-raised">
          <SideChatIcon className="h-5 w-5 text-secondary" />
        </div>
        <p className="mt-3 max-w-[260px] text-[13px] leading-relaxed text-muted">
          {i18nService.t('coworkBtwEmptyThread')}
        </p>
      </div>
    );
  }

  const activePermission = pendingPermissions[0] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Message Stream */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        aria-live="polite"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-4 pt-3 [scrollbar-gutter:stable_both-edges]"
      >
        {messages.length === 0 && !isRunning ? (
          <div className="flex h-full min-h-44 flex-col items-center justify-center px-8 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-raised">
              <SideChatIcon className="h-5 w-5 text-secondary" />
            </div>
            <p className="mt-3 max-w-[260px] text-[13px] leading-relaxed text-muted">
              {i18nService.t('coworkBtwEmptyThread')}
            </p>
          </div>
        ) : (
          <ConversationTurnsView
            messages={messages}
            scrollContainerRef={scrollContainerRef}
            isStreaming={isRunning}
            readOnly
            enableMessageSpeech
            compactMeta
            resolveLocalFilePath={resolveLocalFilePath}
            onLocateSelectedText={onLocateSelectedText}
          />
        )}

        {sideChat.status === CoworkSideChatStatus.Error && sideChat.lastError && (
          <div className="mx-3 mt-2 rounded-xl border border-danger/30 bg-danger/[0.06] px-3 py-2 text-xs text-danger whitespace-pre-wrap break-words">
            {sideChat.lastError}
          </div>
        )}
      </div>

      {/* Inline Approval / User-Questions Card */}
      {activePermission && (
        <SideChatInlineApprovalCard
          request={activePermission}
          queueCount={pendingPermissions.length}
          onRespond={onRespondPermission}
        />
      )}

      {/* Composer */}
      <div className="shrink-0 px-3 pb-3 pt-1.5">
        <div
          onDragEnter={(event) => {
            if (!hasFileTransfer(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            dragDepthRef.current += 1;
            if (!isRunning && !voiceInputLocksEditing) {
              setIsDraggingFiles(true);
            }
          }}
          onDragOver={(event) => {
            if (!hasFileTransfer(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = !isRunning && !voiceInputLocksEditing ? 'copy' : 'none';
          }}
          onDragLeave={(event) => {
            if (!hasFileTransfer(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (dragDepthRef.current === 0) {
              setIsDraggingFiles(false);
            }
          }}
          onDrop={(event) => {
            if (!hasFileTransfer(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            dragDepthRef.current = 0;
            setIsDraggingFiles(false);
            void handleIncomingFiles(event.dataTransfer.files);
            inputRef.current?.focus();
          }}
          className={`rounded-2xl border bg-surface shadow-card transition-colors ${
            isDraggingFiles
              ? 'border-foreground/30 bg-surface-raised/60'
              : 'border-border'
          }`}
        >
          {(hasSelectedSnippets || hasAttachments) && (
            <div className="flex flex-col gap-2 px-3 pt-2.5">
              {hasSelectedSnippets && (
                <SelectedTextSnippetBadge
                  snippets={selectedTextSnippets}
                  onClear={() => onSelectedTextSnippetsChange([])}
                  onRemove={(snippetId) => onSelectedTextSnippetsChange(
                    selectedTextSnippets.filter((snippet) => snippet.id !== snippetId),
                  )}
                  onLocate={onLocateSelectedText}
                />
              )}
              {hasAttachments && (
                <div className="flex flex-wrap gap-2">
                  {attachments.map((attachment) => (
                    <AttachmentCard
                      key={attachment.path}
                      attachment={attachment}
                      onRemove={onRemoveAttachment}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="px-3.5 pb-1 pt-2.5">
            <textarea
              ref={inputRef}
              value={draft}
              readOnly={voiceInputLocksEditing}
              onChange={(event) => onDraftChange(event.target.value)}
              onPaste={handlePaste}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter'
                  && !event.shiftKey
                  && !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  if (canSubmit) {
                    void handleSubmit();
                  }
                }
              }}
              rows={1}
              aria-label={i18nService.t('coworkBtwInputPlaceholder')}
              placeholder={i18nService.t('coworkBtwInputPlaceholder')}
              className="block max-h-32 w-full resize-none overflow-y-auto bg-transparent py-0.5 text-sm leading-6 text-foreground outline-none placeholder:text-muted"
            />
          </div>

          <div className="flex items-center justify-between gap-1.5 px-2 pb-2 pt-1">
            <button
              type="button"
              onClick={() => void handleSelectFiles()}
              disabled={isAddingFile || isRunning || voiceInputLocksEditing}
              title={i18nService.t('coworkAddFile')}
              aria-label={i18nService.t('coworkAddFile')}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
            >
              <PromptAddIcon className="h-4 w-4" />
            </button>

            {isVoiceRecording && (
              <VoiceInputRecordingStatus
                elapsedSeconds={recordingElapsedSeconds}
                showHint={false}
              />
            )}

            <div className="flex min-w-0 items-center gap-1">
              {!isVoiceRecording && (
                <ModelSelector
                  allowPresets
                  compact
                  dropdownDirection="up"
                  alignDropdownToTriggerEnd
                  portal
                  hideCustomProviderName
                  triggerMaxWidthClassName="max-w-[160px]"
                  disabled={isRunning || voiceInputLocksEditing}
                  value={effectiveSelectedModel}
                  thinkingLevel={effectiveThinkingLevel ?? null}
                  onChange={handleModelChange}
                />
              )}

              <VoiceInputButton
                buttonClassName="inline-flex h-7 w-7 shrink-0 items-center justify-center"
                iconClassName="h-4 w-4"
                isLoggedIn={isLoggedIn}
                disabled={isRunning || !sideChat}
                isQuotaExhausted={isAsrQuotaExhaustedToday}
                isRecording={isVoiceRecording}
                isRecognizing={isVoiceRecognizing}
                onClick={handleVoiceButtonClick}
              />

              <button
                type="button"
                onClick={() => {
                  if (isRunning) {
                    onStop();
                  } else {
                    void handleSubmit();
                  }
                }}
                disabled={!isRunning && !canSubmit}
                className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-all ${
                  isRunning || canSubmit
                    ? 'bg-action text-action-foreground shadow-subtle hover:bg-action-hover active:scale-95'
                    : 'cursor-not-allowed bg-neutral-300 text-white dark:bg-neutral-700 dark:text-neutral-500'
                }`}
                title={i18nService.t(isRunning ? 'coworkBtwStop' : 'coworkBtwSend')}
                aria-label={i18nService.t(isRunning ? 'coworkBtwStop' : 'coworkBtwSend')}
              >
                {isRunning
                  ? <StopIcon className="h-4 w-4 fill-current" />
                  : <ArrowUpIcon className="h-[17px] w-[17px]" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SideChatPanelContent;
