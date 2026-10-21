import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type { ImageEditOperation, ImageMark, ImageRegion, ImageVersion } from '../../../shared/imageEditing/types';

export interface ImageEditorDrawing { marks: ImageMark[]; mask: ImageMark[] }
export interface ImageEditorDocument extends ImageEditorDrawing { past: ImageEditorDrawing[]; future: ImageEditorDrawing[]; regions: ImageRegion[] }
export const EMPTY_IMAGE_DOCUMENT: ImageEditorDocument = { marks: [], mask: [], past: [], future: [], regions: [] };
interface ImageEditorFocus { id: string; source: ImageVersion; regionId?: string; operation?: ImageEditOperation }
const initialState: { documents: Record<string, ImageEditorDocument>; focus?: ImageEditorFocus } = { documents: {} };
const imageEditorSlice = createSlice({ name: 'imageEditor', initialState, reducers: {
  requestImageEditorFocus(state, action: PayloadAction<ImageEditorFocus>) { state.focus = action.payload; },
  consumeImageEditorFocus(state, action: PayloadAction<string>) {
    if (state.focus?.id === action.payload) state.focus = undefined;
  },
  commitImageDrawing(state, action: PayloadAction<{ key: string; drawing: ImageEditorDrawing }>) {
    const previous = state.documents[action.payload.key] ?? EMPTY_IMAGE_DOCUMENT;
    state.documents[action.payload.key] = { ...previous, ...action.payload.drawing,
      past: [...previous.past, { marks: previous.marks, mask: previous.mask }].slice(-50), future: [] };
  },
  undoImageDrawing(state, action: PayloadAction<string>) {
    const document = state.documents[action.payload];
    const previous = document?.past.pop();
    if (!previous) return;
    document.future.push({ marks: document.marks, mask: document.mask });
    document.marks = previous.marks; document.mask = previous.mask;
  },
  redoImageDrawing(state, action: PayloadAction<string>) {
    const document = state.documents[action.payload];
    const next = document?.future.pop();
    if (!next) return;
    document.past.push({ marks: document.marks, mask: document.mask });
    document.marks = next.marks; document.mask = next.mask;
  },
  setImageRegions(state, action: PayloadAction<{ key: string; regions: ImageRegion[] }>) {
    state.documents[action.payload.key] = { ...(state.documents[action.payload.key] ?? EMPTY_IMAGE_DOCUMENT), regions: action.payload.regions };
  },
} });
export const { commitImageDrawing, undoImageDrawing, redoImageDrawing, setImageRegions, requestImageEditorFocus, consumeImageEditorFocus } = imageEditorSlice.actions;
export default imageEditorSlice.reducer;
