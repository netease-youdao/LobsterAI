import type { StreamFn } from 'openclaw/plugin-sdk/agent-core';

/**
 * Resolves the bundled default transport lazily, so importing this extension's
 * pure modules never evaluates the OpenClaw LLM runtime.
 */
export const loadDefaultStreamFn = async (): Promise<StreamFn> => {
  const { streamSimple } = await import('openclaw/plugin-sdk/llm');
  return streamSimple as StreamFn;
};
