import { CheckIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { useEffect, useRef } from 'react';

import type { ImageMark } from '../../../../shared/imageEditing/types';
import { i18nService } from '../../../services/i18n';
import { imageTextBounds } from './imageText';

const Handle = { Move: 'move', Resize: 'resize' } as const;
export default function ImageTextBox({ mark, width, height, onChange, onFinish, onCancel }: {
  mark: ImageMark; width: number; height: number;
  onChange: (mark: ImageMark) => void; onFinish: () => void; onCancel: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const finish = useRef(onFinish); finish.current = onFinish;
  const drag = useRef<{ x: number; y: number; mark: ImageMark; kind: typeof Handle[keyof typeof Handle] }>();
  const box = imageTextBounds(mark);
  const fontSize = (mark.fontSize ?? mark.width * 6) * Math.max(width, height);
  useEffect(() => {
    input.current?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!container.current?.contains(target) && !target.closest('[data-image-text-controls]')) finish.current();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, []);
  const start = (event: React.PointerEvent, kind: typeof Handle[keyof typeof Handle]) => {
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, mark, kind };
  };
  const move = (event: React.PointerEvent) => {
    const current = drag.current; if (!current) return;
    const original = imageTextBounds(current.mark);
    const dx = (event.clientX - current.x) / width, dy = (event.clientY - current.y) / height;
    const next = current.kind === Handle.Move
      ? { ...original, x: Math.max(0, Math.min(1 - original.width, original.x + dx)), y: Math.max(0, Math.min(1 - original.height, original.y + dy)) }
      : { ...original, width: Math.max(Math.min(40 / width, 1 - original.x), Math.min(1 - original.x, original.width + dx)),
        height: Math.max(Math.min(24 / height, 1 - original.y), Math.min(1 - original.y, original.height + dy)) };
    onChange({ ...mark, points: [{ x: next.x, y: next.y }, { x: next.x + next.width, y: next.y + next.height }] });
  };
  return <div ref={container} data-image-text-box className="absolute outline outline-1 outline-dashed outline-accent"
    style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: box.width * width, height: box.height * height, cursor: 'text' }}
    onPointerDown={event => event.stopPropagation()} onPointerMove={event => { event.stopPropagation(); move(event); }}
    onPointerUp={event => { event.stopPropagation(); drag.current = undefined; }}
    onPointerCancel={() => { drag.current = undefined; }}>
    <div className={`absolute left-0 flex h-6 items-center rounded-md border border-accent/30 bg-surface text-accent shadow-sm ${box.y * height < 28 ? '-bottom-7' : '-top-7'}`}>
      <button type="button" className="cursor-move whitespace-nowrap px-2 text-[11px]" aria-label={i18nService.t('imageEditMoveText')}
        onPointerDown={event => start(event, Handle.Move)}>{i18nService.t('imageEditMoveText')}</button>
      <button type="button" className="p-1" aria-label={i18nService.t('imageEditFinishText')} onPointerDown={event => event.preventDefault()} onClick={onFinish}><CheckIcon className="h-3.5 w-3.5" /></button>
      <button type="button" className="p-1" aria-label={i18nService.t('imageEditCancel')} onPointerDown={event => event.preventDefault()} onClick={onCancel}><XMarkIcon className="h-3.5 w-3.5" /></button>
    </div>
    <textarea ref={input} value={mark.text ?? ''} maxLength={1000} aria-label={i18nService.t('imageEditTextPlaceholder')}
      placeholder={i18nService.t('imageEditTextPlaceholder')}
      className="h-full w-full resize-none overflow-hidden border-0 bg-transparent p-0 outline-none"
      style={{ color: mark.color, fontFamily: 'sans-serif', fontSize, lineHeight: 1.25, wordBreak: 'break-all', overflowWrap: 'anywhere' }}
      onChange={event => onChange({ ...mark, text: event.target.value })}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); onFinish(); }
      }} />
    <button type="button" aria-label={i18nService.t('imageEditResizeText')} onPointerDown={event => start(event, Handle.Resize)}
      className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize border-2 border-accent bg-white" />
  </div>;
}
