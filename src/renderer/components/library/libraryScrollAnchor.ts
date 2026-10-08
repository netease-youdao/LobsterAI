import { LibraryWindowRefreshLimits } from './libraryWindowRefresh';

export const LibraryScrollLimits = {
  AnchorCandidates: LibraryWindowRefreshLimits.AnchorCandidateLimit,
  Corrections: LibraryWindowRefreshLimits.AnchorCorrectionLimit,
  TopThresholdPx: LibraryWindowRefreshLimits.TopThresholdPx,
} as const;

export interface LibraryScrollAnchor {
  candidates: Array<{ itemKey: string; offsetTop: number }>;
  scrollTop: number;
  userGeneration: number;
  preferTarget?: boolean;
}

export interface LibraryScrollRestoration extends LibraryScrollAnchor {
  id: number;
  isCurrent: () => boolean;
}

export const captureLibraryScrollAnchor = (
  root: HTMLElement | null,
  userGeneration: number,
): LibraryScrollAnchor => {
  const anchor: LibraryScrollAnchor = {
    candidates: [],
    scrollTop: root?.scrollTop ?? 0,
    userGeneration,
  };
  if (!root || anchor.scrollTop <= LibraryScrollLimits.TopThresholdPx) return anchor;
  const rootTop = root.getBoundingClientRect().top;
  for (const element of root.querySelectorAll<HTMLElement>('[data-library-item-key]')) {
    const rect = element.getBoundingClientRect();
    if (rect.bottom <= rootTop || !element.dataset.libraryItemKey) continue;
    anchor.candidates.push({
      itemKey: element.dataset.libraryItemKey,
      offsetTop: rect.top - rootTop,
    });
    if (anchor.candidates.length >= LibraryScrollLimits.AnchorCandidates) break;
  }
  return anchor;
};

export const getLibrarySessionAnchorKey = (sessionId: string): string => `session:${sessionId}`;

export const captureLibrarySessionScrollAnchor = (
  root: HTMLElement | null,
  userGeneration: number,
  sessionId: string,
): LibraryScrollAnchor => {
  const itemKey = getLibrarySessionAnchorKey(sessionId);
  const header = root
    ? [...root.querySelectorAll<HTMLElement>('[data-library-anchor-key]')]
      .find(element => element.dataset.libraryAnchorKey === itemKey)
    : undefined;
  const rootRect = root?.getBoundingClientRect();
  const headerRect = header?.getBoundingClientRect();
  // A footer can be thousands of pixels below an unmounted header. Collapsing
  // must return to that surviving header, never restore a now-hidden file.
  const offsetTop = headerRect && rootRect
    && headerRect.top >= rootRect.top && headerRect.top < rootRect.bottom
    ? headerRect.top - rootRect.top
    : 0;
  return {
    candidates: [{ itemKey, offsetTop }],
    scrollTop: root?.scrollTop ?? 0,
    userGeneration,
    preferTarget: true,
  };
};

export const clampLibraryScrollTop = (scrollTop: number, root: Pick<HTMLElement, 'scrollHeight' | 'clientHeight'>): number => (
  Math.max(0, Math.min(scrollTop, Math.max(0, root.scrollHeight - root.clientHeight)))
);
