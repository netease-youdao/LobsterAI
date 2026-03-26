import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { CoworkFavoriteItem } from '../../types/cowork';

interface FavoritesState {
  items: CoworkFavoriteItem[];
  favoritedMessageIds: Record<string, string[]>;
}

const initialState: FavoritesState = {
  items: [],
  favoritedMessageIds: {},
};

const favoritesSlice = createSlice({
  name: 'favorites',
  initialState,
  reducers: {
    setFavorites: (state, action: PayloadAction<CoworkFavoriteItem[]>) => {
      state.items = action.payload;
    },
    addFavoriteItem: (state, action: PayloadAction<CoworkFavoriteItem>) => {
      state.items.unshift(action.payload);
    },
    removeFavoriteItem: (state, action: PayloadAction<string>) => {
      state.items = state.items.filter((f) => f.messageId !== action.payload);
    },
    removeFavoriteItemById: (state, action: PayloadAction<string>) => {
      state.items = state.items.filter((f) => f.id !== action.payload);
    },
    setSessionFavoritedIds: (
      state,
      action: PayloadAction<{ sessionId: string; messageIds: string[] }>,
    ) => {
      state.favoritedMessageIds[action.payload.sessionId] = action.payload.messageIds;
    },
    addFavoritedMessageId: (
      state,
      action: PayloadAction<{ sessionId: string; messageId: string }>,
    ) => {
      const ids = state.favoritedMessageIds[action.payload.sessionId] ?? [];
      if (!ids.includes(action.payload.messageId)) {
        ids.push(action.payload.messageId);
      }
      state.favoritedMessageIds[action.payload.sessionId] = ids;
    },
    removeFavoritedMessageId: (
      state,
      action: PayloadAction<{ sessionId: string; messageId: string }>,
    ) => {
      const ids = state.favoritedMessageIds[action.payload.sessionId];
      if (ids) {
        state.favoritedMessageIds[action.payload.sessionId] = ids.filter(
          (id) => id !== action.payload.messageId,
        );
      }
    },
  },
});

export const {
  setFavorites,
  addFavoriteItem,
  removeFavoriteItem,
  removeFavoriteItemById,
  setSessionFavoritedIds,
  addFavoritedMessageId,
  removeFavoritedMessageId,
} = favoritesSlice.actions;

export default favoritesSlice.reducer;
