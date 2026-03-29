import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { ActiveArtifact } from '../../types/artifact';

export const PANEL_MIN_WIDTH = 300;
export const PANEL_MAX_WIDTH = 800;

export interface ArtifactState {
  activeArtifact: ActiveArtifact | null;
  panelWidth: number;
}

const initialState: ArtifactState = {
  activeArtifact: null,
  panelWidth: 450,
};

const artifactSlice = createSlice({
  name: 'artifact',
  initialState,
  reducers: {
    setActiveArtifact(state, action: PayloadAction<ActiveArtifact>) {
      state.activeArtifact = action.payload;
    },
    clearActiveArtifact(state) {
      state.activeArtifact = null;
    },
    setPanelWidth(state, action: PayloadAction<number>) {
      state.panelWidth = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, action.payload));
    },
  },
});

export const { setActiveArtifact, clearActiveArtifact, setPanelWidth } = artifactSlice.actions;

export const selectActiveArtifact = (state: { artifact: ArtifactState }): ActiveArtifact | null =>
  state.artifact.activeArtifact;

export const selectArtifactPanelWidth = (state: { artifact: ArtifactState }): number =>
  state.artifact.panelWidth;

export default artifactSlice.reducer;
