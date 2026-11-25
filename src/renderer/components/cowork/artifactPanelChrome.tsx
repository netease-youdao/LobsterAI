import React from 'react';

import type { CoworkSelectedTextValidationError } from '../../../shared/cowork/selectedText';
import {
  ArtifactSpecialTab,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
} from '../../store/slices/artifactSlice';

export const CoworkArtifactScope = {
  Home: '__home__',
} as const;
export type CoworkArtifactScope = typeof CoworkArtifactScope[keyof typeof CoworkArtifactScope];

export const ARTIFACT_PANEL_TRANSITION_MS = 200;
/** Width of the right-side panel controls (expand + toggle + right gutter) while transitioning. */
export const ARTIFACT_HEADER_TRANSITION_MIN_WIDTH = 88;
export const ARTIFACT_PANEL_RESIZE_HANDLE_WIDTH = 4;
export const COWORK_DETAIL_MIN_WIDTH = 480;
export const ARTIFACT_PANEL_MIN_WIDTH_RATIO = 1 / 6;

export const SELECTED_TEXT_ERROR_I18N_KEYS: Record<CoworkSelectedTextValidationError, string> = {
  empty: 'coworkSelectedTextInvalid',
  invalid: 'coworkSelectedTextInvalid',
  too_long: 'coworkSelectedTextTooLong',
  too_many: 'coworkSelectedTextTooMany',
  total_too_long: 'coworkSelectedTextTotalTooLong',
  duplicate: 'coworkSelectedTextDuplicate',
};

export interface ArtifactPanelWidthBounds {
  minWidth: number;
  maxWidth: number;
}

export function computeArtifactPanelWidthBounds(contentWidth: number): ArtifactPanelWidthBounds {
  const availablePanelWidth = contentWidth - COWORK_DETAIL_MIN_WIDTH - ARTIFACT_PANEL_RESIZE_HANDLE_WIDTH;
  const maxWidth = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, availablePanelWidth));
  const proportionalMinWidth = Math.floor(contentWidth * ARTIFACT_PANEL_MIN_WIDTH_RATIO);
  const minWidth = Math.min(maxWidth, Math.max(MIN_PANEL_WIDTH, proportionalMinWidth));
  return { minWidth, maxWidth };
}

export interface ArtifactPanelLayoutInput {
  panelWidth: number;
  contentRowWidth: number;
  artifactPanelMinWidth: number;
  artifactPanelMaxWidth: number;
  isArtifactPanelVisible: boolean;
  isArtifactPanelTransitioning: boolean;
  isArtifactPanelExpanded: boolean;
  isExpandedPromptInputHidden: boolean;
  promptInputAreaHeight: number;
}

export interface ArtifactPanelLayoutMetrics {
  artifactPanelContentWidth: number;
  artifactPanelFrameWidth: number;
  artifactHeaderWidth: number | undefined;
  artifactPanelRenderMinWidth: number;
  artifactPanelRenderMaxWidth: number;
  artifactPanelIsOverlay: boolean;
  artifactPanelOverlayBottom: number;
  artifactPanelInnerWidth: number | '100%';
}

export function computeArtifactPanelLayout(
  input: ArtifactPanelLayoutInput,
): ArtifactPanelLayoutMetrics {
  const defaultArtifactPanelContentWidth = Math.max(
    input.artifactPanelMinWidth,
    Math.min(input.panelWidth, input.artifactPanelMaxWidth),
  );
  const expandedArtifactPanelContentWidth = Math.max(
    MIN_PANEL_WIDTH,
    input.contentRowWidth - ARTIFACT_PANEL_RESIZE_HANDLE_WIDTH,
  );
  const artifactPanelContentWidth = input.isArtifactPanelExpanded
    ? expandedArtifactPanelContentWidth
    : defaultArtifactPanelContentWidth;
  const artifactPanelFrameWidth = input.isArtifactPanelVisible
    ? artifactPanelContentWidth + ARTIFACT_PANEL_RESIZE_HANDLE_WIDTH
    : 0;
  const artifactHeaderWidth = input.isArtifactPanelVisible
    ? input.isArtifactPanelExpanded && input.contentRowWidth > 0
      ? input.contentRowWidth
      : Math.max(0, artifactPanelFrameWidth - ARTIFACT_PANEL_RESIZE_HANDLE_WIDTH)
    : input.isArtifactPanelTransitioning && !input.isArtifactPanelExpanded
      ? ARTIFACT_HEADER_TRANSITION_MIN_WIDTH
      : undefined;
  const artifactPanelRenderMinWidth = input.isArtifactPanelExpanded
    ? expandedArtifactPanelContentWidth
    : input.artifactPanelMinWidth;
  const artifactPanelRenderMaxWidth = input.isArtifactPanelExpanded
    ? expandedArtifactPanelContentWidth
    : input.artifactPanelMaxWidth;
  const artifactPanelIsOverlay = input.isArtifactPanelVisible && input.isArtifactPanelExpanded;
  const artifactPanelOverlayBottom = artifactPanelIsOverlay && !input.isExpandedPromptInputHidden
    ? input.promptInputAreaHeight
    : 0;
  const artifactPanelInnerWidth = artifactPanelIsOverlay ? '100%' : artifactPanelFrameWidth;

  return {
    artifactPanelContentWidth,
    artifactPanelFrameWidth,
    artifactHeaderWidth,
    artifactPanelRenderMinWidth,
    artifactPanelRenderMaxWidth,
    artifactPanelIsOverlay,
    artifactPanelOverlayBottom,
    artifactPanelInnerWidth,
  };
}

