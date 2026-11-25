import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

import { i18nService } from '../../services/i18n';
import { ArtifactSpecialTab, MAX_PANEL_WIDTH, MIN_PANEL_WIDTH } from '../../store/slices/artifactSlice';
import {
  ARTIFACT_HEADER_TRANSITION_MIN_WIDTH,
  ARTIFACT_PANEL_RESIZE_HANDLE_WIDTH,
  ArtifactPanelIcon,
  computeArtifactPanelLayout,
  computeArtifactPanelWidthBounds,
  CoworkArtifactScope,
  resolveHomePanelFallbackAfterClose,
} from './artifactPanelChrome';
import HomeArtifactPanelHeader from './HomeArtifactPanelHeader';

vi.hoisted(() => {
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    electron: { platform: 'darwin' },
  });
});

vi.mock('../agentSidebar/useShortcutHint', () => ({
  useShortcutHint: () => '⇧⌘B',
}));

describe('artifactPanelChrome layout and fallback logic', () => {
  test('computes panel min/max width bounds within workspace constraints', () => {
    const standard = computeArtifactPanelWidthBounds(1200);
    expect(standard.minWidth).toBe(200);
    expect(standard.maxWidth).toBe(716);

    const wide = computeArtifactPanelWidthBounds(2000);
    expect(wide.maxWidth).toBe(MAX_PANEL_WIDTH);
    expect(wide.minWidth).toBe(333);

    const narrow = computeArtifactPanelWidthBounds(500);
    expect(narrow.minWidth).toBe(MIN_PANEL_WIDTH);
    expect(narrow.maxWidth).toBe(MIN_PANEL_WIDTH);
  });

  test('computes closed, split, transitioning, and expanded layout metrics', () => {
    const closed = computeArtifactPanelLayout({
      panelWidth: 560,
      contentRowWidth: 1200,
      artifactPanelMinWidth: 200,
      artifactPanelMaxWidth: 716,
      isArtifactPanelVisible: false,
      isArtifactPanelTransitioning: false,
      isArtifactPanelExpanded: false,
      isExpandedPromptInputHidden: false,
      promptInputAreaHeight: 140,
    });
    expect(closed.artifactPanelFrameWidth).toBe(0);
    expect(closed.artifactHeaderWidth).toBeUndefined();
    expect(closed.artifactPanelIsOverlay).toBe(false);

    const transitioning = computeArtifactPanelLayout({
      panelWidth: 560,
      contentRowWidth: 1200,
      artifactPanelMinWidth: 200,
      artifactPanelMaxWidth: 716,
      isArtifactPanelVisible: false,
      isArtifactPanelTransitioning: true,
      isArtifactPanelExpanded: false,
      isExpandedPromptInputHidden: false,
      promptInputAreaHeight: 140,
    });
    expect(transitioning.artifactHeaderWidth).toBe(ARTIFACT_HEADER_TRANSITION_MIN_WIDTH);

    const split = computeArtifactPanelLayout({
      panelWidth: 560,
      contentRowWidth: 1200,
      artifactPanelMinWidth: 200,
      artifactPanelMaxWidth: 716,
      isArtifactPanelVisible: true,
      isArtifactPanelTransitioning: false,
      isArtifactPanelExpanded: false,
      isExpandedPromptInputHidden: false,
      promptInputAreaHeight: 140,
    });
    expect(split.artifactPanelFrameWidth).toBe(560 + ARTIFACT_PANEL_RESIZE_HANDLE_WIDTH);
    expect(split.artifactHeaderWidth).toBe(560);
    expect(split.artifactPanelInnerWidth).toBe(560 + ARTIFACT_PANEL_RESIZE_HANDLE_WIDTH);

    const expanded = computeArtifactPanelLayout({
      panelWidth: 560,
      contentRowWidth: 1200,
      artifactPanelMinWidth: 200,
      artifactPanelMaxWidth: 716,
      isArtifactPanelVisible: true,
      isArtifactPanelTransitioning: false,
      isArtifactPanelExpanded: true,
      isExpandedPromptInputHidden: false,
      promptInputAreaHeight: 140,
    });
    expect(expanded.artifactPanelIsOverlay).toBe(true);
    expect(expanded.artifactHeaderWidth).toBe(1200);
    expect(expanded.artifactPanelOverlayBottom).toBe(140);
    expect(expanded.artifactPanelInnerWidth).toBe('100%');

    const expandedHiddenInput = computeArtifactPanelLayout({
      panelWidth: 560,
      contentRowWidth: 1200,
      artifactPanelMinWidth: 200,
      artifactPanelMaxWidth: 716,
      isArtifactPanelVisible: true,
      isArtifactPanelTransitioning: false,
      isArtifactPanelExpanded: true,
      isExpandedPromptInputHidden: true,
      promptInputAreaHeight: 140,
    });
    expect(expandedHiddenInput.artifactPanelOverlayBottom).toBe(0);
  });

  test('resolves next active tab or closes panel when closing a home special tab', () => {
    expect(CoworkArtifactScope.Home).toBe('__home__');

    expect(resolveHomePanelFallbackAfterClose(ArtifactSpecialTab.NewTab, {
      firstArtifactTabId: 'artifact:doc-1',
      hasFileListTab: true,
      hasBrowserTab: true,
      hasNewTab: false,
    })).toEqual({ kind: 'artifact', tabId: 'artifact:doc-1' });

    expect(resolveHomePanelFallbackAfterClose(ArtifactSpecialTab.NewTab, {
      firstArtifactTabId: null,
      hasFileListTab: true,
      hasBrowserTab: true,
      hasNewTab: false,
    })).toEqual({ kind: 'special', tab: ArtifactSpecialTab.FileList });

    expect(resolveHomePanelFallbackAfterClose(ArtifactSpecialTab.FileList, {
      firstArtifactTabId: null,
      hasFileListTab: false,
      hasBrowserTab: true,
      hasNewTab: true,
    })).toEqual({ kind: 'special', tab: ArtifactSpecialTab.Browser });

    expect(resolveHomePanelFallbackAfterClose(ArtifactSpecialTab.Browser, {
      firstArtifactTabId: null,
      hasFileListTab: false,
      hasBrowserTab: false,
      hasNewTab: true,
    })).toEqual({ kind: 'special', tab: ArtifactSpecialTab.NewTab });

    expect(resolveHomePanelFallbackAfterClose(ArtifactSpecialTab.NewTab, {
      firstArtifactTabId: null,
      hasFileListTab: false,
      hasBrowserTab: false,
      hasNewTab: false,
    })).toEqual({ kind: 'close' });
  });
});

