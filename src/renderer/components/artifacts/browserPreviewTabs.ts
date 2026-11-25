import type { ShareDeploymentProjectCandidate } from '../../../shared/shareDeployment/constants';

export interface BrowserLocalServiceContext {
  artifactId?: string;
  url: string;
  origin: string;
  projectDirectory?: string;
  projectCandidates?: ShareDeploymentProjectCandidate[];
}

export interface BrowserPreviewTab {
  id: string;
  address: string;
  url: string;
  title: string;
  initialReferrer?: string;
  localServiceContext: BrowserLocalServiceContext | null;
  htmlPreviewArtifactId: string | null;
  htmlPreviewSessionId: string | null;
  htmlPreviewUrl: string | null;
}

export interface SessionBrowserTabsState {
  tabs: BrowserPreviewTab[];
  activeTabId: string | null;
}

export const EMPTY_SESSION_BROWSER_TABS_STATE: SessionBrowserTabsState = {
  tabs: [],
  activeTabId: null,
};

const BROWSER_TAB_ID_PREFIX = 'browser:';
const FALLBACK_HOST_PROTOCOLS = new Set(['http:', 'https:']);

export function createBrowserPreviewTabId(): string {
  return `${BROWSER_TAB_ID_PREFIX}${crypto.randomUUID()}`;
}

export function createBrowserPreviewTab(
  init: Partial<Omit<BrowserPreviewTab, 'id'>> & { id?: string } = {},
): BrowserPreviewTab {
  return {
    id: init.id ?? createBrowserPreviewTabId(),
    address: init.address ?? '',
    url: init.url ?? '',
    title: init.title ?? '',
    ...(init.initialReferrer ? { initialReferrer: init.initialReferrer } : {}),
    localServiceContext: init.localServiceContext ?? null,
    htmlPreviewArtifactId: init.htmlPreviewArtifactId ?? null,
    htmlPreviewSessionId: init.htmlPreviewSessionId ?? null,
    htmlPreviewUrl: init.htmlPreviewUrl ?? null,
  };
}

export function isBlankBrowserPreviewTab(tab: BrowserPreviewTab): boolean {
  return !tab.url.trim() && !tab.address.trim() && !tab.htmlPreviewArtifactId;
}

export function getActiveBrowserPreviewTab(
  state: SessionBrowserTabsState,
): BrowserPreviewTab | null {
  if (state.tabs.length === 0) return null;
  if (state.activeTabId) {
    const matched = state.tabs.find(tab => tab.id === state.activeTabId);
    if (matched) return matched;
  }
  return state.tabs[0] ?? null;
}

export function insertBrowserPreviewTabAfter(
  state: SessionBrowserTabsState,
  options: {
    afterTabId?: string | null;
    tab: BrowserPreviewTab;
    activate?: boolean;
  },
): SessionBrowserTabsState {
  const { afterTabId, tab, activate = true } = options;
  const afterIndex = afterTabId
    ? state.tabs.findIndex(item => item.id === afterTabId)
    : -1;
  const insertIndex = afterIndex >= 0 ? afterIndex + 1 : state.tabs.length;
  const tabs = [
    ...state.tabs.slice(0, insertIndex),
    tab,
    ...state.tabs.slice(insertIndex),
  ];
  const existingActiveValid = Boolean(
    state.activeTabId && tabs.some(item => item.id === state.activeTabId),
  );
  return {
    tabs,
    activeTabId: activate
      ? tab.id
      : existingActiveValid
        ? state.activeTabId
        : tab.id,
  };
}

export function openOrReuseBlankBrowserPreviewTab(
  state: SessionBrowserTabsState,
  options: {
    tab: BrowserPreviewTab;
    reuseBlank?: boolean;
  },
): { state: SessionBrowserTabsState; tabId: string } {
  const { tab, reuseBlank = false } = options;
  if (reuseBlank) {
    const activeTab = getActiveBrowserPreviewTab(state);
    const blankTarget = (activeTab && isBlankBrowserPreviewTab(activeTab) ? activeTab : null)
      ?? state.tabs.find(isBlankBrowserPreviewTab)
      ?? null;
    if (blankTarget) {
      const reused: BrowserPreviewTab = {
        ...tab,
        id: blankTarget.id,
      };
      return {
        state: {
          tabs: state.tabs.map(item => (item.id === blankTarget.id ? reused : item)),
          activeTabId: blankTarget.id,
        },
        tabId: blankTarget.id,
      };
    }
  }

  return {
    state: insertBrowserPreviewTabAfter(state, { tab, activate: true }),
    tabId: tab.id,
  };
}

export function activateBrowserPreviewTab(
  state: SessionBrowserTabsState,
  tabId?: string | null,
): SessionBrowserTabsState {
  if (state.tabs.length === 0) return state;
  if (tabId && state.tabs.some(tab => tab.id === tabId)) {
    if (state.activeTabId === tabId) return state;
    return { ...state, activeTabId: tabId };
  }
  const activeTab = getActiveBrowserPreviewTab(state);
  const nextActiveTabId = activeTab?.id ?? null;
  if (state.activeTabId === nextActiveTabId) return state;
  return { ...state, activeTabId: nextActiveTabId };
}

export function updateBrowserPreviewTab(
  state: SessionBrowserTabsState,
  tabId: string,
  updater: (tab: BrowserPreviewTab) => BrowserPreviewTab,
): SessionBrowserTabsState {
  let changed = false;
  const tabs = state.tabs.map(tab => {
    if (tab.id !== tabId) return tab;
    const next = updater(tab);
    if (next !== tab) changed = true;
    return next;
  });
  return changed ? { ...state, tabs } : state;
}

export function closeBrowserPreviewTab(
  state: SessionBrowserTabsState,
  tabId: string,
): {
  state: SessionBrowserTabsState;
  closedTab: BrowserPreviewTab | null;
  nextActiveTabId: string | null;
} {
  const closingIndex = state.tabs.findIndex(tab => tab.id === tabId);
  if (closingIndex < 0) {
    return {
      state,
      closedTab: null,
      nextActiveTabId: state.activeTabId,
    };
  }

  const closedTab = state.tabs[closingIndex];
  const remaining = state.tabs.filter(tab => tab.id !== tabId);
  let nextActiveTabId: string | null;
  if (state.activeTabId === tabId) {
    nextActiveTabId = remaining[Math.min(closingIndex, remaining.length - 1)]?.id ?? null;
  } else if (state.activeTabId && remaining.some(tab => tab.id === state.activeTabId)) {
    nextActiveTabId = state.activeTabId;
  } else {
    nextActiveTabId = remaining[0]?.id ?? null;
  }

  return {
    state: {
      tabs: remaining,
      activeTabId: nextActiveTabId,
    },
    closedTab,
    nextActiveTabId,
  };
}

export function getBrowserPreviewTabLabel(
  tab: Pick<BrowserPreviewTab, 'title' | 'url' | 'htmlPreviewArtifactId'>,
  fallbackLabel: string,
): string {
  const trimmedTitle = tab.title.trim();
  if (trimmedTitle) return trimmedTitle;

  if (!tab.htmlPreviewArtifactId && tab.url.trim()) {
    try {
      const parsed = new URL(tab.url.trim());
      if (FALLBACK_HOST_PROTOCOLS.has(parsed.protocol) && parsed.host) {
        return parsed.host;
      }
    } catch {
      // Fall through to the localized default label.
    }
  }

  return fallbackLabel;
}
