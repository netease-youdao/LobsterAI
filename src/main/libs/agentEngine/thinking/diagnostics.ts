/** Diagnostic summaries intentionally exclude thinking text. */
const THINKING_DIAGNOSTICS_ENABLED = process.env.LOBSTERAI_THINKING_DIAGNOSTICS === '1';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
);

export const logThinkingDiagnostic = (...parts: unknown[]): void => {
  if (!THINKING_DIAGNOSTICS_ENABLED) return;
  console.debug('[ThinkingDiag]', ...parts);
};

export const summarizeThinkingMessageForDiagnostics = (message: unknown): string => {
  if (!isRecord(message)) return `message=${typeof message}`;

  const role = typeof message.role === 'string' ? message.role : '?';
  const messageId = typeof message.id === 'string' ? message.id.slice(-12) : '-';
  const content = Array.isArray(message.content) ? message.content : [];
  const thinkingChars: number[] = [];
  const textChars: number[] = [];
  let toolCallCount = 0;

  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      thinkingChars.push(block.thinking.length);
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      textChars.push(block.text.length);
    }
    if (block.type === 'toolCall' || block.type === 'tool_use' || block.type === 'tool_call') {
      toolCallCount += 1;
    }
  }

  return [
    `role=${role}`,
    `id=${messageId}`,
    `thinkingBlocks=[${thinkingChars.join(',')}]`,
    `textBlocks=[${textChars.join(',')}]`,
    `toolCalls=${toolCallCount}`,
  ].join(' ');
};

export const summarizeAgentEventForThinkingDiagnostics = (
  payload: unknown,
  frameSeq?: number,
): string | null => {
  if (!isRecord(payload)) return null;
  const stream = typeof payload.stream === 'string' ? payload.stream.trim() : '';
  if (!['assistant', 'thinking', 'tool', 'tools', 'lifecycle'].includes(stream)) return null;

  const data = isRecord(payload.data) ? payload.data : null;
  const runId = typeof payload.runId === 'string' ? payload.runId.slice(-12) : '-';
  const payloadSeq = typeof payload.seq === 'number' ? payload.seq : undefined;
  const textChars = data && typeof data.text === 'string' ? data.text.length : 0;
  const deltaChars = data && typeof data.delta === 'string' ? data.delta.length : 0;
  const phase = data && typeof data.phase === 'string' ? data.phase : '-';
  const replace = data?.replace === true;
  const toolCallId = data && typeof data.toolCallId === 'string'
    ? data.toolCallId.slice(-12)
    : '-';
  const embeddedMessage = data?.message ?? payload.message;

  return [
    `agent stream=${stream || '-'}`,
    `frameSeq=${frameSeq ?? '-'}`,
    `payloadSeq=${payloadSeq ?? '-'}`,
    `run=${runId}`,
    `phase=${phase}`,
    `textChars=${textChars}`,
    `deltaChars=${deltaChars}`,
    `replace=${replace}`,
    `toolCall=${toolCallId}`,
    embeddedMessage !== undefined
      ? summarizeThinkingMessageForDiagnostics(embeddedMessage)
      : `dataKeys=[${data ? Object.keys(data).join(',') : ''}]`,
  ].join(' ');
};

export const summarizeCurrentTurnThinkingHistoryForDiagnostics = (messages: unknown[]): string => {
  let lastUserIdx = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && message.role === 'user') {
      lastUserIdx = index;
      break;
    }
  }

  return messages
    .slice(lastUserIdx + 1)
    .map((message, relativeIndex) => ({ message, relativeIndex }))
    .filter(({ message }) => isRecord(message) && message.role === 'assistant')
    .slice(-40)
    .map(({ message, relativeIndex }) => (
      `assistant[${relativeIndex}] ${summarizeThinkingMessageForDiagnostics(message)}`
    ))
    .join(' | ');
};
