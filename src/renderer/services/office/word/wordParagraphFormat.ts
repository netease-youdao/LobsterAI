import type { EditorCommand } from '@docx-editor.dev/core/contracts/editor';

export interface WordLineSpacingOption {
  readonly value: number;
  readonly labelKey: string;
}

/** Standard multiple line-spacing choices shown in the Word paragraph menu. */
export const WORD_LINE_SPACING_OPTIONS: readonly WordLineSpacingOption[] = [
  { value: 1, labelKey: 'wordLineSpacingSingle' },
  { value: 1.15, labelKey: 'wordLineSpacing115' },
  { value: 1.5, labelKey: 'wordLineSpacing15' },
  { value: 2, labelKey: 'wordLineSpacingDouble' },
];

/** Default paragraph space-after (in points) when turning paragraph spacing on. */
export const WORD_DEFAULT_SPACE_AFTER_PT = 8;

/** Fallback body font size in half-points (12pt 小四) when the selection reports none. */
const DEFAULT_HALF_POINTS = 24;
const TWIPS_PER_HALF_POINT_TWO_CHARS = 20;
const LINE_SPACING_TOLERANCE = 0.02;

export interface WordLineSpacingState {
  readonly rule: 'multiple' | 'exact' | 'atLeast';
  readonly value: number;
}

/** Whether the selection's current multiple line spacing matches a menu preset. */
export function isLineSpacingOptionActive(
  current: WordLineSpacingState | null | undefined,
  optionValue: number,
): boolean {
  if (!current || current.rule !== 'multiple') return false;
  return Math.abs(current.value - optionValue) <= LINE_SPACING_TOLERANCE;
}

/** Width of two full-width CJK characters in twips for the active font size. */
export function twoCharacterIndentTwips(fontSizeHalfPoints?: number | null): number {
  const halfPoints = typeof fontSizeHalfPoints === 'number' && Number.isFinite(fontSizeHalfPoints) && fontSizeHalfPoints > 0
    ? fontSizeHalfPoints
    : DEFAULT_HALF_POINTS;
  return Math.round(halfPoints * TWIPS_PER_HALF_POINT_TWO_CHARS);
}

/** Whether the active selection has a positive non-mixed first-line indent. */
export function hasFirstLineIndent(
  indent: { readonly firstLine: number; readonly mixed: { readonly firstLine: boolean } } | null | undefined,
): boolean {
  return Boolean(indent && !indent.mixed.firstLine && indent.firstLine > 0);
}

/** Whether the active selection has paragraph space after (> 0pt). */
export function hasParagraphSpaceAfter(spaceAfterPt: number | null | undefined): boolean {
  return typeof spaceAfterPt === 'number' && spaceAfterPt > 0;
}

export function buildLineSpacingCommand(multiple: number): EditorCommand {
  return {
    type: 'setParagraphFormat',
    lineSpacing: { rule: 'multiple', value: multiple },
  };
}

export function buildToggleSpaceAfterCommand(currentSpaceAfterPt: number | null | undefined): EditorCommand {
  return {
    type: 'setParagraphFormat',
    spaceAfterPt: hasParagraphSpaceAfter(currentSpaceAfterPt) ? 0 : WORD_DEFAULT_SPACE_AFTER_PT,
  };
}

export function buildToggleFirstLineIndentCommand(
  indent: { readonly firstLine: number; readonly mixed: { readonly firstLine: boolean } } | null | undefined,
  fontSizeHalfPoints?: number | null,
): EditorCommand {
  return {
    type: 'setParagraphFormat',
    indentFirstLineTwips: hasFirstLineIndent(indent) ? 0 : twoCharacterIndentTwips(fontSizeHalfPoints),
  };
}
