/**
 * Agent tools that read and edit the presentation LobsterAI has open, in place. Edits go through
 * the live editor, so the user sees them immediately and can undo each call as one step.
 */
export const SlidesAgentTool = {
  Read: 'ppt_read',
  Edit: 'ppt_edit',
} as const;
export type SlidesAgentTool = typeof SlidesAgentTool[keyof typeof SlidesAgentTool];

export const SlidesEditType = {
  SetText: 'set_text',
  ReplaceText: 'replace_text',
  FormatText: 'format_text',
  FormatParagraph: 'format_paragraph',
  SetTableCell: 'set_table_cell',
  SetBounds: 'set_bounds',
  DeleteShape: 'delete_shape',
  AddTextBox: 'add_text_box',
  AddSlide: 'add_slide',
  DuplicateSlide: 'duplicate_slide',
  DeleteSlide: 'delete_slide',
  MoveSlide: 'move_slide',
  SetNotes: 'set_notes',
} as const;
export type SlidesEditType = typeof SlidesEditType[keyof typeof SlidesEditType];

export const SlidesAlignment = { Left: 'left', Center: 'center', Right: 'right', Justify: 'justify' } as const;
export type SlidesAlignment = typeof SlidesAlignment[keyof typeof SlidesAlignment];

/** What a shape is, as ppt_read reports it. */
export const SlidesShapeKind = {
  Text: 'text',
  Shape: 'shape',
  Picture: 'picture',
  Table: 'table',
  Group: 'group',
  Chart: 'chart',
  Other: 'other',
} as const;
export type SlidesShapeKind = typeof SlidesShapeKind[keyof typeof SlidesShapeKind];

export const SLIDES_AGENT_TIMEOUT_MS = 60_000;

/** The LobsterAI-managed MCP server that exposes these tools to OpenClaw. */
export const SLIDES_AGENT_MCP_SERVER_NAME = 'lobster-ppt';

/** Tool descriptions and schemas shared by the MCP server and the renderer's validator. */
export const SLIDES_AGENT_TOOL_DEFINITIONS = [
  {
    name: SlidesAgentTool.Read,
    description: [
      'Open a local .pptx in LobsterAI\'s PowerPoint editor (right-side panel) and read its slides.',
      'Returns the presentation revision, the slide size in points, and for each slide its number, layout, speaker notes and shapes:',
      'id, name, kind (text, shape, picture, table, group, chart, other), placeholder role (title, body, ...), position and size in points,',
      'text (one line per paragraph, tabs before a line give its bullet level) and table cells. It also returns the user\'s current selection.',
      'Use this before ppt_edit. Prefer these tools over rewriting the .pptx file when the user wants to change an existing presentation:',
      'edits appear live, keep the theme, layouts, animations and everything the tools do not touch, and can be undone in one step.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the .pptx file.' },
        slides: { type: 'string', description: 'Slides to read, e.g. "3" or "1-5,8" (default: all).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: SlidesAgentTool.Edit,
    description: [
      'Apply edits to a .pptx open in LobsterAI\'s PowerPoint editor. Edits apply in order as one undoable step; if any edit is invalid, none is applied.',
      'Changes appear live and save automatically. Pass expectedRevision from ppt_read; if the user changed the presentation since, the call is refused and you must read again.',
      'Slides are numbered from 1 in their current order, shapes are addressed by the ids from ppt_read, and lengths are in points. Edit types:',
      'set_text {slide, shape, text} replaces a shape\'s text and keeps its formatting (a newline starts a paragraph, leading tabs set its bullet level);',
      'replace_text {slide?, shape?, find, replace, occurrence?} replaces an exact phrase and keeps the formatting around it (without slide and shape it searches every slide);',
      'format_text {slide, shape, find?, occurrence?, paragraph?, bold?, italic?, underline?, strike?, color? (#RRGGBB), size?, font?} formats a phrase, a paragraph (from 1) or the whole shape;',
      'format_paragraph {slide, shape, paragraph?, alignment? (left|center|right|justify), level?};',
      'set_table_cell {slide, shape, row, column, text} with rows and columns from 1;',
      'set_bounds {slide, shape, x?, y?, width?, height?}; delete_shape {slide, shape};',
      'add_text_box {slide, text, x?, y?, width?, height?, size?, bold?, color?, alignment?};',
      'add_slide {after?, layout?, title?, body?} adds a slide after slide `after` (default: at the end) with a layout named as in ppt_read (default: the layout of that slide) and fills its title and body placeholders;',
      'duplicate_slide {slide}; delete_slide {slide}; move_slide {slide, position}; set_notes {slide, text} replaces the speaker notes.',
      'Edits run in order, so slide numbers in later edits refer to the presentation after the earlier edits.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the .pptx file.' },
        expectedRevision: { type: 'number', description: 'The revision returned by ppt_read.' },
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: Object.values(SlidesEditType) },
              slide: { type: 'number' },
              shape: { type: ['string', 'number'] },
              text: { type: 'string' },
              find: { type: 'string' },
              replace: { type: 'string' },
              occurrence: { type: 'number' },
              paragraph: { type: 'number' },
              bold: { type: 'boolean' },
              italic: { type: 'boolean' },
              underline: { type: 'boolean' },
              strike: { type: 'boolean' },
              color: { type: 'string', description: 'Hex color such as #C00000.' },
              size: { type: 'number', description: 'Font size in points.' },
              font: { type: 'string', description: 'Font family, e.g. 微软雅黑 or Arial.' },
              alignment: { type: 'string', enum: Object.values(SlidesAlignment) },
              level: { type: 'number', description: 'Bullet level from 0.' },
              row: { type: 'number' },
              column: { type: 'number' },
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
              after: { type: 'number' },
              position: { type: 'number' },
              layout: { type: 'string' },
              title: { type: 'string' },
              body: { type: 'string' },
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

/** Guidance for the managed AGENTS.md section: prefer live edits over rewriting the file. */
export const SLIDES_AGENT_PROMPT = [
  '## Editing Existing Presentations',
  '',
  `- When the user wants to change an existing \`.pptx\` and \`${SlidesAgentTool.Read}\` / \`${SlidesAgentTool.Edit}\` are available, use them instead of rewriting the file with scripts: edits appear live in LobsterAI's editor, keep the theme, layouts, animations and other content, and can be undone as one step.`,
  '- They change text and its formatting, table cells, shape positions and sizes, add text boxes, add, duplicate, move and delete slides, and write speaker notes.',
  '- Use file-based tools only for what those tools cannot do (pictures, charts, new designs), when the presentation is reported as read-only or an edit is refused, or to create a new presentation.',
].join('\n');
