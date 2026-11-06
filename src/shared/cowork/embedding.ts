/** Memory embedding providers accepted in the cowork config. */
export const EmbeddingProvider = {
  Local: 'local',
  OpenAI: 'openai',
  Gemini: 'gemini',
  Voyage: 'voyage',
  Mistral: 'mistral',
  Ollama: 'ollama',
} as const;
export type EmbeddingProvider = typeof EmbeddingProvider[keyof typeof EmbeddingProvider];

export const EMBEDDING_PROVIDERS: readonly EmbeddingProvider[] = Object.values(EmbeddingProvider);

export function isEmbeddingProvider(value: unknown): value is EmbeddingProvider {
  return typeof value === 'string' && (EMBEDDING_PROVIDERS as readonly string[]).includes(value);
}
