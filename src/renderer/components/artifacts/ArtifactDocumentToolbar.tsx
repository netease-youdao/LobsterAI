import {
  ArrowPathIcon,
  CheckIcon,
  FolderIcon,
} from '@heroicons/react/24/outline';
import React from 'react';

import { i18nService } from '@/services/i18n';
import { ArtifactContentView } from '@/store/slices/artifactSlice';
import { type Artifact } from '@/types/artifact';

import CopyIcon from '../icons/CopyIcon';
import Tooltip, {
  TOOLTIP_DARK_BUBBLE_CLASS_NAME,
  TooltipAlign,
  TooltipPosition,
} from '../ui/Tooltip';
import type { ArtifactCodeControlsConfig } from './ArtifactCodeControlsContext';
import { resolveArtifactDocumentToolbarModel } from './artifactDocumentToolbarModel';
import type {
  OfficePreviewSaveStatusConfig,
  OfficePreviewZoomControlsConfig,
} from './renderers/office/common/OfficePreviewActionsContext';
import { OfficeZoomControls } from './renderers/office/common/OfficeZoomControls';

const t = (key: string) => i18nService.t(key);

const ToolbarTooltip: React.FC<{
  content: React.ReactNode;
  children: React.ReactNode;
  align?: TooltipAlign;
  disabled?: boolean;
  className?: string;
}> = ({
  content,
  children,
  align = TooltipAlign.Center,
  disabled = false,
  className = 'shrink-0',
}) => (
  <Tooltip
    portal
    content={content}
    position={TooltipPosition.Bottom}
    align={align}
    delay={300}
    disabled={disabled}
    bubbleClassName={TOOLTIP_DARK_BUBBLE_CLASS_NAME}
    className={className}
  >
    {children}
  </Tooltip>
);

const ShareForwardIcon: React.FC = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M8.75 2.75L14 7.75L8.75 12.75V10.15C5.6 10.15 3.4 11.05 2 13.25C2.1 8.4 4.7 5.35 8.75 5.35V2.75Z" />
  </svg>
);

const DownloadTrayIcon: React.FC = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2 11v1.5A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V11" />
    <path d="M5 7.5L8 10.5L11 7.5" />
    <path d="M8 2v8.5" />
  </svg>
);

const MoreHorizontalIcon: React.FC = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
  >
    <circle cx="3.5" cy="8" r="1.2" />
    <circle cx="8" cy="8" r="1.2" />
    <circle cx="12.5" cy="8" r="1.2" />
  </svg>
);

const WordWrapIcon: React.FC = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <line x1="2.5" y1="3.5" x2="13.5" y2="3.5" />
    <path d="M2.5 8h8.25a2.25 2.25 0 0 1 0 4.5H9" />
    <polyline points="10.5 10.75 8.75 12.5 10.5 14.25" />
    <line x1="2.5" y1="12.5" x2="5.5" y2="12.5" />
  </svg>
);

const TOOLBAR_ICON_BUTTON_CLASS =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-secondary transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45';

const MENU_ITEM_BUTTON_CLASS =
  'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-foreground transition-colors hover:bg-surface focus-visible:bg-surface focus-visible:outline-none';

export interface ArtifactDocumentToolbarProps {
  artifact: Artifact;
  canShowCodeView: boolean;
  isCodeViewActive: boolean;
  onSetContentView: (view: ArtifactContentView) => void;
  codeControls: ArtifactCodeControlsConfig | null;
  saveStatus: OfficePreviewSaveStatusConfig | null;
  zoomControls: OfficePreviewZoomControlsConfig | null;
  canShare: boolean;
  onShare: () => void;
  canDownload: boolean;
  onDownload: () => void;
  canCopy: boolean;
  onCopy: () => void;
  canRefresh: boolean;
  onRefresh: () => void;
  onRevealInFolder: () => void;
  onOpenFileList?: () => void;
  isFileListDrawerOpen?: boolean;
  fileListButtonRef?: React.RefObject<HTMLButtonElement>;
  isMenuOpen: boolean;
  onToggleMenu: () => void;
  onRunMenuAction: (action: () => void) => void;
  menuButtonRef: React.RefObject<HTMLButtonElement>;
  menuRef: React.RefObject<HTMLDivElement>;
}

