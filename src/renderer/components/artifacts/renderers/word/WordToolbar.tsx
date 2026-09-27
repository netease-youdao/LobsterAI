import type { EditorCommand } from '@docx-editor.dev/core/contracts/editor';
import { type ChromeSlotId,commandForSlot, commandForSlotValue } from '@docx-editor.dev/core/editor';
import {
  ArrowUturnLeftIcon, ArrowUturnRightIcon, Bars3BottomLeftIcon, Bars3BottomRightIcon,
  Bars3CenterLeftIcon, Bars3Icon, BoldIcon, ItalicIcon, ListBulletIcon, NumberedListIcon,
  StrikethroughIcon, UnderlineIcon,
} from '@heroicons/react/24/outline';
import React, { useRef, useState, useSyncExternalStore } from 'react';

import { i18nService } from '@/services/i18n';
import type { WordEditorSession } from '@/services/wordEditorSession';

const t = (key: string) => i18nService.t(key);
const Slot = { Style: 'styles.style', Font: 'font.family', Size: 'font.size', Undo: 'history.undo', Redo: 'history.redo' } as const;
/** Word's own family names; the font resolver maps each to an installed face or a stand-in. */
const COMMON_FONTS = ['宋体', '黑体', '微软雅黑', '等线', '楷体', '仿宋', 'Calibri', 'Arial', 'Times New Roman', 'Cambria', 'Courier New'];
const PRIVATE_FAMILY_PREFIX = 'LobsterAI Word ';
const BUTTONS = [
  { slot: Slot.Undo, icon: ArrowUturnLeftIcon, label: 'wordUndo' },
  { slot: Slot.Redo, icon: ArrowUturnRightIcon, label: 'wordRedo' },
  { slot: 'text.bold', icon: BoldIcon, label: 'wordBold' },
  { slot: 'text.italic', icon: ItalicIcon, label: 'wordItalic' },
  { slot: 'text.underline', icon: UnderlineIcon, label: 'wordUnderline' },
  { slot: 'text.strike', icon: StrikethroughIcon, label: 'wordStrike' },
  { slot: 'alignment.left', icon: Bars3BottomLeftIcon, label: 'wordAlignLeft' },
  { slot: 'alignment.center', icon: Bars3CenterLeftIcon, label: 'wordAlignCenter' },
  { slot: 'alignment.right', icon: Bars3BottomRightIcon, label: 'wordAlignRight' },
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
  // An agent edit spans several engine steps; the session undoes it as one.
  const activate = (slot: ChromeSlotId, command: EditorCommand | null) => {
    if ((slot === Slot.Undo && session.undo()) || (slot === Slot.Redo && session.redo())) {
      editor?.focus();
      return;
    }
    run(command);
  };
  return (
    <div className="lobster-word-toolbar" role="toolbar" aria-label={t('wordToolbar')}>
      <select aria-label={t('wordStyle')} title={t('wordStyle')} value={formatting?.styleId ?? ''}
        onFocus={retain} onBlur={release} onChange={event => run(commandForSlotValue(Slot.Style, event.target.value))}>
        <option value="" disabled>{t('wordStyle')}</option>
        {editor?.getDocumentStyles().filter(style => style.type === 'paragraph').map(style => (
          <option key={style.styleId} value={style.styleId}>{style.name}</option>
        ))}
      </select>
      <select aria-label={t('wordFont')} title={t('wordFont')} value={formatting?.fontFamily ?? ''}
        onFocus={retain} onBlur={release} onChange={event => run(commandForSlotValue(Slot.Font, event.target.value))}>
        <option value="" disabled>{t('wordFont')}</option>
        {[...new Set([formatting?.fontFamily, ...(editor?.getDocumentFonts() ?? []), ...COMMON_FONTS])]
          .filter((font): font is string => Boolean(font) && !font!.startsWith(PRIVATE_FAMILY_PREFIX)).map(font => (
          <option key={font} value={font}>{font}</option>
        ))}
      </select>
      <select aria-label={t('wordFontSize')} title={t('wordFontSize')} value={formatting?.fontSizeHalfPoints ?? ''}
        onFocus={retain} onBlur={release} onChange={event => run(commandForSlotValue(Slot.Size, Number(event.target.value)))}>
        <option value="" disabled>{t('wordFontSize')}</option>
        {[...new Set([formatting?.fontSizeHalfPoints, ...[8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72].map(size => size * 2)])]
          .filter((size): size is number => size !== undefined).sort((a, b) => a - b).map(size => (
            <option key={size} value={size}>{size / 2}</option>
          ))}
      </select>
      <span className="lobster-word-toolbar-divider" />
      {BUTTONS.map(({ slot, icon: Icon, label }) => {
        const command = commandForSlot(slot);
        const enabled = Boolean(command && editor?.can(command).ok);
        const active = Boolean(command && editor?.isActive(command));
        return (
          <button type="button" key={slot} title={t(label)} aria-label={t(label)} aria-pressed={active}
            disabled={!enabled} onMouseDown={event => event.preventDefault()} onClick={() => activate(slot, command)}>
            <Icon className="h-4 w-4" />
          </button>
        );
      })}
      {rejected && <span role="status" className="text-xs text-amber-600">{t('wordCommandRejected')}</span>}
    </div>
  );
}
