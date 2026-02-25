export type AnthropicApiFormat = 'anthropic' | 'openai';

export type OpenAIStreamChunk = {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        extra_content?: unknown;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

function toObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toOptionalObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value ?? '');
  } catch {
    return '';
  }
}

export function normalizeProviderApiFormat(format: unknown): AnthropicApiFormat {
  if (format === 'openai') {
    return 'openai';
  }
  return 'anthropic';
}

export function mapStopReason(finishReason?: string | null): string | null {
  if (!finishReason) {
    return null;
  }
  if (finishReason === 'tool_calls') {
    return 'tool_use';
  }
  if (finishReason === 'stop') {
    return 'end_turn';
  }
  if (finishReason === 'length') {
    return 'max_tokens';
  }
  return finishReason;
}

export function formatSSEEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function cleanSchema(schema: unknown): unknown {
  const obj = toObject(schema);
  const output: Record<string, unknown> = { ...obj };

  if (output.format === 'uri') {
    delete output.format;
  }

  const properties = toObject(output.properties);
  if (Object.keys(properties).length > 0) {
    const nextProperties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      nextProperties[key] = cleanSchema(value);
    }
    output.properties = nextProperties;
  }

  if (output.items !== undefined) {
    output.items = cleanSchema(output.items);
  }

  return output;
}

