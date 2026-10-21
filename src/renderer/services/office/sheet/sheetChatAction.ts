import { CommandType, ICommandService, type IDisposable, type IRange, type Univer } from '@univerjs/core';
import { SetWorksheetActiveOperation, SheetsSelectionsService } from '@univerjs/sheets';
import type { FWorkbook } from '@univerjs/sheets/facade';
import { SetCellEditVisibleOperation, SheetCanvasPopManagerService } from '@univerjs/sheets-ui';
import { ContextMenuGroup, ContextMenuPosition, IMenuManagerService, MenuItemType } from '@univerjs/ui';
import { map, type Observable } from 'rxjs';

import { type ReferenceLabels, selectionReference, type SheetSelectionReference } from './sheetChatReference';

/**
 * "Add to chat" for the grid, as the task chat offers it for selected text: the cell, row and
 * column menus start with it, and a button follows ranges selected with the mouse. The selected
 * cells go into the chat's draft as an excerpt the agent can act on with its Excel tools.
 */

export const ADD_TO_CHAT_OPERATION = 'lobster.operation.add-selection-to-chat';
/** The button beside a selected range (registered with Univer's UI). */
export const CHAT_ACTION_COMPONENT = 'LOBSTER_SHEET_CHAT_ACTION';
/** The menu entry's icon (registered with Univer's UI). */
export const CHAT_ICON_COMPONENT = 'LobsterAddToChatIcon';

export interface ChatActionProps {
  label: string;
  onAdd: () => void;
}

export interface SheetChatOptions {
  /** The menu entry and the button. */
  label: string;
  labels: ReferenceLabels;
  /** Whether a task chat takes excerpts now; the entry and the button show only then. */
  available$: Observable<boolean>;
  isAvailable: () => boolean;
  add: (reference: SheetSelectionReference) => void;
}

const single = (range: IRange) => range.startRow === range.endRow && range.startColumn === range.endColumn;

export function installAddToChat(univer: Univer, workbook: FWorkbook, options: SheetChatOptions): IDisposable {
  const injector = univer.__getInjector();
  const commands = injector.get(ICommandService);
  const selections = injector.get(SheetsSelectionsService);
  const popups = injector.get(SheetCanvasPopManagerService);
  let shown: IDisposable | undefined;
  const hide = () => {
    shown?.dispose();
    shown = undefined;
  };
  const add = () => {
    hide();
    const reference = options.isAvailable() ? selectionReference(workbook, options.labels) : undefined;
    if (!reference) return false;
    options.add(reference);
    return true;
  };
  const show = (range: IRange | undefined) => {
    hide();
    if (!range || single(range) || !options.isAvailable()) return;
    const sheet = workbook.getActiveSheet();
    // One merged cell is a single cell to the user.
    const merge = sheet.getSheet().getMergedCell(range.startRow, range.startColumn);
    if (merge && merge.endRow === range.endRow && merge.endColumn === range.endColumn) return;
    const extraProps: ChatActionProps = { label: options.label, onAdd: () => { void commands.executeCommand(ADD_TO_CHAT_OPERATION); } };
    shown = popups.attachRangePopup(range, { componentKey: CHAT_ACTION_COMPONENT, direction: 'vertical-right', extraProps: { ...extraProps } },
      workbook.getId(), sheet.getSheetId()) ?? undefined;
  };
  const subscriptions = [
    // Ranges the user drags or extends; selections set in code (an agent revealing its edit) do not show it.
    selections.selectionMoveStart$.subscribe(hide),
    selections.selectionMoveEnd$.subscribe(current => show(current[current.length - 1]?.range)),
    selections.selectionSet$.subscribe(hide),
    options.available$.subscribe(available => { if (!available) hide(); }),
  ];
  const disposers: IDisposable[] = [
    commands.registerCommand({ id: ADD_TO_CHAT_OPERATION, type: CommandType.OPERATION, handler: add }),
    // Typing into a cell or turning to another sheet puts the button away.
    commands.onCommandExecuted(command => {
      if (command.id === SetWorksheetActiveOperation.id) hide();
      if (command.id === SetCellEditVisibleOperation.id && (command.params as { visible?: boolean } | undefined)?.visible) hide();
    }),
  ];
  // First in the cell, row and column menus, above the clipboard's special entries.
  const entry = {
    [ADD_TO_CHAT_OPERATION]: {
      order: -1,
      menuItemFactory: () => ({
        id: ADD_TO_CHAT_OPERATION, type: MenuItemType.BUTTON, title: options.label, icon: CHAT_ICON_COMPONENT,
        hidden$: options.available$.pipe(map(available => !available)),
      }),
    },
  };
  injector.get(IMenuManagerService).mergeMenu({
    [ContextMenuPosition.MAIN_AREA]: { [ContextMenuGroup.FORMAT]: entry },
    [ContextMenuPosition.ROW_HEADER]: { [ContextMenuGroup.FORMAT]: entry },
    [ContextMenuPosition.COL_HEADER]: { [ContextMenuGroup.FORMAT]: entry },
  });
  return {
    dispose: () => {
      hide();
      subscriptions.forEach(subscription => subscription.unsubscribe());
      disposers.forEach(disposer => disposer.dispose());
    },
  };
}
