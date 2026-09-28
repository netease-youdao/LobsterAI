/**
 * Operations whose results the .xlsx writer cannot represent yet: inserting or deleting cells
 * with a shift, dragging rows and columns, right-to-left sheets, protection, range themes,
 * defined names, grid line colors and whole row/column styles. They are hidden from menus and
 * refused as commands, so a workbook never reaches a state that could not be saved faithfully.
 * Row, column and sheet operations the writer does carry are checked per workbook by the
 * editor session (see sheetStructureSupport).
 */
export const BLOCKED_SHEET_COMMAND = new RegExp([
  // Prefixes: `insert-range` covers insert-range-move-down-confirm, …
  '^sheet\\.command\\.(?:',
  'insert-range|delete-range|move-(?:rows|cols)',
  '|set-worksheet-(?:right-to-left|default-style|protection|permission-points)',
  '|set-gridlines-color|set-(?:row|col)-data',
  '|[a-z-]*range-protection[a-z-]*|[a-z-]*worksheet-protection[a-z-]*|[a-z-]*sheet-permission[a-z-]*|change-sheet-protection[a-z-]*',
  '|(?:insert|set|remove)-defined-name|[a-z-]*range-theme-style|set-protection',
  ')',
].join(''));

const HIDDEN_MENUS = [
  'sheet.contextMenu.permission',
  'sheet.command.insert-range-move-right-confirm', 'sheet.command.insert-range-move-down-confirm',
  'sheet.command.delete-range-move-left-confirm', 'sheet.command.delete-range-move-up-confirm',
  'sheet.command.add-range-protection-from-context-menu', 'sheet.command.set-range-protection-from-context-menu',
  'sheet.command.delete-range-protection-from-context-menu', 'sheet.command.view-sheet-permission-from-context-menu',
  'sheet.command.add-range-protection-from-toolbar', 'sheet.command.add-range-protection-from-sheet-bar',
  'sheet.command.delete-worksheet-protection-from-sheet-bar', 'sheet.command.change-sheet-protection-from-sheet-bar',
  'sheet.command.view-sheet-permission-from-sheet-bar',
];
export const SHEET_MENU_CONFIG = Object.fromEntries(HIDDEN_MENUS.map(id => [id, { hidden: true }]));
