import { createSlice, PayloadAction } from '@reduxjs/toolkit';

import {
  ShareDeploymentCandidateSource,
  type ShareDeploymentProjectCandidate,
} from '../../../shared/shareDeployment/constants';
import {
  dedupeArtifactsForDisplay,
  dedupeArtifactsWithinMessages,
  getLocalServicePortIdentityKey,
  normalizeFilePathForDedup,
  normalizeProjectDirectoryForDedup,
  resolveArtifactIdForDisplay,
  shouldPreferArtifactForDisplay,
} from '../../services/artifactParser';
import { type Artifact, ArtifactTypeValue } from '../../types/artifact';
import type { RootState } from '../index';

const DEFAULT_PANEL_WIDTH = 560;
const MIN_PANEL_WIDTH = 180;
const MAX_PANEL_WIDTH = 1000;

export const ArtifactContentView = {
  Preview: 'preview',
  Code: 'code',
} as const;
export type ArtifactContentView = typeof ArtifactContentView[keyof typeof ArtifactContentView];

export const ArtifactSpecialTab = {
  FileList: 'fileList',
  Browser: 'browser',
  AgentBrowser: 'agentBrowser',
  Subagents: 'subagents',
  UserAttachment: 'userAttachment',
} as const;
export type ArtifactSpecialTab = typeof ArtifactSpecialTab[keyof typeof ArtifactSpecialTab];

export type ArtifactActiveTab = ArtifactContentView;

export interface ArtifactPreviewTab {
  id: string;
  artifactId: string;
  contentView: ArtifactContentView;
  openedAt: number;
}

export interface AddArtifactPayload {
  sessionId: string;
  artifact: Artifact;
  defaultProjectDirectory?: string;
}

interface UpdateLocalServiceProjectMetadataPayload {
  sessionId: string;
  artifactId: string;
  projectDirectory: string;
  projectCandidates: ShareDeploymentProjectCandidate[];
}

interface ArtifactState {
  artifactsBySession: Record<string, Artifact[]>;
  previewTabsBySession: Record<string, ArtifactPreviewTab[]>;
  activePreviewTabIdBySession: Record<string, string | null>;
  panelOpenBySession: Record<string, boolean>;
  selectedArtifactId: string | null;
  isPanelOpen: boolean;
  panelWidth: number;
}

const initialState: ArtifactState = {
  artifactsBySession: {},
  previewTabsBySession: {},
  activePreviewTabIdBySession: {},
  panelOpenBySession: {},
  selectedArtifactId: null,
  isPanelOpen: false,
  panelWidth: DEFAULT_PANEL_WIDTH,
};

const getPreviewTabId = (artifactId: string): string => `artifact:${artifactId}`;

const isMediaArtifact = (artifact: Artifact): boolean => (
  artifact.type === 'image' || artifact.type === 'video'
);

const isSameMessageArtifact = (left: Artifact, right: Artifact): boolean =>
  left.messageId === right.messageId;

const LOCAL_SERVICE_RESOLVED_CANDIDATE_SOURCES = new Set<string>([
  ShareDeploymentCandidateSource.Process,
  ShareDeploymentCandidateSource.ProcessCwd,
  ShareDeploymentCandidateSource.Cache,
  ShareDeploymentCandidateSource.ArtifactMetadata,
  ShareDeploymentCandidateSource.Workspace,
  ShareDeploymentCandidateSource.WorkspaceChild,
]);

const hasResolvedLocalServiceProjectMetadata = (artifact: Artifact): boolean => (
  artifact.type === ArtifactTypeValue.LocalService &&
  Boolean(artifact.localService?.projectCandidates?.some(candidate =>
    LOCAL_SERVICE_RESOLVED_CANDIDATE_SOURCES.has(candidate.source)
  ))
);

const getLocalServiceContextCandidateKey = (artifact: Artifact): string => (
  artifact.localService?.projectCandidates
    ?.filter(candidate => !LOCAL_SERVICE_RESOLVED_CANDIDATE_SOURCES.has(candidate.source))
    .map(candidate => [
      candidate.source,
      normalizeProjectDirectoryForDedup(candidate.directory),
      candidate.messageId || '',
      candidate.confidence,
    ].join(':'))
    .join('|') ?? ''
);

