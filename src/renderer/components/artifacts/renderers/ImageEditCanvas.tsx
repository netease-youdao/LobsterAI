import {
  ArrowUturnLeftIcon,
  ArrowUturnRightIcon,
  ChatBubbleLeftEllipsisIcon,
  MinusIcon,
  PaintBrushIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useCallback, useMemo, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

import {
  buildImageEditPrompt,
  clampImageEditorPoint,
  EMPTY_IMAGE_EDITOR_SNAPSHOT,
  getCompletedImageEditorComments,
  hasImageEditorChanges,
  ImageEditAspectRatio,
  type ImageEditAspectRatio as ImageEditAspectRatioValue,
  type ImageEditorComment,
  type ImageEditorPoint,
  type ImageEditorSnapshot,
  type ImageEditorStroke,
  ImageEditorTool,
  type ImageEditorTool as ImageEditorToolValue,
} from './imageEditorModel';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;
const MAX_EXPORT_DIMENSION = 4096;
const HISTORY_LIMIT = 50;

interface NaturalImageSize {
  width: number;
  height: number;
}

export interface PreparedImageEditAttachment {
  kind: 'original' | 'guide' | 'mask';
  dataUrl: string;
  name: string;
}

export interface PreparedImageEdit {
  attachments: PreparedImageEditAttachment[];
  prompt: string;
}

interface ImageEditCanvasProps {
  alt: string;
  sourceName: string;
  src: string;
  onCancel: () => void;
  onPrepare: (edit: PreparedImageEdit) => void;
}

const ratioOptions: Array<{ labelKey: string; value: ImageEditAspectRatioValue }> = [
  { labelKey: 'imageEditorRatioOriginal', value: ImageEditAspectRatio.Original },
  { labelKey: 'imageEditorRatioSquare', value: ImageEditAspectRatio.Square },
  { labelKey: 'imageEditorRatioPortrait', value: ImageEditAspectRatio.Portrait },
  { labelKey: 'imageEditorRatioStory', value: ImageEditAspectRatio.Story },
  { labelKey: 'imageEditorRatioLandscape', value: ImageEditAspectRatio.Landscape },
  { labelKey: 'imageEditorRatioWidescreen', value: ImageEditAspectRatio.Widescreen },
];

const makeId = (): string => globalThis.crypto.randomUUID();

const loadImage = (src: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const image = new Image();
  if (!src.startsWith('data:') && !src.startsWith('blob:')) {
    image.crossOrigin = 'anonymous';
  }
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('image-load-failed'));
  image.src = src;
});

const createExportCanvas = (image: HTMLImageElement): HTMLCanvasElement => {
  const largestDimension = Math.max(image.naturalWidth, image.naturalHeight, 1);
  const scale = Math.min(1, MAX_EXPORT_DIMENSION / largestDimension);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  return canvas;
};

const drawStroke = (
  context: CanvasRenderingContext2D,
  stroke: ImageEditorStroke,
  size: NaturalImageSize,
): void => {
  if (stroke.points.length === 0) return;
  context.beginPath();
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = Math.max(2, stroke.size * Math.min(size.width, size.height));
  context.moveTo(stroke.points[0].x * size.width, stroke.points[0].y * size.height);
  for (const point of stroke.points.slice(1)) {
    context.lineTo(point.x * size.width, point.y * size.height);
  }
  if (stroke.points.length === 1) {
    context.lineTo(
      stroke.points[0].x * size.width + 0.01,
      stroke.points[0].y * size.height + 0.01,
    );
  }
  context.stroke();
};

