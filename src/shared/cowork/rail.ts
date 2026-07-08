export interface CoworkMessageRailIndexItem {
  messageId: string;
  type: 'user' | 'assistant';
  sequence: number | null;
  messageOffset: number;
  timestamp: number;
  preview: string;
  contentLen: number;
}

export const COWORK_RAIL_PREVIEW_MAX_LENGTH = 50;
export const COWORK_RAIL_TOOLTIP_PREVIEW_MAX_LENGTH = 180;

const COWORK_RAIL_PROPOSED_PLAN_TAG_PATTERN = /<\/?proposed_?plan\b[^>]*>/gi;
const COWORK_RAIL_INCOMPLETE_PROPOSED_PLAN_TAG_PATTERN = /<\/?proposed_?plan\b\s*/gi;
const COWORK_RAIL_LEADING_PLAN_SECTION_LABEL_PATTERN =
  /^(?:#{1,6}\s*)?(?:Summary|Implementation Approach|Key Changes|Validation|Assumptions or Questions)(?:\s*[:：]|\s+|(?=为))\s*/i;

export const stripCoworkRailPreviewMarkdown = (value: string): string => value
  .replace(COWORK_RAIL_PROPOSED_PLAN_TAG_PATTERN, ' ')
  .replace(COWORK_RAIL_INCOMPLETE_PROPOSED_PLAN_TAG_PATTERN, ' ')
  .replace(/^#+\s+/gm, '')
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/`[^`]*`/g, ' ')
  .replace(/[*_~>]/g, '')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(COWORK_RAIL_LEADING_PLAN_SECTION_LABEL_PATTERN, '')
  .trim();

export const getCoworkRailPreview = (
  content: string,
  fallback: string,
  maxLength = COWORK_RAIL_PREVIEW_MAX_LENGTH,
): string => {
  const stripped = stripCoworkRailPreviewMarkdown(content);
  return stripped.slice(0, maxLength) || fallback;
};