const preserveResolvedLocalServiceProjectMetadata = (
  current: Artifact,
  next: Artifact,
): Artifact => {
  if (
    current.type !== ArtifactTypeValue.LocalService ||
    next.type !== ArtifactTypeValue.LocalService ||
    !hasResolvedLocalServiceProjectMetadata(current) ||
    !current.localService ||
    !next.localService
  ) {
    return next;
  }
  if (getLocalServiceContextCandidateKey(current) !== getLocalServiceContextCandidateKey(next)) {
    return next;
  }
  return {
    ...next,
    localService: {
      ...next.localService,
      projectDirectory:
        current.localService.projectDirectory ?? next.localService?.projectDirectory,
      projectCandidates:
        current.localService.projectCandidates ?? next.localService?.projectCandidates,
    },
  };
};

const findArtifactSessionId = (state: ArtifactState, artifactId: string): string | null => {
  for (const [sessionId, artifacts] of Object.entries(state.artifactsBySession)) {
    if (artifacts.some(artifact => artifact.id === artifactId)) {
      return sessionId;
    }
  }
  return null;
};

const activatePreviewTab = (state: ArtifactState, sessionId: string, tabId: string | null) => {
  state.activePreviewTabIdBySession[sessionId] = tabId;
  if (!tabId) {
    state.selectedArtifactId = null;
    return;
  }

  const tab = state.previewTabsBySession[sessionId]?.find(item => item.id === tabId);
  state.selectedArtifactId = tab?.artifactId ?? null;
  state.isPanelOpen = true;
  state.panelOpenBySession[sessionId] = true;
};

const setPanelOpen = (state: ArtifactState, sessionId: string | undefined, isOpen: boolean) => {
  state.isPanelOpen = isOpen;
  if (sessionId) {
    state.panelOpenBySession[sessionId] = isOpen;
  }
};

const openPreviewTab = (state: ArtifactState, sessionId: string, artifactId: string) => {
  if (!state.previewTabsBySession[sessionId]) {
    state.previewTabsBySession[sessionId] = [];
  }

  const displayArtifactId = resolveArtifactIdForDisplay(
    state.artifactsBySession[sessionId] ?? [],
    artifactId,
  );
  const tabId = getPreviewTabId(displayArtifactId);
  const existing = state.previewTabsBySession[sessionId].find(tab => tab.id === tabId);
  if (!existing) {
    state.previewTabsBySession[sessionId].push({
      id: tabId,
      artifactId: displayArtifactId,
      contentView: ArtifactContentView.Preview,
      openedAt: Date.now(),
    });
  }

  activatePreviewTab(state, sessionId, tabId);
};

const replacePreviewTabArtifactId = (
  state: ArtifactState,
  sessionId: string,
  oldArtifactId: string,
  nextArtifactId: string,
) => {
  if (oldArtifactId === nextArtifactId) return;

  const oldTabId = getPreviewTabId(oldArtifactId);
  const nextTabId = getPreviewTabId(nextArtifactId);
  for (const tab of state.previewTabsBySession[sessionId] ?? []) {
    if (tab.artifactId === oldArtifactId) {
      tab.id = nextTabId;
      tab.artifactId = nextArtifactId;
    }
  }
  if (state.activePreviewTabIdBySession[sessionId] === oldTabId) {
    state.activePreviewTabIdBySession[sessionId] = nextTabId;
  }
  if (state.selectedArtifactId === oldArtifactId) {
    state.selectedArtifactId = nextArtifactId;
  }
};

