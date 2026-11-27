import { CheckIcon, PencilIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';

import { renameLocalArtifactFile } from '@/services/artifactWorkspace';
import { i18nService } from '@/services/i18n';
import { getMarkdownDocument } from '@/services/markdownDocument';
import { closeOpenOfficeEditor } from '@/services/office/officeFormats';
import { normalizeShellFilePath } from '@/services/shellAppsCache';
import { renameArtifactFile } from '@/store/slices/artifactSlice';
import { type Artifact, ArtifactTypeValue } from '@/types/artifact';

import type { OfficePreviewSaveStatusConfig } from './renderers/office/common/OfficePreviewActionsContext';

const t = (key: string) => i18nService.t(key);

function splitFileNameExtension(fileName: string): { stem: string; extension: string } {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return { stem: fileName, extension: '' };
  }
  return {
    stem: fileName.slice(0, dotIndex),
    extension: fileName.slice(dotIndex),
  };
}

interface ArtifactInlineFileTitleProps {
  sessionId: string;
  artifact: Artifact;
  saveStatus?: OfficePreviewSaveStatusConfig | null;
}

const ArtifactInlineFileTitle: React.FC<ArtifactInlineFileTitleProps> = ({
  sessionId,
  artifact,
  saveStatus,
}) => {
  const dispatch = useDispatch();
  const displayName = artifact.fileName || artifact.title;
  const canRename = Boolean(
    artifact.filePath
    && artifact.type !== ArtifactTypeValue.LocalService,
  );
  const { stem, extension } = useMemo(() => splitFileNameExtension(displayName), [displayName]);

  const [isEditing, setIsEditing] = useState(false);
  const [draftStem, setDraftStem] = useState(stem);
  const [isRenaming, setIsRenaming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancellingRef = useRef(false);

  useEffect(() => {
    setIsEditing(false);
    setDraftStem(stem);
  }, [artifact.id, artifact.filePath, stem]);

  useEffect(() => {
    if (!isEditing) return;
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isEditing]);

  const startEditing = useCallback(() => {
    if (!canRename || isRenaming) return;
    cancellingRef.current = false;
    setDraftStem(stem);
    setIsEditing(true);
  }, [canRename, isRenaming, stem]);

  const cancelEditing = useCallback(() => {
    cancellingRef.current = true;
    setIsEditing(false);
    setDraftStem(stem);
  }, [stem]);

  const commitRename = useCallback(async () => {
    if (cancellingRef.current) {
      cancellingRef.current = false;
      return;
    }
    setIsEditing(false);
    const trimmed = draftStem.trim();
    if (!trimmed || trimmed === stem || !artifact.filePath) {
      setDraftStem(stem);
      return;
    }

    setIsRenaming(true);
    try {
      const oldFilePath = artifact.filePath;
      if (artifact.type === ArtifactTypeValue.Markdown) {
        await getMarkdownDocument(normalizeShellFilePath(oldFilePath)).flush();
      } else {
        await closeOpenOfficeEditor(oldFilePath);
      }

      const result = await renameLocalArtifactFile(oldFilePath, trimmed);
      if (!result.success) {
        setDraftStem(stem);
        window.dispatchEvent(new CustomEvent('app:showToast', {
          detail: result.error || t('artifactRenameFileFailed'),
        }));
        return;
      }

      dispatch(renameArtifactFile({
        sessionId,
        oldFilePath,
        newFilePath: result.filePath,
        newFileName: result.fileName,
      }));
    } catch (error) {
      setDraftStem(stem);
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: error instanceof Error ? error.message : t('artifactRenameFileFailed'),
      }));
    } finally {
      setIsRenaming(false);
    }
  }, [artifact.filePath, artifact.type, dispatch, draftStem, sessionId, stem]);

  return (
    <div className="flex min-w-0 items-center gap-2">
      {isEditing ? (
        <div className="flex min-w-0 max-w-[260px] items-center rounded-md border border-primary/60 bg-background px-1.5 py-0.5 ring-2 ring-primary/15">
          <input
            ref={inputRef}
            type="text"
            value={draftStem}
            disabled={isRenaming}
            onChange={event => setDraftStem(event.target.value)}
            onBlur={() => { void commitRename(); }}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                void commitRename();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelEditing();
              }
            }}
            aria-label={t('artifactRenameFile')}
            className="min-w-[80px] flex-1 bg-transparent text-[13px] font-medium text-foreground outline-none"
          />
          {extension && (
            <span className="shrink-0 select-none pl-0.5 text-xs text-muted">{extension}</span>
          )}
        </div>
      ) : canRename ? (
        <button
          type="button"
          onClick={startEditing}
          disabled={isRenaming}
          title={t('artifactRenameFileHint')}
          className="group -ml-1.5 inline-flex min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-[13px] transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:opacity-60"
        >
          <span className="truncate font-medium text-foreground">{stem}</span>
          {extension && (
            <span className="shrink-0 text-xs text-muted">{extension}</span>
          )}
          <PencilIcon
            className="h-3 w-3 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden="true"
          />
        </button>
      ) : (
        <span className="truncate text-[13px] font-medium text-foreground">
          {displayName}
        </span>
      )}

      {saveStatus && (
        <div className="flex shrink-0 items-center gap-1.5">
          {saveStatus.canSave ? (
            <button
              type="button"
              onClick={saveStatus.onSave}
              disabled={saveStatus.isBusy}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-surface-raised px-2 text-[11px] font-medium text-foreground transition-colors hover:border-foreground/20 disabled:opacity-50"
              title={saveStatus.label}
            >
              <span>{t('save')}</span>
            </button>
          ) : (
            <span
              className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-muted"
              role="status"
              aria-live="polite"
            >
              {saveStatus.isSaved && <CheckIcon className="h-3 w-3 text-emerald-600" />}
              <span>{saveStatus.label}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
};

export default ArtifactInlineFileTitle;
