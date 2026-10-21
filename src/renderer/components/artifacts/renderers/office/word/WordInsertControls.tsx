import type { EditorCommand } from '@docx-editor.dev/core/contracts/editor';
import { clipboardDropLandsText, clipboardPasteLandsContent, toolbarCommandState } from '@docx-editor.dev/core/editor';
import { PhotoIcon, TableCellsIcon } from '@heroicons/react/24/outline';
import React, { useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import type { WordEditorSession } from '@/services/office/word/wordEditorSession';
import { hasImageFile, imageFileOf, WORD_IMAGE_ACCEPT, WordImageError } from '@/services/office/word/wordImages';
import { showToast } from '@/utils/localFileActions';

import { ToolbarPopoverPanel, useToolbarPopover } from '../common/toolbar/OfficePopover';

const t = (key: string) => i18nService.t(key);
/** Word's table grid: ten columns by eight rows. */
const TABLE_GRID = { rows: 8, cols: 10 } as const;
const GRID_CELL_PX = 16;
const GRID_GAP_PX = 3;
const GRID_PANEL_WIDTH = TABLE_GRID.cols * GRID_CELL_PX + (TABLE_GRID.cols - 1) * GRID_GAP_PX + 22;
const TABLE_MENU_WIDTH = 160;
const IMAGE_ERROR_LABEL: Record<WordImageError, string> = {
  [WordImageError.Empty]: 'wordImageEmpty',
  [WordImageError.TooLarge]: 'wordImageTooLarge',
  [WordImageError.Unsupported]: 'wordImageUnsupported',
  [WordImageError.Rejected]: 'wordImageRejected',
};
/** Word's table layout actions; `null` separates the groups. */
const TABLE_ACTIONS: ({ label: string; command: EditorCommand } | null)[] = [
  { label: 'wordInsertRowAbove', command: { type: 'insertRow', where: 'above' } },
  { label: 'wordInsertRowBelow', command: { type: 'insertRow', where: 'below' } },
  { label: 'wordInsertColumnLeft', command: { type: 'insertColumn', where: 'left' } },
  { label: 'wordInsertColumnRight', command: { type: 'insertColumn', where: 'right' } },
  null,
  { label: 'wordDeleteRow', command: { type: 'deleteRow' } },
  { label: 'wordDeleteColumn', command: { type: 'deleteColumn' } },
  { label: 'wordDeleteTable', command: { type: 'deleteTable' } },
];

type TableSize = { rows: number; cols: number };

const tableSizeLabel = ({ rows, cols }: TableSize) => t('wordTableSize').replace('{rows}', String(rows)).replace('{cols}', String(cols));
const keepEditorFocus = (event: React.MouseEvent) => event.preventDefault();

async function insertWordImage(session: WordEditorSession, file: Blob): Promise<void> {
  let error: WordImageError | null;
  try {
    error = await session.insertImage(new Uint8Array(await file.arrayBuffer()));
  } catch (cause) {
    console.warn('[WordEditor] Could not insert a picture:', cause);
    error = WordImageError.Rejected;
  }
  if (error) showToast(t(IMAGE_ERROR_LABEL[error]));
}

/** Word's Insert Table grid: point at a size, click to insert. Arrow keys and Enter work once it has the focus. */
export function WordTableButton({ session, disabled }: { session: WordEditorSession; disabled: boolean }): React.ReactElement {
  const popover = useToolbarPopover(GRID_PANEL_WIDTH);
  const [size, setSize] = useState<TableSize | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const toggle = (event: React.MouseEvent) => {
    const opening = !popover.open;
    setSize(null);
    popover.setOpen(opening);
    // A click from the keyboard reports no pointer clicks; the grid then takes the focus.
    if (opening && event.detail === 0) requestAnimationFrame(() => grid.current?.focus());
  };
  const insert = (target: TableSize) => {
    popover.setOpen(false);
    session.insertTable(target.rows, target.cols);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const current = size ?? { rows: 1, cols: 1 };
    const moves: Record<string, TableSize> = {
      ArrowRight: { ...current, cols: Math.min(TABLE_GRID.cols, current.cols + 1) },
      ArrowLeft: { ...current, cols: Math.max(1, current.cols - 1) },
      ArrowDown: { ...current, rows: Math.min(TABLE_GRID.rows, current.rows + 1) },
      ArrowUp: { ...current, rows: Math.max(1, current.rows - 1) },
    };
    if (moves[event.key]) setSize(size ? moves[event.key] : current);
    else if (event.key === 'Enter' || event.key === ' ') insert(current);
    else return;
    event.preventDefault();
  };
  const cells = [];
  for (let row = 1; row <= TABLE_GRID.rows; row++) {
    for (let col = 1; col <= TABLE_GRID.cols; col++) {
      const cell = { rows: row, cols: col };
      cells.push(
        <span key={`${row}-${col}`} className="lobster-word-table-cell" role="gridcell"
          aria-selected={Boolean(size && row <= size.rows && col <= size.cols)}
          onMouseEnter={() => setSize(cell)} onMouseDown={keepEditorFocus} onClick={() => insert(cell)} />,
      );
    }
  }
  return (
    <>
      <button ref={popover.trigger} type="button" title={t('wordInsertTable')} aria-label={t('wordInsertTable')}
        aria-haspopup="dialog" aria-expanded={popover.open} disabled={disabled} onMouseDown={keepEditorFocus} onClick={toggle}>
        <TableCellsIcon className="h-4 w-4" />
      </button>
      <ToolbarPopoverPanel popover={popover} label={t('wordInsertTable')} width={GRID_PANEL_WIDTH}>
        <span className="lobster-word-table-size" aria-live="polite">{size ? tableSizeLabel(size) : t('wordTableSizeHint')}</span>
        <div ref={grid} className="lobster-word-table-grid" role="grid" tabIndex={-1} aria-label={t('wordInsertTable')}
          style={{ gridTemplateColumns: `repeat(${TABLE_GRID.cols}, ${GRID_CELL_PX}px)`, gap: GRID_GAP_PX }}
          onMouseLeave={() => setSize(null)} onKeyDown={onKeyDown}>
          {cells}
        </div>
      </ToolbarPopoverPanel>
    </>
  );
}

/** Picks a picture file and inserts it at the caret. */
export function WordImageButton({ session, disabled }: { session: WordEditorSession; disabled: boolean }): React.ReactElement {
  const input = useRef<HTMLInputElement>(null);
  const picked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    // Cleared so that picking the same file again still reports a change.
    event.currentTarget.value = '';
    if (file) void insertWordImage(session, file);
  };
  return (
    <>
      <button type="button" title={t('wordInsertImage')} aria-label={t('wordInsertImage')} disabled={disabled}
        onMouseDown={keepEditorFocus} onClick={() => input.current?.click()}>
        <PhotoIcon className="h-4 w-4" />
      </button>
      <input ref={input} type="file" accept={WORD_IMAGE_ACCEPT} hidden tabIndex={-1} onChange={picked} />
    </>
  );
}

