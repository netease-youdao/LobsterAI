import { describe, expect, test } from 'vitest';

import {
  buildLineSpacingCommand,
  buildToggleFirstLineIndentCommand,
  buildToggleSpaceAfterCommand,
  hasFirstLineIndent,
  hasParagraphSpaceAfter,
  isLineSpacingOptionActive,
  twoCharacterIndentTwips,
  WORD_DEFAULT_SPACE_AFTER_PT,
} from './wordParagraphFormat';

describe('wordParagraphFormat helpers', () => {
  test('matches multiple line-spacing presets within OOXML 240th-line rounding tolerance', () => {
    expect(isLineSpacingOptionActive({ rule: 'multiple', value: 276 / 240 }, 1.15)).toBe(true);
    expect(isLineSpacingOptionActive({ rule: 'multiple', value: 1.5 }, 1.5)).toBe(true);
    expect(isLineSpacingOptionActive({ rule: 'multiple', value: 1.5 }, 1.15)).toBe(false);
    expect(isLineSpacingOptionActive({ rule: 'exact', value: 1.15 }, 1.15)).toBe(false);
    expect(isLineSpacingOptionActive(null, 1.15)).toBe(false);
  });

  test('computes two-character first-line indent in twips from active font size', () => {
    // 12pt (24 half-points) -> 24pt = 480 twips; 10.5pt (21 half-points) -> 21pt = 420 twips.
    expect(twoCharacterIndentTwips(24)).toBe(480);
    expect(twoCharacterIndentTwips(21)).toBe(420);
    expect(twoCharacterIndentTwips(undefined)).toBe(480);
    expect(twoCharacterIndentTwips(null)).toBe(480);
  });

  test('toggles paragraph space-after between 0 and default 8pt', () => {
    expect(hasParagraphSpaceAfter(8)).toBe(true);
    expect(hasParagraphSpaceAfter(0)).toBe(false);
    expect(hasParagraphSpaceAfter(null)).toBe(false);

    expect(buildToggleSpaceAfterCommand(8)).toEqual({ type: 'setParagraphFormat', spaceAfterPt: 0 });
    expect(buildToggleSpaceAfterCommand(0)).toEqual({ type: 'setParagraphFormat', spaceAfterPt: WORD_DEFAULT_SPACE_AFTER_PT });
    expect(buildToggleSpaceAfterCommand(null)).toEqual({ type: 'setParagraphFormat', spaceAfterPt: WORD_DEFAULT_SPACE_AFTER_PT });
  });

  test('toggles first-line indent off when active and to two characters when absent or mixed', () => {
    const indented = { firstLine: 480, mixed: { firstLine: false } };
    const none = { firstLine: 0, mixed: { firstLine: false } };
    const mixed = { firstLine: 480, mixed: { firstLine: true } };

    expect(hasFirstLineIndent(indented)).toBe(true);
    expect(hasFirstLineIndent(none)).toBe(false);
    expect(hasFirstLineIndent(mixed)).toBe(false);

    expect(buildToggleFirstLineIndentCommand(indented, 24)).toEqual({ type: 'setParagraphFormat', indentFirstLineTwips: 0 });
    expect(buildToggleFirstLineIndentCommand(none, 24)).toEqual({ type: 'setParagraphFormat', indentFirstLineTwips: 480 });
    expect(buildToggleFirstLineIndentCommand(mixed, 21)).toEqual({ type: 'setParagraphFormat', indentFirstLineTwips: 420 });
  });

  test('builds multiple line-spacing commands', () => {
    expect(buildLineSpacingCommand(1.15)).toEqual({
      type: 'setParagraphFormat',
      lineSpacing: { rule: 'multiple', value: 1.15 },
    });
  });
});
