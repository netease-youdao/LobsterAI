import type { EditorCommand } from '@docx-editor.dev/core/contracts/editor';
import { type ChromeSlotId, commandForSlot, commandForSlotValue, toolbarCommandState } from '@docx-editor.dev/core/editor';
import {
  ArrowUturnLeftIcon, ArrowUturnRightIcon, Bars3BottomLeftIcon, Bars3BottomRightIcon,
  Bars3CenterLeftIcon, Bars3Icon, BoldIcon, ItalicIcon, ListBulletIcon, NumberedListIcon,
  StrikethroughIcon, UnderlineIcon,
} from '@heroicons/react/24/outline';
import React, { useRef, useState, useSyncExternalStore } from 'react';

import { i18nService } from '@/services/i18n';
import type { WordEditorSession } from '@/services/office/word/wordEditorSession';

import {
  OfficeFontSelect, OfficeFontSizeSelect, OfficeToolbar, OfficeToolbarButton, OfficeToolbarDivider,
} from '../common/toolbar/OfficeToolbar';
import { WordImageButton, WordTableButton, WordTableMenu } from './WordInsertControls';

const t = (key: string) => i18nService.t(key);
const Slot = { Style: 'styles.style', Font: 'font.family', Size: 'font.size', Undo: 'history.undo', Redo: 'history.redo' } as const;
/** Families the font resolver registers for stand-in faces; they are not the document's fonts. */
const PRIVATE_FAMILY_PREFIX = 'LobsterAI Word ';
const BUTTONS = [
  { slot: Slot.Undo, icon: ArrowUturnLeftIcon, label: 'officeUndo' },
  { slot: Slot.Redo, icon: ArrowUturnRightIcon, label: 'officeRedo' },
  { slot: 'text.bold', icon: BoldIcon, label: 'officeBold' },
  { slot: 'text.italic', icon: ItalicIcon, label: 'officeItalic' },
  { slot: 'text.underline', icon: UnderlineIcon, label: 'officeUnderline' },
  { slot: 'text.strike', icon: StrikethroughIcon, label: 'officeStrike' },
  { slot: 'alignment.left', icon: Bars3BottomLeftIcon, label: 'officeAlignLeft' },
  { slot: 'alignment.center', icon: Bars3CenterLeftIcon, label: 'officeAlignCenter' },
  { slot: 'alignment.right', icon: Bars3BottomRightIcon, label: 'officeAlignRight' },
  { slot: 'alignment.justify', icon: Bars3Icon, label: 'wordAlignJustify' },
  { slot: 'list.bullet', icon: ListBulletIcon, label: 'wordBullet' },
  { slot: 'list.numbered', icon: NumberedListIcon, label: 'wordNumbered' },
] satisfies { slot: ChromeSlotId; icon: typeof BoldIcon; label: string }[];

export function WordToolbar({ session }: { session: WordEditorSession }): React.ReactElement {
  useSyncExternalStore(session.subscribeEditor, session.getEditorSnapshot);
  const [rejected, setRejected] = useState(false);
  const editor = session.editor;
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
  return (
    <OfficeToolbar label="wordToolbar">
      <select aria-label={t('wordStyle')} title={t('wordStyle')} value={formatting?.styleId ?? ''}
        onFocus={retain} onBlur={release} onChange={event => run(commandForSlotValue(Slot.Style, event.target.value))}>
        <option value="" disabled>{t('wordStyle')}</option>
        {editor?.getDocumentStyles().filter(style => style.type === 'paragraph').map(style => (
          <option key={style.styleId} value={style.styleId}>{style.name}</option>
        ))}
      </select>
      <OfficeFontSelect value={formatting?.fontFamily} fonts={editor?.getDocumentFonts()} hidden={font => font.startsWith(PRIVATE_FAMILY_PREFIX)}
        onFocus={retain} onBlur={release} onChange={font => run(commandForSlotValue(Slot.Font, font))} />
      <OfficeFontSizeSelect value={halfPoints === undefined ? undefined : halfPoints / 2}
        onFocus={retain} onBlur={release} onChange={points => run(commandForSlotValue(Slot.Size, points * 2))} />
      <OfficeToolbarDivider />
      {BUTTONS.map(({ slot, icon: Icon, label }) => {
        const command = commandForSlot(slot);
        return (
          <OfficeToolbarButton key={slot} label={label} active={Boolean(command && editor?.isActive(command))}
            disabled={!(command && editor?.can(command).ok)} onClick={() => activate(slot, command)}>
            <Icon className="h-4 w-4" />
          </OfficeToolbarButton>
        );
      })}
      <OfficeToolbarDivider />
      <WordTableButton session={session} disabled={!toolbarCommandState(editor ?? null, 'table.insert').enabled} />
      <WordImageButton session={session} disabled={!toolbarCommandState(editor ?? null, 'image.insert').enabled} />
      <WordTableMenu session={session} run={run} />
      {rejected && <span role="status" className="text-xs text-amber-600">{t('wordCommandRejected')}</span>}
    </OfficeToolbar>
  );
}
