import { describe, expect, test } from 'vitest';

import { getCoworkRailPreview, stripCoworkRailPreviewMarkdown } from './rail';

describe('cowork rail preview', () => {
  test('removes proposed plan tags from rail previews', () => {
    expect(stripCoworkRailPreviewMarkdown('<proposed_plan>Summary: Build the page.</proposed_plan>'))
      .toBe('Build the page.');
    expect(stripCoworkRailPreviewMarkdown('<proposedplan Summary 在下创建一个烘焙工作室网页。'))
      .toBe('在下创建一个烘焙工作室网页。');
  });

  test('keeps rail preview fallback when plan tags contain no visible text', () => {
    expect(getCoworkRailPreview('<proposed_plan></proposed_plan>', 'LobsterAI')).toBe('LobsterAI');
  });
});