export interface HomePanelFallbackState {
  firstArtifactTabId?: string | null;
  hasFileListTab: boolean;
  hasBrowserTab: boolean;
  hasNewTab: boolean;
}

export type HomePanelCloseFallback =
  | { kind: 'artifact'; tabId: string }
  | { kind: 'special'; tab: ArtifactSpecialTab }
  | { kind: 'close' };

export function resolveHomePanelFallbackAfterClose(
  closing: ArtifactSpecialTab,
  state: HomePanelFallbackState,
): HomePanelCloseFallback {
  if (state.firstArtifactTabId) {
    return { kind: 'artifact', tabId: state.firstArtifactTabId };
  }

  const orderByClosing: Record<string, ArtifactSpecialTab[]> = {
    [ArtifactSpecialTab.NewTab]: [ArtifactSpecialTab.FileList, ArtifactSpecialTab.Browser],
    [ArtifactSpecialTab.FileList]: [ArtifactSpecialTab.Browser, ArtifactSpecialTab.NewTab],
    [ArtifactSpecialTab.Browser]: [ArtifactSpecialTab.FileList, ArtifactSpecialTab.NewTab],
  };

  const candidates = orderByClosing[closing] ?? [
    ArtifactSpecialTab.FileList,
    ArtifactSpecialTab.Browser,
    ArtifactSpecialTab.NewTab,
  ];

  for (const candidate of candidates) {
    if (candidate === ArtifactSpecialTab.FileList && state.hasFileListTab) {
      return { kind: 'special', tab: ArtifactSpecialTab.FileList };
    }
    if (candidate === ArtifactSpecialTab.Browser && state.hasBrowserTab) {
      return { kind: 'special', tab: ArtifactSpecialTab.Browser };
    }
    if (candidate === ArtifactSpecialTab.NewTab && state.hasNewTab) {
      return { kind: 'special', tab: ArtifactSpecialTab.NewTab };
    }
  }

  return { kind: 'close' };
}

export const ArtifactPanelIcon: React.FC<React.SVGProps<SVGSVGElement> & { open?: boolean }> = ({ open, ...props }) => {
  const dividerX = open ? 10.5 : 12.5;
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="1.5" y="2" width="13" height="12" rx="2" />
      <line x1={dividerX} y1="2" x2={dividerX} y2="14" />
    </svg>
  );
};

export const PanelExpandIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M10 3h3v3" />
    <path d="M6 13H3v-3" />
    <path d="M9 7l4-4" />
    <path d="M7 9l-4 4" />
  </svg>
);

export const PanelRestoreIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M13.25 2.75l-4 4" />
    <path d="M9.25 3.75v3h3" />
    <path d="M2.75 13.25l4-4" />
    <path d="M3.75 9.25h3v3" />
  </svg>
);

export const PromptInputCollapseIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M4.5 6.25L8 9.75l3.5-3.5" />
  </svg>
);

export const PromptInputExpandIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M4.5 9.75L8 6.25l3.5 3.5" />
  </svg>
);

export const ArtifactTabPlusIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...props}>
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
);

export class ArtifactPanelErrorBoundary extends React.Component<
  { children: React.ReactNode; onClose: () => void },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode; onClose: () => void }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error) {
    console.error('[ArtifactPanel] render error:', error);
  }
  render() {
    if (this.state.hasError) {
      return (
        <aside className="w-[420px] shrink-0 border-l border-border bg-background flex flex-col h-full items-center justify-center p-4">
          <p className="text-sm text-red-500 mb-2">Artifact panel error</p>
          <pre className="text-xs text-muted whitespace-pre-wrap max-w-full overflow-auto mb-3">
            {this.state.error?.message}
          </pre>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); this.props.onClose(); }}
            className="px-3 py-1.5 text-xs rounded-lg bg-surface hover:bg-surface-hover text-foreground"
          >
            Close
          </button>
        </aside>
      );
    }
    return this.props.children;
  }
}