describe('HomeArtifactPanelHeader rendering', () => {
  const baseProps = {
    isPanelOpen: false,
    isArtifactPanelVisible: false,
    isArtifactPanelTransitioning: false,
    isArtifactPanelExpanded: false,
    artifactHeaderWidth: undefined,
    artifactTabsScrollRef: { current: null },
    isFileListPreviewTabOpen: false,
    browserTabs: [],
    activeBrowserTabId: null,
    artifactTabsWithArtifacts: [],
    activeArtifactPreviewTab: null,
    activeSpecialPreviewTab: ArtifactSpecialTab.NewTab,
    isNewTabPreviewTabOpen: false,
    renamingArtifactTabId: null,
    shouldShowArtifactAddButton: true,
    shouldPinArtifactAddTab: false,
    artifactTabsCanScrollLeft: false,
    artifactTabsCanScrollRight: false,
    artifactTabActionTargets: [],
    onActivateFileListTab: vi.fn(),
    onCloseFileListTab: vi.fn(),
    onActivateBrowserTab: vi.fn(),
    onCloseBrowserTab: vi.fn(),
    onStartArtifactTabRename: vi.fn(),
    onCancelArtifactTabRename: vi.fn(),
    onCommitArtifactTabRename: vi.fn(async () => true),
    onActivateArtifactTab: vi.fn(),
    onCloseArtifactTab: vi.fn(),
    onActivateNewTab: vi.fn(),
    onCloseNewTab: vi.fn(),
    onOpenNewTab: vi.fn(),
    onToggleExpanded: vi.fn(),
    onTogglePanel: vi.fn(),
  };

  test('renders the right-panel toggle button in closed state with collapsed icon divider', () => {
    i18nService.setLanguage('zh', { persist: false });
    const html = renderToStaticMarkup(React.createElement(HomeArtifactPanelHeader, baseProps));
    expect(html).toContain('data-home-artifact-panel-toggle="true"');
    expect(html).toContain(`aria-label="${i18nService.t('artifactPanelShow')}"`);
    expect(html).toContain('x1="12.5"');
    expect(html).not.toContain(`aria-label="${i18nService.t('artifactBrowserExpandPanel')}"`);
  });

  test('renders tabs, expand control, and open icon divider when panel is open', () => {
    i18nService.setLanguage('zh', { persist: false });
    const html = renderToStaticMarkup(
      React.createElement(HomeArtifactPanelHeader, {
        ...baseProps,
        isPanelOpen: true,
        isArtifactPanelVisible: true,
        artifactHeaderWidth: 560,
        isNewTabPreviewTabOpen: true,
        shouldShowArtifactAddButton: false,
      }),
    );
    expect(html).toContain(`aria-label="${i18nService.t('artifactPanelHide')}"`);
    expect(html).toContain(`aria-label="${i18nService.t('artifactBrowserExpandPanel')}"`);
    expect(html).toContain(i18nService.t('artifactNewTabTitle'));
    expect(html).toContain('x1="10.5"');
    expect(html).toContain('border-l border-border');
  });

  test('shifts divider line in ArtifactPanelIcon based on open prop', () => {
    const closedSvg = renderToStaticMarkup(React.createElement(ArtifactPanelIcon, { open: false }));
    const openSvg = renderToStaticMarkup(React.createElement(ArtifactPanelIcon, { open: true }));
    expect(closedSvg).toContain('x1="12.5"');
    expect(openSvg).toContain('x1="10.5"');
  });
});
