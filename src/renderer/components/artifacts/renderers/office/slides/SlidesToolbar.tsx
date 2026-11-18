import {
  ArrowUturnLeftIcon, ArrowUturnRightIcon, Bars3BottomLeftIcon, Bars3BottomRightIcon, Bars3CenterLeftIcon, BoldIcon, ItalicIcon,
  PlusIcon, StrikethroughIcon, TrashIcon, UnderlineIcon,
} from '@heroicons/react/24/outline';
import React, { useSyncExternalStore } from 'react';

import type { SlidesEditorSession } from '@/services/office/slides/slidesEditorSession';
import { SlidesAlign, type TextStyleChange } from '@/services/office/slides/slidesText';

import { ColorTarget, OfficeColorButton } from '../common/toolbar/OfficeColorButton';
import {
  OfficeFontSelect, OfficeFontSizeSelect, OfficeToolbar, OfficeToolbarButton, OfficeToolbarDivider,
} from '../common/toolbar/OfficeToolbar';

const TOGGLES = [
  { key: 'bold', icon: BoldIcon, label: 'officeBold' },
  { key: 'italic', icon: ItalicIcon, label: 'officeItalic' },
  { key: 'underline', icon: UnderlineIcon, label: 'officeUnderline' },
  { key: 'strike', icon: StrikethroughIcon, label: 'officeStrike' },
] as const;
const ALIGNMENTS = [
  { align: SlidesAlign.Left, css: 'left', icon: Bars3BottomLeftIcon, label: 'officeAlignLeft' },
  { align: SlidesAlign.Center, css: 'center', icon: Bars3CenterLeftIcon, label: 'officeAlignCenter' },
  { align: SlidesAlign.Right, css: 'right', icon: Bars3BottomRightIcon, label: 'officeAlignRight' },
] as const;

/** PowerPoint's text box button: a dashed box around a letter. */
function TextBoxIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.2} aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" strokeDasharray="2 1.5" />
      <path d="M5.5 11 L8 5 L10.5 11 M6.4 9 H9.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Duplicate slide: a slide with a title in front of another, landscape so it is not read as the
 * clipboard's copy button.
 */
function DuplicateSlideIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.2} aria-hidden="true">
      <path d="M4.5 6V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1h-2" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="1.5" y="6" width="10" height="6.5" rx="1" />
      <path d="M3.5 8.5h4.5" strokeLinecap="round" />
    </svg>
  );
}

export function SlidesToolbar({ session, disabled }: { session: SlidesEditorSession; disabled: boolean }): React.ReactElement {
  useSyncExternalStore(session.subscribe, session.getVersion);
  const format = session.formatState();
  const editable = !disabled && session.editable;
  const hasSlide = editable && session.currentIndex >= 0;
  const formatting = editable && Boolean(format);
  const style = (change: TextStyleChange) => session.applyTextStyle(change);
  return (
    <OfficeToolbar label="slidesToolbar">
      <OfficeToolbarButton label="officeUndo" disabled={!editable || !session.canUndo} onClick={() => session.undo()}>
        <ArrowUturnLeftIcon className="h-4 w-4" />
      </OfficeToolbarButton>
      <OfficeToolbarButton label="officeRedo" disabled={!editable || !session.canRedo} onClick={() => session.redo()}>
        <ArrowUturnRightIcon className="h-4 w-4" />
      </OfficeToolbarButton>
      <OfficeToolbarDivider />
      <OfficeToolbarButton label="slidesNewSlide" disabled={!editable} onClick={() => session.addSlide()}>
        <PlusIcon className="h-4 w-4" />
      </OfficeToolbarButton>
      <OfficeToolbarButton label="slidesDuplicateSlide" disabled={!hasSlide} onClick={() => session.duplicateSlide()}>
        <DuplicateSlideIcon />
      </OfficeToolbarButton>
      <OfficeToolbarButton label="slidesDeleteSlide" disabled={!hasSlide || session.slideCount <= 1} onClick={() => session.deleteSlide()}>
        <TrashIcon className="h-4 w-4" />
      </OfficeToolbarButton>
      <OfficeToolbarButton label="slidesInsertTextBox" disabled={!hasSlide} onClick={() => session.insertTextBox()}>
        <TextBoxIcon />
      </OfficeToolbarButton>
      <OfficeToolbarDivider />
      <OfficeFontSelect value={format?.font} disabled={!formatting} onChange={font => style({ font })} />
      <OfficeFontSizeSelect value={format?.size} disabled={!formatting} onChange={size => style({ size })} />
      {TOGGLES.map(({ key, icon: Icon, label }) => (
        <OfficeToolbarButton key={key} label={label} active={Boolean(format?.[key])} disabled={!formatting} onClick={() => style({ [key]: !format?.[key] })}>
          <Icon className="h-4 w-4" />
        </OfficeToolbarButton>
      ))}
      <OfficeColorButton target={ColorTarget.Font} themeColors={session.themeColors()} disabled={!formatting}
        onPick={color => style({ color: color ? color.replace(/^#/, '') : null })} />
      <OfficeToolbarDivider />
      {ALIGNMENTS.map(({ align, css, icon: Icon, label }) => (
        <OfficeToolbarButton key={align} label={label} active={format?.align === css} disabled={!formatting} onClick={() => session.applyAlignment(align)}>
          <Icon className="h-4 w-4" />
        </OfficeToolbarButton>
      ))}
    </OfficeToolbar>
  );
}