const exportImageEdit = async (
  src: string,
  comments: ImageEditorComment[],
  strokes: ImageEditorStroke[],
): Promise<PreparedImageEditAttachment[]> => {
  const image = await loadImage(src);
  const originalCanvas = createExportCanvas(image);
  const originalContext = originalCanvas.getContext('2d');
  if (!originalContext) throw new Error('canvas-context-unavailable');
  originalContext.drawImage(image, 0, 0, originalCanvas.width, originalCanvas.height);

  const originalDataUrl = originalCanvas.toDataURL('image/png');
  const attachments: PreparedImageEditAttachment[] = [{
    kind: 'original',
    dataUrl: originalDataUrl,
    name: 'image-edit-original.png',
  }];

  const completedComments = getCompletedImageEditorComments(comments);
  if (completedComments.length > 0) {
    const guideCanvas = createExportCanvas(image);
    const guideContext = guideCanvas.getContext('2d');
    if (!guideContext) throw new Error('canvas-context-unavailable');
    guideContext.drawImage(image, 0, 0, guideCanvas.width, guideCanvas.height);
    const shortestSide = Math.min(guideCanvas.width, guideCanvas.height);
    const radius = Math.max(14, shortestSide * 0.028);
    const fontSize = Math.max(14, radius * 1.15);
    guideContext.textAlign = 'center';
    guideContext.textBaseline = 'middle';
    guideContext.font = `700 ${fontSize}px system-ui, sans-serif`;
    completedComments.forEach((comment, index) => {
      const x = comment.x * guideCanvas.width;
      const y = comment.y * guideCanvas.height;
      guideContext.beginPath();
      guideContext.fillStyle = '#ef4444';
      guideContext.strokeStyle = '#ffffff';
      guideContext.lineWidth = Math.max(2, radius * 0.14);
      guideContext.arc(x, y, radius, 0, Math.PI * 2);
      guideContext.fill();
      guideContext.stroke();
      guideContext.fillStyle = '#ffffff';
      guideContext.fillText(String(index + 1), x, y + 0.5);
    });
    attachments.push({
      kind: 'guide',
      dataUrl: guideCanvas.toDataURL('image/png'),
      name: 'image-edit-guide.png',
    });
  }

  if (strokes.length > 0) {
    const maskCanvas = createExportCanvas(image);
    const maskContext = maskCanvas.getContext('2d');
    if (!maskContext) throw new Error('canvas-context-unavailable');
    maskContext.fillStyle = '#000000';
    maskContext.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    maskContext.strokeStyle = '#ffffff';
    for (const stroke of strokes) {
      drawStroke(maskContext, stroke, maskCanvas);
    }
    attachments.push({
      kind: 'mask',
      dataUrl: maskCanvas.toDataURL('image/png'),
      name: 'image-edit-mask.png',
    });
  }

  return attachments;
};

