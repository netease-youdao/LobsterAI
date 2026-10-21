import {
  ArrowDownTrayIcon, ArrowUpRightIcon,
  ArrowUturnLeftIcon, ArrowUturnRightIcon, BackspaceIcon, CursorArrowRaysIcon, PencilIcon,
  SparklesIcon, Square2StackIcon, Square3Stack3DIcon, StopIcon,
} from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { imagePoint, imageRectangle } from '../../../../shared/imageEditing/geometry';
import {
  IMAGE_EDIT_MAX_REGIONS, IMAGE_EDIT_RATIOS, ImageEditOperation, ImageEditorTool,
  type ImageEditRequest, type ImageMark, type ImagePoint, type ImageRegion, type ImageVersion,
} from '../../../../shared/imageEditing/types';
import { i18nService } from '../../../services/i18n';
import { imageEditDraftConflicts } from '../../../services/imageEditDrafts';
import { imageEditTitle, setImageEditDraft, submitImageEdit } from '../../../services/imageEditing';
import { type RootState, store } from '../../../store';
import { setDraftAttachments } from '../../../store/slices/coworkSlice';
import { commitImageDrawing, consumeImageEditorFocus, EMPTY_IMAGE_DOCUMENT, redoImageDrawing, setImageRegions, undoImageDrawing } from '../../../store/slices/imageEditorSlice';
import type { Artifact } from '../../../types/artifact';
import Modal from '../../common/Modal';
import ImageRenderer from '../renderers/ImageRenderer';
import { drawImageMark, drawImageMarks, exportImageDrawing, loadEditorImage } from './imageDrawing';
import { DrawIcon, EraserIcon, ReframeIcon, RegionEditIcon, RemoveBackgroundIcon, TextIcon } from './ImageEditingIcons';
import { imageTextBox } from './imageText';
import ImageTextBox from './ImageTextBox';

const t = (key: string) => i18nService.t(key);
const Mode = { View: 'view', Markup: 'markup', Comment: 'comment', RemoveBackground: 'remove-background', Erase: 'erase', Resize: 'resize' } as const;
type Mode = typeof Mode[keyof typeof Mode];
const buttonClass = 'inline-flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-35';
const inputClass = 'min-w-0 rounded-lg border border-light-border bg-light-surface px-2 py-1.5 text-xs text-primary focus:border-accent focus:outline-none dark:border-dark-border dark:bg-dark-surface';
function ToolButton({ label, icon: Icon, active, children, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string; icon?: React.ElementType; active?: boolean;
}) {
  return <button type="button" title={label} aria-label={label} aria-pressed={active} {...props}
    className={`${buttonClass} ${active ? 'bg-accent/10 text-accent' : 'text-secondary hover:bg-black/5 dark:hover:bg-white/10'} ${className}`}>
    {Icon && <Icon className="h-4 w-4 shrink-0" />}{children}
  </button>;
}