const ArtifactDocumentToolbar: React.FC<ArtifactDocumentToolbarProps> = ({
  artifact,
  canShowCodeView,
  isCodeViewActive,
  onSetContentView,
  codeControls,
  saveStatus,
  zoomControls,
  canShare,
  onShare,
  canDownload,
  onDownload,
  canCopy,
  onCopy,
  canRefresh,
  onRefresh,
  onRevealInFolder,
  onOpenFileList,
  isFileListDrawerOpen = false,
  fileListButtonRef,
  isMenuOpen,
  onToggleMenu,
  onRunMenuAction,
  menuButtonRef,
  menuRef,
}) => {
  const model = resolveArtifactDocumentToolbarModel({
    artifact,
    canShare,
    canDownload,
    canCopy,
    canRefresh,
    hasCodeControls: Boolean(codeControls),
    hasZoomControls: Boolean(zoomControls),
    canOpenFileList: Boolean(onOpenFileList),
  });

  const showExceptionalStatus = Boolean(
    saveStatus && (saveStatus.isReadOnly || saveStatus.isBusy),
  );

  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
      {/* Left zone: document mode + language / exceptional status */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {canShowCodeView && (
          <div
            role="tablist"
            aria-label={t('artifactView')}
            className="inline-flex h-6 shrink-0 items-center rounded-md bg-surface p-0.5 text-[11px]"
          >
            <button
              type="button"
              role="tab"
              aria-selected={!isCodeViewActive}
              onClick={() => onSetContentView(ArtifactContentView.Preview)}
              className={`inline-flex h-5 items-center rounded-[4px] px-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 ${
                !isCodeViewActive
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-secondary hover:text-foreground'
              }`}
            >
              {t('artifactPreview')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={isCodeViewActive}
              onClick={() => onSetContentView(ArtifactContentView.Code)}
              className={`inline-flex h-5 items-center rounded-[4px] px-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 ${
                isCodeViewActive
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-secondary hover:text-foreground'
              }`}
            >
              {t('artifactCode')}
            </button>
          </div>
        )}

        {codeControls && !canShowCodeView && (
          <span className="shrink-0 select-none rounded bg-surface px-1.5 py-0.5 font-mono text-[11px] leading-4 text-secondary">
            {codeControls.languageLabel}
          </span>
        )}

        {showExceptionalStatus && saveStatus && (
          <span
            role="status"
            aria-live="polite"
            className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${
              saveStatus.isReadOnly
                ? 'bg-surface-raised text-secondary'
                : 'text-muted'
            }`}
          >
            {saveStatus.label}
          </span>
        )}
      </div>

      {/* Right zone: uniform 28x28 actions ending with More menu and Workspace File List */}
      <div className="flex shrink-0 items-center gap-1">
        {codeControls && (
          <>
            <ToolbarTooltip content={t('artifactCodeWordWrap')}>
              <button
                type="button"
                onClick={codeControls.onToggleWrapLines}
                aria-label={t('artifactCodeWordWrap')}
                aria-pressed={codeControls.wrapLines}
                className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 ${
                  codeControls.wrapLines
                    ? 'bg-surface-raised text-foreground'
                    : 'text-secondary hover:bg-surface hover:text-foreground'
                }`}
              >
                <WordWrapIcon />
              </button>
            </ToolbarTooltip>
            <ToolbarTooltip content={codeControls.copied ? t('artifactCodeCopied') : t('artifactCopyCode')}>
              <button
                type="button"
                onClick={codeControls.onCopyCode}
                aria-label={codeControls.copied ? t('artifactCodeCopied') : t('artifactCopyCode')}
                className={TOOLBAR_ICON_BUTTON_CLASS}
              >
                {codeControls.copied ? (
                  <CheckIcon className="h-4 w-4 text-emerald-600" />
                ) : (
                  <CopyIcon className="h-4 w-4" />
                )}
              </button>
            </ToolbarTooltip>
          </>
        )}

        {model.showShareButton && (
          <ToolbarTooltip content={t('htmlShare')}>
            <button
              type="button"
              onClick={onShare}
              className={TOOLBAR_ICON_BUTTON_CLASS}
              aria-label={t('htmlShare')}
            >
              <ShareForwardIcon />
            </button>
          </ToolbarTooltip>
        )}

        {model.showDownloadButton && (
          <ToolbarTooltip content={t('artifactDownload')}>
            <button
              type="button"
              onClick={onDownload}
              className={TOOLBAR_ICON_BUTTON_CLASS}
              aria-label={t('artifactDownload')}
            >
              <DownloadTrayIcon />
            </button>
          </ToolbarTooltip>
        )}

        {model.showMoreMenu && (
          <div className="relative">
            <ToolbarTooltip
              content={t('artifactActionsMenu')}
              align={model.showFileListButton ? TooltipAlign.Center : TooltipAlign.End}
              disabled={isMenuOpen}
            >
              <button
                ref={menuButtonRef}
                type="button"
                onClick={onToggleMenu}
                className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 ${
                  isMenuOpen
                    ? 'bg-surface text-foreground'
                    : 'text-secondary hover:bg-surface hover:text-foreground'
                }`}
                aria-label={t('artifactActionsMenu')}
                aria-haspopup="menu"
                aria-expanded={isMenuOpen}
              >
                <MoreHorizontalIcon />
              </button>
            </ToolbarTooltip>
            {isMenuOpen && (
              <div
                ref={menuRef}
                role="menu"
                aria-label={t('artifactActionsMenu')}
                className="absolute right-0 top-8 z-40 w-44 rounded-lg border border-border bg-surface-raised p-1.5 text-sm text-foreground shadow-xl"
              >
                {model.showCopyInMenu && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => onRunMenuAction(onCopy)}
                    className={MENU_ITEM_BUTTON_CLASS}
                  >
                    <CopyIcon className="h-3.5 w-3.5 shrink-0 text-secondary" />
                    <span>{t('artifactCopyCode')}</span>
                  </button>
                )}
                {model.showRefreshInMenu && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => onRunMenuAction(onRefresh)}
                    className={MENU_ITEM_BUTTON_CLASS}
                  >
                    <ArrowPathIcon className="h-3.5 w-3.5 shrink-0 text-secondary" />
                    <span>{t('artifactRefresh')}</span>
                  </button>
                )}
                {model.showRevealInFolderInMenu && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => onRunMenuAction(onRevealInFolder)}
                    className={MENU_ITEM_BUTTON_CLASS}
                  >
                    <FolderIcon className="h-3.5 w-3.5 shrink-0 text-secondary" />
                    <span>{t('artifactViewDirectory')}</span>
                  </button>
                )}

                {zoomControls && (
                  <div
                    className={`${model.hasMenuActions ? 'mt-1 border-t border-border/70 pt-1.5' : ''} px-1 py-1`}
                  >
                    <div className="flex h-8 items-center gap-1.5">
                      <span className="shrink-0 whitespace-nowrap text-xs text-secondary">
                        {t('artifactBrowserZoom')}
                      </span>
                      <OfficeZoomControls
                        zoomFactor={zoomControls.zoomFactor}
                        displayZoomFactor={zoomControls.displayZoomFactor}
                        onZoomOut={zoomControls.onZoomOut}
                        onZoomIn={zoomControls.onZoomIn}
                        onResetZoom={zoomControls.onResetZoom}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {model.showFileListButton && onOpenFileList && (
          <ToolbarTooltip
            content={isFileListDrawerOpen ? t('artifactCloseFileList') : t('artifactFileList')}
            align={TooltipAlign.End}
          >
            <button
              ref={fileListButtonRef}
              type="button"
              data-artifact-file-drawer-toggle="true"
              onClick={onOpenFileList}
              aria-pressed={isFileListDrawerOpen}
              className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 ${
                isFileListDrawerOpen
                  ? 'bg-surface-raised text-foreground'
                  : 'text-secondary hover:bg-surface hover:text-foreground'
              }`}
              aria-label={isFileListDrawerOpen ? t('artifactCloseFileList') : t('artifactFileList')}
            >
              <FolderIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          </ToolbarTooltip>
        )}
      </div>
    </div>
  );
};

export default ArtifactDocumentToolbar;
