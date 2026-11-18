import { EmbeddingProvider } from '../../shared/cowork/embedding';

/** Embedding providers LobsterAI configures as OpenClaw remote memory search. */
export type OpenClawRemoteEmbeddingProvider = Exclude<EmbeddingProvider, typeof EmbeddingProvider.Local>;

/**
 * The bundled OpenClaw plugin that registers each remote embedding provider
 * (`contracts.embeddingProviders` in the plugin manifest). OpenClaw treats a
 * non-empty `plugins.allow` as strict, so unless this plugin is allowed the
 * provider never exists and memory search quietly drops to keyword results.
 *
 * openai, google and ollama ship in the runtime's dist/extensions, so
 * scripts/prune-openclaw-runtime.cjs must keep them. OpenClaw v2026.8.1
 * publishes voyage and mistral as separate npm plugins that LobsterAI does not
 * ship yet; config sync warns when one of them is selected.
 */
export const OpenClawEmbeddingPluginId: Readonly<Record<OpenClawRemoteEmbeddingProvider, string>> = {
  [EmbeddingProvider.OpenAI]: 'openai',
  [EmbeddingProvider.Gemini]: 'google',
  [EmbeddingProvider.Voyage]: 'voyage',
  [EmbeddingProvider.Mistral]: 'mistral',
  [EmbeddingProvider.Ollama]: 'ollama',
};

/** Unknown and local providers fall back to OpenAI, as memory search always has. */
export function resolveOpenClawEmbeddingProvider(provider: string): OpenClawRemoteEmbeddingProvider {
  return Object.prototype.hasOwnProperty.call(OpenClawEmbeddingPluginId, provider)
    ? provider as OpenClawRemoteEmbeddingProvider
    : EmbeddingProvider.OpenAI;
}
