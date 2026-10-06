import { OfficeEditorId, type OfficeEditorSpec } from './core/officeEditor';
import {
  SHEET_AGENT_MCP_SERVER_NAME, SHEET_AGENT_PROMPT, SHEET_AGENT_TIMEOUT_MS, SHEET_AGENT_TOOL_DEFINITIONS,
} from './sheet/sheetAgent';
import { type SheetFileBridge, SheetFileIpc } from './sheet/sheetFile';
import {
  SLIDES_AGENT_MCP_SERVER_NAME, SLIDES_AGENT_PROMPT, SLIDES_AGENT_TIMEOUT_MS, SLIDES_AGENT_TOOL_DEFINITIONS,
} from './slides/slidesAgent';
import { type SlidesFileBridge, SlidesFileIpc } from './slides/slidesFile';
import { WORD_AGENT_MCP_SERVER_NAME, WORD_AGENT_TIMEOUT_MS, WORD_AGENT_TOOL_DEFINITIONS } from './word/wordAgent';
import { type WordFileBridge, WordFileIpc } from './word/wordFile';

/**
 * The Office editors LobsterAI ships. Supporting another format means one more entry here and in
 * each layer's format table (main process, renderer services, editor components); the shared
 * plumbing in between (IPC, preload, MCP servers, agent routing) follows these entries.
 */

export const WORD_EDITOR = {
  id: OfficeEditorId.Word,
  editorName: 'Word',
  extension: '.docx',
  channels: WordFileIpc,
  agent: { serverName: WORD_AGENT_MCP_SERVER_NAME, tools: WORD_AGENT_TOOL_DEFINITIONS, timeoutMs: WORD_AGENT_TIMEOUT_MS },
} as const satisfies OfficeEditorSpec;

export const SHEET_EDITOR = {
  id: OfficeEditorId.Sheet,
  editorName: 'Excel',
  extension: '.xlsx',
  channels: SheetFileIpc,
  agent: {
    serverName: SHEET_AGENT_MCP_SERVER_NAME,
    tools: SHEET_AGENT_TOOL_DEFINITIONS,
    timeoutMs: SHEET_AGENT_TIMEOUT_MS,
    prompt: SHEET_AGENT_PROMPT,
  },
} as const satisfies OfficeEditorSpec;

export const SLIDES_EDITOR = {
  id: OfficeEditorId.Slides,
  editorName: 'PowerPoint',
  extension: '.pptx',
  channels: SlidesFileIpc,
  agent: {
    serverName: SLIDES_AGENT_MCP_SERVER_NAME,
    tools: SLIDES_AGENT_TOOL_DEFINITIONS,
    timeoutMs: SLIDES_AGENT_TIMEOUT_MS,
    prompt: SLIDES_AGENT_PROMPT,
  },
} as const satisfies OfficeEditorSpec;

export const OFFICE_EDITORS: readonly OfficeEditorSpec[] = [WORD_EDITOR, SHEET_EDITOR, SLIDES_EDITOR];

/** The renderer's bridge to each editor, `window.electron.artifact.office`. */
export interface OfficeBridges {
  [OfficeEditorId.Word]: WordFileBridge;
  [OfficeEditorId.Sheet]: SheetFileBridge;
  [OfficeEditorId.Slides]: SlidesFileBridge;
}

/** The editor that opens a file, by extension. */
export function officeEditorForPath(filePath: string): OfficeEditorSpec | undefined {
  const lower = filePath.toLowerCase();
  return OFFICE_EDITORS.find(editor => lower.endsWith(editor.extension));
}
