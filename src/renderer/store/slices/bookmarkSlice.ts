import { createSlice, PayloadAction } from '@reduxjs/toolkit';

import type { Bookmark } from '../../types/cowork';

interface BookmarkState {
  bookmarks: Bookmark[];
  bookmarkedKeys: Record<string, string>; // `${sessionId}:${messageId}` → bookmarkId
  loading: boolean;
}

function buildBookmarkedKeys(bookmarks: Bookmark[]): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const bm of bookmarks) {
    keys[`${bm.sessionId}:${bm.messageId}`] = bm.id;
  }
  return keys;
}

const initialState: BookmarkState = {
  bookmarks: [],
  bookmarkedKeys: {},
  loading: false,
};

const bookmarkSlice = createSlice({
  name: 'bookmark',
  initialState,
  reducers: {
    setBookmarks(state, action: PayloadAction<Bookmark[]>) {
      state.bookmarks = action.payload;
      state.bookmarkedKeys = buildBookmarkedKeys(action.payload);
      state.loading = false;
    },
    setLoading(state, action: PayloadAction<boolean>) {
      state.loading = action.payload;
    },
    addBookmark(state, action: PayloadAction<Bookmark>) {
      state.bookmarks.unshift(action.payload);
      const bm = action.payload;
      state.bookmarkedKeys[`${bm.sessionId}:${bm.messageId}`] = bm.id;
    },
    removeBookmark(state, action: PayloadAction<string>) {
      const idx = state.bookmarks.findIndex(bm => bm.id === action.payload);
      if (idx !== -1) {
        const bm = state.bookmarks[idx];
        delete state.bookmarkedKeys[`${bm.sessionId}:${bm.messageId}`];
        state.bookmarks.splice(idx, 1);
      }
    },
  },
});

export const { setBookmarks, setLoading, addBookmark, removeBookmark } = bookmarkSlice.actions;
export default bookmarkSlice.reducer;
