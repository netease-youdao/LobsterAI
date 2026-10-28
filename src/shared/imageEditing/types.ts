export const ImageEditOperation = {
  Original: 'original', Markup: 'markup', Comment: 'comment', RemoveBackground: 'remove-background',
  Erase: 'erase', Resize: 'resize', Reframe: 'reframe',
} as const;
export type ImageEditOperation = typeof ImageEditOperation[keyof typeof ImageEditOperation];
export const ImageEditorTool = {
  View: 'view', Pen: 'pen', Arrow: 'arrow', Rectangle: 'rectangle', Text: 'text',
  Eraser: 'eraser', Comment: 'comment', Erase: 'erase', Resize: 'resize',
} as const;
export type ImageEditorTool = typeof ImageEditorTool[keyof typeof ImageEditorTool];
export const ImageEditingIpc = {
  Open: 'image-editing:open', Read: 'image-editing:read', Save: 'image-editing:save',
  Stage: 'image-editing:stage', List: 'image-editing:list', Changed: 'image-editing:changed',
  History: 'image-editing:history', ReadSnapshot: 'image-editing:read-snapshot',
} as const;
export const IMAGE_EDIT_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_EDIT_MAX_PIXELS = 20_000_000;
export const IMAGE_EDIT_MAX_REGIONS = 20;
export const IMAGE_EDIT_RATIOS = ['1:1', '3:4', '9:16', '4:3', '16:9'] as const;
export const ImageEditorEvent = { Submit: 'image-editor:submit' } as const;

/** Coordinates and stroke widths are fractions of the original image, independent of zoom. */
export interface ImagePoint { x: number; y: number }
export interface ImageRegion { id: string; x: number; y: number; width: number; height: number; text: string }
export interface ImageMark {
  id: string;
  tool: typeof ImageEditorTool.Pen | typeof ImageEditorTool.Arrow | typeof ImageEditorTool.Rectangle | typeof ImageEditorTool.Text | typeof ImageEditorTool.Eraser;
  points: ImagePoint[];
  color: string;
  width: number;
  text?: string;
  /** Font size relative to the longest image side. Two points bound a text box. */
  fontSize?: number;
}
export interface ImageVersion {
  id: string;
  rootId: string;
  parentId?: string;
  sessionId: string;
  filePath: string;
  originalPath?: string;
  title: string;
  width: number;
  height: number;
  operation: ImageEditOperation;
  createdAt: number;
  requestId?: string;
  taskId?: string;
  outputIndex?: number;
}
export interface ImageEditRequest {
  id: string;
  sourceVersionNumber?: number;
  source: ImageVersion;
  operation: ImageEditOperation;
  regions: ImageRegion[];
  guidePath?: string;
  aspectRatio?: string;
  instruction?: string;
  createdAt: number;
}
/** A message owns its submitted selection, independently of later editor drafts. */
export interface ImageEditMessageSnapshot {
  requestId: string;
  sourceVersionNumber?: number;
  source: ImageVersion;
  operation: ImageEditOperation;
  regions: ImageRegion[];
  instruction?: string;
}
/** Images read from the immutable request, never from the current editor draft. */
export interface ImageEditSnapshotImages {
  dataUrl: string;
  /** Black preserves the source; white is the submitted removal area. */
  maskDataUrl?: string;
  /** The original composited with the submitted drawing, including text and eraser results. */
  markupDataUrl?: string;
}
export interface ImageEditStageInput {
  sessionId: string;
  sourceId: string;
  operation: ImageEditOperation;
  regions?: ImageRegion[];
  guideDataUrl?: string;
  aspectRatio?: string;
  instruction?: string;
}
export type ImageEditingResult<T> = { success: true; data: T } | { success: false; error: string };
export interface ImageEditingBridge {
  open(input: { sessionId: string; title: string; filePath?: string; dataUrl?: string }): Promise<ImageEditingResult<{ version: ImageVersion; dataUrl: string }>>;
  read(input: { sessionId: string; versionId: string }): Promise<ImageEditingResult<{ version: ImageVersion; dataUrl: string }>>;
  list(input: { sessionId: string; rootId: string }): Promise<ImageEditingResult<ImageVersion[]>>;
  save(input: { sessionId: string; sourceId: string; dataUrl: string; operation: ImageEditOperation }): Promise<ImageEditingResult<ImageVersion>>;
  stage(input: ImageEditStageInput): Promise<ImageEditingResult<ImageEditRequest>>;
  history(input: { sessionId: string; messageId: string }): Promise<ImageEditingResult<ImageEditMessageSnapshot[]>>;
  readSnapshot(input: { sessionId: string; requestId: string; preview?: boolean }): Promise<ImageEditingResult<ImageEditSnapshotImages>>;
  onChanged(callback: (version: ImageVersion) => void): () => void;
}