const artifactSlice = createSlice({
  name: 'artifact',
  initialState,
  reducers: {
    setSessionArtifacts(state, action: PayloadAction<{ sessionId: string; artifacts: Artifact[] }>) {
      const artifacts = dedupeArtifactsWithinMessages(action.payload.artifacts);
      state.artifactsBySession[action.payload.sessionId] = artifacts;
      const knownIds = new Set(artifacts.map(artifact => artifact.id));
      const tabs = state.previewTabsBySession[action.payload.sessionId] ?? [];
      state.previewTabsBySession[action.payload.sessionId] = tabs.filter(tab => knownIds.has(tab.artifactId));
      const activeTabId = state.activePreviewTabIdBySession[action.payload.sessionId];
      if (activeTabId && !state.previewTabsBySession[action.payload.sessionId].some(tab => tab.id === activeTabId)) {
        activatePreviewTab(
          state,
          action.payload.sessionId,
          state.previewTabsBySession[action.payload.sessionId][0]?.id ?? null,
        );
      }
    },

    addArtifact(state, action: PayloadAction<AddArtifactPayload>) {
      const { sessionId, artifact, defaultProjectDirectory } = action.payload;
      if (!state.artifactsBySession[sessionId]) {
        state.artifactsBySession[sessionId] = [];
      }
      const existing = state.artifactsBySession[sessionId].findIndex(a => a.id === artifact.id);
      if (existing >= 0) {
        const old = state.artifactsBySession[sessionId][existing];
        if (artifact.content || !old.content || artifact.contentVersion !== old.contentVersion) {
          state.artifactsBySession[sessionId][existing] =
            preserveResolvedLocalServiceProjectMetadata(old, artifact);
        }
      } else {
        if (artifact.type === ArtifactTypeValue.LocalService) {
          const localServicePortKey = getLocalServicePortIdentityKey(artifact.url || artifact.content);
          const dupIndex = state.artifactsBySession[sessionId].findIndex(
            a => isSameMessageArtifact(a, artifact) &&
              a.type === ArtifactTypeValue.LocalService &&
              getLocalServicePortIdentityKey(a.url || a.content) === localServicePortKey
          );
          if (dupIndex >= 0) {
            const old = state.artifactsBySession[sessionId][dupIndex];
            if (shouldPreferArtifactForDisplay(artifact, old, { defaultProjectDirectory })) {
              state.artifactsBySession[sessionId][dupIndex] = artifact;
              replacePreviewTabArtifactId(state, sessionId, old.id, artifact.id);
            }
            return;
          }
        }

        // Deduplicate by filePath only within the same message. The conversation
        // stream intentionally keeps repeated resources in later replies visible.
        if (artifact.filePath) {
          const normalizedPath = normalizeFilePathForDedup(artifact.filePath);
          const dupIndex = state.artifactsBySession[sessionId].findIndex(
            a => isSameMessageArtifact(a, artifact) &&
              a.filePath &&
              normalizeFilePathForDedup(a.filePath) === normalizedPath
          );
          if (dupIndex >= 0) {
            const old = state.artifactsBySession[sessionId][dupIndex];
            if (artifact.content || !old.content || artifact.contentVersion !== old.contentVersion) {
              state.artifactsBySession[sessionId][dupIndex] = artifact;
              replacePreviewTabArtifactId(state, sessionId, old.id, artifact.id);
            }
            return;
          }
        }
        if (artifact.filePath && artifact.remoteUrl && isMediaArtifact(artifact)) {
          const dupIndex = state.artifactsBySession[sessionId].findIndex(
            a => isSameMessageArtifact(a, artifact) &&
              !a.filePath &&
              a.type === artifact.type &&
              a.content === artifact.remoteUrl
          );
          if (dupIndex >= 0) {
            const old = state.artifactsBySession[sessionId][dupIndex];
            state.artifactsBySession[sessionId][dupIndex] = artifact;
            replacePreviewTabArtifactId(state, sessionId, old.id, artifact.id);
            return;
          }
        }
        if (!artifact.filePath && isMediaArtifact(artifact) && artifact.content) {
          const localExists = state.artifactsBySession[sessionId].some(
            a => isSameMessageArtifact(a, artifact) &&
              a.type === artifact.type &&
              a.filePath &&
              a.remoteUrl === artifact.content
          );
          if (localExists) return;
          const dupIndex = state.artifactsBySession[sessionId].findIndex(
            a => isSameMessageArtifact(a, artifact) &&
              !a.filePath &&
              a.type === artifact.type &&
              a.content === artifact.content
          );
          if (dupIndex >= 0) {
            const old = state.artifactsBySession[sessionId][dupIndex];
            if (artifact.content || !old.content) {
              state.artifactsBySession[sessionId][dupIndex] = artifact;
            }
            return;
          }
        }
        state.artifactsBySession[sessionId].push(artifact);
      }
    },

    updateLocalServiceProjectMetadata(
      state,
      action: PayloadAction<UpdateLocalServiceProjectMetadataPayload>,
    ) {
      const { sessionId, artifactId, projectDirectory, projectCandidates } = action.payload;
      const artifact = state.artifactsBySession[sessionId]?.find(item => item.id === artifactId);
      if (artifact?.type !== ArtifactTypeValue.LocalService || !artifact.localService) return;
      artifact.localService.projectDirectory = projectDirectory;
      artifact.localService.projectCandidates = projectCandidates;
    },

    selectArtifact(state, action: PayloadAction<string | null>) {
      const artifactId = action.payload;
      if (!artifactId) {
        state.selectedArtifactId = null;
        for (const sessionId of Object.keys(state.activePreviewTabIdBySession)) {
          state.activePreviewTabIdBySession[sessionId] = null;
        }
        return;
      }
      const sessionId = findArtifactSessionId(state, artifactId);
      if (!sessionId) return;
      openPreviewTab(state, sessionId, artifactId);
    },

    openArtifactPreviewTab(state, action: PayloadAction<{ sessionId: string; artifactId: string }>) {
      openPreviewTab(state, action.payload.sessionId, action.payload.artifactId);
    },

    activateArtifactPreviewTab(state, action: PayloadAction<{ sessionId: string; tabId: string }>) {
      activatePreviewTab(state, action.payload.sessionId, action.payload.tabId);
    },

    activateArtifactFileListTab(state, action: PayloadAction<{ sessionId: string }>) {
      activatePreviewTab(state, action.payload.sessionId, null);
      setPanelOpen(state, action.payload.sessionId, true);
    },

    activateArtifactBrowserTab(state, action: PayloadAction<{ sessionId: string }>) {
      activatePreviewTab(state, action.payload.sessionId, null);
      setPanelOpen(state, action.payload.sessionId, true);
    },

    activateArtifactAgentBrowserTab(state, action: PayloadAction<{ sessionId: string }>) {
      activatePreviewTab(state, action.payload.sessionId, null);
      setPanelOpen(state, action.payload.sessionId, true);
    },

    activateArtifactSubagentTab(state, action: PayloadAction<{ sessionId: string }>) {
      activatePreviewTab(state, action.payload.sessionId, null);
      setPanelOpen(state, action.payload.sessionId, true);
    },

    activateArtifactUserAttachmentTab(state, action: PayloadAction<{ sessionId: string }>) {
      activatePreviewTab(state, action.payload.sessionId, null);
      setPanelOpen(state, action.payload.sessionId, true);
    },

    closeArtifactPreviewTab(state, action: PayloadAction<{ sessionId: string; tabId: string }>) {
      const { sessionId, tabId } = action.payload;
      const tabs = state.previewTabsBySession[sessionId] ?? [];
      const closingIndex = tabs.findIndex(tab => tab.id === tabId);
      if (closingIndex < 0) return;

      state.previewTabsBySession[sessionId] = tabs.filter(tab => tab.id !== tabId);
      if (state.activePreviewTabIdBySession[sessionId] !== tabId) return;

      const remainingTabs = state.previewTabsBySession[sessionId];
      const nextTab = remainingTabs[Math.min(closingIndex, remainingTabs.length - 1)] ?? null;
      activatePreviewTab(state, sessionId, nextTab?.id ?? null);
    },

    setPreviewTabContentView(state, action: PayloadAction<{ sessionId: string; tabId: string; contentView: ArtifactContentView }>) {
      const tab = state.previewTabsBySession[action.payload.sessionId]?.find(item => item.id === action.payload.tabId);
      if (tab) {
        tab.contentView = action.payload.contentView;
      }
    },

    togglePanel(state, action: PayloadAction<{ sessionId?: string } | undefined>) {
      const sessionId = action.payload?.sessionId;
      const currentOpen = sessionId
        ? state.panelOpenBySession[sessionId] ?? false
        : state.isPanelOpen;
      setPanelOpen(state, sessionId, !currentOpen);
    },

    closePanel(state, action: PayloadAction<{ sessionId?: string } | undefined>) {
      setPanelOpen(state, action.payload?.sessionId, false);
    },

    setActiveTab(state, action: PayloadAction<ArtifactActiveTab>) {
      const artifactId = state.selectedArtifactId;
      if (!artifactId) return;
      const sessionId = findArtifactSessionId(state, artifactId);
      if (!sessionId) return;
      const activeTabId = state.activePreviewTabIdBySession[sessionId];
      const tab = state.previewTabsBySession[sessionId]?.find(item => item.id === activeTabId);
      if (tab) {
        tab.contentView = action.payload;
      }
    },

    setPanelWidth(state, action: PayloadAction<number>) {
      state.panelWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, action.payload));
    },

    clearSessionArtifacts(state, action: PayloadAction<string>) {
      delete state.artifactsBySession[action.payload];
      delete state.previewTabsBySession[action.payload];
      delete state.activePreviewTabIdBySession[action.payload];
      delete state.panelOpenBySession[action.payload];
      state.selectedArtifactId = null;
    },
  },
});

