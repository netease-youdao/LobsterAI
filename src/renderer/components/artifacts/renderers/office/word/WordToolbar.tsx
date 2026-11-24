import type { EditorCommand } from '@docx-editor.dev/core/contracts/editor';
import { type ChromeSlotId, commandForSlot, commandForSlotValue, toolbarCommandState } from '@docx-editor.dev/core/editor';
import {
  ArrowUturnLeftIcon, ArrowUturnRightIcon, Bars3BottomLeftIcon, Bars3BottomRightIcon,
  Bars3CenterLeftIcon, Bars3Icon, BoldIcon, EllipsisHorizontalIcon, ItalicIcon,
  ListBulletIcon, NumberedListIcon, StrikethroughIcon, UnderlineIcon,
} from '@heroicons/react/24/outline';
import React, { useRef, useState, useSyncExternalStore } from 'react';

import { i18nService } from '@/services/i18n';
import type { WordEditorSession } from '@/services/office/word/wordEditorSession';

import { ColorTarget, OfficeColorButton } from '../common/toolbar/OfficeColorButton';
import { ToolbarPopoverPanel, useToolbarPopover } from '../common/toolbar/OfficePopover';
import {
  OfficeFontSelect, OfficeFontSizeSelect, OfficeToolbar, OfficeToolbarButton, OfficeToolbarDivider,
} from '../common/toolbar/OfficeToolbar';
import { formatWordStyleLabel } from '../common/toolbar/officeToolbarLabels';
import { WordImageButton, WordTableButton, WordTableMenu } from './WordInsertControls';

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

const MORE_ITEMS = [
  { slot: Slot.Undo, icon: ArrowUturnLeftIcon, label: 'officeUndo' },
  { slot: Slot.Redo, icon: ArrowUturnRightIcon, label: 'officeRedo' },
  { slot: 'text.strike', icon: StrikethroughIcon, label: 'officeStrike' },
] satisfies { slot: ChromeSlotId; icon: typeof BoldIcon; label: string }[];

const MENU_WIDTH = 148;
const keepEditorFocus = (event: React.MouseEvent) => event.preventDefault();

const toWordColorValue = (color: string | null): string => {
  if (!color) return 'auto';
  return color.replace(/^#/, '').toUpperCase();
};

export function WordToolbar({ session }: { session: WordEditorSession }): React.ReactElement {
  useSyncExternalStore(session.subscribeEditor, session.getEditorSnapshot);
  const [rejected, setRejected] = useState(false);
  const alignPopover = useToolbarPopover(MENU_WIDTH);
  const listPopover = useToolbarPopover(MENU_WIDTH);
  const morePopover = useToolbarPopover(MENU_WIDTH);
  const editor = session.editor;
  const language = i18nService.getLanguage();
  const pin = useRef<ReturnType<NonNullable<typeof editor>['retainSelection']>>(null);
  const formatting = editor?.getSelectionFormatting();
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

  const strikeCommand = commandForSlot('text.strike');
  const isStrikeActive = Boolean(strikeCommand && editor?.isActive(strikeCommand));

  return (
    <OfficeToolbar label="wordToolbar">
      <select className="lobster-word-style-select" aria-label={t('wordStyle')} title={t('wordStyle')} value={formatting?.styleId ?? ''}
        onFocus={retain} onBlur={release} onChange={event => run(commandForSlotValue(Slot.Style, event.target.value))}>
        <option value="" disabled>{t('wordStyle')}</option>
        {editor?.getDocumentStyles().filter(style => style.type === 'paragraph').map(style => (
          <option key={style.styleId} value={style.styleId}>
            {formatWordStyleLabel(style.styleId, style.name, language)}
          </option>
        ))}
      </select>
      <OfficeFontSelect className="lobster-word-font-select" value={formatting?.fontFamily} fonts={editor?.getDocumentFonts()}
        hidden={font => font.startsWith(PRIVATE_FAMILY_PREFIX)}
        onFocus={retain} onBlur={release} onChange={font => run(commandForSlotValue(Slot.Font, font))} />
      <OfficeFontSizeSelect className="lobster-word-size-select" value={halfPoints === undefined ? undefined : halfPoints / 2}
        onFocus={retain} onBlur={release} onChange={points => run(commandForSlotValue(Slot.Size, Math.round(points * 2)))} />
      <OfficeToolbarDivider />
      {INLINE_TEXT_BUTTONS.map(({ slot, icon: Icon, label }) => {
        const command = commandForSlot(slot);
        return (
          <OfficeToolbarButton key={slot} label={label} active={Boolean(command && editor?.isActive(command))}
            disabled={!(command && editor?.can(command).ok)} onClick={() => activate(slot, command)}>
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
      <WordTableButton session={session} disabled={!toolbarCommandState(editor ?? null, 'table.insert').enabled} />
      <WordImageButton session={session} disabled={!toolbarCommandState(editor ?? null, 'image.insert').enabled} />
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
      <ToolbarPopoverPanel popover={morePopover} label={t('wordMoreTools')} width={MENU_WIDTH}>
        {morePopover.open && MORE_ITEMS.map(({ slot, icon: Icon, label }, index) => {
          const command = commandForSlot(slot);
          const active = Boolean(command && editor?.isActive(command));
          const disabled = !(command && editor?.can(command).ok);
          return (
            <React.Fragment key={slot}>
              {index === 2 && <span className="lobster-word-menu-divider" role="separator" />}
              <button
                type="button"
                className={`lobster-office-menu-item lobster-word-popover-item${active ? ' is-active' : ''}`}
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
            </React.Fragment>
          );
        })}
      </ToolbarPopoverPanel>
      {rejected && <span role="status" className="text-xs text-amber-600">{t('wordCommandRejected')}</span>}
    </OfficeToolbar>
  );
}
