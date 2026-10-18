import './screenshotEditor.css';

import { type PointerEvent, useCallback, useEffect, useRef, useState } from 'react';

import type { CompanionPoint, CompanionRect } from '../../../shared/desktopCompanion/geometry';
import { CompanionScreenshotAction, companionScreenshotRect } from '../../../shared/desktopCompanion/screenshot';
import { i18nService } from '../../services/i18n';
import {
  moveScreenshotSelection, renderScreenshotCrop, resizeScreenshotSelection, type ScreenshotAnnotation,
screenshotContains,
  ScreenshotHandle, ScreenshotTool, translateScreenshotAnnotations, } from './screenshotAnnotation';
import type { screenshotCopy } from './screenshotCopy';

const GestureMode = { Select: 'select', Move: 'move', Resize: 'resize', Draw: 'draw' } as const;
interface Gesture {
  mode: typeof GestureMode[keyof typeof GestureMode];
  start: CompanionPoint;
  rect: CompanionRect | null;
  annotations: ScreenshotAnnotation[];
  handle?: ScreenshotHandle;
  annotation?: ScreenshotAnnotation;
}
const toolIcons: Record<ScreenshotTool, string> = {
  select: '↔', rectangle: '□', ellipse: '○', arrow: '↗', pen: '✎', mosaic: '▦', text: 'T',
};
const handles = [
  [ScreenshotHandle.NW, 0, 0], [ScreenshotHandle.N, 50, 0], [ScreenshotHandle.NE, 100, 0],
  [ScreenshotHandle.E, 100, 50], [ScreenshotHandle.SE, 100, 100], [ScreenshotHandle.S, 50, 100],
  [ScreenshotHandle.SW, 0, 100], [ScreenshotHandle.W, 0, 50],
] as const;
const t = (key: keyof typeof screenshotCopy.en) => i18nService.t(`screenshotEditor_${key}`);
const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

