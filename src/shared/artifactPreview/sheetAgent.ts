/**
 * Agent tools that read and edit the Excel workbook LobsterAI has open, in place. Edits go
 * through the live editor, so the user sees them immediately and can undo each call as one step.
 */
export const SheetAgentTool = {
  Read: 'excel_read',
  Edit: 'excel_edit',
} as const;
export type SheetAgentTool = typeof SheetAgentTool[keyof typeof SheetAgentTool];

export const SheetEditType = {
  SetValues: 'set_values',
  SetFormula: 'set_formula',
  Clear: 'clear',
  Format: 'format',
  SetColumnWidth: 'set_column_width',
  SetRowHeight: 'set_row_height',
  Merge: 'merge',
  Unmerge: 'unmerge',
  InsertRows: 'insert_rows',
  DeleteRows: 'delete_rows',
  InsertColumns: 'insert_columns',
  DeleteColumns: 'delete_columns',
  AddSheet: 'add_sheet',
  RenameSheet: 'rename_sheet',
  DeleteSheet: 'delete_sheet',
  MoveSheet: 'move_sheet',
  HideSheet: 'hide_sheet',
  ShowSheet: 'show_sheet',
  Freeze: 'freeze',
  SetTabColor: 'set_tab_color',
} as const;
export type SheetEditType = typeof SheetEditType[keyof typeof SheetEditType];

export const SheetClearTarget = { Contents: 'contents', Formats: 'formats', All: 'all' } as const;
export type SheetClearTarget = typeof SheetClearTarget[keyof typeof SheetClearTarget];

export const SheetHorizontalAlignment = { Left: 'left', Center: 'center', Right: 'right' } as const;
export const SheetVerticalAlignment = { Top: 'top', Middle: 'middle', Bottom: 'bottom' } as const;
export const SheetBorder = { All: 'all', Outside: 'outside', None: 'none' } as const;

export const SHEET_AGENT_TIMEOUT_MS = 60_000;

/** The LobsterAI-managed MCP server that exposes these tools to OpenClaw. */
export const SHEET_AGENT_MCP_SERVER_NAME = 'lobster-excel';

/** Tool descriptions and schemas shared by the MCP server and the renderer's validator. */
export const SHEET_AGENT_TOOL_DEFINITIONS = [
  {
    name: SheetAgentTool.Read,
    description: [
      'Open a local .xlsx in LobsterAI\'s Excel editor (right-side panel) and read cells.',
      'Returns the workbook revision, every sheet with its used range, and the non-empty cells of the requested range keyed by address',
      '(a plain value, or {value, formula, text} when the cell has a formula or its displayed text differs), merged ranges and the user\'s current selection.',
      'Use this before excel_edit. Prefer these tools over rewriting the .xlsx file when the user wants to change an existing workbook:',
      'edits appear live, keep all formatting, charts and other content the tools do not touch, recalculate formulas, and can be undone in one step.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the .xlsx file.' },
        sheet: { type: 'string', description: 'Sheet name (default: the active sheet).' },
        range: { type: 'string', description: 'A1 range to read, e.g. "A1:F50" (default: the used range, truncated to maxCells).' },
        maxCells: { type: 'number', description: 'Maximum cells to return (default 2000, maximum 10000).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: SheetAgentTool.Edit,
    description: [
      'Apply edits to a .xlsx open in LobsterAI\'s Excel editor. Edits apply in order as one undoable step; if any edit is invalid, none is applied.',
      'Changes appear live, formulas recalculate, and the file saves automatically.',
      'Pass expectedRevision from excel_read; if the user changed the workbook since, the call is refused and you must read again.',
      'Every edit may name a "sheet" (default: the active sheet). Edit types:',
      'set_values {range, values: 2D array} writes values row by row starting at the range\'s first cell; a string starting with "=" is a formula; null clears a cell\'s contents;',
      'set_formula {range, formula} writes one formula to the first cell and fills the rest of the range with relative references adjusted, like Excel\'s fill;',
      'clear {range, what?: "contents" | "formats" | "all"};',
      'format {range, bold?, italic?, underline?, strikethrough?, fontColor?, fillColor?, fontFamily?, fontSize?, numberFormat?, horizontalAlignment? (left|center|right), verticalAlignment? (top|middle|bottom), wrap?, border? (all|outside|none)} with colors as #RRGGBB and numberFormat as an Excel format code such as "#,##0.00" or "yyyy-mm-dd";',
      'set_column_width {columns: "B" or "B:D", width} in Excel character units; set_row_height {rows: "3" or "3:5", height} in points;',
      'merge {range}; unmerge {range};',
      'insert_rows {rows: "5" or "5:7"} inserts that many blank rows so the first new row is that row number (row 5 moves down); delete_rows {rows};',
      'insert_columns {columns: "C" or "C:E"}; delete_columns {columns}. Formulas, charts, names, conditional formats, data validation, links, notes and tables follow the moved cells like in Excel;',
      'add_sheet {name, position?}; rename_sheet {sheet, name}; delete_sheet {sheet}; move_sheet {sheet, position} with position 1 for the first tab;',
      'hide_sheet {sheet}; show_sheet {sheet}; freeze {sheet?, rows?, columns?} keeps that many top rows / left columns in view (0 unfreezes); set_tab_color {sheet, color: #RRGGBB or null}.',
      'Edits run in order, so addresses in later edits refer to the workbook after the earlier edits.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the .xlsx file.' },
        expectedRevision: { type: 'number', description: 'The revision returned by excel_read.' },
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: Object.values(SheetEditType) },
              sheet: { type: 'string' },
              range: { type: 'string' },
              values: { type: 'array', items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } } },
              formula: { type: 'string' },
              what: { type: 'string', enum: Object.values(SheetClearTarget) },
              bold: { type: 'boolean' },
              italic: { type: 'boolean' },
              underline: { type: 'boolean' },
              strikethrough: { type: 'boolean' },
              fontColor: { type: 'string' },
              fillColor: { type: 'string' },
              fontFamily: { type: 'string' },
              fontSize: { type: 'number' },
              numberFormat: { type: 'string' },
              horizontalAlignment: { type: 'string', enum: Object.values(SheetHorizontalAlignment) },
              verticalAlignment: { type: 'string', enum: Object.values(SheetVerticalAlignment) },
              wrap: { type: 'boolean' },
              border: { type: 'string', enum: Object.values(SheetBorder) },
              columns: { type: ['string', 'number'] },
              rows: { type: ['string', 'number'] },
              width: { type: 'number' },
              height: { type: 'number' },
              name: { type: 'string' },
              position: { type: 'number' },
              color: { type: ['string', 'null'] },
            },
            required: ['type'],
            additionalProperties: false,
          },
        },
      },
      required: ['path', 'edits'],
      additionalProperties: false,
    },
  },
] as const;
