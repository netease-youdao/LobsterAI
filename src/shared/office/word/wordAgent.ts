/**
 * Agent tools that read and edit the Word document LobsterAI has open, in place. Edits go
 * through the live editor, so the user sees them immediately and can undo them as one step.
 */
export const WordAgentTool = {
  Read: 'word_read',
  Edit: 'word_edit',
} as const;
export type WordAgentTool = typeof WordAgentTool[keyof typeof WordAgentTool];

export const WordEditType = {
  ReplaceText: 'replace_text',
  SetText: 'set_text',
  InsertParagraph: 'insert_paragraph',
  DeleteParagraph: 'delete_paragraph',
  FormatText: 'format_text',
  FormatParagraph: 'format_paragraph',
  InsertTable: 'insert_table',
} as const;
export type WordEditType = typeof WordEditType[keyof typeof WordEditType];

export const WordInsertPosition = { Before: 'before', After: 'after' } as const;
export type WordInsertPosition = typeof WordInsertPosition[keyof typeof WordInsertPosition];

/** Anchors for inserting at the document boundaries instead of next to a paragraph. */
export const WordDocumentEdge = { Start: 'start', End: 'end' } as const;

export const WordAlignment = { Left: 'left', Center: 'center', Right: 'right', Justify: 'justify' } as const;
export type WordAlignment = typeof WordAlignment[keyof typeof WordAlignment];

export const WORD_AGENT_TIMEOUT_MS = 60_000;

/** The LobsterAI-managed MCP server that exposes these tools to OpenClaw. */
export const WORD_AGENT_MCP_SERVER_NAME = 'lobster-word';

/** Tool descriptions and schemas shared by the MCP server and the renderer's validator. */
export const WORD_AGENT_TOOL_DEFINITIONS = [
  {
    name: WordAgentTool.Read,
    description: [
      'Open a local .docx in LobsterAI\'s Word editor (right-side panel) and read it paragraph by paragraph.',
      'Returns the document revision, each paragraph\'s id, style and text, table cell positions, and the user\'s current selection.',
      'Use this before word_edit. Prefer these tools over rewriting the .docx file when the user wants to change an existing Word document,',
      'because edits then appear live in the editor, keep all formatting the tools do not touch, and can be undone in one step.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the .docx file.' },
        offset: { type: 'number', description: 'First paragraph index to return (default 0).' },
        limit: { type: 'number', description: 'Maximum paragraphs to return (default 300, maximum 1000).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: WordAgentTool.Edit,
    description: [
      'Apply edits to a .docx open in LobsterAI\'s Word editor. Edits apply in order; if any edit cannot apply, none of them is applied. Changes appear live and save automatically.',
      'Address paragraphs by the ids from word_read. Pass expectedRevision from word_read; if the user changed the document since, the call is refused and you must read again.',
      'Edit types: replace_text {paragraph, find, replace, occurrence?} replaces an exact phrase inside a paragraph and keeps its formatting;',
      'set_text {paragraph, text} replaces a paragraph\'s whole text; insert_paragraph {anchor: paragraph id | "start" | "end", position: "before" | "after", text, style?};',
      'delete_paragraph {paragraph}; format_text {paragraph, find?, occurrence?, bold?, italic?, underline?, strike?, color?, highlight?, size?, font?};',
      'format_paragraph {paragraph, style?, alignment? (left|center|right|justify), lineSpacing?, spaceBefore?, spaceAfter?, firstLineIndent?, leftIndent?} with lengths in points;',
      'insert_table {anchor, position, rows: string[][]}. A newline in text starts a new paragraph.',
      'Style names are the document\'s paragraph style names, e.g. "Normal", "Heading 1", "Title".',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the .docx file.' },
        expectedRevision: { type: 'number', description: 'The revision returned by word_read.' },
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: Object.values(WordEditType) },
              paragraph: { type: 'string' },
              anchor: { type: 'string' },
              position: { type: 'string', enum: Object.values(WordInsertPosition) },
              find: { type: 'string' },
              replace: { type: 'string' },
              occurrence: { type: 'number' },
              text: { type: 'string' },
              style: { type: 'string' },
              bold: { type: 'boolean' },
              italic: { type: 'boolean' },
              underline: { type: 'boolean' },
              strike: { type: 'boolean' },
              color: { type: 'string', description: 'Hex color such as #C00000.' },
              highlight: { type: 'string', description: 'Word highlight name such as yellow, or "none".' },
              size: { type: 'number', description: 'Font size in points.' },
              font: { type: 'string', description: 'Font family, e.g. 宋体 or Arial.' },
              alignment: { type: 'string', enum: Object.values(WordAlignment) },
              lineSpacing: { type: 'number' },
              spaceBefore: { type: 'number' },
              spaceAfter: { type: 'number' },
              firstLineIndent: { type: 'number' },
              leftIndent: { type: 'number' },
              rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
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