/** A table with its middle cell picked out: rows and columns to insert or delete. */
function TableToolsIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.2} aria-hidden="true">
      <rect x="6" y="6.3" width="4" height="3.4" fill="currentColor" fillOpacity={0.35} stroke="none" />
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path d="M1.5 6.3h13M1.5 9.7h13M6 2.5v11M10 2.5v11" />
    </svg>
  );
}

/** Word's table layout actions for the table the caret is in. */
export function WordTableMenu({ session, run }: { session: WordEditorSession; run: (command: EditorCommand) => void }): React.ReactElement {
  const popover = useToolbarPopover(TABLE_MENU_WIDTH);
  const editor = session.editor;
  const inTable = Boolean(editor?.snapshot().table);
  const label = inTable ? t('wordTableTools') : t('wordTableToolsHint');
  return (
    <>
      <button ref={popover.trigger} type="button" className="lobster-word-menu-button" title={label} aria-label={label}
        aria-haspopup="menu" aria-expanded={popover.open} disabled={!inTable} onMouseDown={keepEditorFocus}
        onClick={() => popover.setOpen(open => !open)}>
        <TableToolsIcon />
        <span aria-hidden="true">▾</span>
      </button>
      <ToolbarPopoverPanel popover={popover} label={t('wordTableTools')} width={TABLE_MENU_WIDTH}>
        {popover.open && TABLE_ACTIONS.map((action, index) => (action ? (
          <button key={action.label} type="button" className="lobster-office-menu-item" disabled={!editor?.can(action.command).ok}
            onMouseDown={keepEditorFocus} onClick={() => { popover.setOpen(false); run(action.command); }}>
            {t(action.label)}
          </button>
        ) : <span key={`divider-${index}`} className="lobster-word-menu-divider" role="separator" />))}
      </ToolbarPopoverPanel>
    </>
  );
}

/**
 * Pictures pasted or dropped onto the pages go in at the caret, unless the engine lands the payload
 * itself: Word on macOS puts a rendered picture of copied text beside the text.
 */
export function wordImageTransferHandlers(session: WordEditorSession): Pick<React.DOMAttributes<HTMLElement>, 'onPaste' | 'onDragOver' | 'onDrop'> {
  const canInsert = () => toolbarCommandState(session.editor ?? null, 'image.insert').enabled;
  return {
    onPaste: event => {
      const data = event.clipboardData;
      if (!hasImageFile(data) || !canInsert() || clipboardPasteLandsContent(data)) return;
      const file = imageFileOf(data);
      if (!file) return;
      event.preventDefault();
      void insertWordImage(session, file);
    },
    onDragOver: event => {
      if (!hasImageFile(event.dataTransfer)) return;
      // Without a handled drop the window would open the file instead of the app.
      event.preventDefault();
      event.dataTransfer.dropEffect = canInsert() || clipboardDropLandsText(event.dataTransfer) ? 'copy' : 'none';
    },
    onDrop: event => {
      const data = event.dataTransfer;
      if (!hasImageFile(data)) return;
      // Text travels through the browser's own drop on editable text, which the engine handles.
      const target = event.target instanceof Element ? event.target : null;
      if (clipboardDropLandsText(data) && target?.closest('[contenteditable]')?.getAttribute('contenteditable') === 'true') return;
      event.preventDefault();
      const file = imageFileOf(data);
      if (file && canInsert() && !clipboardDropLandsText(data)) void insertWordImage(session, file);
    },
  };
}