export default function ImageEditor({ artifact }: { artifact: Artifact }) {
  const dispatch = useDispatch();
  const bridge = window.electron?.artifact?.imageEditing;
  const [loaded, setLoaded] = useState<{ version: ImageVersion; dataUrl: string; image: HTMLImageElement }>();
  const loadedRef = useRef(loaded); loadedRef.current = loaded;
  const loadGeneration = useRef(0);
  const invalidateLoads = useCallback(() => { loadGeneration.current++; }, []);
  const [versions, setVersions] = useState<ImageVersion[]>([]);
  const [mode, setMode] = useState<Mode>(Mode.View);
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
  const [regionText, setRegionText] = useState('');
  const [textDraft, setTextDraft] = useState<ImageMark>();
  const textDraftRef = useRef(textDraft); textDraftRef.current = textDraft;
  const [replacement, setReplacement] = useState<{ request: ImageEditRequest; ids: string[]; applied: () => void }>();
  const [instruction, setInstruction] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [initialFailed, setInitialFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [viewportSize, setViewportSize] = useState({ width: 500, height: 500 });
  const [space, setSpace] = useState(false);
  const [compare, setCompare] = useState(false);
  const [original, setOriginal] = useState<HTMLImageElement>();
  const [ratio, setRatio] = useState<string>('16:9');
  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const regionInput = useRef<HTMLTextAreaElement>(null);
  const drag = useRef<{ start: ImagePoint; pan?: { x: number; y: number; left: number; top: number } }>();
  const pending = useRef(new Set<string>());
  const key = loaded ? `${artifact.sessionId}:${loaded.version.id}` : '';
  const drawing = useSelector((state: RootState) => state.imageEditor.documents[key] ?? EMPTY_IMAGE_DOCUMENT);
  const focusRequest = useSelector((state: RootState) => state.imageEditor.focus);
  const drawingRef = useRef(drawing); drawingRef.current = drawing;
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
    setMode(Mode.View); setSelection(undefined); setCompare(false); setError(''); setNotice('');
    pending.current.clear();
    const focus = store.getState().imageEditor.focus;
    const restoreVersion = focus?.source.sessionId === artifact.sessionId && (artifact.id === `image-edit-version-${focus.source.id}`
      || artifact.filePath === focus.source.originalPath || artifact.filePath === focus.source.filePath);
    const opening = restoreVersion ? bridge.read({ sessionId: artifact.sessionId, versionId: focus.source.id })
      : bridge.open({ sessionId: artifact.sessionId, title: artifact.title, filePath: artifact.filePath,
        dataUrl: artifact.filePath ? undefined : artifact.content });
    void opening.then(async result => {
      if (!result.success) throw new Error(result.error);
      const image = await loadEditorImage(result.data.dataUrl);
      const list = await bridge.list({ sessionId: artifact.sessionId, rootId: result.data.version.rootId });
      if (!alive || generation !== loadGeneration.current) return;
      setLoaded({ ...result.data, image }); setVersions(list.success ? list.data : [result.data.version]);
    }).catch(error => { if (alive) { setError(error.message); setInitialFailed(true); } });
    return () => { alive = false; invalidateLoads(); };
  }, [artifact.id, artifact.content, artifact.filePath, artifact.sessionId, artifact.title, bridge, invalidateLoads]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onChanged(version => {
      const current = loadedRef.current;
      if (version.sessionId !== artifact.sessionId || version.rootId !== current?.version.rootId) return;
      setVersions(values => values.some(v => v.id === version.id) ? values : [...values, version]);
      if (version.requestId && pending.current.has(version.requestId)) {
        pending.current.delete(version.requestId); setNotice(t('imageEditSaved'));
        if (current.version.id === version.parentId) void loadVersion(version).catch(error => setError(error.message));
      }
    });
  }, [artifact.sessionId, bridge, loadVersion]);

  useEffect(() => {
    if (!focusRequest || focusRequest.source.sessionId !== artifact.sessionId || focusRequest.source.rootId !== loaded?.version.rootId) return;
    dispatch(consumeImageEditorFocus(focusRequest.id));
    setMode(!focusRequest.operation || focusRequest.operation === ImageEditOperation.Comment ? Mode.Comment
      : focusRequest.operation === ImageEditOperation.RemoveBackground ? Mode.RemoveBackground : Mode.View);
    void loadVersion(focusRequest.source).then(() => {
      const region = store.getState().imageEditor.documents[`${artifact.sessionId}:${focusRequest.source.id}`]?.regions.find(r => r.id === focusRequest.regionId);
      if (region) { setSelection(region); setRegionText(region.text); }
    }).catch(error => setError(error.message));
  }, [artifact.sessionId, dispatch, focusRequest, loaded?.version.rootId, loadVersion]);

  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const observer = new ResizeObserver(() => setViewportSize({ width: element.clientWidth, height: element.clientHeight }));
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setBrushPoint(undefined);
      setZoom(value => Math.min(8, Math.max(0.25, value * Math.exp(-event.deltaY * 0.002))));
    };
    observer.observe(element); element.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); element.removeEventListener('wheel', wheel); };
  }, [loaded?.version.id]);

  useEffect(() => {
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
    const down = (event: KeyboardEvent) => {
      if (!root.current?.contains(document.activeElement) || /INPUT|TEXTAREA|SELECT/.test((event.target as HTMLElement).tagName)) return;
      if (event.code === 'Space') { event.preventDefault(); setSpace(true); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); dispatch(event.shiftKey ? redoImageDrawing(key) : undoImageDrawing(key));
      }
      if (event.key === 'Escape') { setSelection(undefined); setTextDraft(undefined); setMode(Mode.View); }
    };
    const up = () => setSpace(false);
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', up); };
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
  const stageDraft = (request: ImageEditRequest, applied: () => void = () => {}) => {
    if (setImageEditDraft(request)) { applied(); setNotice(t('imageEditDraftAdded')); return; }
    const attachments = store.getState().cowork.draftAttachments[artifact.sessionId] ?? [];
    setReplacement({ request, ids: imageEditDraftConflicts(attachments, request).map(conflict => conflict.id), applied });
  };
  const syncRegions = async (regions: ImageRegion[]) => {
    if (!loaded) return;
    const applied = () => { dispatch(setImageRegions({ key, regions })); setSelection(undefined); setRegionText(''); };
    if (regions.length) {
      const result = await bridge.stage({ sessionId: artifact.sessionId, sourceId: loaded.version.id, operation: ImageEditOperation.Comment, regions });
      if (!result.success) throw new Error(result.error);
      stageDraft(result.data, applied);
    } else {
      const attachments = store.getState().cowork.draftAttachments[artifact.sessionId] ?? [];
      dispatch(setDraftAttachments({ draftKey: artifact.sessionId, attachments: attachments.filter(a =>
        a.imageEdit?.source.id !== loaded.version.id || a.imageEdit.operation !== ImageEditOperation.Comment) }));
      applied();
    }
  };
  const generate = (operation: ImageEditOperation) => run(async () => {
    if (!loaded) return;
    finishText();
    const marks = store.getState().imageEditor.documents[key]?.marks ?? [];
    const guideDataUrl = operation === ImageEditOperation.Markup ? exportImageDrawing(loaded.image, marks)
      : operation === ImageEditOperation.Erase ? exportImageDrawing(loaded.image, drawing.mask, loaded.version.width, loaded.version.height, true) : undefined;
    const result = await bridge.stage({ sessionId: artifact.sessionId, sourceId: loaded.version.id, operation, guideDataUrl,
      instruction: operation === ImageEditOperation.Markup ? instruction : undefined, aspectRatio: operation === ImageEditOperation.Reframe ? ratio : undefined });
    if (!result.success) throw new Error(result.error);
    if (operation === ImageEditOperation.RemoveBackground) { stageDraft(result.data); return; }
    pending.current.add(result.data.id);
    try { await submitImageEdit(result.data); } catch (error) { pending.current.delete(result.data.id); throw error; }
    setNotice(t('imageEditPending'));
  });
  const save = () => run(async () => {
    if (!loaded) return;
    finishText();
    const dataUrl = exportImageDrawing(loaded.image, store.getState().imageEditor.documents[key]?.marks ?? []);
    const result = await bridge.save({ sessionId: artifact.sessionId, sourceId: loaded.version.id, operation: ImageEditOperation.Markup, dataUrl });
    if (!result.success) throw new Error(result.error);
    await loadVersion(result.data); setNotice(t('imageEditSaved')); setMode(Mode.View);
  });
  const previewBrush = (event: React.PointerEvent) => {
    if (!(mode === Mode.Erase || (mode === Mode.Markup && tool === ImageEditorTool.Eraser)) || !stage.current || busy || compare || space) { setBrushPoint(undefined); return; }
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
    if (space || isPanMode) {
      drag.current.pan = { x: event.clientX, y: event.clientY, left: viewport.current.scrollLeft, top: viewport.current.scrollTop }; return;
    }
    if (mode === Mode.Comment) {
      setSelection({ id: crypto.randomUUID(), ...imageRectangle(point, point), text: '' }); setRegionText(''); return;
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
    if (mode === Mode.Comment) { setSelection(current => current && ({ ...current, ...imageRectangle(drag.current!.start, point) })); return; }
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
    activeMarkRef.current = undefined; setActiveMark(undefined); drag.current = undefined;
    if (stage.current?.hasPointerCapture(event.pointerId)) stage.current.releasePointerCapture(event.pointerId);
    if (mode === Mode.Comment && event.type !== 'pointercancel') regionInput.current?.focus();
  };
  if (initialFailed) return <div className="flex h-full flex-col"><p className="px-4 py-2 text-xs text-muted">{error || t('imageEditUnsupported')}</p><div className="min-h-0 flex-1"><ImageRenderer artifact={artifact} /></div></div>;
  if (!loaded) return <div className="flex h-full items-center justify-center text-sm text-muted">{t('imageEditLoading')}</div>;
  const size = loaded.version;
  const fit = Math.min((viewportSize.width - 32) / size.width, (viewportSize.height - 32) / size.height, 1);
  const displayWidth = Math.max(1, size.width * Math.max(0.01, fit) * zoom);
  const displayHeight = Math.max(1, size.height * Math.max(0.01, fit) * zoom);
  const isEraser = mode === Mode.Markup && tool === ImageEditorTool.Eraser;
  const isText = mode === Mode.Markup && tool === ImageEditorTool.Text;
  const eraseCursor = (mode === Mode.Erase || isEraser) && !space && !compare && !busy;
  const brushValue = mode === Mode.Erase ? maskBrush : isEraser ? eraserBrush : brush;
  const brushDiameter = brushValue / 1000 * Math.max(displayWidth, displayHeight);
  const brushLabel = mode === Mode.Erase ? 'imageEditEraseBrush' : isEraser ? 'imageEditEraserSize' : isText ? 'imageEditFontSize' : 'imageEditStrokeWidth';
  const markupHint = { [ImageEditorTool.Pen]: 'imageEditPenHint', [ImageEditorTool.Arrow]: 'imageEditArrowHint',
    [ImageEditorTool.Rectangle]: 'imageEditRectangleHint', [ImageEditorTool.Text]: 'imageEditTextHint', [ImageEditorTool.Eraser]: 'imageEditEraserHint' };
  const visibleRegions = drawing.regions.map(region => selection && region.id === selection.id ? selection : region);
  if (selection && !drawing.regions.some(region => region.id === selection.id)) visibleRegions.push(selection);
  const tools = [
    [Mode.Markup, DrawIcon, 'imageEditMarkup'], [Mode.Comment, RegionEditIcon, 'imageEditComment'],
    [Mode.RemoveBackground, RemoveBackgroundIcon, 'imageEditRemoveBackground'],
    [Mode.Erase, EraserIcon, 'imageEditErase'], [Mode.Resize, ReframeIcon, 'imageEditReframe'],
  ] as const;
  return <div ref={root} className="flex h-full min-h-0 flex-col text-primary" aria-label={t('imageEditTitle')}>
    <div className="flex items-center gap-2 border-b border-light-border px-3 py-2 dark:border-dark-border">
      <Square3Stack3DIcon className="h-4 w-4 text-muted" />
      <select aria-label={t('imageEditVersion')} className={`${inputClass} flex-1 border-0 bg-transparent`} value={size.id}
        onChange={event => { finishText(); const version = versions.find(v => v.id === event.target.value); if (version) void run(() => loadVersion(version)); }}>
        {versions.map((version, i) => <option key={version.id} value={version.id}>{i === 0 ? t('imageEditOriginal') : `v${i + 1} · ${imageEditTitle(version.operation)}`} · {version.width} × {version.height}</option>)}
      </select>
      <ToolButton label={t('imageEditCompare')} icon={Square2StackIcon} active={compare} disabled={size.id === size.rootId || busy}
        onClick={() => void run(async () => {
          if (!original) { const result = await bridge.read({ sessionId: artifact.sessionId, versionId: size.rootId }); if (!result.success) throw new Error(result.error); setOriginal(await loadEditorImage(result.data.dataUrl)); }
          setCompare(!compare);
        })} />
      <ToolButton label={t('imageEditExport')} icon={ArrowDownTrayIcon} onClick={() => {
        const link = document.createElement('a'); link.href = loaded.dataUrl; link.download = size.title; link.click();
      }} />
    </div>
    <div className="flex flex-wrap items-center justify-center gap-0.5 border-b border-light-border px-2 py-2 dark:border-dark-border">
      {tools.map(([value, icon, label]) => <ToolButton key={value} label={t(label)} icon={icon} active={mode === value}
        disabled={busy} onClick={() => { finishText(); setMode(mode === value ? Mode.View : value); setCompare(false); setNotice(''); }}>{t(label)}</ToolButton>)}
    </div>
    {(mode === Mode.Markup || mode === Mode.Erase) && <div className="flex flex-wrap items-center gap-1 border-b border-light-border px-2 py-2 dark:border-dark-border">
      {mode === Mode.Markup && <div className="flex flex-wrap items-center gap-0.5">
        {[[ImageEditorTool.Pen, PencilIcon, 'imageEditPen'], [ImageEditorTool.Arrow, ArrowUpRightIcon, 'imageEditArrow'],
          [ImageEditorTool.Rectangle, StopIcon, 'imageEditRectangle'], [ImageEditorTool.Text, TextIcon, 'imageEditText'],
          [ImageEditorTool.Eraser, EraserIcon, 'imageEditEraser']].map(([value, icon, label]) => <ToolButton key={String(value)} label={t(String(label))} icon={icon as React.ElementType}
            active={tool === value} onClick={() => { finishText(); setTool(value as ImageEditorTool); setBrushPoint(undefined); }}>{t(String(label))}</ToolButton>)}
      </div>}
      <div data-image-text-controls className={`flex min-w-0 flex-wrap items-center gap-3 ${mode === Mode.Markup ? 'mt-1 w-full border-t border-light-border pt-2 dark:border-dark-border' : 'flex-1'}`}>
        {mode === Mode.Markup && !isEraser && <label className="flex items-center gap-1.5 border-r border-light-border pr-3 text-xs text-secondary dark:border-dark-border">
          {t('imageEditColor')}<input type="color" value={color} aria-label={t('imageEditColor')}
            onChange={event => { setColor(event.target.value); setTextDraft(mark => mark && ({ ...mark, color: event.target.value })); }}
            className="h-6 w-6 cursor-pointer rounded border-0 bg-transparent" />
        </label>}
        <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-secondary">
          {(mode === Mode.Erase || isEraser) && <span className="flex h-6 w-6 shrink-0 items-center justify-center" aria-hidden="true">
            <span className="rounded-full border border-current bg-current/10" style={{ width: 4 + brushValue / 10, height: 4 + brushValue / 10 }} />
          </span>}
          <span className="shrink-0">{t(brushLabel)}</span>
          <input type="range" min={isText ? 16 : mode === Mode.Erase || isEraser ? 8 : 1} max={isText ? 240 : mode === Mode.Erase || isEraser ? 150 : 16}
            aria-label={t(brushLabel)} value={isText ? fontSize : brushValue} className="min-w-10 max-w-28 flex-1 accent-accent"
            onChange={event => {
              const value = Number(event.target.value);
              if (isText) { setFontSize(value); setTextDraft(mark => mark && ({ ...mark, fontSize: value / Math.max(size.width, size.height) })); }
              else (mode === Mode.Erase ? setMaskBrush : isEraser ? setEraserBrush : setBrush)(value);
            }} />
          <output className="shrink-0 text-[11px] tabular-nums text-muted">{isText ? fontSize : Math.round(brushValue / 1000 * Math.max(size.width, size.height))} px</output>
        </label>
        <div className="ml-auto flex border-l border-light-border pl-2 dark:border-dark-border">
          <ToolButton label={t('imageEditUndo')} icon={ArrowUturnLeftIcon} disabled={!drawing.past.length || !!textDraft} onClick={() => dispatch(undoImageDrawing(key))} />
          <ToolButton label={t('imageEditRedo')} icon={ArrowUturnRightIcon} disabled={!drawing.future.length || !!textDraft} onClick={() => dispatch(redoImageDrawing(key))} />
        </div>
      </div>
    </div>}
    <div ref={viewport} onScroll={() => setBrushPoint(undefined)} className="relative min-h-32 flex-1 overflow-auto bg-black/[0.025] dark:bg-white/[0.025]">
      <div className="flex min-h-full min-w-full p-4" style={{ width: Math.max(viewportSize.width, displayWidth + 32), height: Math.max(viewportSize.height, displayHeight + 32) }}>
        <div ref={stage} tabIndex={0} role="img" aria-label={size.title} onPointerDown={pointerDown} onPointerMove={pointerMove}
          onPointerUp={pointerUp} onPointerCancel={pointerUp}
          onPointerEnter={previewBrush} onPointerLeave={() => setBrushPoint(undefined)}
          className="relative m-auto shrink-0 touch-none select-none shadow-md outline-none focus-visible:ring-2 focus-visible:ring-accent"
          style={{ width: displayWidth, height: displayHeight, cursor: space || isPanMode ? 'grab' : eraseCursor ? 'none' : 'crosshair',
            backgroundColor: '#fff', backgroundImage: 'conic-gradient(#e5e7eb 25%, transparent 0 50%, #e5e7eb 0 75%, transparent 0)', backgroundSize: '16px 16px' }}>
          <canvas ref={canvas} width={size.width} height={size.height} className="h-full w-full" />
          {mode === Mode.Markup && !compare && textDraft && <ImageTextBox mark={textDraft} width={displayWidth} height={displayHeight}
            onChange={setTextDraft} onFinish={finishText} onCancel={() => setTextDraft(undefined)} />}
          {activeMark?.tool === ImageEditorTool.Text && <div className="pointer-events-none absolute border border-dashed border-accent"
            style={(() => { const box = imageRectangle(activeMark.points[0], activeMark.points[activeMark.points.length - 1]);
              return { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` }; })()} />}
          {eraseCursor && brushPoint && <div data-image-erase-cursor aria-hidden="true"
            className={`pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-white ${isEraser ? 'bg-black/15' : 'bg-rose-400/20'}`}
            style={{ left: `${brushPoint.x * 100}%`, top: `${brushPoint.y * 100}%`, width: brushDiameter, height: brushDiameter, boxShadow: '0 0 0 1px rgba(0,0,0,.65)' }} />}
          {mode === Mode.Comment && !compare && <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
            {visibleRegions.map((region, i) => <g key={region.id}>
              <rect x={region.x} y={region.y} width={region.width} height={region.height} fill="rgba(59,130,246,.12)" stroke="#3b82f6" strokeWidth={2 / displayWidth} strokeDasharray={`${5 / displayWidth} ${3 / displayWidth}`} />
              <svg x={region.x} y={region.y} width={22 / displayWidth} height={22 / displayHeight} viewBox="0 0 22 22">
                <rect width="22" height="22" rx="6" fill="#2563eb" /><text x="11" y="15" textAnchor="middle" fontSize="12" fill="white">{i + 1}</text>
              </svg>
            </g>)}
          </svg>}
        </div>
      </div>
    </div>
    <div data-image-edit-hint className="flex items-center gap-2 border-t border-light-border bg-accent/5 px-3 py-3 text-sm font-medium text-secondary dark:border-dark-border">
      <CursorArrowRaysIcon className="h-4 w-4 shrink-0" /><span className="flex-1">{t(mode === Mode.View ? 'imageEditViewHint' : mode === Mode.Comment ? 'imageEditCommentHint' : mode === Mode.RemoveBackground ? 'imageEditRemoveBackgroundHint' : mode === Mode.Erase ? 'imageEditEraseHint' : mode === Mode.Resize ? 'imageEditResizeHint' : markupHint[tool as keyof typeof markupHint])}</span>
      <button type="button" title={t('imageEditResetZoom')} onClick={() => { setZoom(1); setBrushPoint(undefined); }} className="shrink-0 rounded px-1.5 py-1 text-[11px] font-normal text-muted hover:bg-black/5 dark:hover:bg-white/10">{Math.round(Math.max(0.01, fit) * zoom * 100)}%</button>
    </div>
    <div className="max-h-[45%] shrink-0 overflow-y-auto">
      {mode === Mode.RemoveBackground && <div className="flex justify-end border-t border-light-border p-3 dark:border-dark-border">
        <button type="button" className={`${buttonClass} bg-accent text-white`} disabled={busy}
          onClick={() => void generate(ImageEditOperation.RemoveBackground)}>{t('imageEditAddComment')}</button>
      </div>}
      {mode === Mode.Comment && <div className="space-y-2 border-t border-light-border p-3 dark:border-dark-border">
        <textarea ref={regionInput} disabled={!selection} value={regionText} maxLength={4000} onChange={event => setRegionText(event.target.value)} placeholder={t('imageEditCommentPlaceholder')}
          className={`${inputClass} min-h-16 w-full resize-y`} />
        <div className="flex justify-end gap-2"><ToolButton label={t('imageEditCancel')} onClick={() => setSelection(undefined)}>{t('imageEditCancel')}</ToolButton>
          <button type="button" disabled={busy || !regionText.trim() || !selection?.width || !selection?.height || (drawing.regions.length >= IMAGE_EDIT_MAX_REGIONS && !drawing.regions.some(region => region.id === selection?.id))}
            className={`${buttonClass} bg-accent text-white`} onClick={() => selection && void run(() => {
              const updated = { ...selection, text: regionText.trim() };
              return syncRegions(drawing.regions.some(region => region.id === selection.id)
                ? drawing.regions.map(region => region.id === selection.id ? updated : region)
                : [...drawing.regions, updated]);
            })}>{t('imageEditAddComment')}</button></div>
      </div>}
      {mode === Mode.Comment && drawing.regions.length > 0 && <div className="space-y-1 px-3 pb-3">
        {drawing.regions.map((region, index) => <div key={region.id} className="flex items-center gap-2 rounded-lg bg-accent/5 px-2 py-1.5 text-xs">
          <span className="text-accent">{index + 1}</span><button type="button" className="flex-1 truncate text-left" onClick={() => { setSelection(region); setRegionText(region.text); }}>{region.text}</button>
          <ToolButton label={t('imageEditDelete')} icon={BackspaceIcon} disabled={busy} onClick={() => void run(() => syncRegions(drawing.regions.filter(r => r.id !== region.id)))} />
        </div>)}
      </div>}
      {(mode === Mode.Markup || mode === Mode.Erase) && <div className="flex flex-wrap items-center gap-2 border-t border-light-border p-3 dark:border-dark-border">
        {mode === Mode.Markup && <input className={`${inputClass} basis-full`} placeholder={t('imageEditInstruction')} value={instruction} maxLength={4000} onChange={event => setInstruction(event.target.value)} />}
        {mode === Mode.Markup && <button type="button" className={`${buttonClass} border border-light-border dark:border-dark-border`} disabled={busy || !(drawing.marks.length || textDraft?.text?.trim())} onClick={() => void save()}>{t('imageEditSave')}</button>}
        <button type="button" className={`${buttonClass} ml-auto bg-accent text-white`} disabled={busy || !(mode === Mode.Erase ? drawing.mask.length : drawing.marks.length || textDraft?.text?.trim())}
          onClick={() => void generate(mode === Mode.Erase ? ImageEditOperation.Erase : ImageEditOperation.Markup)}><SparklesIcon className="h-4 w-4" />{t(mode === Mode.Erase ? 'imageEditGenerate' : 'imageEditToAI')}</button>
      </div>}
      {mode === Mode.Resize && <div className="space-y-3 border-t border-light-border p-3 text-xs dark:border-dark-border">
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('imageEditRatio')}>
          {IMAGE_EDIT_RATIOS.map(value => <button key={value} type="button" aria-pressed={ratio === value} onClick={() => setRatio(value)}
            className={`flex min-w-12 flex-1 flex-col items-center gap-2 rounded-xl border px-2 py-2.5 ${ratio === value ? 'border-accent bg-accent/5 text-accent' : 'border-light-border text-secondary dark:border-dark-border'}`}>
            <span className="flex h-7 items-center justify-center" aria-hidden="true"><span className="rounded-sm border border-current"
              style={{ width: 24 * Math.min(1, Number(value.split(':')[0]) / Number(value.split(':')[1])), height: 24 * Math.min(1, Number(value.split(':')[1]) / Number(value.split(':')[0])) }} /></span>{value}
          </button>)}
        </div>
        <div className="flex justify-end"><button type="button" className={`${buttonClass} bg-accent text-white`} disabled={busy}
          onClick={() => void generate(ImageEditOperation.Reframe)}><SparklesIcon className="h-4 w-4" />{t('imageEditGenerate')}</button></div>
      </div>}
    </div>
    {(busy || error || notice) && <div role={error ? 'alert' : 'status'} className={`border-t border-light-border px-3 py-2 text-xs dark:border-dark-border ${error ? 'text-red-500' : 'text-muted'}`}>
      {error || (busy ? t('imageEditSaving') : notice)}
    </div>}
    {replacement && <Modal onClose={() => setReplacement(undefined)} onEscape={() => setReplacement(undefined)}
      className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5 text-foreground shadow-xl">
      <div role="dialog" aria-modal="true" aria-label={t('imageEditReplaceTitle')} onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const buttons = event.currentTarget.querySelectorAll('button');
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
        <h2 className="text-base font-medium">{t('imageEditReplaceTitle')}</h2>
        <p className="mt-2 text-sm leading-6 text-secondary">{t('imageEditReplaceHint').replace('{operation}', imageEditTitle(replacement.request.operation))}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" autoFocus className={buttonClass} onClick={() => setReplacement(undefined)}>{t('imageEditCancel')}</button>
          <button type="button" className={`${buttonClass} bg-accent text-white`} onClick={() => {
            if (setImageEditDraft(replacement.request, replacement.ids)) {
              replacement.applied(); setReplacement(undefined); setNotice(t('imageEditDraftAdded'));
            } else stageDraft(replacement.request, replacement.applied);
          }}>{t('imageEditReplaceConfirm')}</button>
        </div>
      </div>
    </Modal>}
  </div>;
}
