import { ArrowUpRightIcon, ArrowUturnLeftIcon, ArrowUturnRightIcon, PencilIcon, StopIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useRef, useState } from 'react';

import { ImageEditorTool } from '../../../../shared/imageEditing/types';
import { i18nService } from '../../../services/i18n';
import { EraserIcon, TextIcon } from './ImageEditingIcons';

const t = (key: string) => i18nService.t(key);
/** Two rows of seven with the custom color well first; white and black stay in for marking dark and light images. */
const MARK_COLORS = ['#ffffff', '#111827', '#6b7280', '#92400e', '#f05252', '#f97316',
  '#f59e0b', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
const RAINBOW = 'conic-gradient(#f43f5e, #f59e0b, #84cc16, #06b6d4, #6366f1, #d946ef, #f43f5e)';
const DRAW_TOOLS = [
  [ImageEditorTool.Pen, PencilIcon, 'imageEditPen', 'imageEditPenHint'],
  [ImageEditorTool.Arrow, ArrowUpRightIcon, 'imageEditArrow', 'imageEditArrowHint'],
  [ImageEditorTool.Rectangle, StopIcon, 'imageEditRectangle', 'imageEditRectangleHint'],
  [ImageEditorTool.Text, TextIcon, 'imageEditText', 'imageEditTextHint'],
] as const;
const iconButton = 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors disabled:cursor-not-allowed disabled:opacity-35';
const idleButton = 'text-secondary hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10';
const swatchRing = 'ring-1 ring-inset ring-black/15 dark:ring-white/25';
const selectedSwatch = 'outline outline-2 outline-offset-2 outline-accent';

export interface ImageMarkupSize { value: number; min: number; max: number; pixels: number; label: string }

/** The style popover is 244 px wide; it centers with a margin because its scale-in animation owns `transform`. */
const STYLE_POPOVER_WIDTH = 244;

/**
 * The markup tools as one floating bar, with the edit instruction in its own bar underneath.
 * Color and size live in a popover so the tool bar stays a single row at any panel width.
 */
export default function ImageMarkupToolbar({ tool, color, size, instruction, canUndo, canRedo, canApply, className = '',
  onToolChange, onColorChange, onSizeChange, onInstructionChange, onUndo, onRedo, onApply }: {
  tool: ImageEditorTool; color: string; size: ImageMarkupSize; instruction: string;
  canUndo: boolean; canRedo: boolean; canApply: boolean; className?: string;
  onToolChange: (tool: ImageEditorTool) => void; onColorChange: (color: string) => void; onSizeChange: (value: number) => void;
  onInstructionChange: (value: string) => void; onUndo: () => void; onRedo: () => void; onApply: () => void;
}) {
  const [styleOpen, setStyleOpen] = useState(false);
  const stylePicker = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!styleOpen) return;
    const outside = (event: PointerEvent) => { if (!stylePicker.current?.contains(event.target as Node)) setStyleOpen(false); };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [styleOpen]);
  const isEraser = tool === ImageEditorTool.Eraser;
  const isText = tool === ImageEditorTool.Text;
  const customColor = !MARK_COLORS.includes(color);
  const progress = (size.value - size.min) / Math.max(1, size.max - size.min);
  const styleLabel = t(isEraser ? 'imageEditEraserSize' : 'imageEditColor');
  const toolButton = (value: ImageEditorTool, Icon: React.ElementType, label: string, hint: string) =>
    <button key={value} type="button" title={`${t(label)}\n${t(hint)}`} aria-label={t(label)} aria-pressed={tool === value}
      onClick={() => onToolChange(value)} className={`${iconButton} ${tool === value ? 'bg-accent/10 text-accent' : idleButton}`}>
      <Icon className="h-[18px] w-[18px]" />
    </button>;
  const sizeMark = (large: boolean) => <span aria-hidden="true" className="flex w-4 shrink-0 items-center justify-center">
    {isText ? <span className={`font-medium leading-none ${large ? 'text-base' : 'text-[10px]'}`}>A</span>
      : <span className={`rounded-full ${large ? 'h-3 w-3' : 'h-1 w-1'} ${isEraser ? 'border border-current' : 'bg-current'}`} />}
  </span>;
  return <>
    <div data-image-text-controls role="toolbar" aria-label={t('imageEditMarkup')}
      onKeyDown={event => { if (event.key === 'Escape' && styleOpen) { event.preventDefault(); event.stopPropagation(); setStyleOpen(false); } }}
      className={`${className} flex max-w-full shrink-0 animate-fade-in-up items-center gap-0.5 rounded-2xl p-1`}>
      {DRAW_TOOLS.map(([value, Icon, label, hint]) => toolButton(value, Icon, label, hint))}
      <div ref={stylePicker} className="relative shrink-0">
        <button type="button" title={styleLabel} aria-label={styleLabel} aria-haspopup="dialog" aria-expanded={styleOpen}
          onClick={() => setStyleOpen(open => !open)} className={`${iconButton} ${styleOpen ? 'bg-black/5 text-foreground dark:bg-white/10' : idleButton}`}>
          {isEraser ? <span aria-hidden="true" className="rounded-full border-[1.5px] border-current" style={{ width: 9 + progress * 9, height: 9 + progress * 9 }} />
            : <span aria-hidden="true" className={`h-[18px] w-[18px] rounded-full ${swatchRing}`} style={{ backgroundColor: color }} />}
        </button>
        {styleOpen && <div role="dialog" aria-label={styleLabel} style={{ width: STYLE_POPOVER_WIDTH, marginLeft: -STYLE_POPOVER_WIDTH / 2 }}
          className="absolute bottom-full left-1/2 z-10 mb-2 origin-bottom animate-scale-in rounded-2xl border border-border bg-surface p-3 shadow-popover">
          {!isEraser && <div role="group" aria-label={t('imageEditColor')} className="grid grid-cols-7 gap-2">
            <label title={t('imageEditCustomColor')} className={`relative h-6 w-6 cursor-pointer overflow-hidden rounded-full transition-transform ${swatchRing} ${customColor ? selectedSwatch : 'hover:scale-110'}`}
              style={{ background: RAINBOW }}>
              <input type="color" value={color} aria-label={t('imageEditCustomColor')} onChange={event => onColorChange(event.target.value)}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
            </label>
            {MARK_COLORS.map(value => <button key={value} type="button" title={value} aria-label={value} aria-pressed={color === value}
              onClick={() => { onColorChange(value); setStyleOpen(false); }}
              className={`h-6 w-6 rounded-full transition-transform ${swatchRing} ${color === value ? selectedSwatch : 'hover:scale-110'}`} style={{ backgroundColor: value }} />)}
          </div>}
          <label className={`flex items-center gap-2 text-muted ${isEraser ? '' : 'mt-3 border-t border-border pt-3'}`}>
            {sizeMark(false)}
            <input type="range" min={size.min} max={size.max} value={size.value} aria-label={t(size.label)}
              onChange={event => onSizeChange(Number(event.target.value))} className="min-w-0 flex-1 accent-accent" />
            {sizeMark(true)}
            <output className="w-12 shrink-0 text-right text-[11px] tabular-nums">{size.pixels} px</output>
          </label>
        </div>}
      </div>
      {toolButton(ImageEditorTool.Eraser, EraserIcon, 'imageEditEraser', 'imageEditEraserHint')}
      <span className="mx-1 h-5 w-px shrink-0 bg-border" />
      <button type="button" title={t('imageEditUndo')} aria-label={t('imageEditUndo')} disabled={!canUndo} onClick={onUndo} className={`${iconButton} ${idleButton}`}>
        <ArrowUturnLeftIcon className="h-[18px] w-[18px]" />
      </button>
      <button type="button" title={t('imageEditRedo')} aria-label={t('imageEditRedo')} disabled={!canRedo} onClick={onRedo} className={`${iconButton} ${idleButton}`}>
        <ArrowUturnRightIcon className="h-[18px] w-[18px]" />
      </button>
    </div>
    <div data-image-text-controls className={`${className} flex w-full max-w-[680px] animate-fade-in-up items-center gap-2 rounded-2xl p-1.5 pl-4`}>
      <input value={instruction} maxLength={4000} placeholder={t('imageEditInstruction')} aria-label={t('imageEditInstruction')}
        onChange={event => onInstructionChange(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && canApply) { event.preventDefault(); onApply(); } }}
        className="h-9 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted" />
      <button type="button" disabled={!canApply} onClick={onApply}
        className="inline-flex h-9 shrink-0 items-center justify-center rounded-xl bg-accent px-4 text-xs font-medium text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-35">
        {t('imageEditGenerate')}
      </button>
    </div>
  </>;
}
