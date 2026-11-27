export const AGENT_ROUTING_DESCRIPTION_MAX_CHARS = 120;
export const AGENT_DESCRIPTION_MAX_CHARS = 140;

const MIN_PRIMARY_LINE_CHARS = 18;
const MIN_SENTENCE_BOUNDARY_CHARS = 24;

const GENERIC_HEADING_PATTERN = /^(?:角色|角色定位|角色与规则|角色设定|人设|定位|职责|规则|工作原则|输出风格|输出规范|行为准则|工作指南|指南|说明|系统提示词?|role|role\s*(?:&|and)\s*rules|identity|persona|purpose|responsibilities|instructions|guidelines|rules|system\s*prompt|overview)\s*[:：]?$/i;
const LEADING_ROLE_LABEL_PATTERN = /^(?:角色定位|角色设定|角色|定位|职责|目标|核心职责|主要职责|简介|描述|role|identity|persona|purpose|summary|description)\s*[:：]\s*/i;
const SUMMARY_PREFIX_PATTERN = /^(?:summary|description|brief\s+description|one[- ]line\s+summary|简介|简短描述|描述|摘要|总结)\s*[:：]\s*/i;
const CJK_CHAR_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export interface AgentRoutingDescriptionInput {
  description?: string | null;
  systemPrompt?: string | null;
  identity?: string | null;
  workingDirectory?: string | null;
}

function clampSingleLine(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function clampAtSentenceOrLimit(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  if (compact.length <= maxChars) return compact;

  const windowText = compact.slice(0, maxChars);
  const sentenceEndings = [
    windowText.lastIndexOf('。'),
    windowText.lastIndexOf('！'),
    windowText.lastIndexOf('？'),
    windowText.lastIndexOf('. '),
    windowText.lastIndexOf('! '),
    windowText.lastIndexOf('? '),
  ];
  const bestBoundary = Math.max(...sentenceEndings);
  if (bestBoundary >= MIN_SENTENCE_BOUNDARY_CHARS) {
    return windowText.slice(0, bestBoundary + 1).trim();
  }
  return `${compact.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function stripFrontmatter(raw: string): string {
  const normalized = raw.replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) return normalized;
  const endIndex = normalized.indexOf('\n---', 4);
  if (endIndex === -1) return normalized;
  return normalized.slice(endIndex + 4);
}

function cleanMarkdownLine(rawLine: string): string {
  let line = rawLine.trim();
  if (!line) return '';
  if (/^[-*_=\s]{3,}$/.test(line)) return '';
  line = line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s*/, '')
    .replace(/^(?:[-*+•]\s+|\d+[.)]\s+)/, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!line || GENERIC_HEADING_PATTERN.test(line)) return '';
  line = line.replace(LEADING_ROLE_LABEL_PATTERN, '').trim();
  return line;
}

function extractExcerptFromInstructions(raw: string | null | undefined, maxChars: number): string {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const withoutFrontmatter = stripFrontmatter(raw);
  const withoutCodeBlocks = withoutFrontmatter.replace(/```[\s\S]*?```/g, '\n');
  const lines = withoutCodeBlocks.split('\n');

  const meaningful: string[] = [];
  for (const rawLine of lines) {
    const cleaned = cleanMarkdownLine(rawLine);
    if (!cleaned) continue;
    meaningful.push(cleaned);
    if (meaningful.length >= 2) break;
  }

  if (meaningful.length === 0) return '';
  if (meaningful.length === 1 || meaningful[0].length >= MIN_PRIMARY_LINE_CHARS) {
    return clampAtSentenceOrLimit(meaningful[0], maxChars);
  }
  const separator = CJK_CHAR_PATTERN.test(meaningful[0]) ? '；' : '; ';
  return clampAtSentenceOrLimit(`${meaningful[0]}${separator}${meaningful[1]}`, maxChars);
}

function extractWorkspaceBasename(workingDirectory: string | null | undefined): string {
  if (typeof workingDirectory !== 'string') return '';
  const trimmed = workingDirectory.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1].trim() : '';
}

/**
 * Resolve a compact description suitable for multi-agent collaboration routing.
 * Prefers the explicit `description`; when blank, falls back cleanly to a
 * stripped excerpt of `systemPrompt` / `identity`, and finally the bound
 * working folder name.
 */
export function deriveAgentRoutingDescription(
  input: AgentRoutingDescriptionInput,
  maxChars: number = AGENT_ROUTING_DESCRIPTION_MAX_CHARS,
): string {
  const explicit = typeof input.description === 'string' ? clampSingleLine(input.description, maxChars) : '';
  if (explicit) return explicit;

  const fromSystemPrompt = extractExcerptFromInstructions(input.systemPrompt, maxChars);
  if (fromSystemPrompt) return fromSystemPrompt;

  const fromIdentity = extractExcerptFromInstructions(input.identity, maxChars);
  if (fromIdentity) return fromIdentity;

  const folderName = extractWorkspaceBasename(input.workingDirectory);
  if (folderName) {
    return clampSingleLine(`workspace: ${folderName}`, maxChars);
  }

  return '';
}

/**
 * Clean a one-line LLM-generated agent summary (removing code fences, labels,
 * surrounding quotes, and line breaks) and clamp it to the draft limit.
 */
export function normalizeAgentSummaryDescription(
  rawText: string,
  maxChars: number = AGENT_DESCRIPTION_MAX_CHARS,
): string {
  let text = rawText.replace(/\r\n?/g, '\n').trim();
  if (!text) return '';

  const fencedMatch = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fencedMatch) {
    text = fencedMatch[1].trim();
  }

  const firstNonEmptyLine = text
    .split('\n')
    .map(line => line.trim())
    .find(Boolean) ?? '';
  if (!firstNonEmptyLine) return '';

  let cleaned = firstNonEmptyLine
    .replace(/^(?:[-*+•]\s+|\d+[.)]\s+)/, '')
    .replace(SUMMARY_PREFIX_PATTERN, '')
    .trim();

  // Unwrap matching outer quotation marks if the model wrapped the summary.
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"'))
    || (cleaned.startsWith('\'') && cleaned.endsWith('\''))
    || (cleaned.startsWith('“') && cleaned.endsWith('”'))
    || (cleaned.startsWith('「') && cleaned.endsWith('」'))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars).trimEnd() : cleaned;
}
