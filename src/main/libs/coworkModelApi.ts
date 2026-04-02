export const CoworkModelProtocol = {
  Anthropic: 'anthropic',
  GeminiNative: 'gemini_native',
} as const;

export type CoworkModelProtocol = typeof CoworkModelProtocol[keyof typeof CoworkModelProtocol];

const API_ERROR_SNIPPET_MAX_CHARS = 240;

const toRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const collectTextFromUnknown = (value: unknown): string[] => {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextFromUnknown(item));
  }

  const record = toRecord(value);
  if (!record) {
    return [];
  }

  const directText = typeof record.text === 'string' ? record.text.trim() : '';
  const collected = directText ? [directText] : [];

  if (record.content !== undefined) {
    collected.push(...collectTextFromUnknown(record.content));
  }
  if (record.parts !== undefined) {
    collected.push(...collectTextFromUnknown(record.parts));
  }

  return collected;
};

export function buildAnthropicMessagesUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    return '/v1/messages';
  }
  if (normalized.endsWith('/v1/messages')) {
    return normalized;
  }
  if (normalized.endsWith('/v1')) {
    return `${normalized}/messages`;
  }
  return `${normalized}/v1/messages`;
}

export function normalizeGeminiBaseUrl(rawBaseUrl: string): string {
  const normalized = rawBaseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    return 'https://generativelanguage.googleapis.com/v1beta';
  }
  if (!normalized.includes('generativelanguage.googleapis.com')) {
    return normalized;
  }
  if (normalized.endsWith('/v1beta/openai')) {
    return normalized.slice(0, -'/openai'.length);
  }
  if (normalized.endsWith('/v1/openai')) {
    return normalized.slice(0, -'/openai'.length);
  }
  if (normalized.endsWith('/v1beta')) {
    return normalized;
  }
  if (normalized.endsWith('/v1')) {
    return `${normalized.slice(0, -3)}/v1beta`;
  }
  return 'https://generativelanguage.googleapis.com/v1beta';
}

export function buildGeminiGenerateContentUrl(baseUrl: string, model: string): string {
  const normalizedBaseUrl = normalizeGeminiBaseUrl(baseUrl);
  const encodedModel = encodeURIComponent(model.trim());
  return `${normalizedBaseUrl}/models/${encodedModel}:generateContent`;
}

export function extractApiErrorSnippet(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const payload = JSON.parse(trimmed) as Record<string, unknown>;
    const payloadError = payload.error;
    if (typeof payloadError === 'string' && payloadError.trim()) {
      return payloadError.trim().slice(0, API_ERROR_SNIPPET_MAX_CHARS);
    }
    if (payloadError && typeof payloadError === 'object') {
      const message = (payloadError as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim()) {
        return message.trim().slice(0, API_ERROR_SNIPPET_MAX_CHARS);
      }
    }
    const payloadMessage = payload.message;
    if (typeof payloadMessage === 'string' && payloadMessage.trim()) {
      return payloadMessage.trim().slice(0, API_ERROR_SNIPPET_MAX_CHARS);
    }
  } catch {
    // Fall through to plain-text extraction when response is not JSON.
  }

  return trimmed.replace(/\s+/g, ' ').slice(0, API_ERROR_SNIPPET_MAX_CHARS);
}

export function extractTextFromAnthropicResponse(payload: unknown): string {
  const record = toRecord(payload);
  if (!record) return '';

  const content = record.content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const block = toRecord(item);
        return typeof block?.text === 'string' ? block.text : '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof content === 'string') {
    return content.trim();
  }
  if (typeof record.output_text === 'string') {
    return record.output_text.trim();
  }
  return '';
}

export function extractTextFromGeminiResponse(payload: unknown): string {
  const record = toRecord(payload);
  if (!record) {
    return '';
  }

  const directTexts = [
    ...collectTextFromUnknown(record.candidates),
    ...collectTextFromUnknown(record.content),
  ];
  if (directTexts.length > 0) {
    return directTexts.join('\n').trim();
  }

  if (typeof record.text === 'string') {
    return record.text.trim();
  }

  return '';
}
