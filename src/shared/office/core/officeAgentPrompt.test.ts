import { describe, expect, test } from 'vitest';

import { OFFICE_EDITORS, WORD_EDITOR } from '../editors';
import { buildOfficeAgentPrompt } from './officeAgentPrompt';

describe('buildOfficeAgentPrompt', () => {
  const prompt = buildOfficeAgentPrompt(OFFICE_EDITORS);

  test('covers every editor in one section', () => {
    expect(prompt.match(/^## /gm)).toHaveLength(1);
    expect(prompt).toContain('## Editing Existing Office Files');
    expect(prompt).toContain('an existing `.docx`, `.xlsx` or `.pptx`');
    for (const editor of OFFICE_EDITORS) {
      for (const tool of editor.agent.tools) {
        expect(prompt).toContain(`\`${tool.name}\``);
      }
    }
  });

  test('keeps the rules that stop extra model requests after an edit', () => {
    expect(prompt).toContain('After a successful `word_edit`, `excel_edit` or `ppt_edit`, answer from its reply');
    expect(prompt).toContain('also when the user asks you to verify or check the change');
    expect(prompt).toContain('another read verifies nothing and costs a full extra model request');
    expect(prompt).toContain('do not check the file with shell commands before or after editing');
  });

  test('keeps what each format adds', () => {
    expect(prompt).toContain('use them instead of rewriting the file with scripts');
    expect(prompt).toContain('insert and delete rows and columns');
    expect(prompt).toContain('write speaker notes');
    expect(prompt).toContain('(`.xlsx`: building charts or pivot tables; `.pptx`: pictures, charts, new designs)');
    expect(prompt).toContain('reported as read-only or an edit is refused');
  });

  test('stays well under the three per-format sections it replaced', () => {
    // The three sections were 3,037 characters; this is part of every model request.
    expect(prompt.length).toBeLessThan(1900);
  });

  test('names a single editor without list punctuation', () => {
    const single = buildOfficeAgentPrompt([WORD_EDITOR]);

    expect(single).toContain('an existing `.docx` and');
    expect(single).toContain('After a successful `word_edit`, answer from its reply (the changed paragraphs as they now read');
    expect(single).toContain('cannot do, when the file is reported as read-only');
  });

  test('is empty when no editor has guidance', () => {
    const { guidance: _guidance, ...agent } = WORD_EDITOR.agent;

    expect(buildOfficeAgentPrompt([{ ...WORD_EDITOR, agent }])).toBe('');
    expect(buildOfficeAgentPrompt([])).toBe('');
  });
});
