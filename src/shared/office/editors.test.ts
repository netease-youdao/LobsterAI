import { describe, expect, test } from 'vitest';

import { OfficeEditorId } from './core/officeEditor';
import { OFFICE_EDITORS, officeEditorForPath, SHEET_EDITOR, SLIDES_EDITOR, WORD_EDITOR } from './editors';

describe('Office editor table', () => {
  test('keeps the channel names the preload and main process agree on', () => {
    // These strings are an IPC contract; renaming an editor id would silently break it.
    expect(WORD_EDITOR.channels).toEqual({
      Open: 'artifact:word:open',
      Read: 'artifact:word:read',
      Checkpoint: 'artifact:word:checkpoint',
      Save: 'artifact:word:save',
      DiscardDraft: 'artifact:word:discard-draft',
      Release: 'artifact:word:release',
      Changed: 'artifact:word:changed',
      SetUnsafeEdits: 'artifact:word:set-unsafe-edits',
      AgentRequest: 'artifact:word:agent-request',
      AgentRespond: 'artifact:word:agent-respond',
      ResolveFonts: 'artifact:word:resolve-fonts',
      ReadFont: 'artifact:word:read-font',
    });
    expect(Object.values(SHEET_EDITOR.channels).every(channel => channel.startsWith('artifact:sheet:'))).toBe(true);
    expect(SHEET_EDITOR.channels.AgentRespond).toBe('artifact:sheet:agent-respond');
    expect(SLIDES_EDITOR.channels.Open).toBe('artifact:slides:open');
  });

  test('gives every editor its own id, extension, channels, server and tools', () => {
    const unique = (values: string[]) => new Set(values).size === values.length;
    expect(OFFICE_EDITORS.map(editor => editor.id).sort()).toEqual(Object.values(OfficeEditorId).sort());
    expect(unique(OFFICE_EDITORS.map(editor => editor.extension))).toBe(true);
    expect(unique(OFFICE_EDITORS.flatMap(editor => Object.values(editor.channels)))).toBe(true);
    expect(unique(OFFICE_EDITORS.map(editor => editor.agent.serverName))).toBe(true);
    expect(unique(OFFICE_EDITORS.flatMap(editor => editor.agent.tools.map(tool => tool.name)))).toBe(true);
    expect(OFFICE_EDITORS.map(editor => editor.agent.serverName)).toEqual(['lobster-word', 'lobster-excel', 'lobster-ppt']);
  });

  test('finds the editor for a file by extension', () => {
    expect(officeEditorForPath('/tmp/报告.DOCX')).toBe(WORD_EDITOR);
    expect(officeEditorForPath('C:\\data\\book.xlsx')).toBe(SHEET_EDITOR);
    expect(officeEditorForPath('/tmp/汇报.pptx')).toBe(SLIDES_EDITOR);
    expect(officeEditorForPath('/tmp/old.xls')).toBeUndefined();
  });
});
