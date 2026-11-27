import { CONTEXT_CLEANUP_DEFAULTS } from '../../shared/contextCleanup/constants';
import { DECISION_EVALUATE_TOOL_DESCRIPTOR } from '../libs/dsh/dshDecisionTool';
import { estimateMcpToolTokens } from '../mcp/mcpToolDiscovery';

const ASCII_CHARS_PER_TOKEN = 4;

/**
 * Approximate prompt token count for mixed ASCII / CJK text using the same
 * density heuristic as `estimateMcpToolTokens`.
 */
export function estimateTextTokensCjkAware(text: string): number {
  if (!text) return 0;
  let asciiChars = 0;
  let otherChars = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) asciiChars += 1;
    else otherChars += 1;
  }
  return Math.max(1, Math.ceil(asciiChars / ASCII_CHARS_PER_TOKEN + otherChars));
}

/**
 * Estimate per-turn prompt tokens consumed by one skill entry in DSH's
 * `<available_skills>` catalog (`- \`id\`: truncatedDescription\n`).
 */
export function estimateSkillCatalogTokens(
  id: string,
  description: string,
  maxDescChars: number = CONTEXT_CLEANUP_DEFAULTS.DefaultCatalogDescriptionMaxChars,
): number {
  const cleanId = id.trim();
  const cleanDesc = description.replace(/\s+/g, ' ').trim();
  const clipped = cleanDesc.length > maxDescChars
    ? `${cleanDesc.slice(0, Math.max(0, maxDescChars - 1))}…`
    : cleanDesc;
  const renderedLine = clipped ? `- \`${cleanId}\`: ${clipped}\n` : `- \`${cleanId}\`\n`;
  return estimateTextTokensCjkAware(renderedLine);
}

let cachedDecisionEvaluateTokens: number | null = null;

/** Estimate per-turn prompt tokens of the `decision_evaluate` tool descriptor. */
export function estimateDecisionEvaluateTokens(): number {
  if (cachedDecisionEvaluateTokens === null) {
    cachedDecisionEvaluateTokens = estimateMcpToolTokens(DECISION_EVALUATE_TOOL_DESCRIPTOR);
  }
  return cachedDecisionEvaluateTokens;
}

/**
 * Estimate per-turn tokens for an enabled MCP server from its discovered tools.
 * Falls back to `{ tokens: 0, unknown: true }` when no tool list is available.
 */
export function estimateMcpServerTokensFromTools(
  tools: ReadonlyArray<{ estimatedTokens?: number }> | undefined,
): { tokens: number; unknown: boolean } {
  if (!Array.isArray(tools) || tools.length === 0) {
    return { tokens: 0, unknown: true };
  }
  let total = 0;
  for (const tool of tools) {
    if (typeof tool.estimatedTokens === 'number' && Number.isFinite(tool.estimatedTokens) && tool.estimatedTokens > 0) {
      total += tool.estimatedTokens;
    }
  }
  return total > 0 ? { tokens: total, unknown: false } : { tokens: 0, unknown: true };
}
