const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
);

const collectTextChunks = (value: unknown): string[] => {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextChunks(item));
  }

  if (!isRecord(value)) {
    return [];
  }

  const chunks: string[] = [];
  if (typeof value.text === 'string') {
    const text = value.text.trim();
    if (text) {
      chunks.push(text);
    }
  }
  if (typeof value.output_text === 'string') {
    const text = value.output_text.trim();
    if (text) {
      chunks.push(text);
    }
  }

  if (value.content !== undefined) {
    chunks.push(...collectTextChunks(value.content));
  }
  if (value.parts !== undefined) {
    chunks.push(...collectTextChunks(value.parts));
  }
  if (value.candidates !== undefined) {
    chunks.push(...collectTextChunks(value.candidates));
  }
  if (value.response !== undefined) {
    chunks.push(...collectTextChunks(value.response));
  }

  return chunks;
};

export function extractOpenClawAssistantStreamText(payload: unknown): string {
  const chunks = collectTextChunks(payload);
  return chunks.join('\n').trim();
}
