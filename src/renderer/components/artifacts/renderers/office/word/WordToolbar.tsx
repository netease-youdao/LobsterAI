import type { EditorCommand } from '@docx-editor.dev/core/contracts/editor';
import { type ChromeSlotId, commandForSlot, commandForSlotValue, toolbarCommandState } from '@docx-editor.dev/core/editor';
import {
  ArrowUturnLeftIcon, ArrowUturnRightIcon, Bars3BottomLeftIcon, Bars3BottomRightIcon,
  Bars3CenterLeftIcon, Bars3Icon, BoldIcon, CheckIcon, EllipsisHorizontalIcon, ItalicIcon,
  ListBulletIcon, NumberedListIcon, PhotoIcon, StrikethroughIcon, TableCellsIcon, UnderlineIcon,
} from '@heroicons/react/24/outline';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { i18nService } from '@/services/i18n';
import type { WordEditorSession } from '@/services/office/word/wordEditorSession';
import { WORD_IMAGE_ACCEPT } from '@/services/office/word/wordImages';
import {
  buildLineSpacingCommand,
  buildToggleFirstLineIndentCommand,
  buildToggleSpaceAfterCommand,
  hasFirstLineIndent,
  hasParagraphSpaceAfter,
  isLineSpacingOptionActive,
  WORD_LINE_SPACING_OPTIONS,
} from '@/services/office/word/wordParagraphFormat';
import {
  resolveWordHeaderCompact,
  resolveWordToolbarDensity,
  WordToolbarDensity,
} from '@/services/office/word/wordToolbarLayout';

import { ColorTarget, OfficeColorButton } from '../common/toolbar/OfficeColorButton';
import { ToolbarPopoverPanel, useToolbarPopover } from '../common/toolbar/OfficePopover';
import {
  OfficeFontSelect, OfficeFontSizeSelect, OfficeToolbar, OfficeToolbarButton, OfficeToolbarDivider,
} from '../common/toolbar/OfficeToolbar';
import { formatWordStyleLabel } from '../common/toolbar/officeToolbarLabels';
import { insertWordImage, WordImageButton, WordTableButton, WordTableMenu } from './WordInsertControls';

const t = (key: string) => i18nService.t(key);
const Slot = {
  Style: 'styles.style',
  Font: 'font.family',
  Size: 'font.size',
  Color: 'text.color',
  Undo: 'history.undo',
  Redo: 'history.redo',
} as const;
/** Families the font resolver registers for stand-in faces; they are not the document's fonts. */
const PRIVATE_FAMILY_PREFIX = 'LobsterAI Word ';
const INLINE_TEXT_BUTTONS = [
  { slot: 'text.bold', icon: BoldIcon, label: 'officeBold' },
  { slot: 'text.italic', icon: ItalicIcon, label: 'officeItalic' },
  { slot: 'text.underline', icon: UnderlineIcon, label: 'officeUnderline' },
] satisfies { slot: ChromeSlotId; icon: typeof BoldIcon; label: string }[];

const ALIGNMENT_ITEMS = [
  { slot: 'alignment.left', icon: Bars3BottomLeftIcon, label: 'officeAlignLeft' },
  { slot: 'alignment.center', icon: Bars3CenterLeftIcon, label: 'officeAlignCenter' },
  { slot: 'alignment.right', icon: Bars3BottomRightIcon, label: 'officeAlignRight' },
  { slot: 'alignment.justify', icon: Bars3Icon, label: 'wordAlignJustify' },
] satisfies { slot: ChromeSlotId; icon: typeof BoldIcon; label: string }[];

const LIST_ITEMS = [
  { slot: 'list.bullet', icon: ListBulletIcon, label: 'wordBullet' },
  { slot: 'list.numbered', icon: NumberedListIcon, label: 'wordNumbered' },
] satisfies { slot: ChromeSlotId; icon: typeof BoldIcon; label: string }[];

const HISTORY_ITEMS = [
  { slot: Slot.Undo, icon: ArrowUturnLeftIcon, label: 'officeUndo' },
  { slot: Slot.Redo, icon: ArrowUturnRightIcon, label: 'officeRedo' },
] satisfies { slot: ChromeSlotId; icon: typeof BoldIcon; label: string }[];