function convertMessageToOpenAI(role: string, content: unknown): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  if (typeof content === 'string') {
    result.push({ role, content });
    return result;
  }

  const blocks = toArray(content);
  if (blocks.length === 0) {
    result.push({ role, content: null });
    return result;
  }

  const contentParts: Array<Record<string, unknown>> = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  const thinkingParts: string[] = [];

  for (const block of blocks) {
    const blockObj = toObject(block);
    const blockType = toString(blockObj.type);

    if (blockType === 'text') {
      const text = toString(blockObj.text);
      if (text) {
        contentParts.push({ type: 'text', text });
      }
      continue;
    }

    if (blockType === 'image') {
      const source = toObject(blockObj.source);
      const mediaType = toString(source.media_type) || 'image/png';
      const data = toString(source.data);
      if (data) {
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:${mediaType};base64,${data}`,
          },
        });
      }
      continue;
    }

    if (blockType === 'tool_use') {
      const id = toString(blockObj.id);
      const name = toString(blockObj.name);
      const input = blockObj.input ?? {};
      const toolCall: Record<string, unknown> = {
        id,
        type: 'function',
        function: {
          name,
          arguments: stringifyUnknown(input),
        },
      };

      let extraContent: unknown = blockObj.extra_content;
      if (extraContent === undefined) {
        const thoughtSignature = toString(blockObj.thought_signature);
        if (thoughtSignature) {
          extraContent = {
            google: {
              thought_signature: thoughtSignature,
            },
          };
        }
      }

      if (extraContent !== undefined) {
        toolCall.extra_content = extraContent;
      }

      toolCalls.push(toolCall);
      continue;
    }

    if (blockType === 'tool_result') {
      const toolCallId = toString(blockObj.tool_use_id);
      const toolContent = stringifyUnknown(blockObj.content);
      result.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: toolContent,
      });
      continue;
    }

    if (blockType === 'thinking') {
      const thinking = toString(blockObj.thinking) || toString(blockObj.text);
      if (thinking) {
        thinkingParts.push(thinking);
      }
      continue;
    }
  }

  const mergedThinking = thinkingParts.join('');
  if (contentParts.length > 0 || toolCalls.length > 0 || (role === 'assistant' && mergedThinking)) {
    const nextMessage: Record<string, unknown> = { role };

    if (contentParts.length === 1 && contentParts[0].type === 'text') {
      nextMessage.content = contentParts[0].text;
    } else if (contentParts.length > 0) {
      nextMessage.content = contentParts;
    } else {
      nextMessage.content = null;
    }

    if (toolCalls.length > 0) {
      nextMessage.tool_calls = toolCalls;
    }

    if (role === 'assistant' && mergedThinking) {
      nextMessage.reasoning_content = mergedThinking;
    }

    result.push(nextMessage);
  }

  return result;
}

export function anthropicToOpenAI(body: unknown): Record<string, unknown> {
  const source = toObject(body);
  const output: Record<string, unknown> = {};

  if (source.model !== undefined) {
    output.model = source.model;
  }

  const messages: Array<Record<string, unknown>> = [];

  const system = source.system;
  if (typeof system === 'string' && system) {
    messages.push({ role: 'system', content: system });
  } else if (Array.isArray(system)) {
    for (const item of system) {
      const itemObj = toObject(item);
      const text = toString(itemObj.text);
      if (text) {
        messages.push({ role: 'system', content: text });
      }
    }
  }

  const sourceMessages = toArray(source.messages);
  for (const item of sourceMessages) {
    const itemObj = toObject(item);
    const role = toString(itemObj.role) || 'user';
    const converted = convertMessageToOpenAI(role, itemObj.content);
    messages.push(...converted);
  }

  output.messages = messages;

  if (source.max_tokens !== undefined) {
    output.max_tokens = source.max_tokens;
  }
  if (source.temperature !== undefined) {
    output.temperature = source.temperature;
  }
  if (source.top_p !== undefined) {
    output.top_p = source.top_p;
  }
  if (source.stop_sequences !== undefined) {
    output.stop = source.stop_sequences;
  }
  if (source.stream !== undefined) {
    output.stream = source.stream;
  }

  const tools = toArray(source.tools)
    .filter((tool) => toString(toObject(tool).type) !== 'BatchTool')
    .map((tool) => {
      const toolObj = toObject(tool);
      return {
        type: 'function',
        function: {
          name: toString(toolObj.name),
          description: toolObj.description,
          parameters: cleanSchema(toolObj.input_schema ?? {}),
        },
      };
    });

  if (tools.length > 0) {
    output.tools = tools;
  }

  if (source.tool_choice !== undefined) {
    output.tool_choice = source.tool_choice;
  }

  return output;
}

export function openAIToAnthropic(body: unknown): Record<string, unknown> {
  const source = toObject(body);
  const choices = toArray(source.choices);
  const firstChoice = toObject(choices[0]);
  const message = toObject(firstChoice.message);

  const content: Array<Record<string, unknown>> = [];

  const reasoningContent = toString(message.reasoning_content) || toString(message.reasoning);
  if (reasoningContent) {
    content.push({ type: 'thinking', thinking: reasoningContent });
  }

  const textContent = message.content;
  if (typeof textContent === 'string' && textContent) {
    content.push({ type: 'text', text: textContent });
  } else if (Array.isArray(textContent)) {
    for (const part of textContent) {
      const partObj = toObject(part);
      if (partObj.type === 'text' && typeof partObj.text === 'string' && partObj.text) {
        content.push({ type: 'text', text: partObj.text });
      }
    }
  }

  const toolCalls = toArray(message.tool_calls);
  for (const toolCall of toolCalls) {
    const toolCallObj = toObject(toolCall);
    const functionObj = toObject(toolCallObj.function);
    const argsString = toString(functionObj.arguments) || '{}';
    let parsedArgs: unknown = {};
    try {
      parsedArgs = JSON.parse(argsString);
    } catch {
      parsedArgs = {};
    }

    const toolUseBlock: Record<string, unknown> = {
      type: 'tool_use',
      id: toString(toolCallObj.id),
      name: toString(functionObj.name),
      input: parsedArgs,
    };

    let extraContent: unknown = toolCallObj.extra_content;
    if (extraContent === undefined) {
      const functionObject = toOptionalObject(toolCallObj.function);
      if (functionObject?.extra_content !== undefined) {
        extraContent = functionObject.extra_content;
      } else {
        const thoughtSignature = toString(functionObject?.thought_signature);
        if (thoughtSignature) {
          extraContent = {
            google: {
              thought_signature: thoughtSignature,
            },
          };
        }
      }
    }

    if (extraContent !== undefined) {
      toolUseBlock.extra_content = extraContent;
    }

    content.push(toolUseBlock);
  }

  const usage = toObject(source.usage);

  return {
    id: toString(source.id),
    type: 'message',
    role: 'assistant',
    content,
    model: toString(source.model),
    stop_reason: mapStopReason(
      typeof firstChoice.finish_reason === 'string' ? firstChoice.finish_reason : null
    ),
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens) || 0,
      output_tokens: Number(usage.completion_tokens) || 0,
    },
  };
}

export function buildOpenAIChatCompletionsURL(baseURL: string): string {
  const normalized = baseURL.trim().replace(/\/+$/, '');
  if (!normalized) {
    return '/v1/chat/completions';
  }
  if (normalized.endsWith('/chat/completions')) {
    return normalized;
  }

  if (normalized.includes('generativelanguage.googleapis.com')) {
    if (normalized.endsWith('/v1beta/openai') || normalized.endsWith('/v1/openai')) {
      return `${normalized}/chat/completions`;
    }
    if (normalized.endsWith('/v1beta') || normalized.endsWith('/v1')) {
      const betaBase = normalized.endsWith('/v1')
        ? `${normalized.slice(0, -3)}v1beta`
        : normalized;
      return `${betaBase}/openai/chat/completions`;
    }
    return `${normalized}/v1beta/openai/chat/completions`;
  }

  // Handle /v1, /v4 etc. versioned paths
  if (/\/v\d+$/.test(normalized)) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
}
