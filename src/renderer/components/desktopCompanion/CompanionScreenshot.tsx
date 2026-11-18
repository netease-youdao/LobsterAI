import { type PointerEvent, useEffect, useRef, useState } from 'react';

import type { CompanionPoint, CompanionRect } from '../../../shared/desktopCompanion/geometry';
import { companionScreenshotRect } from '../../../shared/desktopCompanion/screenshot';
import { i18nService } from '../../services/i18n';

export default function CompanionScreenshot() {
  const api = window.electron.desktopCompanion;
  const [frame, setFrame] = useState('');
  const [selection, setSelection] = useState<CompanionRect | null>(null);
  const start = useRef<CompanionPoint | null>(null);
  const finished = useRef(false);
  useEffect(() => {
    const language = localStorage.getItem('lobster-language');
    if (language === 'zh' || language === 'en') void i18nService.setLanguage(language, { persist: false });
    document.title = i18nService.t('desktopCompanionScreenshot');
    void api.getScreenshotFrame().then(setFrame).catch(() => { void api.finishScreenshot(null); });
  }, [api]);

  const finish = (rect: CompanionRect | null) => {
    if (finished.current) return;
    finished.current = true;
    void api.finishScreenshot(rect).catch(() => { finished.current = false; });
  };
  const point = (event: PointerEvent): CompanionPoint => ({
    x: Math.max(0, Math.min(window.innerWidth, event.clientX)),
    y: Math.max(0, Math.min(window.innerHeight, event.clientY)),
  });

  return <div className="screenshot-surface"
    onContextMenu={event => { event.preventDefault(); finish(null); }}
    onPointerDown={event => {
      if (event.button !== 0 || !frame) return;
      start.current = point(event);
      setSelection(null);
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      if (start.current) setSelection(companionScreenshotRect(start.current, point(event)));
    }}
    onPointerUp={event => {
      if (!start.current || event.button !== 0) return;
      const rect = companionScreenshotRect(start.current, point(event));
      start.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      if (rect.width >= 2 && rect.height >= 2) finish(rect);
      else setSelection(null);
    }}
    onPointerCancel={() => { start.current = null; setSelection(null); }}
  >
    {frame && <img src={frame} alt="" draggable={false} onLoad={() => { void api.screenshotReady(); }} />}
    {selection
      ? <div className="screenshot-selection" style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }} />
      : <div className="screenshot-shade" />}
    <div className="screenshot-hint" onPointerDown={event => event.stopPropagation()}>
      <span>{i18nService.t('desktopCompanionScreenshotHint')}</span>
      <button type="button" onClick={() => finish(null)}>{i18nService.t('desktopCompanionScreenshotCancel')}</button>
    </div>
  </div>;
}