const MENU_WIDTH = 148;
const PARAGRAPH_MENU_WIDTH = 188;
const OVERFLOW_MENU_WIDTH = 192;
const QUICK_TABLE_ROWS = 3;
const QUICK_TABLE_COLS = 3;
const keepEditorFocus = (event: React.MouseEvent) => event.preventDefault();

const LineSpacingIcon: React.FC<{ className?: string }> = ({ className = 'h-3.5 w-3.5' }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M3.5 3.5v9M2 5l1.5-1.5L5 5M2 11l1.5 1.5L5 11" />
    <path d="M7.5 4.25h6.5M7.5 8h6.5M7.5 11.75h6.5" />
  </svg>
);

const toWordColorValue = (color: string | null): string => {
  if (!color) return 'auto';
  return color.replace(/^#/, '').toUpperCase();
};

export function WordToolbar({ session }: { session: WordEditorSession }): React.ReactElement {
  useSyncExternalStore(session.subscribeEditor, session.getEditorSnapshot);
  const [rejected, setRejected] = useState(false);
  const [barWidth, setBarWidth] = useState(0);
  const barWrapRef = useRef<HTMLDivElement>(null);
  const overflowImageInputRef = useRef<HTMLInputElement>(null);
  const alignPopover = useToolbarPopover(MENU_WIDTH);
  const spacingPopover = useToolbarPopover(PARAGRAPH_MENU_WIDTH);
  const listPopover = useToolbarPopover(MENU_WIDTH);
  const morePopover = useToolbarPopover(OVERFLOW_MENU_WIDTH);
  const editor = session.editor;
  const language = i18nService.getLanguage();
  const pin = useRef<ReturnType<NonNullable<typeof editor>['retainSelection']>>(null);

  useEffect(() => {
    const element = barWrapRef.current;
    if (!element) return undefined;
    setBarWidth(element.clientWidth);
    const observer = new ResizeObserver(entries => {
      const nextWidth = Math.round(entries[0]?.contentRect.width ?? element.clientWidth);
      setBarWidth(prev => (prev === nextWidth ? prev : nextWidth));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const density = resolveWordToolbarDensity(barWidth);
  const isFull = density === WordToolbarDensity.Full;
  const isMinimal = density === WordToolbarDensity.Minimal;
  const showHistoryInMore = resolveWordHeaderCompact(barWidth);

  const formatting = editor?.getSelectionFormatting();
  const surfaceFormatting = editor?.surface?.formatting();
  // The menus take the focus while open; the engine would drop its selection without the pin.
  const retain = () => {
    if (pin.current) editor?.releaseSelection(pin.current);
    pin.current = editor?.retainSelection() ?? null;
  };
  const release = () => {
    if (pin.current) editor?.releaseSelection(pin.current);
    pin.current = null;
  };
  const run = (command: EditorCommand | null) => {
    if (!editor || !command) return;
    const can = editor.can(command);
    setRejected(!can.ok || !editor.exec(command).ok);
    release();
    editor.focus();
  };
  // An agent edit or a table at the caret spans several engine steps; the session undoes it as one.
  const activate = (slot: ChromeSlotId, command: EditorCommand | null) => {
    if ((slot === Slot.Undo && session.undo()) || (slot === Slot.Redo && session.redo())) {
      editor?.focus();
      return;
    }
    run(command);
  };

  const halfPoints = formatting?.fontSizeHalfPoints;
  const colorSampleCommand = commandForSlotValue(Slot.Color, '000000');
  const canSetColor = Boolean(editor && colorSampleCommand && editor.can(colorSampleCommand).ok);
  const inTable = Boolean(editor?.snapshot().table);
  const canInsertTable = toolbarCommandState(editor ?? null, 'table.insert').enabled;
  const canInsertImage = toolbarCommandState(editor ?? null, 'image.insert').enabled;

  const activeAlignItem = ALIGNMENT_ITEMS.find(item => {
    const command = commandForSlot(item.slot);
    return Boolean(command && editor?.isActive(command));
  }) ?? ALIGNMENT_ITEMS[0];
  const ActiveAlignIcon = activeAlignItem.icon;
  const alignDisabled = !ALIGNMENT_ITEMS.some(item => {
    const command = commandForSlot(item.slot);
    return Boolean(command && editor?.can(command).ok);
  });

  const activeListItem = LIST_ITEMS.find(item => {
    const command = commandForSlot(item.slot);
    return Boolean(command && editor?.isActive(command));
  });
  const ActiveListIcon = activeListItem?.icon ?? ListBulletIcon;
  const listDisabled = !LIST_ITEMS.some(item => {
    const command = commandForSlot(item.slot);
    return Boolean(command && editor?.can(command).ok);
  });

  const canFormatParagraph = Boolean(editor?.can(buildLineSpacingCommand(1.15)).ok);
  const spaceAfterActive = hasParagraphSpaceAfter(surfaceFormatting?.spaceAfterPt);
  const firstLineIndentActive = hasFirstLineIndent(surfaceFormatting?.indent);

  const strikeCommand = commandForSlot('text.strike');
  const isStrikeActive = Boolean(strikeCommand && editor?.isActive(strikeCommand));
  const strikeDisabled = !(strikeCommand && editor?.can(strikeCommand).ok);

  const handleOverflowImagePicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) void insertWordImage(session, file);
  };

  return (
    <div ref={barWrapRef} className="lobster-word-format-bar">
      <OfficeToolbar label="wordToolbar">
        <select
          className="lobster-word-style-select"
          aria-label={t('wordStyle')}
          title={t('wordStyle')}
          value={formatting?.styleId ?? ''}
          onFocus={retain}
          onBlur={release}
          onChange={event => run(commandForSlotValue(Slot.Style, event.target.value))}
        >
          <option value="" disabled>{t('wordStyle')}</option>
          {editor?.getDocumentStyles().filter(style => style.type === 'paragraph').map(style => (
            <option key={style.styleId} value={style.styleId}>
              {formatWordStyleLabel(style.styleId, style.name, language)}
            </option>
          ))}
        </select>
        <OfficeFontSelect
          className="lobster-word-font-select"
          value={formatting?.fontFamily}
          fonts={editor?.getDocumentFonts()}
          hidden={font => font.startsWith(PRIVATE_FAMILY_PREFIX)}
          onFocus={retain}
          onBlur={release}
          onChange={font => run(commandForSlotValue(Slot.Font, font))}
        />
        <OfficeFontSizeSelect
          className="lobster-word-size-select"
          value={halfPoints === undefined ? undefined : halfPoints / 2}
          onFocus={retain}
          onBlur={release}
          onChange={points => run(commandForSlotValue(Slot.Size, Math.round(points * 2)))}
        />
        <OfficeToolbarDivider />
        {INLINE_TEXT_BUTTONS.map(({ slot, icon: Icon, label }) => {
          const command = commandForSlot(slot);
          return (
            <OfficeToolbarButton
              key={slot}
              label={label}
              active={Boolean(command && editor?.isActive(command))}
              disabled={!(command && editor?.can(command).ok)}
              onClick={() => activate(slot, command)}
            >
              <Icon className="h-3.5 w-3.5" />
            </OfficeToolbarButton>
          );
        })}
        <OfficeColorButton
          target={ColorTarget.Font}
          themeColors={[]}
          disabled={!canSetColor}
          onPick={color => run(commandForSlotValue(Slot.Color, toWordColorValue(color)))}
        />

        {!isMinimal && (
          <>
            <OfficeToolbarDivider />
            <button
              ref={alignPopover.trigger}
              type="button"
              className="lobster-word-menu-button"
              title={t('wordAlignMenu')}
              aria-label={t('wordAlignMenu')}
              aria-haspopup="menu"
              aria-expanded={alignPopover.open}
              disabled={alignDisabled}
              onMouseDown={keepEditorFocus}
              onClick={() => alignPopover.setOpen(open => !open)}
            >
              <ActiveAlignIcon className="h-3.5 w-3.5" />
              <span aria-hidden="true">▾</span>
            </button>
            <ToolbarPopoverPanel popover={alignPopover} label={t('wordAlignMenu')} width={MENU_WIDTH}>
              {alignPopover.open && ALIGNMENT_ITEMS.map(({ slot, icon: Icon, label }) => {
                const command = commandForSlot(slot);
                const active = Boolean(command && editor?.isActive(command));
                return (
                  <button
                    key={slot}
                    type="button"
                    className={`lobster-office-menu-item lobster-word-popover-item${active ? ' is-active' : ''}`}
                    disabled={!(command && editor?.can(command).ok)}
                    onMouseDown={keepEditorFocus}
                    onClick={() => {
                      alignPopover.setOpen(false);
                      activate(slot, command);
                    }}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span>{t(label)}</span>
                  </button>
                );
              })}
            </ToolbarPopoverPanel>
            <button
              ref={spacingPopover.trigger}
              type="button"
              className="lobster-word-menu-button"
              title={t('wordSpacingMenu')}
              aria-label={t('wordSpacingMenu')}
              aria-haspopup="menu"
              aria-expanded={spacingPopover.open}
              aria-pressed={firstLineIndentActive}
              disabled={!canFormatParagraph}
              onMouseDown={keepEditorFocus}
              onClick={() => spacingPopover.setOpen(open => !open)}
            >
              <LineSpacingIcon className="h-3.5 w-3.5" />
              <span aria-hidden="true">▾</span>
            </button>
            <ToolbarPopoverPanel popover={spacingPopover} label={t('wordSpacingMenu')} width={PARAGRAPH_MENU_WIDTH}>
              {spacingPopover.open && (
                <>
                  <span className="lobster-word-menu-heading">{t('wordLineSpacingSection')}</span>
                  {WORD_LINE_SPACING_OPTIONS.map(option => {
                    const active = isLineSpacingOptionActive(surfaceFormatting?.lineSpacing, option.value);
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className={`lobster-office-menu-item lobster-word-popover-item${active ? ' is-active' : ''}`}
                        onMouseDown={keepEditorFocus}
                        onClick={() => {
                          spacingPopover.setOpen(false);
                          run(buildLineSpacingCommand(option.value));
                        }}
                      >
                        <CheckIcon className={`h-3.5 w-3.5 shrink-0${active ? '' : ' opacity-0'}`} aria-hidden="true" />
                        <span>{t(option.labelKey)}</span>
                      </button>
                    );
                  })}
                  <span className="lobster-word-menu-divider" role="separator" />
                  <button
                    type="button"
                    className={`lobster-office-menu-item lobster-word-popover-item${spaceAfterActive ? ' is-active' : ''}`}
                    onMouseDown={keepEditorFocus}
                    onClick={() => {
                      spacingPopover.setOpen(false);
                      run(buildToggleSpaceAfterCommand(surfaceFormatting?.spaceAfterPt));
                    }}
                  >
                    <CheckIcon className={`h-3.5 w-3.5 shrink-0${spaceAfterActive ? '' : ' opacity-0'}`} aria-hidden="true" />
                    <span>{t(spaceAfterActive ? 'wordRemoveSpaceAfter' : 'wordAddSpaceAfter')}</span>
                  </button>
                  <button
                    type="button"
                    className={`lobster-office-menu-item lobster-word-popover-item${firstLineIndentActive ? ' is-active' : ''}`}
                    onMouseDown={keepEditorFocus}
                    onClick={() => {
                      spacingPopover.setOpen(false);
                      run(buildToggleFirstLineIndentCommand(surfaceFormatting?.indent, halfPoints));
                    }}
                  >
                    <CheckIcon className={`h-3.5 w-3.5 shrink-0${firstLineIndentActive ? '' : ' opacity-0'}`} aria-hidden="true" />
                    <span>{t('wordFirstLineIndent')}</span>
                  </button>
                </>
              )}
            </ToolbarPopoverPanel>
          </>
        )}

        {isFull && (
          <>
            <button
              ref={listPopover.trigger}
              type="button"
              className="lobster-word-menu-button"
              title={t('wordListMenu')}
              aria-label={t('wordListMenu')}
              aria-haspopup="menu"
              aria-expanded={listPopover.open}
              aria-pressed={Boolean(activeListItem)}
              disabled={listDisabled}
              onMouseDown={keepEditorFocus}
              onClick={() => listPopover.setOpen(open => !open)}
            >
              <ActiveListIcon className="h-3.5 w-3.5" />
              <span aria-hidden="true">▾</span>
            </button>
            <ToolbarPopoverPanel popover={listPopover} label={t('wordListMenu')} width={MENU_WIDTH}>
              {listPopover.open && LIST_ITEMS.map(({ slot, icon: Icon, label }) => {
                const command = commandForSlot(slot);
                const active = Boolean(command && editor?.isActive(command));
                return (
                  <button
                    key={slot}
                    type="button"
                    className={`lobster-office-menu-item lobster-word-popover-item${active ? ' is-active' : ''}`}
                    disabled={!(command && editor?.can(command).ok)}
                    onMouseDown={keepEditorFocus}
                    onClick={() => {
                      listPopover.setOpen(false);
                      activate(slot, command);
                    }}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span>{t(label)}</span>
                  </button>
                );
              })}
            </ToolbarPopoverPanel>
            <OfficeToolbarDivider />
            <WordTableButton session={session} disabled={!canInsertTable} />
            <WordImageButton session={session} disabled={!canInsertImage} />
          </>
        )}

        {inTable && <WordTableMenu session={session} run={run} />}

        <button
          ref={morePopover.trigger}
          type="button"
          title={t('wordMoreTools')}
          aria-label={t('wordMoreTools')}
          aria-haspopup="menu"
          aria-expanded={morePopover.open}
          aria-pressed={isStrikeActive}
          onMouseDown={keepEditorFocus}
          onClick={() => morePopover.setOpen(open => !open)}
        >
          <EllipsisHorizontalIcon className="h-4 w-4" />
        </button>
        <ToolbarPopoverPanel popover={morePopover} label={t('wordMoreTools')} width={OVERFLOW_MENU_WIDTH}>
          {morePopover.open && (
            <>
              <button
                type="button"
                className={`lobster-office-menu-item lobster-word-popover-item${isStrikeActive ? ' is-active' : ''}`}
                disabled={strikeDisabled}
                onMouseDown={keepEditorFocus}
                onClick={() => {
                  morePopover.setOpen(false);
                  activate('text.strike', strikeCommand);
                }}
              >
                <StrikethroughIcon className="h-3.5 w-3.5 shrink-0" />
                <span>{t('officeStrike')}</span>
              </button>

              {isMinimal && (
                <>
                  <span className="lobster-word-menu-divider" role="separator" />
                  <span className="lobster-word-menu-heading">{t('wordAlignMenu')}</span>
                  {ALIGNMENT_ITEMS.map(({ slot, icon: Icon, label }) => {
                    const command = commandForSlot(slot);
                    const active = Boolean(command && editor?.isActive(command));
                    return (
                      <button
                        key={slot}
                        type="button"
                        className={`lobster-office-menu-item lobster-word-popover-item${active ? ' is-active' : ''}`}
                        disabled={!(command && editor?.can(command).ok)}
                        onMouseDown={keepEditorFocus}
                        onClick={() => {
                          morePopover.setOpen(false);
                          activate(slot, command);
                        }}
                      >
                        <Icon className="h-3.5 w-3.5 shrink-0" />
                        <span>{t(label)}</span>
                      </button>
                    );
                  })}
                  <span className="lobster-word-menu-divider" role="separator" />
                  <button
                    type="button"
                    className={`lobster-office-menu-item lobster-word-popover-item${spaceAfterActive ? ' is-active' : ''}`}
                    disabled={!canFormatParagraph}
                    onMouseDown={keepEditorFocus}
                    onClick={() => {
                      morePopover.setOpen(false);
                      run(buildToggleSpaceAfterCommand(surfaceFormatting?.spaceAfterPt));
                    }}
                  >
                    <CheckIcon className={`h-3.5 w-3.5 shrink-0${spaceAfterActive ? '' : ' opacity-0'}`} aria-hidden="true" />
                    <span>{t(spaceAfterActive ? 'wordRemoveSpaceAfter' : 'wordAddSpaceAfter')}</span>
                  </button>
                  <button
                    type="button"
                    className={`lobster-office-menu-item lobster-word-popover-item${firstLineIndentActive ? ' is-active' : ''}`}
                    disabled={!canFormatParagraph}
                    onMouseDown={keepEditorFocus}
                    onClick={() => {
                      morePopover.setOpen(false);
                      run(buildToggleFirstLineIndentCommand(surfaceFormatting?.indent, halfPoints));
                    }}
                  >
                    <CheckIcon className={`h-3.5 w-3.5 shrink-0${firstLineIndentActive ? '' : ' opacity-0'}`} aria-hidden="true" />
                    <span>{t('wordFirstLineIndent')}</span>
                  </button>
                </>
              )}

              {!isFull && (
                <>
                  <span className="lobster-word-menu-divider" role="separator" />
                  {LIST_ITEMS.map(({ slot, icon: Icon, label }) => {
                    const command = commandForSlot(slot);
                    const active = Boolean(command && editor?.isActive(command));
                    return (
                      <button
                        key={slot}
                        type="button"
                        className={`lobster-office-menu-item lobster-word-popover-item${active ? ' is-active' : ''}`}
                        disabled={!(command && editor?.can(command).ok)}
                        onMouseDown={keepEditorFocus}
                        onClick={() => {
                          morePopover.setOpen(false);
                          activate(slot, command);
                        }}
                      >
                        <Icon className="h-3.5 w-3.5 shrink-0" />
                        <span>{t(label)}</span>
                      </button>
                    );
                  })}
                  <span className="lobster-word-menu-divider" role="separator" />
                  <button
                    type="button"
                    className="lobster-office-menu-item lobster-word-popover-item"
                    disabled={!canInsertTable}
                    onMouseDown={keepEditorFocus}
                    onClick={() => {
                      morePopover.setOpen(false);
                      session.insertTable(QUICK_TABLE_ROWS, QUICK_TABLE_COLS);
                    }}
                  >
                    <TableCellsIcon className="h-3.5 w-3.5 shrink-0" />
                    <span>{t('wordInsertTableQuick')}</span>
                  </button>
                  <button
                    type="button"
                    className="lobster-office-menu-item lobster-word-popover-item"
                    disabled={!canInsertImage}
                    onMouseDown={keepEditorFocus}
                    onClick={() => {
                      morePopover.setOpen(false);
                      overflowImageInputRef.current?.click();
                    }}
                  >
                    <PhotoIcon className="h-3.5 w-3.5 shrink-0" />
                    <span>{t('wordInsertImage')}</span>
                  </button>
                </>
              )}

              {showHistoryInMore && (
                <>
                  <span className="lobster-word-menu-divider" role="separator" />
                  {HISTORY_ITEMS.map(({ slot, icon: Icon, label }) => {
                    const command = commandForSlot(slot);
                    const disabled = !(command && editor?.can(command).ok);
                    return (
                      <button
                        key={slot}
                        type="button"
                        className="lobster-office-menu-item lobster-word-popover-item"
                        disabled={disabled}
                        onMouseDown={keepEditorFocus}
                        onClick={() => {
                          morePopover.setOpen(false);
                          activate(slot, command);
                        }}
                      >
                        <Icon className="h-3.5 w-3.5 shrink-0" />
                        <span>{t(label)}</span>
                      </button>
                    );
                  })}
                </>
              )}
            </>
          )}
        </ToolbarPopoverPanel>
        <input
          ref={overflowImageInputRef}
          type="file"
          accept={WORD_IMAGE_ACCEPT}
          hidden
          onChange={handleOverflowImagePicked}
        />
        {rejected && <span role="status" className="ml-1 truncate text-xs text-amber-600">{t('wordCommandRejected')}</span>}
      </OfficeToolbar>
    </div>
  );
}
