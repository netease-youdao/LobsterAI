export interface SseEvent {
  event?: string;
  data: string;
}

/** Splits complete server-sent events off a text buffer and returns the unfinished remainder. */
export function splitSseEvents(buffer: string): { events: SseEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n?/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: SseEvent[] = [];
  for (const block of blocks) {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length) events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}

export interface StreamChunk {
  text?: string;
  done?: boolean;
  error?: string;
}

/** Reads one Anthropic Messages streaming event. Thinking and tool deltas are ignored. */
export function readAnthropicStreamEvent(event: SseEvent): StreamChunk {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(event.data) as Record<string, unknown>;
  } catch {
    return {};
  }
  const type = payload.type ?? event.event;
  if (type === 'content_block_delta') {
    const delta = payload.delta as Record<string, unknown> | undefined;
    return delta?.type === 'text_delta' && typeof delta.text === 'string' ? { text: delta.text } : {};
  }
  if (type === 'message_stop') return { done: true };
  if (type === 'error') {
    const error = payload.error as Record<string, unknown> | undefined;
    return { error: typeof error?.message === 'string' ? error.message : 'stream error' };
  }
  return {};
}

/** Reads one Gemini `streamGenerateContent?alt=sse` event. */
export function readGeminiStreamEvent(event: SseEvent): StreamChunk {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(event.data) as Record<string, unknown>;
  } catch {
    return {};
  }
  const error = payload.error as Record<string, unknown> | undefined;
  if (error) return { error: typeof error.message === 'string' ? error.message : 'stream error' };
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const parts = ((candidates[0] as Record<string, unknown> | undefined)?.content as Record<string, unknown> | undefined)?.parts;
  if (!Array.isArray(parts)) return {};
  const text = parts
    .filter(part => part && typeof part === 'object' && !(part as Record<string, unknown>).thought)
    .map(part => (typeof (part as Record<string, unknown>).text === 'string' ? (part as Record<string, string>).text : ''))
    .join('');
  return text ? { text } : {};
}

const readErrorMessage = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const message = (value as Record<string, unknown>).message;
  return typeof message === 'string' && message ? message : undefined;
};

/** Reads one OpenAI Chat Completions streaming chunk. Reasoning and tool deltas are ignored. */
export function readOpenAIChatStreamEvent(event: SseEvent): StreamChunk {
  if (event.data.trim() === '[DONE]') return { done: true };
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(event.data) as Record<string, unknown>;
  } catch {
    return {};
  }
  if (payload.error) return { error: readErrorMessage(payload.error) ?? 'stream error' };
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const delta = (choices[0] as Record<string, unknown> | undefined)?.delta as Record<string, unknown> | undefined;
  return typeof delta?.content === 'string' && delta.content ? { text: delta.content } : {};
}

/** Reads one OpenAI Responses streaming event. Reasoning and tool events are ignored. */
export function readOpenAIResponsesStreamEvent(event: SseEvent): StreamChunk {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(event.data) as Record<string, unknown>;
  } catch {
    return {};
  }
  const type = payload.type ?? event.event;
  if (type === 'response.output_text.delta') {
    return typeof payload.delta === 'string' && payload.delta ? { text: payload.delta } : {};
  }
  if (type === 'response.completed' || type === 'response.incomplete') return { done: true };
  if (type === 'response.failed' || type === 'error') {
    const response = payload.response as Record<string, unknown> | undefined;
    return {
      error: readErrorMessage(response?.error) ?? readErrorMessage(payload.error) ?? readErrorMessage(payload) ?? 'stream error',
    };
  }
  return {};
}
