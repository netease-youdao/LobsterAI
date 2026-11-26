import {
  Bars3BottomLeftIcon,
  Bars3BottomRightIcon,
  Bars3CenterLeftIcon,
  BoldIcon,
  EllipsisHorizontalIcon,
  ItalicIcon,
  StrikethroughIcon,
  TrashIcon,
  UnderlineIcon,
} from '@heroicons/react/24/outline';
import React, { useSyncExternalStore } from 'react';

import { i18nService } from '@/services/i18n';
import type { SlidesEditorSession } from '@/services/office/slides/slidesEditorSession';
import { SlidesAlign, type TextStyleChange } from '@/services/office/slides/slidesText';

import { ColorTarget, OfficeColorButton } from '../common/toolbar/OfficeColorButton';
import { ToolbarPopoverPanel, useToolbarPopover } from '../common/toolbar/OfficePopover';
import {
  OfficeFontSelect,
  OfficeFontSizeSelect,
  OfficeToolbarButton,
  OfficeToolbarDivider,
} from '../common/toolbar/OfficeToolbar';

const t = (key: string) => i18nService.t(key);
const keepFocus = (event: React.MouseEvent) => event.preventDefault();

const INLINE_TOGGLES = [
  { key: 'bold', icon: BoldIcon, label: 'officeBold' },
  { key: 'italic', icon: ItalicIcon, label: 'officeItalic' },
  { key: 'underline', icon: UnderlineIcon, label: 'officeUnderline' },
] as const;

const ALIGNMENTS = [
  { align: SlidesAlign.Left, css: 'left', icon: Bars3BottomLeftIcon, label: 'officeAlignLeft' },
  { align: SlidesAlign.Center, css: 'center', icon: Bars3CenterLeftIcon, label: 'officeAlignCenter' },
  { align: SlidesAlign.Right, css: 'right', icon: Bars3BottomRightIcon, label: 'officeAlignRight' },
] as const;

const ALIGN_MENU_WIDTH = 136;
const MORE_MENU_WIDTH = 152;

/**
 * Floating contextual format pill anchored above the active slide stage.
 * Appears only when a shape or text range is selected, keeping the top bar clean while browsing.
 */
export function SlidesFormatBar({
  session,
  disabled,
}: {
  session: SlidesEditorSession;
  disabled: boolean;
}): React.ReactElement | null {
  useSyncExternalStore(session.subscribe, session.getVersion);
  const alignPopover = useToolbarPopover(ALIGN_MENU_WIDTH);
  const morePopover = useToolbarPopover(MORE_MENU_WIDTH);

  const editable = !disabled && session.editable;
  const hasSelection = session.hasSelectedShape || session.editingText;
  if (!editable || !hasSelection) return null;

  const format = session.formatState();
  const canDeleteShape = session.hasSelectedShape && !session.editingText;
  const style = (change: TextStyleChange) => session.applyTextStyle(change);

  if (!format) {
    if (!canDeleteShape) return null;
    return (
      <div
        className="lobster-slides-format-pill"
        role="toolbar"
        aria-label={t('slidesToolbar')}
        onPointerUp={event => event.stopPropagation()}
      >
        <OfficeToolbarButton label="slidesDeleteShape" onClick={() => session.deleteSelectedShape()}>
          <TrashIcon className="h-3.5 w-3.5" />
        </OfficeToolbarButton>
      </div>
    );
  }

  const activeAlign = ALIGNMENTS.find(item => item.css === format.align) ?? ALIGNMENTS[0];
  const ActiveAlignIcon = activeAlign.icon;

  return (
    <div
      className="lobster-slides-format-pill"
      role="toolbar"
      aria-label={t('slidesToolbar')}
      onPointerUp={event => event.stopPropagation()}
    >
      <OfficeFontSelect
        className="lobster-slides-font-select"
        value={format.font}
        fonts={session.documentFonts()}
        onChange={font => style({ font })}
      />
      <OfficeFontSizeSelect
        className="lobster-slides-size-select"
        value={format.size}
        onChange={size => style({ size })}
      />
      <OfficeToolbarDivider />
      {INLINE_TOGGLES.map(({ key, icon: Icon, label }) => (
        <OfficeToolbarButton
          key={key}
          label={label}
          active={Boolean(format[key])}
          onClick={() => style({ [key]: !format[key] })}
        >
          <Icon className="h-3.5 w-3.5" />
        </OfficeToolbarButton>
      ))}
      <OfficeColorButton
        target={ColorTarget.Font}
        themeColors={session.themeColors()}
        disabled={false}
        onPick={color => style({ color: color ? color.replace(/^#/, '') : null })}
      />
      <OfficeToolbarDivider />
      <button
        ref={alignPopover.trigger}
        type="button"
        className="lobster-slides-menu-trigger"
        title={t('wordAlignMenu')}
        aria-label={t('wordAlignMenu')}
        aria-haspopup="menu"
        aria-expanded={alignPopover.open}
        onMouseDown={keepFocus}
        onClick={() => alignPopover.setOpen(open => !open)}
      >
        <ActiveAlignIcon className="h-3.5 w-3.5" />
        <span className="lobster-slides-caret" aria-hidden="true">▾</span>
      </button>
      <ToolbarPopoverPanel popover={alignPopover} label={t('wordAlignMenu')} width={ALIGN_MENU_WIDTH}>
        {alignPopover.open && ALIGNMENTS.map(({ align, css, icon: Icon, label }) => {
          const active = format.align === css;
          return (
            <button
              key={align}
              type="button"
              className={`lobster-office-menu-item lobster-slides-popover-item${active ? ' is-active' : ''}`}
              onMouseDown={keepFocus}
              onClick={() => {
                alignPopover.setOpen(false);
                session.applyAlignment(align);
              }}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span>{t(label)}</span>
            </button>
          );
        })}
      </ToolbarPopoverPanel>
      <button
        ref={morePopover.trigger}
        type="button"
        className="lobster-slides-icon-btn"
        title={t('slidesMoreFormatting')}
        aria-label={t('slidesMoreFormatting')}
        aria-haspopup="menu"
        aria-expanded={morePopover.open}
        aria-pressed={Boolean(format.strike)}
        onMouseDown={keepFocus}
        onClick={() => morePopover.setOpen(open => !open)}
      >
        <EllipsisHorizontalIcon className="h-4 w-4" />
      </button>
      <ToolbarPopoverPanel popover={morePopover} label={t('slidesMoreFormatting')} width={MORE_MENU_WIDTH}>
        {morePopover.open && (
          <>
            <button
              type="button"
              className={`lobster-office-menu-item lobster-slides-popover-item${format.strike ? ' is-active' : ''}`}
              onMouseDown={keepFocus}
              onClick={() => {
                morePopover.setOpen(false);
                style({ strike: !format.strike });
              }}
            >
              <StrikethroughIcon className="h-3.5 w-3.5 shrink-0" />
              <span>{t('officeStrike')}</span>
            </button>
            {canDeleteShape && (
              <>
                <span className="lobster-slides-menu-divider" role="separator" />
                <button
                  type="button"
                  className="lobster-office-menu-item lobster-slides-popover-item is-danger"
                  onMouseDown={keepFocus}
                  onClick={() => {
                    morePopover.setOpen(false);
                    session.deleteSelectedShape();
                  }}
                >
                  <TrashIcon className="h-3.5 w-3.5 shrink-0" />
                  <span>{t('slidesDeleteShape')}</span>
                </button>
              </>
            )}
          </>
        )}
      </ToolbarPopoverPanel>
    </div>
  );
}
