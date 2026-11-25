import React from 'react';

import { ShortcutAction } from '../../config';
import { i18nService } from '../../services/i18n';
import { type ArtifactPreviewTab, ArtifactSpecialTab } from '../../store/slices/artifactSlice';
import type { Artifact } from '../../types/artifact';
import { useShortcutHint } from '../agentSidebar/useShortcutHint';
import { canRenameArtifactFile } from '../artifacts/artifactHeaderPath';
import {
  ArtifactBrowserIcon,
  WorkspaceFilesIcon,
} from '../artifacts/ArtifactPreviewIdentity';
import {
  type BrowserPreviewTab,
  getBrowserPreviewTabLabel,
} from '../artifacts/browserPreviewTabs';
import FileTypeIcon from '../icons/fileTypes/FileTypeIcon';
import Tooltip, {
  TOOLTIP_DARK_BUBBLE_CLASS_NAME,
  TooltipAlign,
  TooltipPosition,
} from '../ui/Tooltip';
import { MAC_TRAFFIC_LIGHT_INSET_CLASS } from '../window/windowZoom';
import {
  ArtifactPanelIcon,
  ArtifactTabPlusIcon,
  PanelExpandIcon,
  PanelRestoreIcon,
} from './artifactPanelChrome';
import ArtifactPreviewTabItem from './ArtifactPreviewTabItem';
import { type ArtifactTabActionTarget, artifactTabMenuActions } from './artifactTabActions';

export interface HomeArtifactPanelHeaderProps {
  isPanelOpen: boolean;
  isArtifactPanelVisible: boolean;
  isArtifactPanelTransitioning: boolean;
  isArtifactPanelExpanded: boolean;
  artifactHeaderWidth: number | undefined;
  needsMacTrafficLightInsetWhenExpanded?: boolean;
  artifactTabsScrollRef: React.RefObject<HTMLDivElement>;
  isFileListPreviewTabOpen: boolean;
  browserTabs: BrowserPreviewTab[];
  activeBrowserTabId: string | null;
  artifactTabsWithArtifacts: Array<{ tab: ArtifactPreviewTab; artifact: Artifact }>;
  activeArtifactPreviewTab: ArtifactPreviewTab | null;
  activeSpecialPreviewTab: ArtifactSpecialTab;
  isNewTabPreviewTabOpen: boolean;
  renamingArtifactTabId: string | null;
  shouldShowArtifactAddButton: boolean;
  shouldPinArtifactAddTab: boolean;
  artifactTabsCanScrollLeft: boolean;
  artifactTabsCanScrollRight: boolean;
  artifactTabActionTargets: ArtifactTabActionTarget[];
  onActivateFileListTab: () => void;
  onCloseFileListTab: () => void;
  onActivateBrowserTab: (tabId: string) => void;
  onCloseBrowserTab: (tabId: string) => void;
  onStartArtifactTabRename: (tabId: string) => void;
  onCancelArtifactTabRename: (tabId: string) => void;
  onCommitArtifactTabRename: (artifact: Artifact, nextStem: string) => Promise<boolean>;
  onActivateArtifactTab: (tabId: string) => void;
  onCloseArtifactTab: (tabId: string) => void;
  onActivateNewTab: () => void;
  onCloseNewTab: () => void;
  onOpenNewTab: () => void;
  onToggleExpanded: () => void;
  onTogglePanel: () => void;
}