export default function CompanionScreenshot() {
  const api = window.electron.desktopCompanion;
  const [frame, setFrame] = useState('');
  const [selection, setSelection] = useState<CompanionRect | null>(null);
  const [annotations, setAnnotations] = useState<ScreenshotAnnotation[]>([]);
  const [preview, setPreview] = useState<ScreenshotAnnotation | null>(null);
  const [tool, setTool] = useState<ScreenshotTool>(ScreenshotTool.Select);
  const [color, setColor] = useState('#ef4444');
  const [width, setWidth] = useState(4);
  const [fontSize, setFontSize] = useState(24);
  const [text, setText] = useState<{ point: CompanionPoint; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [dragging, setDragging] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const finished = useRef(false);
  const textAnnotation = useCallback((): ScreenshotAnnotation[] => text?.value.trim()
    ? [{ tool: ScreenshotTool.Text, points: [text.point], text: text.value.trim(), color, width: fontSize }] : [], [text, color, fontSize]);
  const commitText = () => {
    const added = textAnnotation();
    if (added.length) setAnnotations(previous => [...previous, ...added]);
    setText(null);
  };

  useEffect(() => {
    const language = localStorage.getItem('lobster-language');
    if (language === 'zh' || language === 'en') i18nService.setLanguage(language, { persist: false });
    document.title = i18nService.t('desktopCompanionScreenshot');
    let mounted = true;
    void api.getScreenshotFrame().then(value => { if (mounted) setFrame(value); })
      .catch(() => { if (mounted) void api.finishScreenshot(null); });
    return () => { mounted = false; };
  }, [api]);

  useEffect(() => {
    if (!selection || selection.width < 2 || selection.height < 2 || !image.current?.complete || !canvas.current) return;
    try {
      renderScreenshotCrop(canvas.current, image.current, selection, viewport(), [...annotations, ...(preview ? [preview] : [])]);
    } catch { setError(true); }
  }, [selection, annotations, preview, frame]);

  const finish = useCallback(async (action: CompanionScreenshotAction | null) => {
    if (finished.current || (action && !selection)) return;
    finished.current = true;
    setBusy(true);
    setError(false);
    try {
      if (!action) await api.finishScreenshot(null);
      else if (selection) {
        const allAnnotations = [...annotations, ...textAnnotation()];
        let imageDataUrl: string | undefined;
        if (allAnnotations.length) {
          if (!image.current) throw new Error('Screenshot frame unavailable');
          const output = document.createElement('canvas');
          renderScreenshotCrop(output, image.current, selection, viewport(), allAnnotations);
          imageDataUrl = output.toDataURL('image/png');
          if (!imageDataUrl.startsWith('data:image/png;base64,')) throw new Error('Screenshot export failed');
        }
        await api.finishScreenshot({ rect: selection, action, imageDataUrl });
      }
    } catch { setError(true); }
    finally { finished.current = false; setBusy(false); }
  }, [api, selection, annotations, textAnnotation]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void finish(null);
        return;
      }
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || busy || dragging) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); setAnnotations(previous => previous.slice(0, -1));
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        event.preventDefault(); void finish(CompanionScreenshotAction.Copy);
      } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault(); void finish(CompanionScreenshotAction.Ask);
      }
    };
    window.addEventListener('keydown', keyDown);
    return () => window.removeEventListener('keydown', keyDown);
  }, [finish, text, busy, dragging]);

  const point = (event: PointerEvent): CompanionPoint => ({
    x: Math.max(0, Math.min(window.innerWidth, event.clientX)),
    y: Math.max(0, Math.min(window.innerHeight, event.clientY)),
  });
  const updateGesture = (at: CompanionPoint) => {
    const active = gesture.current;
    if (!active) return;
    if (active.mode === GestureMode.Select) setSelection(companionScreenshotRect(active.start, at));
    else if (active.mode === GestureMode.Resize && active.rect && active.handle) {
      setSelection(resizeScreenshotSelection(active.rect, active.handle, at, viewport()));
    } else if (active.mode === GestureMode.Move && active.rect) {
      const moved = moveScreenshotSelection(active.rect, { x: at.x - active.start.x, y: at.y - active.start.y }, viewport());
      setSelection(moved);
      setAnnotations(translateScreenshotAnnotations(active.annotations, { x: moved.x - active.rect.x, y: moved.y - active.rect.y }));
    } else if (active.annotation && active.rect) {
      const clipped = { x: Math.max(active.rect.x, Math.min(active.rect.x + active.rect.width, at.x)),
        y: Math.max(active.rect.y, Math.min(active.rect.y + active.rect.height, at.y)) };
      const points = active.annotation.tool === ScreenshotTool.Pen ? [...active.annotation.points, clipped] : [active.start, clipped];
      active.annotation = { ...active.annotation, points };
      setPreview(active.annotation);
    }
  };

  return <div className="screenshot-surface screenshot-editor" role="application" aria-label={t('editor')}
    onContextMenu={event => { event.preventDefault(); void finish(null); }}
    onPointerDown={event => {
      if (event.button !== 0 || !frame || busy || text) return;
      const at = point(event);
      const handle = (event.target as HTMLElement).dataset.screenshotHandle as ScreenshotHandle | undefined;
      const active: Gesture = { mode: GestureMode.Select, start: at, rect: selection, annotations };
      if (handle && selection) { active.mode = GestureMode.Resize; active.handle = handle; }
      else if (selection && screenshotContains(selection, at)) {
        if (tool === ScreenshotTool.Text) { setText({ point: at, value: '' }); return; }
        if (tool === ScreenshotTool.Select) active.mode = GestureMode.Move;
        else {
          active.mode = GestureMode.Draw;
          active.annotation = { tool, points: [at], color, width };
          setPreview(active.annotation);
        }
      } else {
        setSelection(null); setAnnotations([]); setTool(ScreenshotTool.Select); setError(false);
      }
      gesture.current = active;
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => updateGesture(point(event))}
    onPointerUp={event => {
      if (!gesture.current || event.button !== 0) return;
      updateGesture(point(event));
      const active = gesture.current;
      if (active.mode === GestureMode.Select) {
        const rect = companionScreenshotRect(active.start, point(event));
        setSelection(rect.width >= 2 && rect.height >= 2 ? rect : null);
      } else if (active.annotation) setAnnotations(previous => [...previous, active.annotation!]);
      gesture.current = null; setPreview(null); setDragging(false);
      event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={() => {
      if (gesture.current) { setSelection(gesture.current.rect); setAnnotations(gesture.current.annotations); }
      gesture.current = null; setPreview(null); setDragging(false);
    }}
  >
    {frame && <img ref={image} src={frame} alt="" draggable={false} onLoad={() => { void api.screenshotReady(); }}
      onError={() => { void finish(null); }} />}
    {selection ? <>
      <canvas ref={canvas} className="screenshot-annotation-canvas" style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }} />
      <div className="screenshot-selection" style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }}>
        {!dragging && handles.map(([handle, x, y]) => <span key={handle} className={`screenshot-resize screenshot-resize-${handle}`}
          data-screenshot-handle={handle} title={t('resize')} style={{ left: `${x}%`, top: `${y}%` }} />)}
      </div>
      <output className="screenshot-dimensions" style={{ left: selection.x, top: Math.max(0, selection.y - 28) }}>
        {Math.round(selection.width)} × {Math.round(selection.height)}
      </output>
    </> : <div className="screenshot-shade" />}
    {!selection && <div className="screenshot-hint" onPointerDown={event => event.stopPropagation()}>
      <span>{t('hint')}</span><button type="button" onClick={() => { void finish(null); }}>{t('cancel')}</button>
    </div>}
    {selection && !dragging && <div className="screenshot-editor-toolbar" role="toolbar" aria-label={t('toolbar')}
      onPointerDown={event => event.stopPropagation()}
      style={{ left: Math.max(8, Math.min(selection.x, window.innerWidth - 708)),
        top: selection.y + selection.height + 148 < window.innerHeight ? selection.y + selection.height + 12 : Math.max(8, selection.y - 148) }}>
      <fieldset disabled={busy}>
        <div className="screenshot-editor-row">
          {Object.values(ScreenshotTool).map(value => <button type="button" key={value} aria-label={t(value)} title={t(value)}
            aria-pressed={tool === value} onClick={() => { commitText(); setTool(value); }}>{toolIcons[value]}</button>)}
          <label title={t('color')}><span className="screenshot-sr-only">{t('color')}</span>
            <input type="color" value={color} onChange={event => setColor(event.target.value)} />
          </label>
          <label className="screenshot-weight">{t(tool === ScreenshotTool.Text ? 'fontSize' : 'width')}
            <select value={tool === ScreenshotTool.Text ? fontSize : width}
              onChange={event => tool === ScreenshotTool.Text ? setFontSize(Number(event.target.value)) : setWidth(Number(event.target.value))}>
              {(tool === ScreenshotTool.Text ? [18, 24, 32] : [2, 4, 7]).map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <button type="button" disabled={!annotations.length} onClick={() => setAnnotations(previous => previous.slice(0, -1))}>{t('undo')}</button>
          <button type="button" onClick={() => { setSelection(null); setAnnotations([]); setText(null); }}>{t('reset')}</button>
        </div>
        <div className="screenshot-editor-row screenshot-editor-actions">
          {Object.values(CompanionScreenshotAction).map(action => <button type="button" key={action}
            className={action === CompanionScreenshotAction.Ask ? 'screenshot-primary-action' : ''}
            onClick={() => { void finish(action); }}>{t(action)}</button>)}
          <button type="button" onClick={() => { void finish(null); }}>{t('cancel')}</button>
        </div>
      </fieldset>
      {busy && <div role="status">{t('busy')}</div>}
      {error && <div role="alert">{t('error')}</div>}
    </div>}
    {text && <div className="screenshot-text-editor" style={{ left: Math.max(8, Math.min(text.point.x, window.innerWidth - 260)),
      top: Math.max(8, Math.min(text.point.y, window.innerHeight - 130)) }} onPointerDown={event => event.stopPropagation()}>
      <textarea autoFocus aria-label={t('text')} placeholder={t('placeholder')} value={text.value} maxLength={4000}
        style={{ color, fontSize }} onChange={event => setText({ ...text, value: event.target.value })} />
      <button type="button" onClick={commitText}>{t('done')}</button>
      <button type="button" onClick={() => setText(null)}>{t('cancel')}</button>
    </div>}
  </div>;
}
