import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type { ImageEditOperation, ImageMark, ImageRegion, ImageVersion } from '../../../shared/imageEditing/types';
import type { Artifact } from '../../types/artifact';

export interface ImageEditorDrawing { marks: ImageMark[]; mask: ImageMark[] }
export interface ImageEditorDocument extends ImageEditorDrawing { past: ImageEditorDrawing[]; future: ImageEditorDrawing[]; regions: ImageRegion[] }
export const EMPTY_IMAGE_DOCUMENT: ImageEditorDocument = { marks: [], mask: [], past: [], future: [], regions: [] };
interface ImageEditorFocus { id: string; source: ImageVersion; regionId?: string; operation?: ImageEditOperation }
/** The full-screen studio; `operation` picks the tool it opens with and `versionId` the version it shows first. */
export interface ImageStudioRequest { artifact: Artifact; operation?: ImageEditOperation; versionId?: string }
/** An edit sent to the conversation. One per image, so every editor of that image shows it until the new version arrives. */
export interface ImageEditJob {
  requestId: string; sessionId: string; rootId: string; sourceId: string; operation: ImageEditOperation; regionCount: number; startedAt: number;
}
export const imageEditJobKey = (sessionId: string, rootId: string): string => `${sessionId}:${rootId}`;
const initialState: { documents: Record<string, ImageEditorDocument>; jobs: Record<string, ImageEditJob>; focus?: ImageEditorFocus; studio?: ImageStudioRequest } = {
  documents: {}, jobs: {},
};
const imageEditorSlice = createSlice({ name: 'imageEditor', initialState, reducers: {
  openImageStudio(state, action: PayloadAction<ImageStudioRequest>) { state.studio = action.payload; },
  closeImageStudio(state) { state.studio = undefined; },
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
  startImageEditJob(state, action: PayloadAction<ImageEditJob>) {
    state.jobs[imageEditJobKey(action.payload.sessionId, action.payload.rootId)] = action.payload;
  },
  /** Ends the job for this request only; a newer edit of the same image keeps running. */
  endImageEditJob(state, action: PayloadAction<string>) {
    for (const [key, job] of Object.entries(state.jobs)) if (job.requestId === action.payload) delete state.jobs[key];
  },
} });
export const { commitImageDrawing, undoImageDrawing, redoImageDrawing, setImageRegions, requestImageEditorFocus, consumeImageEditorFocus,
  openImageStudio, closeImageStudio, startImageEditJob, endImageEditJob } = imageEditorSlice.actions;
export default imageEditorSlice.reducer;
