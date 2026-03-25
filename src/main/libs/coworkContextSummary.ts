/**
 * Rule-based session summary generator for context management.
 *
 * Generates a structured summary of older conversation turns by extracting
 * key information: user request excerpts, assistant response excerpts,
 * tool names, and files modified.
 */

interface SummarizableMessage {
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
}

interface TurnSummary {
  turnNumber: number;
  userExcerpt: string;
  assistantExcerpt: string;
  toolNames: string[];
  filesModified: string[];
}

const USER_EXCERPT_MAX_CHARS = 200;
const ASSISTANT_EXCERPT_MAX_CHARS = 300;
const FILE_PATH_RE = /(?:^|\s)(?:Write|Edit|Create|Modify|Update|Delete|Remove|Move|Rename|MultiEdit|write_to_file|edit_file|replace_in_file)\b[^]*?(?:file|path|target|to)\s*[:=]?\s*["'`]?([^\s"'`\n,;]+\.[A-Za-z][A-Za-z0-9]{0,7})/gi;
const TOOL_NAME_RE = /^Tool:\s*(\w+)/m;

/**
 * Group messages into turns. Each turn starts with a user message.
 */
function groupMessagesIntoTurns(messages: SummarizableMessage[]): SummarizableMessage[][] {
  const turns: SummarizableMessage[][] = [];
  let currentTurn: SummarizableMessage[] = [];

  for (const msg of messages) {
    if (msg.type === 'user' && currentTurn.length > 0) {
      turns.push(currentTurn);
      currentTurn = [];
    }
    currentTurn.push(msg);
  }
  if (currentTurn.length > 0) {
    turns.push(currentTurn);
  }

  return turns;
}

/**
 * Extract file paths from tool_use and tool_result messages.
 */
function extractFilesModified(messages: SummarizableMessage[]): string[] {
  const files = new Set<string>();

  for (const msg of messages) {
    if (msg.type !== 'tool_use' && msg.type !== 'tool_result') continue;

    // Check metadata toolInput for file paths
    const toolInput = msg.metadata?.toolInput as Record<string, unknown> | undefined;
    if (toolInput) {
      for (const key of ['file_path', 'path', 'target_file', 'file', 'filename']) {
        const val = toolInput[key];
        if (typeof val === 'string' && val.includes('.')) {
          files.add(val);
        }
      }
    }

    // Regex fallback on content
    const matches = msg.content.matchAll(FILE_PATH_RE);
    for (const match of matches) {
      if (match[1]) files.add(match[1]);
    }
  }

  return [...files].slice(0, 10);
}

/**
 * Extract tool names from tool_use messages.
 */
function extractToolNames(messages: SummarizableMessage[]): string[] {
  const names = new Set<string>();

  for (const msg of messages) {
    if (msg.type === 'tool_use') {
      const toolName = msg.metadata?.toolName as string | undefined;
      if (toolName) {
        names.add(toolName);
        continue;
      }
      // Fallback: parse from content
      const match = msg.content.match(TOOL_NAME_RE);
      if (match?.[1]) names.add(match[1]);
    }
  }

  return [...names];
}

function truncate(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars)}...`;
}

/**
 * Summarize a single turn.
 */
function summarizeTurn(turnMessages: SummarizableMessage[], turnNumber: number): TurnSummary {
  const userMsg = turnMessages.find(m => m.type === 'user');
  const assistantMsgs = turnMessages.filter(m => m.type === 'assistant' && !m.metadata?.isThinking);
  const assistantText = assistantMsgs.map(m => m.content).join(' ');

  return {
    turnNumber,
    userExcerpt: userMsg ? truncate(userMsg.content, USER_EXCERPT_MAX_CHARS) : '',
    assistantExcerpt: truncate(assistantText, ASSISTANT_EXCERPT_MAX_CHARS),
    toolNames: extractToolNames(turnMessages),
    filesModified: extractFilesModified(turnMessages),
  };
}

/**
 * Generate a rule-based summary of conversation turns.
 *
 * @param messages All session messages
 * @param upToTurn Summarize turns 1 through this number (inclusive)
 * @param maxChars Maximum total summary characters
 */
/**
 * Generate an LLM-assisted summary by sending the rule-based summary
 * to an LLM for refinement and compression.
 */
export async function generateLlmSummary(
  messages: SummarizableMessage[],
  upToTurn: number,
  maxChars: number = 4000,
  apiConfig: { baseURL: string; apiKey: string; model: string }
): Promise<string | null> {
  // First generate the rule-based summary as input
  const ruleBasedSummary = generateRuleBasedSummary(messages, upToTurn, maxChars * 2);
  if (!ruleBasedSummary) return null;

  const normalizedBaseUrl = apiConfig.baseURL.replace(/\/+$/, '');
  const url = normalizedBaseUrl.endsWith('/v1/messages')
    ? normalizedBaseUrl
    : normalizedBaseUrl.endsWith('/v1')
      ? `${normalizedBaseUrl}/messages`
      : `${normalizedBaseUrl}/v1/messages`;

  const systemPrompt = [
    'You are a session summarizer. Given a per-turn activity log of an AI coding session,',
    'produce a concise narrative summary that captures: the overall goal, key decisions made,',
    'files modified, current state of work, and any unresolved issues.',
    'Keep the summary under 2000 characters. Use plain text, no markdown headers.',
    'Write in the same language as the user messages (Chinese or English).',
  ].join(' ');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiConfig.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: apiConfig.model,
        max_tokens: 1024,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Summarize this session activity log:\n\n${ruleBasedSummary}` }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn('[ContextSummary] LLM summary request failed with status', response.status);
      return null;
    }

    const payload = await response.json() as Record<string, unknown>;
    const content = payload.content;
    if (Array.isArray(content)) {
      const text = content
        .map((item: unknown) => {
          if (!item || typeof item !== 'object') return '';
          const block = item as Record<string, unknown>;
          return typeof block.text === 'string' ? block.text : '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
      return text.slice(0, maxChars) || null;
    }
    if (typeof content === 'string') {
      return content.trim().slice(0, maxChars) || null;
    }
    return null;
  } catch (error) {
    console.warn('[ContextSummary] LLM summary generation failed:', error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function generateRuleBasedSummary(
  messages: SummarizableMessage[],
  upToTurn: number,
  maxChars: number = 4000
): string {
  const allTurns = groupMessagesIntoTurns(messages);
  const turnsToSummarize = allTurns.slice(0, upToTurn);

  const summaries: TurnSummary[] = turnsToSummarize.map(
    (turnMsgs, idx) => summarizeTurn(turnMsgs, idx + 1)
  );

  const lines: string[] = [];
  let totalChars = 0;

  for (const s of summaries) {
    const parts: string[] = [];

    if (s.userExcerpt) {
      parts.push(`Turn ${s.turnNumber}: ${s.userExcerpt}`);
    } else {
      parts.push(`Turn ${s.turnNumber}: (no user message)`);
    }

    if (s.filesModified.length > 0) {
      parts.push(`  → Modified: ${s.filesModified.join(', ')}`);
    }

    if (s.toolNames.length > 0) {
      parts.push(`  → Tools: ${s.toolNames.join(', ')}`);
    }

    if (s.assistantExcerpt) {
      parts.push(`  → Outcome: ${s.assistantExcerpt}`);
    }

    const block = parts.join('\n');

    if (totalChars + block.length + 2 > maxChars) {
      lines.push(`... (${summaries.length - lines.length} more turns omitted)`);
      break;
    }

    lines.push(block);
    totalChars += block.length + 2; // +2 for \n\n
  }

  return lines.join('\n\n');
}
