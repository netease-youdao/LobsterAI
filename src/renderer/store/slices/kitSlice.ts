import { createSlice, PayloadAction } from '@reduxjs/toolkit';

import type { InstalledKit, MarketplaceKit } from '../../types/kit';
import { resetAccountSessionData } from '../accountSessionBoundary';

interface KitState {
  installedKits: Record<string, InstalledKit>;
  marketplaceKits: MarketplaceKit[];
  activeKitIds: string[];
}

const initialState: KitState = {
  installedKits: {},
  marketplaceKits: [],
  activeKitIds: [],
};

const kitSlice = createSlice({
  name: 'kit',
  initialState,
  reducers: {
    setInstalledKits: (state, action: PayloadAction<Record<string, InstalledKit>>) => {
      state.installedKits = action.payload;
      // Remove active kits that are no longer installed
      state.activeKitIds = state.activeKitIds.filter(id => id in action.payload);
    },
    setMarketplaceKits: (state, action: PayloadAction<MarketplaceKit[]>) => {
      state.marketplaceKits = action.payload;
    },
    toggleActiveKit: (state, action: PayloadAction<string>) => {
      const index = state.activeKitIds.indexOf(action.payload);
      if (index === -1) {
        state.activeKitIds.push(action.payload);
      } else {
        state.activeKitIds.splice(index, 1);
      }
    },
    setActiveKitIds: (state, action: PayloadAction<string[]>) => {
      state.activeKitIds = action.payload;
    },
    clearActiveKits: (state) => {
      state.activeKitIds = [];
    },
  },
  extraReducers: builder => {
    builder.addCase(resetAccountSessionData, state => { state.activeKitIds = []; });
  },
});

export const {
  setInstalledKits,
  setMarketplaceKits,
  toggleActiveKit,
  setActiveKitIds,
  clearActiveKits,
} = kitSlice.actions;

export default kitSlice.reducer;