const HomeArtifactPanelHeader: React.FC<HomeArtifactPanelHeaderProps> = ({
  isPanelOpen,
  isArtifactPanelVisible,
  isArtifactPanelTransitioning,
  isArtifactPanelExpanded,
  artifactHeaderWidth,
  needsMacTrafficLightInsetWhenExpanded = false,
  artifactTabsScrollRef,
  isFileListPreviewTabOpen,
  browserTabs,
  activeBrowserTabId,
  artifactTabsWithArtifacts,
  activeArtifactPreviewTab,
  activeSpecialPreviewTab,
  isNewTabPreviewTabOpen,
  renamingArtifactTabId,
  shouldShowArtifactAddButton,
  shouldPinArtifactAddTab,
  artifactTabsCanScrollLeft,
  artifactTabsCanScrollRight,
  artifactTabActionTargets,
  onActivateFileListTab,
  onCloseFileListTab,
  onActivateBrowserTab,
  onCloseBrowserTab,
  onStartArtifactTabRename,
  onCancelArtifactTabRename,
  onCommitArtifactTabRename,
  onActivateArtifactTab,
  onCloseArtifactTab,
  onActivateNewTab,
  onCloseNewTab,
  onOpenNewTab,
  onToggleExpanded,
  onTogglePanel,
}) => {
  const toggleArtifactPanelShortcutHint = useShortcutHint(ShortcutAction.ToggleArtifacts);
  const expandArtifactPanelLabel = isArtifactPanelExpanded
    ? i18nService.t('artifactBrowserRestorePanelWidth')
    : i18nService.t('artifactBrowserExpandPanel');
  const toggleArtifactPanelLabel = isPanelOpen
    ? i18nService.t('artifactPanelHide')
    : i18nService.t('artifactPanelShow');

  return (
    <div
      className={`flex h-full shrink-0 items-center justify-end gap-1 ${
        isArtifactPanelTransitioning && !isArtifactPanelExpanded
          ? 'overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none'
          : ''
      } ${
        isArtifactPanelVisible
          ? isArtifactPanelExpanded
            ? '-mr-4 bg-background pr-4'
            : '-mr-4 border-l border-border bg-background pr-4'
          : isArtifactPanelTransitioning && !isArtifactPanelExpanded
            ? '-mr-4 pr-4'
            : ''
      }`}
      style={artifactHeaderWidth !== undefined ? { width: artifactHeaderWidth } : undefined}
    >
      {isArtifactPanelVisible && (
        <div className="flex h-full min-w-0 flex-1 items-center">
          <div className="relative flex h-full min-w-0 flex-1">
            <div
              ref={artifactTabsScrollRef}
              className="scrollbar-hidden flex h-full min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
            >
              <div className={`flex h-full min-w-0 flex-1 items-center gap-1 pr-3 ${
                isArtifactPanelExpanded
                  ? needsMacTrafficLightInsetWhenExpanded
                    ? MAC_TRAFFIC_LIGHT_INSET_CLASS
                    : 'pl-3'
                  : 'pl-4'
              }`}
              >
                {isFileListPreviewTabOpen && (
                  <ArtifactPreviewTabItem
                    active={!activeArtifactPreviewTab && activeSpecialPreviewTab === ArtifactSpecialTab.FileList}
                    icon={<WorkspaceFilesIcon className="h-3.5 w-3.5" />}
                    label={i18nService.t('artifactFiles')}
                    closeLabel={i18nService.t('artifactCloseTab')}
                    onActivate={onActivateFileListTab}
                    onClose={onCloseFileListTab}
                    {...artifactTabMenuActions(artifactTabActionTargets, ArtifactSpecialTab.FileList)}
                  />
                )}
                {browserTabs.map(tab => (
                  <ArtifactPreviewTabItem
                    key={tab.id}
                    active={!activeArtifactPreviewTab
                      && activeSpecialPreviewTab === ArtifactSpecialTab.Browser
                      && activeBrowserTabId === tab.id}
                    icon={<ArtifactBrowserIcon className="h-3.5 w-3.5 text-[#0EA5E9] dark:text-[#38BDF8]" />}
                    label={getBrowserPreviewTabLabel(tab, i18nService.t('artifactBrowserTab'))}
                    closeLabel={i18nService.t('artifactCloseTab')}
                    onActivate={() => onActivateBrowserTab(tab.id)}
                    onClose={() => onCloseBrowserTab(tab.id)}
                    {...artifactTabMenuActions(artifactTabActionTargets, tab.id)}
                  />
                ))}
                {artifactTabsWithArtifacts.map(({ tab, artifact }) => {
                  const fileName = artifact.fileName || artifact.title;
                  const renamable = canRenameArtifactFile(artifact);
                  return (
                    <ArtifactPreviewTabItem
                      key={tab.id}
                      active={tab.id === activeArtifactPreviewTab?.id}
                      icon={<FileTypeIcon fileName={fileName} className="h-3.5 w-3.5" />}
                      label={fileName}
                      closeLabel={i18nService.t('artifactCloseTab')}
                      canRename={renamable}
                      isRenaming={renamingArtifactTabId === tab.id}
                      onStartRename={renamable ? () => onStartArtifactTabRename(tab.id) : undefined}
                      onCancelRename={() => onCancelArtifactTabRename(tab.id)}
                      onCommitRename={renamable ? (nextStem) => onCommitArtifactTabRename(artifact, nextStem) : undefined}
                      onActivate={() => onActivateArtifactTab(tab.id)}
                      onClose={() => onCloseArtifactTab(tab.id)}
                      {...artifactTabMenuActions(artifactTabActionTargets, tab.id)}
                    />
                  );
                })}
                {isNewTabPreviewTabOpen && (
                  <ArtifactPreviewTabItem
                    active={!activeArtifactPreviewTab && activeSpecialPreviewTab === ArtifactSpecialTab.NewTab}
                    icon={<ArtifactTabPlusIcon className="h-3.5 w-3.5" />}
                    label={i18nService.t('artifactNewTabTitle')}
                    closeLabel={i18nService.t('artifactCloseTab')}
                    onActivate={onActivateNewTab}
                    onClose={onCloseNewTab}
                    {...artifactTabMenuActions(artifactTabActionTargets, ArtifactSpecialTab.NewTab)}
                  />
                )}
                {shouldShowArtifactAddButton && (
                  shouldPinArtifactAddTab ? (
                    <div className="h-full w-9 shrink-0" aria-hidden="true" />
                  ) : (
                    <div
                      data-skin-artifact-add-tab="true"
                      className="z-20 flex h-full shrink-0 items-center bg-background pl-1 pr-1"
                    >
                      <Tooltip
                        portal
                        content={i18nService.t('artifactAddTab')}
                        position={TooltipPosition.Bottom}
                        align={TooltipAlign.Center}
                        delay={300}
                        bubbleClassName={TOOLTIP_DARK_BUBBLE_CLASS_NAME}
                        className="non-draggable shrink-0"
                      >
                        <button
                          type="button"
                          onClick={onOpenNewTab}
                          className="non-draggable inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface hover:text-foreground"
                          aria-label={i18nService.t('artifactAddTab')}
                        >
                          <ArtifactTabPlusIcon className="h-4 w-4" />
                        </button>
                      </Tooltip>
                    </div>
                  )
                )}
              </div>
            </div>
            {shouldPinArtifactAddTab && (
              <div
                data-skin-artifact-add-tab="true"
                className="absolute inset-y-0 right-0 z-20 flex items-center bg-background pl-1 pr-1"
              >
                <Tooltip
                  portal
                  content={i18nService.t('artifactAddTab')}
                  position={TooltipPosition.Bottom}
                  align={TooltipAlign.Center}
                  delay={300}
                  bubbleClassName={TOOLTIP_DARK_BUBBLE_CLASS_NAME}
                  className="non-draggable shrink-0"
                >
                  <button
                    type="button"
                    onClick={onOpenNewTab}
                    className="non-draggable inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface hover:text-foreground"
                    aria-label={i18nService.t('artifactAddTab')}
                  >
                    <ArtifactTabPlusIcon className="h-4 w-4" />
                  </button>
                </Tooltip>
              </div>
            )}
            {(artifactTabsCanScrollLeft || artifactTabsCanScrollRight) && (
              <>
                {artifactTabsCanScrollLeft && (
                  <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-12 bg-gradient-to-r from-background from-[34%] via-background/80 via-[66%] to-transparent backdrop-blur-sm [mask-image:linear-gradient(to_right,black_0%,black_40%,rgba(0,0,0,0.75)_72%,transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,black_0%,black_40%,rgba(0,0,0,0.75)_72%,transparent_100%)]" />
                )}
                {artifactTabsCanScrollRight && (
                  <div className={`pointer-events-none absolute inset-y-0 z-10 w-12 bg-gradient-to-l from-background from-[18%] via-background/80 via-[58%] to-transparent backdrop-blur-sm [mask-image:linear-gradient(to_left,black_0%,black_30%,rgba(0,0,0,0.75)_68%,transparent_100%)] [-webkit-mask-image:linear-gradient(to_left,black_0%,black_30%,rgba(0,0,0,0.75)_68%,transparent_100%)] ${
                    shouldPinArtifactAddTab ? 'right-[36px]' : 'right-0'
                  }`}
                  />
                )}
              </>
            )}
          </div>
        </div>
      )}
      {isPanelOpen && (
        <Tooltip
          portal
          content={expandArtifactPanelLabel}
          position={TooltipPosition.Bottom}
          align={TooltipAlign.End}
          delay={300}
          bubbleClassName={TOOLTIP_DARK_BUBBLE_CLASS_NAME}
          className="non-draggable shrink-0"
        >
          <button
            type="button"
            onClick={onToggleExpanded}
            className={`non-draggable relative inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
              isArtifactPanelExpanded
                ? 'bg-surface-raised text-foreground hover:bg-surface-hover'
                : 'text-secondary hover:bg-surface-raised hover:text-foreground'
            }`}
            aria-label={expandArtifactPanelLabel}
          >
            {isArtifactPanelExpanded ? (
              <PanelRestoreIcon className="h-4 w-4" />
            ) : (
              <PanelExpandIcon className="h-4 w-4" />
            )}
          </button>
        </Tooltip>
      )}
      <Tooltip
        portal
        content={(
          <span className="inline-flex items-center gap-1.5">
            <span>{toggleArtifactPanelLabel}</span>
            {toggleArtifactPanelShortcutHint && (
              <span className="rounded bg-white/15 px-1 py-0.5 text-[10px] leading-none text-white/80">
                {toggleArtifactPanelShortcutHint}
              </span>
            )}
          </span>
        )}
        position={TooltipPosition.Bottom}
        align={TooltipAlign.End}
        delay={300}
        bubbleClassName={TOOLTIP_DARK_BUBBLE_CLASS_NAME}
        className="non-draggable shrink-0"
      >
        <button
          type="button"
          onClick={onTogglePanel}
          data-home-artifact-panel-toggle="true"
          className="non-draggable relative h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
          aria-label={toggleArtifactPanelLabel}
        >
          <ArtifactPanelIcon className="h-4 w-4" open={isPanelOpen} />
        </button>
      </Tooltip>
    </div>
  );
};

export default HomeArtifactPanelHeader;