const ImageEditCanvas: React.FC<ImageEditCanvasProps> = ({
  alt,
  sourceName,
  src,
  onCancel,
  onPrepare,
}) => {
  const [tool, setTool] = useState<ImageEditorToolValue>(ImageEditorTool.Comment);
  const [snapshot, setSnapshot] = useState<ImageEditorSnapshot>(EMPTY_IMAGE_EDITOR_SNAPSHOT);
  const [past, setPast] = useState<ImageEditorSnapshot[]>([]);
  const [future, setFuture] = useState<ImageEditorSnapshot[]>([]);
  const [activeStroke, setActiveStroke] = useState<ImageEditorStroke | null>(null);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState<ImageEditAspectRatioValue>(ImageEditAspectRatio.Original);
  const [customInstructions, setCustomInstructions] = useState('');
  const [brushSize, setBrushSize] = useState(0.07);
  const [zoom, setZoom] = useState(1);
  const [naturalSize, setNaturalSize] = useState<NaturalImageSize | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const commitSnapshot = useCallback((next: ImageEditorSnapshot) => {
    setPast(current => [...current, snapshot].slice(-HISTORY_LIMIT));
    setSnapshot(next);
    setFuture([]);
  }, [snapshot]);

  const handleUndo = useCallback(() => {
    const previous = past[past.length - 1];
    if (!previous) return;
    setPast(current => current.slice(0, -1));
    setFuture(current => [snapshot, ...current].slice(0, HISTORY_LIMIT));
    setSnapshot(previous);
    setSelectedCommentId(null);
  }, [past, snapshot]);

  const handleRedo = useCallback(() => {
    const next = future[0];
    if (!next) return;
    setFuture(current => current.slice(1));
    setPast(current => [...current, snapshot].slice(-HISTORY_LIMIT));
    setSnapshot(next);
    setSelectedCommentId(null);
  }, [future, snapshot]);

  const getPointerPoint = useCallback((event: React.PointerEvent): ImageEditorPoint | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return clampImageEditorPoint({
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    });
  }, []);

  const handlePointerDown = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (preparing) return;
    const point = getPointerPoint(event);
    if (!point) return;
    if (tool === ImageEditorTool.Comment) {
      const comment: ImageEditorComment = {
        id: makeId(),
        text: '',
        ...point,
      };
      commitSnapshot({
        ...snapshot,
        comments: [...snapshot.comments, comment],
      });
      setSelectedCommentId(comment.id);
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    setActiveStroke({
      id: makeId(),
      points: [point],
      size: brushSize,
    });
  }, [brushSize, commitSnapshot, getPointerPoint, preparing, snapshot, tool]);

  const handlePointerMove = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (!activeStroke) return;
    const point = getPointerPoint(event);
    if (!point) return;
    const lastPoint = activeStroke.points[activeStroke.points.length - 1];
    if (lastPoint && Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y) < 0.002) {
      return;
    }
    setActiveStroke(current => current ? {
      ...current,
      points: [...current.points, point],
    } : null);
  }, [activeStroke, getPointerPoint]);

  const finishActiveStroke = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (!activeStroke) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    commitSnapshot({
      ...snapshot,
      strokes: [...snapshot.strokes, activeStroke],
    });
    setActiveStroke(null);
  }, [activeStroke, commitSnapshot, snapshot]);

  const handleCommentChange = useCallback((id: string, text: string) => {
    setSnapshot(current => ({
      ...current,
      comments: current.comments.map(comment => comment.id === id ? { ...comment, text } : comment),
    }));
  }, []);

  const handleDeleteComment = useCallback((id: string) => {
    commitSnapshot({
      ...snapshot,
      comments: snapshot.comments.filter(comment => comment.id !== id),
    });
    setSelectedCommentId(current => current === id ? null : current);
  }, [commitSnapshot, snapshot]);

  const promptInput = useMemo(() => ({
    aspectRatio,
    comments: snapshot.comments,
    customInstructions,
    hasRemovalMask: snapshot.strokes.length > 0,
    language: i18nService.getLanguage(),
  }), [aspectRatio, customInstructions, snapshot.comments, snapshot.strokes.length]);
  const canPrepare = hasImageEditorChanges(promptInput) && !preparing;

  const handlePrepare = useCallback(async () => {
    if (!canPrepare) return;
    setPreparing(true);
    setError(null);
    try {
      const attachments = await exportImageEdit(src, snapshot.comments, snapshot.strokes);
      onPrepare({
        attachments,
        prompt: buildImageEditPrompt(promptInput),
      });
    } catch (prepareError) {
      console.error('[ImageEditor] failed to prepare image edit:', prepareError);
      setError(i18nService.t('imageEditorPrepareFailed'));
    } finally {
      setPreparing(false);
    }
  }, [canPrepare, onPrepare, promptInput, snapshot.comments, snapshot.strokes, src]);

  const allStrokes = activeStroke
    ? [...snapshot.strokes, activeStroke]
    : snapshot.strokes;
  const viewBox = naturalSize
    ? `0 0 ${naturalSize.width} ${naturalSize.height}`
    : '0 0 1 1';

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-surface-secondary">
      <div className="flex min-h-12 flex-wrap items-center gap-1.5 border-b border-border bg-background px-2 py-1.5">
        <div className="mr-1 min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">
            {i18nService.t('imageEditorTitle')}
          </div>
          <div className="truncate text-[11px] text-secondary">{sourceName}</div>
        </div>
        <button
          type="button"
          onClick={() => setTool(ImageEditorTool.Comment)}
          className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors ${
            tool === ImageEditorTool.Comment
              ? 'bg-primary text-white'
              : 'text-secondary hover:bg-surface-hover hover:text-foreground'
          }`}
          aria-pressed={tool === ImageEditorTool.Comment}
          title={i18nService.t('imageEditorComment')}
        >
          <ChatBubbleLeftEllipsisIcon className="h-4 w-4" />
          {i18nService.t('imageEditorComment')}
        </button>
        <button
          type="button"
          onClick={() => setTool(ImageEditorTool.Remove)}
          className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors ${
            tool === ImageEditorTool.Remove
              ? 'bg-primary text-white'
              : 'text-secondary hover:bg-surface-hover hover:text-foreground'
          }`}
          aria-pressed={tool === ImageEditorTool.Remove}
          title={i18nService.t('imageEditorRemove')}
        >
          <PaintBrushIcon className="h-4 w-4" />
          {i18nService.t('imageEditorRemove')}
        </button>
        <div className="mx-0.5 h-5 w-px bg-border" />
        <button
          type="button"
          onClick={handleUndo}
          disabled={past.length === 0}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-35"
          title={i18nService.t('imageEditorUndo')}
          aria-label={i18nService.t('imageEditorUndo')}
        >
          <ArrowUturnLeftIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={handleRedo}
          disabled={future.length === 0}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-35"
          title={i18nService.t('imageEditorRedo')}
          aria-label={i18nService.t('imageEditorRedo')}
        >
          <ArrowUturnRightIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            commitSnapshot(EMPTY_IMAGE_EDITOR_SNAPSHOT);
            setSelectedCommentId(null);
          }}
          disabled={snapshot.comments.length === 0 && snapshot.strokes.length === 0}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-35"
          title={i18nService.t('imageEditorClear')}
          aria-label={i18nService.t('imageEditorClear')}
        >
          <TrashIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="ml-0.5 inline-flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-surface-hover hover:text-foreground"
          title={i18nService.t('cancel')}
          aria-label={i18nService.t('cancel')}
        >
          <XMarkIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          className={`relative flex min-w-0 flex-1 overflow-auto p-5 ${
            tool === ImageEditorTool.Remove ? 'cursor-crosshair' : 'cursor-cell'
          }`}
          onWheel={(event) => {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            setZoom(current => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current - event.deltaY * 0.001)));
          }}
        >
          <div className="m-auto flex min-h-full min-w-full items-center justify-center">
            <div
              ref={stageRef}
              className="relative inline-block max-h-full max-w-full select-none rounded-xl bg-white shadow-lg ring-1 ring-black/10"
              style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
            >
              <img
                src={src}
                alt={alt}
                className="block max-h-[calc(100vh-15rem)] max-w-full rounded-xl object-contain"
                draggable={false}
                onLoad={(event) => {
                  const image = event.currentTarget;
                  setNaturalSize({
                    width: Math.max(1, image.naturalWidth),
                    height: Math.max(1, image.naturalHeight),
                  });
                }}
              />
              <svg
                className="absolute inset-0 z-10 h-full w-full touch-none rounded-xl"
                viewBox={viewBox}
                preserveAspectRatio="none"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={finishActiveStroke}
                onPointerCancel={finishActiveStroke}
              >
                {naturalSize && allStrokes.map(stroke => (
                  <polyline
                    key={stroke.id}
                    points={stroke.points
                      .map(point => `${point.x * naturalSize.width},${point.y * naturalSize.height}`)
                      .join(' ')}
                    fill="none"
                    stroke="rgba(239, 68, 68, 0.62)"
                    strokeWidth={Math.max(2, stroke.size * Math.min(naturalSize.width, naturalSize.height))}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
              </svg>
              {snapshot.comments.map((comment, index) => (
                <button
                  key={comment.id}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedCommentId(comment.id);
                  }}
                  className={`absolute z-20 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white text-xs font-bold text-white shadow-md ${
                    selectedCommentId === comment.id ? 'bg-primary ring-2 ring-primary/30' : 'bg-red-500'
                  }`}
                  style={{ left: `${comment.x * 100}%`, top: `${comment.y * 100}%` }}
                  aria-label={`${i18nService.t('imageEditorComment')} ${index + 1}`}
                >
                  {index + 1}
                </button>
              ))}
            </div>
          </div>

          <div className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-background/95 p-1 shadow-md backdrop-blur">
            <button
              type="button"
              onClick={() => setZoom(current => Math.max(MIN_ZOOM, current - ZOOM_STEP))}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-secondary hover:bg-surface-hover"
              aria-label={i18nService.t('imageEditorZoomOut')}
              title={i18nService.t('imageEditorZoomOut')}
            >
              <MinusIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setZoom(1)}
              className="min-w-12 px-1 text-center text-xs tabular-nums text-secondary hover:text-foreground"
              title={i18nService.t('imageEditorResetZoom')}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              onClick={() => setZoom(current => Math.min(MAX_ZOOM, current + ZOOM_STEP))}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-secondary hover:bg-surface-hover"
              aria-label={i18nService.t('imageEditorZoomIn')}
              title={i18nService.t('imageEditorZoomIn')}
            >
              <PlusIcon className="h-4 w-4" />
            </button>
          </div>
        </div>

        <aside className="flex w-[250px] shrink-0 flex-col border-l border-border bg-background">
          <div className="border-b border-border p-3">
            <div className="text-xs font-semibold text-foreground">
              {tool === ImageEditorTool.Comment
                ? i18nService.t('imageEditorCommentHint')
                : i18nService.t('imageEditorRemoveHint')}
            </div>
            {tool === ImageEditorTool.Remove && (
              <label className="mt-3 block text-xs text-secondary">
                <span className="mb-1 flex items-center justify-between">
                  <span>{i18nService.t('imageEditorBrushSize')}</span>
                  <span>{Math.round(brushSize * 100)}%</span>
                </span>
                <input
                  type="range"
                  min="0.02"
                  max="0.18"
                  step="0.01"
                  value={brushSize}
                  onChange={event => setBrushSize(Number(event.target.value))}
                  className="w-full accent-primary"
                />
              </label>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground">
                {i18nService.t('imageEditorComments')}
              </span>
              <span className="text-[11px] tabular-nums text-secondary">
                {snapshot.comments.length}
              </span>
            </div>
            {snapshot.comments.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-xs text-secondary">
                {i18nService.t('imageEditorNoComments')}
              </div>
            ) : (
              <div className="space-y-2">
                {snapshot.comments.map((comment, index) => (
                  <div
                    key={comment.id}
                    className={`rounded-xl border p-2 transition-colors ${
                      selectedCommentId === comment.id
                        ? 'border-primary bg-primary/5'
                        : 'border-border bg-surface'
                    }`}
                  >
                    <div className="mb-1 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedCommentId(comment.id)}
                        className="flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white"
                        aria-label={`${i18nService.t('imageEditorComment')} ${index + 1}`}
                      >
                        {index + 1}
                      </button>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-secondary">
                        {i18nService.t('imageEditorCommentLabel').replace('{number}', String(index + 1))}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleDeleteComment(comment.id)}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-secondary hover:bg-surface-hover hover:text-red-500"
                        title={i18nService.t('imageEditorDeleteComment')}
                        aria-label={i18nService.t('imageEditorDeleteComment')}
                      >
                        <TrashIcon className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <textarea
                      value={comment.text}
                      onFocus={() => setSelectedCommentId(comment.id)}
                      onChange={event => handleCommentChange(comment.id, event.target.value)}
                      rows={2}
                      className="w-full resize-none rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted focus:border-primary"
                      placeholder={i18nService.t('imageEditorCommentPlaceholder')}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2 border-t border-border p-3">
            <label className="block text-xs font-medium text-foreground">
              <span className="mb-1 block">{i18nService.t('imageEditorAspectRatio')}</span>
              <select
                value={aspectRatio}
                onChange={event => setAspectRatio(event.target.value as ImageEditAspectRatioValue)}
                className="h-8 w-full rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
              >
                {ratioOptions.map(option => (
                  <option key={option.value} value={option.value}>
                    {i18nService.t(option.labelKey)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-medium text-foreground">
              <span className="mb-1 block">{i18nService.t('imageEditorInstructions')}</span>
              <textarea
                value={customInstructions}
                onChange={event => setCustomInstructions(event.target.value)}
                rows={3}
                className="w-full resize-none rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted focus:border-primary"
                placeholder={i18nService.t('imageEditorInstructionsPlaceholder')}
              />
            </label>
            {error && <div className="text-xs text-red-500">{error}</div>}
            <button
              type="button"
              onClick={() => void handlePrepare()}
              disabled={!canPrepare}
              className="inline-flex h-9 w-full items-center justify-center rounded-lg bg-primary px-3 text-xs font-semibold text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
              title={!hasImageEditorChanges(promptInput) ? i18nService.t('imageEditorEmpty') : undefined}
            >
              {preparing
                ? i18nService.t('imageEditorPreparing')
                : i18nService.t('imageEditorAddToPrompt')}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
};

export default ImageEditCanvas;