export const {
  setSessionArtifacts,
  addArtifact,
  updateLocalServiceProjectMetadata,
  selectArtifact,
  openArtifactPreviewTab,
  activateArtifactBrowserTab,
  activateArtifactAgentBrowserTab,
  activateArtifactSubagentTab,
  activateArtifactUserAttachmentTab,
  activateArtifactPreviewTab,
  activateArtifactFileListTab,
  closeArtifactPreviewTab,
  setPreviewTabContentView,
  togglePanel,
  closePanel,
  setActiveTab,
  setPanelWidth,
  clearSessionArtifacts,
} = artifactSlice.actions;

export const selectSessionArtifacts = (state: RootState, sessionId: string): Artifact[] =>
  dedupeArtifactsForDisplay(state.artifact.artifactsBySession[sessionId] ?? []);

export const selectSelectedArtifact = (state: RootState): Artifact | null => {
  const id = state.artifact.selectedArtifactId;
  if (!id) return null;
  for (const artifacts of Object.values(state.artifact.artifactsBySession)) {
    const found = artifacts.find(a => a.id === id);
    if (found) return found;
  }
  return null;
};

export const selectIsPanelOpen = (state: RootState, sessionId?: string | null): boolean => {
  if (sessionId) {
    return state.artifact.panelOpenBySession[sessionId] ?? false;
  }
  return state.artifact.isPanelOpen;
};
export const selectPanelWidth = (state: RootState): number => state.artifact.panelWidth;

export const selectPreviewTabs = (state: RootState, sessionId: string): ArtifactPreviewTab[] =>
  state.artifact.previewTabsBySession[sessionId] ?? [];

export const selectActivePreviewTab = (state: RootState, sessionId: string): ArtifactPreviewTab | null => {
  const activeTabId = state.artifact.activePreviewTabIdBySession[sessionId];
  if (!activeTabId) return null;
  return state.artifact.previewTabsBySession[sessionId]?.find(tab => tab.id === activeTabId) ?? null;
};

export const selectActiveTab = (state: RootState): ArtifactActiveTab => {
  const artifactId = state.artifact.selectedArtifactId;
  if (!artifactId) return ArtifactContentView.Preview;
  for (const [sessionId, tabs] of Object.entries(state.artifact.previewTabsBySession)) {
    const activeTabId = state.artifact.activePreviewTabIdBySession[sessionId];
    const tab = tabs.find(item => item.id === activeTabId && item.artifactId === artifactId);
    if (tab) return tab.contentView;
  }
  return ArtifactContentView.Preview;
};

export { DEFAULT_PANEL_WIDTH, MAX_PANEL_WIDTH, MIN_PANEL_WIDTH };

export default artifactSlice.reducer;
