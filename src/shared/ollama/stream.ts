import type { OllamaChatChunk, OllamaToolCall } from './types';

export type OllamaStreamPhase = 'waiting' | 'thinking' | 'responding' | 'done' | 'error';

export type OllamaStreamState = {
  rawContent: string;
  officialThinking: string;
  thinking: string;
  content: string;
  toolCalls: OllamaToolCall[];
  done: boolean;
  phase: OllamaStreamPhase;
  finalChunk: OllamaChatChunk | null;
  error: string | null;
};

export function createOllamaStreamState(): OllamaStreamState {
  return {
    rawContent: '',
    officialThinking: '',
    thinking: '',
    content: '',
    toolCalls: [],
    done: false,
    phase: 'waiting',
    finalChunk: null,
    error: null,
  };
}

export function reduceOllamaStreamChunk(
  state: OllamaStreamState,
  chunk: OllamaChatChunk,
): OllamaStreamState {
  if (chunk.error) {
    return {
      ...state,
      done: true,
      phase: 'error',
      finalChunk: chunk,
      error: chunk.error,
    };
  }

  const message = chunk.message;
  const thinkingDelta = readStringField(message, 'thinking')
    || readStringField(message, 'reasoning_content');
  const contentDelta = typeof message?.content === 'string' ? message.content : '';
  const rawContent = state.rawContent + contentDelta;
  const officialThinking = state.officialThinking + thinkingDelta;
  const legacySplit = splitThinkMarkup(rawContent);
  const thinking = joinThinking(officialThinking, legacySplit.thinking);
  const content = legacySplit.content;
  const toolCalls = Array.isArray(message?.tool_calls)
    ? [...state.toolCalls, ...message.tool_calls]
    : state.toolCalls;

  let phase: OllamaStreamPhase = state.phase;
  if (content) {
    phase = 'responding';
  } else if (thinking) {
    phase = 'thinking';
  } else if (phase === 'done' || phase === 'error') {
    phase = 'waiting';
  }
  if (chunk.done) {
    phase = 'done';
  }

  return {
    rawContent,
    officialThinking,
    thinking,
    content,
    toolCalls,
    done: Boolean(chunk.done),
    phase,
    finalChunk: chunk.done ? chunk : state.finalChunk,
    error: null,
  };
}

export function splitThinkMarkup(value: string): { thinking: string; content: string } {
  const tagPattern = /<\/?think>/gi;
  let thinking = '';
  let content = '';
  let cursor = 0;
  let inThinking = false;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(value)) !== null) {
    const segment = value.slice(cursor, match.index);
    if (inThinking) {
      thinking += segment;
    } else {
      content += segment;
    }
    inThinking = match[0].toLowerCase() === '<think>';
    cursor = tagPattern.lastIndex;
  }

  const tail = value.slice(cursor);
  if (inThinking) {
    thinking += tail;
  } else {
    content += tail;
  }

  return { thinking, content };
}

function readStringField(message: unknown, key: string): string {
  if (!message || typeof message !== 'object') return '';
  const value = (message as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function joinThinking(officialThinking: string, legacyThinking: string): string {
  if (!officialThinking) return legacyThinking;
  if (!legacyThinking) return officialThinking;
  return `${officialThinking}\n${legacyThinking}`;
}
