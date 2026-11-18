import {
  ArrowDownTrayIcon, ArrowsPointingOutIcon, ArrowUturnLeftIcon, ArrowUturnRightIcon, CheckIcon, ChevronDownIcon,
  HandRaisedIcon, MinusIcon, PlusIcon, TrashIcon, ViewColumnsIcon, XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { imagePoint, imageRectangle } from '../../../../shared/imageEditing/geometry';
import {
  IMAGE_EDIT_MAX_REGIONS, IMAGE_EDIT_RATIOS, ImageEditOperation, ImageEditorTool,
  type ImageMark, type ImagePoint, type ImageRegion, type ImageVersion,
} from '../../../../shared/imageEditing/types';
import { i18nService } from '../../../services/i18n';
import { imageEditTitle, openImageInStudio, submitImageEdit } from '../../../services/imageEditing';
import { type RootState, store } from '../../../store';
import { openArtifactPreviewTab } from '../../../store/slices/artifactSlice';
import {
  commitImageDrawing, consumeImageEditorFocus, EMPTY_IMAGE_DOCUMENT, endImageEditJob, imageEditJobKey, redoImageDrawing, setImageRegions,
  startImageEditJob, undoImageDrawing,
} from '../../../store/slices/imageEditorSlice';
import type { Artifact } from '../../../types/artifact';
import { createModalEscapeLayerId, isDismissEscapeEvent, isTopModalEscapeLayer, registerModalEscapeLayer, unregisterModalEscapeLayer } from '../../common/modalEscape';
import MessageCopiedIcon from '../../icons/MessageCopiedIcon';
import MessageCopyIcon from '../../icons/MessageCopyIcon';
import { getImageArtifactSrc } from '../renderers/imageArtifactSource';
import ImageRenderer from '../renderers/ImageRenderer';
import { buildLocalFileSrc } from '../renderers/VideoRenderer';
import { drawImageMark, drawImageMarks, exportImageDrawing, loadEditorImage } from './imageDrawing';
import { CompareIcon, DrawIcon, EraserIcon, ReframeIcon, RegionEditIcon, RemoveBackgroundIcon } from './ImageEditingIcons';
import { ImageEditJobPhase } from './imageEditJobStatus';
import { ImageEditPendingVersion, ImageEditProgressCard, ImageEditStageOverlay, useImageEditJobStatus } from './ImageEditProgress';
import ImageMarkupToolbar from './ImageMarkupToolbar';
import { isImageStudioAvailable } from './imageStudioAvailability';
import { imageTextBox } from './imageText';
import ImageTextBox from './ImageTextBox';

const t = (key: string) => i18nService.t(key);
const Mode = { View: 'view', Markup: 'markup', Comment: 'comment', RemoveBackground: 'remove-background', Erase: 'erase', Resize: 'resize' } as const;
type Mode = typeof Mode[keyof typeof Mode];
/** The side panel embeds the editor; the studio is the full-screen view opened from the conversation. */
export const ImageEditorSurface = { Panel: 'panel', Studio: 'studio' } as const;
export type ImageEditorSurface = typeof ImageEditorSurface[keyof typeof ImageEditorSurface];
const MODE_OPERATIONS: [Mode, ImageEditOperation][] = [[Mode.Markup, ImageEditOperation.Markup], [Mode.Comment, ImageEditOperation.Comment],
  [Mode.RemoveBackground, ImageEditOperation.RemoveBackground], [Mode.Erase, ImageEditOperation.Erase], [Mode.Resize, ImageEditOperation.Reframe]];
const modeFor = (operation?: ImageEditOperation): Mode => MODE_OPERATIONS.find(([, value]) => value === operation)?.[0] ?? Mode.View;
const operationFor = (mode: Mode): ImageEditOperation | undefined => MODE_OPERATIONS.find(([value]) => value === mode)?.[1];
const STAGE_GUTTER = 24;
const NOTICE_TIMEOUT_MS = 4000;
const COPIED_FEEDBACK_MS = 2000;
const COMPACT_WIDTH = 560;
const clampZoom = (value: number) => Math.min(8, Math.max(0.25, value));
const buttonClass = 'inline-flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-35';
const primaryClass = `${buttonClass} shrink-0 bg-accent px-3 font-medium text-white hover:bg-accent/90`;
const floatingClass = 'pointer-events-auto border border-border bg-surface/95 shadow-popover backdrop-blur';
const dividerClass = 'mx-0.5 h-5 w-px shrink-0 bg-border';
const CHECKERBOARD: React.CSSProperties = { backgroundColor: '#fff', backgroundImage: 'conic-gradient(#e5e7eb 25%, transparent 0 50%, #e5e7eb 0 75%, transparent 0)', backgroundSize: '16px 16px' };
const stageBackgroundClass = 'bg-surface-raised [background-image:radial-gradient(rgba(128,128,128,0.18)_1px,transparent_1px)] [background-size:20px_20px]';
const imageFrameClass = 'rounded-lg shadow-[0_16px_48px_-16px_rgba(0,0,0,0.35)]';
function ToolButton({ label, icon: Icon, active, children, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string; icon?: React.ElementType; active?: boolean;
}) {
  return <button type="button" title={label} aria-label={label} aria-pressed={active} {...props}
    className={`${buttonClass} ${children ? '' : 'h-8 w-8 px-0'} ${active ? 'bg-accent/10 text-accent' : 'text-secondary hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10'} ${className}`}>
    {Icon && <Icon className="h-4 w-4 shrink-0" />}{children}
  </button>;
}
const CopiedIcon = ({ className = '' }: { className?: string }) => <MessageCopiedIcon className={`${className} text-success`} />;
/** Keeps the region composer next to its selection, flipping above it or inside it near the image edges. */
function composerPosition(region: ImageRegion): React.CSSProperties {
  const bottom = region.y + region.height;
  return {
    ...(bottom < 0.72 ? { top: `calc(${bottom * 100}% + 8px)` } : region.y > 0.28 ? { bottom: `calc(${(1 - region.y) * 100}% + 8px)` } : { bottom: `calc(${(1 - bottom) * 100}% + 8px)` }),
    ...(region.x + region.width / 2 > 0.5 ? { right: `${(1 - region.x - region.width) * 100}%` } : { left: `${region.x * 100}%` }),
  };
}

export default function ImageEditor({ artifact, surface = ImageEditorSurface.Panel, initialOperation, initialVersionId, onClose }: {
  artifact: Artifact; surface?: ImageEditorSurface; initialOperation?: ImageEditOperation; initialVersionId?: string; onClose?: () => void;
}) {
  const dispatch = useDispatch();
  const bridge = window.electron?.artifact?.imageEditing;
  const isStudio = surface === ImageEditorSurface.Studio;
  const [loaded, setLoaded] = useState<{ version: ImageVersion; dataUrl: string; image: HTMLImageElement }>();
  const loadedRef = useRef(loaded); loadedRef.current = loaded;
  const loadGeneration = useRef(0);
  const invalidateLoads = useCallback(() => { loadGeneration.current++; }, []);
  const [versions, setVersions] = useState<ImageVersion[]>([]);
  const [mode, setMode] = useState<Mode>(() => modeFor(initialOperation));
  const modeRef = useRef(mode); modeRef.current = mode;
  const [tool, setTool] = useState<ImageEditorTool>(ImageEditorTool.Pen);
  const [color, setColor] = useState('#f05252');
  const [brush, setBrush] = useState(4);
  const [maskBrush, setMaskBrush] = useState(30);
  const [eraserBrush, setEraserBrush] = useState(30);
  const [fontSize, setFontSize] = useState(64);
  const [brushPoint, setBrushPoint] = useState<ImagePoint>();
  const [activeMark, setActiveMark] = useState<ImageMark>();
  const activeMarkRef = useRef<ImageMark>();
  const [selection, setSelection] = useState<ImageRegion>();
  const [selecting, setSelecting] = useState(false);
  const [regionText, setRegionText] = useState('');
  const [textDraft, setTextDraft] = useState<ImageMark>();
  const textDraftRef = useRef(textDraft); textDraftRef.current = textDraft;
  const [instruction, setInstruction] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  useEffect(() => () => { if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current); }, []);
  const [busy, setBusy] = useState(false);
  const [initialFailed, setInitialFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [viewportSize, setViewportSize] = useState({ width: 500, height: 500 });
  // The floating bars' height in view mode, so the loading placeholder already sits where the canvas will.
  const [insets, setInsets] = useState({ top: 66, bottom: 66 });
  const [space, setSpace] = useState(false);
  const [compare, setCompare] = useState(false);
  const [original, setOriginal] = useState<HTMLImageElement>();
  const [ratio, setRatio] = useState<string>('16:9');
  const [versionMenu, setVersionMenu] = useState(false);
  const versionMenuRef = useRef(versionMenu); versionMenuRef.current = versionMenu;
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  const escapeLayer = useRef(0);
  if (isStudio && !escapeLayer.current) escapeLayer.current = createModalEscapeLayerId();
  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const topBar = useRef<HTMLDivElement>(null);
  const bottomBar = useRef<HTMLDivElement>(null);
  const versionPicker = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const regionInput = useRef<HTMLTextAreaElement>(null);
  const drag = useRef<{ start: ImagePoint; pan?: { x: number; y: number; left: number; top: number } }>();
  const key = loaded ? `${artifact.sessionId}:${loaded.version.id}` : '';
  const drawing = useSelector((state: RootState) => state.imageEditor.documents[key] ?? EMPTY_IMAGE_DOCUMENT);
  const focusRequest = useSelector((state: RootState) => state.imageEditor.focus);
  const drawingRef = useRef(drawing); drawingRef.current = drawing;
  // An edit in flight locks editing for the whole image until its version arrives or the user dismisses its failure.
  const job = useSelector((state: RootState) => loaded ? state.imageEditor.jobs[imageEditJobKey(artifact.sessionId, loaded.version.rootId)] : undefined);
  const jobRef = useRef(job); jobRef.current = job;
  const jobStatus = useImageEditJobStatus(job);
  const [revealId, setRevealId] = useState<string>();
  const isPanMode = mode === Mode.View || mode === Mode.Resize || mode === Mode.RemoveBackground;

  const loadVersion = useCallback(async (version: ImageVersion) => {
    const generation = ++loadGeneration.current;
    const result = await bridge.read({ sessionId: artifact.sessionId, versionId: version.id });
    if (generation !== loadGeneration.current) return;
    if (!result.success) throw new Error(result.error);
    const image = await loadEditorImage(result.data.dataUrl);
    if (generation !== loadGeneration.current) return;
    setLoaded({ ...result.data, image });
    setZoom(1); setSelection(undefined); setTextDraft(undefined); setCompare(false); setNotice('');
  }, [artifact.sessionId, bridge]);

  useEffect(() => {
    if (!bridge) { setInitialFailed(true); return; }
    let alive = true;
    const generation = ++loadGeneration.current;
    setInitialFailed(false); setLoaded(undefined); setOriginal(undefined); setVersions([]);
    setMode(modeFor(initialOperation)); setSelection(undefined); setCompare(false); setError(''); setNotice('');
    // Only the studio answers focus requests, so the side panel never jumps to another version underneath it.
    const focus = isStudio ? store.getState().imageEditor.focus : undefined;
    const restoreVersion = focus?.source.sessionId === artifact.sessionId && (artifact.id === `image-edit-version-${focus.source.id}`
      || artifact.filePath === focus.source.originalPath || artifact.filePath === focus.source.filePath);
    const versionId = restoreVersion ? focus.source.id : initialVersionId;
    const opening = versionId ? bridge.read({ sessionId: artifact.sessionId, versionId })
      : bridge.open({ sessionId: artifact.sessionId, title: artifact.title, filePath: artifact.filePath,
        dataUrl: artifact.filePath ? undefined : artifact.content });
    void opening.then(async result => {
      if (!result.success) throw new Error(result.error);
      const image = await loadEditorImage(result.data.dataUrl);
      const list = await bridge.list({ sessionId: artifact.sessionId, rootId: result.data.version.rootId });
      if (!alive || generation !== loadGeneration.current) return;
      setLoaded({ ...result.data, image }); setVersions(list.success ? list.data : [result.data.version]);
      // An edit that finished while no editor was open has already added its version.
      const finished = store.getState().imageEditor.jobs[imageEditJobKey(artifact.sessionId, result.data.version.rootId)];
      if (finished && list.success && list.data.some(version => version.requestId === finished.requestId)) dispatch(endImageEditJob(finished.requestId));
    }).catch(error => { if (alive) { setError(error.message); setInitialFailed(true); } });
    return () => { alive = false; invalidateLoads(); };
  // contentVersion reopens a file refreshed in the panel or changed on disk.
  }, [artifact.id, artifact.content, artifact.contentVersion, artifact.filePath, artifact.sessionId, artifact.title, bridge, dispatch, initialOperation, initialVersionId, invalidateLoads, isStudio]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onChanged(version => {
      const current = loadedRef.current;
      if (version.sessionId !== artifact.sessionId || version.rootId !== current?.version.rootId) return;
      setVersions(values => values.some(v => v.id === version.id) ? values : [...values, version]);
      const finished = jobRef.current;
      if (!finished || version.requestId !== finished.requestId) return;
      dispatch(endImageEditJob(finished.requestId));
      if (current.version.id !== version.parentId) { setNotice(t('imageEditSavedElsewhere')); return; }
      void loadVersion(version).then(() => { setRevealId(version.id); setNotice(t('imageEditSaved')); }).catch(error => setError(error.message));
    });
  }, [artifact.sessionId, bridge, dispatch, loadVersion]);

  useEffect(() => {
    if (!isStudio || !focusRequest || focusRequest.source.sessionId !== artifact.sessionId || focusRequest.source.rootId !== loaded?.version.rootId) return;
    dispatch(consumeImageEditorFocus(focusRequest.id));
    setMode(!focusRequest.operation || focusRequest.operation === ImageEditOperation.Comment ? Mode.Comment
      : focusRequest.operation === ImageEditOperation.RemoveBackground ? Mode.RemoveBackground : Mode.View);
    void loadVersion(focusRequest.source).then(() => {
      const region = store.getState().imageEditor.documents[`${artifact.sessionId}:${focusRequest.source.id}`]?.regions.find(r => r.id === focusRequest.regionId);
      if (region) { setSelection(region); setRegionText(region.text); }
    }).catch(error => setError(error.message));
  }, [artifact.sessionId, dispatch, focusRequest, isStudio, loaded?.version.rootId, loadVersion]);

  // Layout effects measure before the first paint, so the image never shows at a guessed size and then jumps.
  useLayoutEffect(() => {
    const element = viewport.current; if (!element) return;
    // Preserve fractional pixels so zoom rounding cannot toggle the scrollbars on every resize.
    const resize = (width: number, height: number) => setViewportSize(current => current.width === width && current.height === height ? current : { width, height });
    const rect = element.getBoundingClientRect();
    resize(rect.width - (element.offsetWidth - element.clientWidth), rect.height - (element.offsetHeight - element.clientHeight));
    const observer = new ResizeObserver(([entry]) => resize(entry.contentRect.width, entry.contentRect.height));
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setBrushPoint(undefined);
      setZoom(value => clampZoom(value * Math.exp(-event.deltaY * 0.002)));
    };
    observer.observe(element); element.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); element.removeEventListener('wheel', wheel); };
  }, [loaded?.version.id]);

  useLayoutEffect(() => {
    // The floating bars reserve their height so the fitted image is never hidden underneath them.
    // While loading only the bottom bar exists; the top one keeps its default height until it appears.
    const top = topBar.current, bottom = bottomBar.current; if (!bottom) return;
    const measure = () => setInsets(current => {
      const next = { top: top?.offsetHeight ?? current.top, bottom: bottom.offsetHeight };
      return current.top === next.top && current.bottom === next.bottom ? current : next;
    });
    measure();
    const observer = new ResizeObserver(measure);
    if (top) observer.observe(top);
    observer.observe(bottom);
    return () => observer.disconnect();
  }, [loaded?.version.id]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), NOTICE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    // Preload the original so holding "compare" swaps it in without a wait.
    if (!bridge || !loaded || loaded.version.id === loaded.version.rootId || original) return;
    let alive = true;
    void bridge.read({ sessionId: artifact.sessionId, versionId: loaded.version.rootId }).then(async result => {
      if (!result.success) return;
      const image = await loadEditorImage(result.data.dataUrl);
      if (alive) setOriginal(image);
    }).catch(error => console.warn('[ImageEditor] Failed to preload the original for comparison', error));
    return () => { alive = false; };
  }, [artifact.sessionId, bridge, loaded, original]);

  useEffect(() => {
    if (!versionMenu) return;
    const outside = (event: PointerEvent) => { if (!versionPicker.current?.contains(event.target as Node)) setVersionMenu(false); };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [versionMenu]);

  const selectionId = selection?.id;
  useEffect(() => {
    if (mode === Mode.Comment && selectionId && !selecting) regionInput.current?.focus();
  }, [mode, selectionId, selecting]);

  // Drawn before paint, so the canvas never shows a blank frame in place of the image.
  useLayoutEffect(() => {
    const context = canvas.current?.getContext('2d'); if (!context || !loaded) return;
    context.clearRect(0, 0, loaded.version.width, loaded.version.height);
    if (compare && original) {
      const scale = Math.min(loaded.version.width / original.naturalWidth, loaded.version.height / original.naturalHeight);
      const w = original.naturalWidth * scale, h = original.naturalHeight * scale;
      context.drawImage(original, (loaded.version.width - w) / 2, (loaded.version.height - h) / 2, w, h);
      return;
    }
    context.drawImage(loaded.image, 0, 0, loaded.version.width, loaded.version.height);
    if (mode === Mode.Markup) drawImageMarks(context, [...drawing.marks, ...(activeMark ? [activeMark] : [])], loaded.version.width, loaded.version.height);
    if (mode === Mode.Erase) {
      context.save(); context.globalAlpha = 0.55;
      drawing.mask.forEach(mark => drawImageMark(context, { ...mark, color: '#f43f5e' }, loaded.version.width, loaded.version.height));
      context.restore();
    }
    if (activeMark && mode !== Mode.Markup) {
      context.save(); if (mode === Mode.Erase) context.globalAlpha = 0.55;
      drawImageMark(context, mode === Mode.Erase ? { ...activeMark, color: '#f43f5e' } : activeMark, loaded.version.width, loaded.version.height); context.restore();
    }
  }, [loaded, compare, original, drawing.marks, drawing.mask, activeMark, mode]);

  useEffect(() => {
    const layer = escapeLayer.current;
    if (layer) registerModalEscapeLayer(layer);
    const down = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = /INPUT|TEXTAREA|SELECT/.test(target.tagName);
      // The studio is modal: Escape steps back out of menus and tools first, then closes it.
      if (layer && event.key === 'Escape') {
        if (!isDismissEscapeEvent(event) || !isTopModalEscapeLayer(layer)) return;
        event.preventDefault();
        if (typing) target.blur();
        else if (versionMenuRef.current) setVersionMenu(false);
        else if (modeRef.current !== Mode.View && !jobRef.current) { setSelection(undefined); setTextDraft(undefined); setMode(Mode.View); }
        else onCloseRef.current?.();
        return;
      }
      if (!(layer || root.current?.contains(document.activeElement)) || typing) return;
      if (event.code === 'Space') { event.preventDefault(); setSpace(true); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); dispatch(event.shiftKey ? redoImageDrawing(key) : undoImageDrawing(key));
      }
      if (event.key === 'Escape' && !jobRef.current) { setSelection(undefined); setTextDraft(undefined); setMode(Mode.View); }
    };
    const up = () => setSpace(false);
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', up);
    return () => {
      if (layer) unregisterModalEscapeLayer(layer);
      window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', up);
    };
  }, [dispatch, key]);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (error) { setError(error instanceof Error ? error.message : t('imageEditFailed')); }
    finally { setBusy(false); }
  };
  const commit = (marks = drawingRef.current.marks, mask = drawingRef.current.mask) => dispatch(commitImageDrawing({ key, drawing: { marks, mask } }));
  const finishText = () => {
    const mark = textDraftRef.current;
    if (mark?.text?.trim()) commit([...drawingRef.current.marks, mark]);
    textDraftRef.current = undefined; setTextDraft(undefined);
  };
  /** Regions are collected here and go to the model together when the user applies the edit. */
  const setRegions = (regions: ImageRegion[]) => { dispatch(setImageRegions({ key, regions })); setSelection(undefined); setRegionText(''); };
  const generate = (operation: ImageEditOperation) => run(async () => {
    if (!loaded) return;
    finishText();
    const marks = store.getState().imageEditor.documents[key]?.marks ?? [];
    const guideDataUrl = operation === ImageEditOperation.Markup ? exportImageDrawing(loaded.image, marks)
      : operation === ImageEditOperation.Erase ? exportImageDrawing(loaded.image, drawing.mask, loaded.version.width, loaded.version.height, true) : undefined;
    const result = await bridge.stage({ sessionId: artifact.sessionId, sourceId: loaded.version.id, operation, guideDataUrl,
      regions: operation === ImageEditOperation.Comment ? drawing.regions : undefined,
      instruction: operation === ImageEditOperation.Markup ? instruction : undefined, aspectRatio: operation === ImageEditOperation.Reframe ? ratio : undefined });
    if (!result.success) throw new Error(result.error);
    const request = result.data;
    // Registered before sending, so even an instant result finds its job.
    dispatch(startImageEditJob({ requestId: request.id, sessionId: artifact.sessionId, rootId: loaded.version.rootId, sourceId: loaded.version.id,
      operation, regionCount: request.regions.length, startedAt: Date.now() }));
    setSelection(undefined);
    try { await submitImageEdit(request); } catch (error) { dispatch(endImageEditJob(request.id)); throw error; }
  });
  const previewBrush = (event: React.PointerEvent) => {
    if (!(mode === Mode.Erase || (mode === Mode.Markup && tool === ImageEditorTool.Eraser)) || !stage.current || busy || compare || space || job) { setBrushPoint(undefined); return; }
    const rect = stage.current.getBoundingClientRect();
    setBrushPoint(event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
      ? imagePoint(event.clientX, event.clientY, rect) : undefined);
  };
  const pointerDown = (event: React.PointerEvent) => {
    previewBrush(event);
    if (!loaded || event.button !== 0 || busy || compare || !stage.current || !viewport.current) return;
    stage.current.focus(); stage.current.setPointerCapture(event.pointerId);
    const point = imagePoint(event.clientX, event.clientY, stage.current.getBoundingClientRect());
    drag.current = { start: point };
    if (space || isPanMode || job) {
      drag.current.pan = { x: event.clientX, y: event.clientY, left: viewport.current.scrollLeft, top: viewport.current.scrollTop }; return;
    }
    if (mode === Mode.Comment) {
      setSelection({ id: crypto.randomUUID(), ...imageRectangle(point, point), text: '' }); setRegionText(''); setSelecting(true); return;
    }
    const mark: ImageMark = { id: crypto.randomUUID(), tool: mode === Mode.Erase ? ImageEditorTool.Pen : tool as ImageMark['tool'],
      points: [point], color, width: (mode === Mode.Erase ? maskBrush : tool === ImageEditorTool.Eraser ? eraserBrush : brush) / 1000,
      ...(tool === ImageEditorTool.Text ? { fontSize: fontSize / Math.max(loaded.version.width, loaded.version.height), text: '' } : {}) };
    activeMarkRef.current = mark; setActiveMark(mark);
  };
  const pointerMove = (event: React.PointerEvent) => {
    previewBrush(event);
    if (!drag.current || !loaded || !stage.current) return;
    if (drag.current.pan && viewport.current) {
      viewport.current.scrollLeft = drag.current.pan.left - event.clientX + drag.current.pan.x;
      viewport.current.scrollTop = drag.current.pan.top - event.clientY + drag.current.pan.y; return;
    }
    const point = imagePoint(event.clientX, event.clientY, stage.current.getBoundingClientRect());
    if (mode === Mode.Comment) {
      const start = drag.current.start;
      setSelection(current => current && ({ ...current, ...imageRectangle(start, point) })); return;
    }
    if (activeMarkRef.current) {
      const current = activeMarkRef.current;
      const points = current.tool === ImageEditorTool.Pen || current.tool === ImageEditorTool.Eraser ? [...current.points, point].slice(-10000) : [current.points[0], point];
      activeMarkRef.current = { ...current, points }; setActiveMark(activeMarkRef.current);
    }
  };
  const pointerUp = (event: React.PointerEvent) => {
    if (activeMarkRef.current && event.type !== 'pointercancel') {
      if (mode === Mode.Markup && activeMarkRef.current.tool === ImageEditorTool.Text && stage.current) {
        const mark = activeMarkRef.current, rect = stage.current.getBoundingClientRect();
        const box = imageTextBox(mark.points[0], mark.points[mark.points.length - 1], rect.width, rect.height);
        setTextDraft({ ...mark, points: [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y + box.height }] });
      } else if (mode === Mode.Erase) commit(undefined, [...drawingRef.current.mask, activeMarkRef.current]);
      else commit([...drawingRef.current.marks, activeMarkRef.current]);
    }
    if (mode === Mode.Comment && drag.current && !drag.current.pan && stage.current) {
      const rect = stage.current.getBoundingClientRect(), point = imagePoint(event.clientX, event.clientY, rect);
      const box = imageRectangle(drag.current.start, point);
      // A click rather than a drag reopens the region under the pointer.
      if (event.type === 'pointercancel' || box.width * rect.width < 6 || box.height * rect.height < 6) {
        const hit = event.type === 'pointercancel' ? undefined : [...drawingRef.current.regions].reverse().find(region =>
          point.x >= region.x && point.x <= region.x + region.width && point.y >= region.y && point.y <= region.y + region.height);
        setSelection(hit); setRegionText(hit?.text ?? '');
      }
    }
    setSelecting(false);
    activeMarkRef.current = undefined; setActiveMark(undefined); drag.current = undefined;
    if (stage.current?.hasPointerCapture(event.pointerId)) stage.current.releasePointerCapture(event.pointerId);
  };
  const studioClose = onClose && <ToolButton label={t('close')} icon={XMarkIcon} onClick={onClose} className="non-draggable pointer-events-auto" />;
  const fallbackSrc = getImageArtifactSrc(artifact);
  const platform = window.electron?.platform;
  const topBarClass = `pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start gap-2 p-3 ${
    isStudio ? `draggable ${platform === 'darwin' ? 'pl-[84px]' : ''} ${platform === 'win32' ? 'pr-[150px]' : ''}` : ''}`;
  if (initialFailed) return <div className="flex h-full flex-col">
    <div className={`flex items-center gap-2 px-4 py-2 ${isStudio ? 'draggable' : ''}`}><p className="flex-1 text-xs text-muted">{error || t('imageEditUnsupported')}</p>{studioClose}</div>
    <div className="min-h-0 flex-1"><ImageRenderer artifact={artifact} /></div>
  </div>;
  // The bottom bar renders while loading too, so the placeholder is laid out around its real height, mode panel included.
  const compact = viewportSize.width < COMPACT_WIDTH;
  const isEraser = mode === Mode.Markup && tool === ImageEditorTool.Eraser;
  const isText = mode === Mode.Markup && tool === ImageEditorTool.Text;
  const brushValue = mode === Mode.Erase ? maskBrush : isEraser ? eraserBrush : brush;
  const brushLabel = mode === Mode.Erase ? 'imageEditEraseBrush' : isEraser ? 'imageEditEraserSize' : isText ? 'imageEditFontSize' : 'imageEditStrokeWidth';
  const [sizeMin, sizeMax] = isText ? [16, 240] : mode === Mode.Erase || isEraser ? [8, 150] : [1, 16];
  const sizeValue = isText ? fontSize : brushValue;
  const longestSide = loaded ? Math.max(loaded.version.width, loaded.version.height) : 0;
  const sizePixels = isText ? fontSize : Math.round(brushValue / 1000 * longestSide);
  const changeSize = (value: number) => {
    if (isText) { setFontSize(value); setTextDraft(mark => mark && ({ ...mark, fontSize: value / longestSide })); }
    else (mode === Mode.Erase ? setMaskBrush : isEraser ? setEraserBrush : setBrush)(value);
  };
  // Markup carries its tool hints as tooltips on its own bar.
  const hint = t(mode === Mode.Comment ? 'imageEditCommentHint' : mode === Mode.RemoveBackground ? 'imageEditRemoveBackgroundHint'
    : mode === Mode.Erase ? 'imageEditEraseHint' : 'imageEditResizeHint');
  const switchMode = (value: Mode) => { finishText(); setMode(mode === value ? Mode.View : value); setCompare(false); setNotice(''); };
  const changeColor = (value: string) => { setColor(value); setTextDraft(mark => mark && ({ ...mark, color: value })); };
  const tools = [
    [Mode.View, HandRaisedIcon, 'imageEditView'], [Mode.Comment, RegionEditIcon, 'imageEditComment'], [Mode.Markup, DrawIcon, 'imageEditMarkup'],
    [Mode.Erase, EraserIcon, 'imageEditErase'], [Mode.RemoveBackground, RemoveBackgroundIcon, 'imageEditRemoveBackground'], [Mode.Resize, ReframeIcon, 'imageEditReframe'],
  ] as const;
  const sizeControl = <label className="flex min-w-[180px] flex-1 items-center gap-2 text-xs text-secondary">
    {(mode === Mode.Erase || isEraser) && <span className="flex h-6 w-6 shrink-0 items-center justify-center" aria-hidden="true">
      <span className="rounded-full border border-current bg-current/10" style={{ width: 4 + brushValue / 10, height: 4 + brushValue / 10 }} />
    </span>}
    <span className="shrink-0">{t(brushLabel)}</span>
    <input type="range" min={sizeMin} max={sizeMax} aria-label={t(brushLabel)} value={sizeValue} className="min-w-12 max-w-36 flex-1 accent-accent"
      onChange={event => changeSize(Number(event.target.value))} />
    <output className="w-14 shrink-0 text-[11px] tabular-nums text-muted">{longestSide ? `${sizePixels} px` : ''}</output>
  </label>;
  const history = <div className="flex shrink-0 items-center">
    <ToolButton label={t('imageEditUndo')} icon={ArrowUturnLeftIcon} disabled={!drawing.past.length || !!textDraft} onClick={() => dispatch(undoImageDrawing(key))} />
    <ToolButton label={t('imageEditRedo')} icon={ArrowUturnRightIcon} disabled={!drawing.future.length || !!textDraft} onClick={() => dispatch(redoImageDrawing(key))} />
  </div>;
  const applyButton = (operation: ImageEditOperation, ready: boolean, label = t('imageEditGenerate')) =>
    <button type="button" className={primaryClass} disabled={busy || !ready} onClick={() => void generate(operation)}>{label}</button>;
  const modePanel = job && jobStatus ? <ImageEditProgressCard job={job} status={jobStatus} className={`${floatingClass} w-full max-w-[680px] animate-fade-in-up`}
    onShowInChat={isStudio ? onClose : undefined} onDismiss={() => dispatch(endImageEditJob(job.requestId))}
    onRetry={job.sourceId === loaded?.version.id ? () => { dispatch(endImageEditJob(job.requestId)); void generate(job.operation); } : undefined} />
    : mode === Mode.Markup ? <ImageMarkupToolbar className={floatingClass}
      tool={tool} color={color} size={{ value: sizeValue, min: sizeMin, max: sizeMax, pixels: sizePixels, label: brushLabel }} instruction={instruction}
      canUndo={!!drawing.past.length && !textDraft} canRedo={!!drawing.future.length && !textDraft}
      canApply={!busy && !!(drawing.marks.length || textDraft?.text?.trim())}
      onToolChange={value => { finishText(); setTool(value); setBrushPoint(undefined); }} onColorChange={changeColor} onSizeChange={changeSize}
      onInstructionChange={setInstruction} onUndo={() => dispatch(undoImageDrawing(key))} onRedo={() => dispatch(redoImageDrawing(key))}
      onApply={() => void generate(ImageEditOperation.Markup)} />
    : mode !== Mode.View && <div className={`${floatingClass} w-full max-w-[680px] animate-fade-in-up rounded-2xl p-2`}>
    {mode === Mode.RemoveBackground ? <div className="flex items-center gap-3 pl-1.5">
      <p className="min-w-0 flex-1 text-xs leading-5 text-secondary">{hint}</p>
      {applyButton(ImageEditOperation.RemoveBackground, true)}
    </div> : <p className="px-1.5 pb-2 text-xs leading-5 text-secondary">{hint}</p>}
    {mode === Mode.Erase && <div data-image-text-controls className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1">
      {sizeControl}{history}
      {applyButton(ImageEditOperation.Erase, drawing.mask.length > 0)}
    </div>}
    {mode === Mode.Comment && <div className="flex items-center gap-2 px-1">
      <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
        {drawing.regions.map((region, index) => <span key={region.id} className={`inline-flex max-w-[240px] items-center gap-1 rounded-full border py-0.5 pl-1 pr-0.5 text-xs ${
          selection?.id === region.id ? 'border-accent/40 bg-accent/10' : 'border-border bg-black/[0.03] dark:bg-white/[0.04]'}`}>
          <button type="button" className="flex min-w-0 items-center gap-1.5" onClick={() => { setSelection(region); setRegionText(region.text); }}>
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-medium text-white">{index + 1}</span>
            <span className="truncate text-foreground">{region.text}</span>
          </button>
          <button type="button" title={t('imageEditDelete')} aria-label={t('imageEditDelete')} disabled={busy}
            onClick={() => setRegions(drawing.regions.filter(r => r.id !== region.id))}
            className="rounded-full p-0.5 text-muted hover:bg-black/10 hover:text-foreground dark:hover:bg-white/10"><XMarkIcon className="h-3 w-3" /></button>
        </span>)}
      </div>
      {applyButton(ImageEditOperation.Comment, drawing.regions.length > 0,
        drawing.regions.length ? t('imageEditGenerateRegions').replace('{count}', String(drawing.regions.length)) : undefined)}
    </div>}
    {mode === Mode.Resize && <div role="group" aria-label={t('imageEditRatio')} className="flex flex-wrap items-center gap-1.5 px-1">
      {IMAGE_EDIT_RATIOS.map(value => {
        const [w, h] = value.split(':').map(Number);
        return <button key={value} type="button" aria-pressed={ratio === value} onClick={() => setRatio(value)}
          className={`inline-flex h-9 min-w-[60px] items-center justify-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors ${
            ratio === value ? 'border-accent bg-accent/10 text-accent' : 'border-border text-secondary hover:text-foreground'}`}>
          <span aria-hidden="true" className="rounded-[2px] border-[1.5px] border-current" style={{ width: 16 * Math.min(1, w / h), height: 16 * Math.min(1, h / w) }} />{value}
        </button>;
      })}
      <span className="ml-auto">{applyButton(ImageEditOperation.Reframe, true)}</span>
    </div>}
  </div>;
  // Keyed alike in both renders below, so finishing the load keeps the bar's elements and does not replay its panel's entry animation.
  const bottomBarElement = <div key="bottom-bar" ref={bottomBar} className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-2 px-3 pb-3 pt-2">
    {modePanel}
    <div role="toolbar" aria-label={t('imageEditTools')} className={`${floatingClass} flex max-w-full items-center gap-0.5 overflow-x-auto rounded-2xl p-1`}>
      {tools.map(([value, Icon, label], index) => <React.Fragment key={value}>
        {index === 1 && <span className={dividerClass} />}
        <button type="button" title={t(label)} aria-label={t(label)} aria-pressed={mode === value} disabled={busy || !!job} onClick={() => switchMode(value)}
          className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${compact ? 'w-9 justify-center' : 'px-2.5'} ${
            mode === value ? 'bg-accent/10 text-accent' : 'text-secondary hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10'}`}>
          <Icon className="h-[18px] w-[18px] shrink-0" />{!compact && <span>{t(label)}</span>}
        </button>
      </React.Fragment>)}
    </div>
  </div>;
  const rootClass = 'relative h-full min-h-0 overflow-hidden text-foreground';
  const viewportClass = `absolute inset-0 overflow-auto ${stageBackgroundClass}`;
  // The placeholder is laid out like the stage and shown at full strength, so the canvas takes its place without moving.
  if (!loaded) return <div ref={root} className={rootClass} aria-label={t('imageEditTitle')}>
    <div key="viewport" ref={viewport} className={viewportClass}>
      {isStudio && fallbackSrc && <div className="absolute inset-0" style={{ padding: `${insets.top}px ${STAGE_GUTTER}px ${insets.bottom}px` }}>
        <div className="relative h-full w-full">
          <img src={fallbackSrc} alt="" draggable={false} className={`absolute inset-0 m-auto max-h-full max-w-full ${imageFrameClass}`} style={CHECKERBOARD} />
        </div>
      </div>}
    </div>
    {/* Delayed, so a quick load does not flash it. */}
    <span className={`text-sm text-muted ${isStudio ? 'absolute left-1/2 top-16 -translate-x-1/2 animate-[fade-in_0.2s_ease-out_0.3s_both] rounded-full border border-border bg-surface/95 px-3 py-1.5 text-xs shadow-popover'
      : 'pointer-events-none absolute inset-0 flex items-center justify-center'}`}>{t('imageEditLoading')}</span>
    {studioClose && <div className={topBarClass}><div className="ml-auto rounded-xl border border-transparent p-1">{studioClose}</div></div>}
    {bottomBarElement}
  </div>;
  const size = loaded.version;
  const fit = Math.min((viewportSize.width - STAGE_GUTTER * 2) / size.width, (viewportSize.height - insets.top - insets.bottom) / size.height, 1);
  const displayWidth = Math.max(1, size.width * Math.max(0.01, fit) * zoom);
  const displayHeight = Math.max(1, size.height * Math.max(0.01, fit) * zoom);
  const eraseCursor = (mode === Mode.Erase || isEraser) && !space && !compare && !busy && !job;
  const working = !!job && job.sourceId === size.id && jobStatus?.phase !== ImageEditJobPhase.Failed;
  const brushDiameter = brushValue / 1000 * Math.max(displayWidth, displayHeight);
  const visibleRegions = drawing.regions.map(region => selection && region.id === selection.id ? selection : region);
  if (selection && !drawing.regions.some(region => region.id === selection.id)) visibleRegions.push(selection);
  const regionExists = !!selection && drawing.regions.some(region => region.id === selection.id);
  const canSubmitRegion = !busy && !!regionText.trim() && !!selection?.width && !!selection?.height && (regionExists || drawing.regions.length < IMAGE_EDIT_MAX_REGIONS);
  const submitRegion = () => {
    if (!selection || !canSubmitRegion) return;
    const updated = { ...selection, text: regionText.trim() };
    setRegions(regionExists ? drawing.regions.map(region => region.id === selection.id ? updated : region) : [...drawing.regions, updated]);
  };
  const versionLabel = (version: ImageVersion) => {
    const index = versions.findIndex(v => v.id === version.id);
    return version.id === version.rootId ? t('imageEditOriginal') : `${index >= 0 ? `v${index + 1} · ` : ''}${imageEditTitle(version.operation)}`;
  };
  // The current version reuses the bytes already in memory; its own file is an uncached full-size load that pops in after the editor.
  const thumbnail = (version: ImageVersion) => version.id === size.id ? loaded.dataUrl : buildLocalFileSrc(version.filePath, version.createdAt);
  // Same feedback as the conversation's copy button: a check for a moment on success, an error only on failure.
  const copyImage = async () => {
    const result = await window.electron?.clipboard?.writeImageFromDataUrl(loaded.dataUrl);
    if (!result?.success) { setError(result?.error || t('copyFailed')); return; }
    setCopied(true);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  };
  return <div ref={root} className={rootClass} aria-label={t('imageEditTitle')}>
    <div key="viewport" ref={viewport} onScroll={() => setBrushPoint(undefined)}
      className={viewportClass}>
      <div className="flex min-h-full min-w-full" style={{ width: Math.max(viewportSize.width, displayWidth + STAGE_GUTTER * 2),
        height: Math.max(viewportSize.height, displayHeight + insets.top + insets.bottom), padding: `${insets.top}px ${STAGE_GUTTER}px ${insets.bottom}px` }}>
        <div ref={stage} tabIndex={0} role="img" aria-label={size.title} onPointerDown={pointerDown} onPointerMove={pointerMove}
          onPointerUp={pointerUp} onPointerCancel={pointerUp}
          onPointerEnter={previewBrush} onPointerLeave={() => setBrushPoint(undefined)}
          className="relative m-auto shrink-0 touch-none select-none rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent"
          style={{ width: displayWidth, height: displayHeight, cursor: space || isPanMode || job ? 'grab' : eraseCursor ? 'none' : 'crosshair' }}>
          <canvas ref={canvas} width={size.width} height={size.height} style={CHECKERBOARD} onAnimationEnd={() => setRevealId(undefined)}
            className={`h-full w-full ${imageFrameClass} ${revealId === size.id ? 'image-edit-reveal' : ''}`} />
          {working && !compare && <ImageEditStageOverlay />}
          {mode === Mode.Markup && !compare && textDraft && <ImageTextBox mark={textDraft} width={displayWidth} height={displayHeight}
            onChange={setTextDraft} onFinish={finishText} onCancel={() => setTextDraft(undefined)} />}
          {activeMark?.tool === ImageEditorTool.Text && <div className="pointer-events-none absolute border border-dashed border-accent"
            style={(() => { const box = imageRectangle(activeMark.points[0], activeMark.points[activeMark.points.length - 1]);
              return { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` }; })()} />}
          {eraseCursor && brushPoint && <div data-image-erase-cursor aria-hidden="true"
            className={`pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-white ${isEraser ? 'bg-black/15' : 'bg-rose-400/20'}`}
            style={{ left: `${brushPoint.x * 100}%`, top: `${brushPoint.y * 100}%`, width: brushDiameter, height: brushDiameter, boxShadow: '0 0 0 1px rgba(0,0,0,.65)' }} />}
          {mode === Mode.Comment && !compare && <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
            {visibleRegions.map((region, i) => <g key={region.id} className={working ? 'image-edit-region-working' : undefined}>
              <rect x={region.x} y={region.y} width={region.width} height={region.height} fill={region.id === selection?.id ? 'rgba(59,130,246,.18)' : 'rgba(59,130,246,.1)'}
                stroke="#3b82f6" strokeWidth={2 / displayWidth} strokeDasharray={region.id === selection?.id ? undefined : `${5 / displayWidth} ${3 / displayWidth}`} />
              <svg x={region.x} y={region.y} width={22 / displayWidth} height={22 / displayHeight} viewBox="0 0 22 22">
                <rect width="22" height="22" rx="6" fill="#2563eb" /><text x="11" y="15" textAnchor="middle" fontSize="12" fill="white">{i + 1}</text>
              </svg>
            </g>)}
          </svg>}
          {mode === Mode.Comment && !compare && !job && selection && !selecting && selection.width > 0 && selection.height > 0 && <div
            onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
            className="absolute z-10 w-72 max-w-[calc(100vw-48px)] animate-scale-in cursor-auto rounded-xl border border-border bg-surface p-2 text-foreground shadow-popover"
            style={composerPosition(selection)}>
            <textarea ref={regionInput} value={regionText} maxLength={4000} rows={2} placeholder={t('imageEditCommentPlaceholder')}
              onChange={event => setRegionText(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setSelection(undefined); }
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submitRegion(); }
              }}
              className="block max-h-40 min-h-[52px] w-full resize-none bg-transparent px-1 py-0.5 text-sm leading-5 outline-none placeholder:text-muted" />
            <div className="mt-1 flex items-center justify-end gap-1">
              {regionExists && <ToolButton label={t('imageEditDelete')} icon={TrashIcon} disabled={busy}
                onClick={() => setRegions(drawing.regions.filter(region => region.id !== selection.id))} />}
              <button type="button" className={`${buttonClass} text-secondary hover:bg-black/5 dark:hover:bg-white/10`} onClick={() => setSelection(undefined)}>{t('imageEditCancel')}</button>
              <button type="button" className={primaryClass} disabled={!canSubmitRegion} onClick={submitRegion}>{t('imageEditAddRegion')}</button>
            </div>
          </div>}
        </div>
      </div>
    </div>
    <div ref={topBar} className={`${topBarClass} animate-fade-in`}>
      <div ref={versionPicker} className={`${floatingClass} non-draggable relative flex min-w-0 items-center gap-1 rounded-xl p-1`}>
        {isStudio && <><span className="max-w-[260px] truncate pl-2 pr-1 text-sm font-medium" title={artifact.title}>{artifact.title}</span><span className={dividerClass} /></>}
        {/* Anchor the menu to the trigger, not the pill, so it opens right under the select even when the title sits to its left. */}
        <div className="relative flex min-w-0">
          <button type="button" aria-haspopup="listbox" aria-expanded={versionMenu} title={t('imageStudioVersions')} disabled={busy && !versionMenu}
            onClick={() => setVersionMenu(open => !open)}
            className="flex min-w-0 items-center gap-2 rounded-lg py-1 pl-1 pr-1.5 text-xs transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/10">
            <img src={thumbnail(size)} alt="" draggable={false} className="h-6 w-6 shrink-0 rounded object-cover ring-1 ring-border" style={CHECKERBOARD} />
            <span className="truncate font-medium">{versionLabel(size)}</span>
            {!compact && <span className="shrink-0 tabular-nums text-muted">{size.width} × {size.height}</span>}
            <ChevronDownIcon className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${versionMenu ? 'rotate-180' : ''}`} />
          </button>
          {versionMenu && <div role="listbox" aria-label={t('imageStudioVersions')}
            className="absolute left-0 top-full z-30 mt-3 max-h-80 w-full min-w-[12rem] animate-fade-in-down overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-popover">
            <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted">{t('imageStudioVersions')} · {versions.length}</div>
            {versions.map(version => <button key={version.id} type="button" role="option" aria-selected={version.id === size.id}
              onClick={() => { setVersionMenu(false); if (version.id === size.id) return; finishText(); void run(() => loadVersion(version)); }}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${version.id === size.id ? 'bg-accent/10' : 'hover:bg-black/5 dark:hover:bg-white/10'}`}>
              <img src={thumbnail(version)} alt="" draggable={false} loading="lazy" className="h-10 w-10 shrink-0 rounded-md object-cover ring-1 ring-border" style={CHECKERBOARD} />
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{versionLabel(version)}</span>
                <span className="block tabular-nums text-muted">{version.width} × {version.height}</span></span>
              {version.id === size.id && <CheckIcon className="h-4 w-4 shrink-0 text-accent" />}
            </button>)}
            {job && jobStatus?.phase !== ImageEditJobPhase.Failed && <ImageEditPendingVersion label={`v${versions.length + 1} · ${imageEditTitle(job.operation)}`} />}
          </div>}
        </div>
      </div>
      <div className={`${floatingClass} non-draggable ml-auto flex shrink-0 items-center gap-0.5 rounded-xl p-1`}>
        {size.id !== size.rootId && <>
          {/* Press and hold: the original shows only while held, so there is no mode to forget to leave. */}
          <button type="button" title={t('imageEditCompareHint')} aria-pressed={compare} disabled={!original}
            onPointerDown={event => { if (event.button === 0) setCompare(true); }}
            onPointerUp={() => setCompare(false)} onPointerLeave={() => setCompare(false)} onPointerCancel={() => setCompare(false)} onBlur={() => setCompare(false)}
            onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); setCompare(true); } }}
            onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') { event.stopPropagation(); setCompare(false); } }}
            className={`inline-flex h-8 shrink-0 select-none items-center gap-1.5 rounded-lg px-2 text-xs transition-colors disabled:opacity-35 ${
              compare ? 'bg-accent/10 text-accent' : 'text-secondary hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10'}`}>
            <CompareIcon className="h-4 w-4 shrink-0" />{!compact && t('imageEditCompare')}
          </button>
          <span className={dividerClass} />
        </>}
        <ToolButton label={t('imageEditZoomOut')} icon={MinusIcon} onClick={() => { setZoom(value => clampZoom(value / 1.25)); setBrushPoint(undefined); }} />
        <button type="button" title={`${t('imageEditResetZoom')} · ${t('imageEditViewHint')}`} onClick={() => { setZoom(1); setBrushPoint(undefined); }}
          className="h-8 min-w-[46px] rounded-lg px-1 text-[11px] tabular-nums text-secondary transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10">
          {Math.round(Math.max(0.01, fit) * zoom * 100)}%
        </button>
        <ToolButton label={t('imageEditZoomIn')} icon={PlusIcon} onClick={() => { setZoom(value => clampZoom(value * 1.25)); setBrushPoint(undefined); }} />
        <span className={dividerClass} />
        {isStudio && <ToolButton label={t('imageEditCopy')} icon={copied ? CopiedIcon : MessageCopyIcon} onClick={() => void copyImage()} />}
        <ToolButton label={t('imageEditExport')} icon={ArrowDownTrayIcon} onClick={() => {
          const link = document.createElement('a'); link.href = loaded.dataUrl; link.download = size.title; link.click();
        }} />
        {isStudio ? <>
          <ToolButton label={t('imageStudioOpenInPanel')} icon={ViewColumnsIcon} onClick={() => {
            dispatch(openArtifactPreviewTab({ sessionId: artifact.sessionId, artifactId: artifact.id })); onClose?.();
          }} />
          <span className={dividerClass} />{studioClose}
        </> : isImageStudioAvailable() && <ToolButton label={t('imageStudioOpen')} icon={ArrowsPointingOutIcon} onClick={() => {
          finishText(); openImageInStudio(artifact, operationFor(mode), size.id);
        }} />}
      </div>
    </div>
    {(busy || error || notice) && <div className="pointer-events-none absolute inset-x-0 z-30 flex justify-center px-3" style={{ top: insets.top }}>
      <div role={error ? 'alert' : 'status'} className={`pointer-events-auto flex max-w-[min(560px,100%)] animate-fade-in-down items-center gap-2 rounded-xl border px-3 py-1.5 text-xs shadow-popover backdrop-blur ${
        error ? 'border-red-500/30 bg-red-50/95 text-red-600 dark:bg-red-950/80 dark:text-red-300' : 'border-border bg-surface/95 text-secondary'}`}>
        {busy && !error && <span aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />}
        <span className="min-w-0">{error || (busy ? t('imageEditSaving') : notice)}</span>
        {error && <button type="button" aria-label={t('close')} title={t('close')} onClick={() => setError('')} className="-mr-1 shrink-0 rounded p-0.5 hover:bg-black/5 dark:hover:bg-white/10"><XMarkIcon className="h-3.5 w-3.5" /></button>}
      </div>
    </div>}
    {bottomBarElement}
  </div>;
}
