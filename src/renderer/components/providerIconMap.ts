import React from 'react';

import {
  OpenAIIcon,
  DeepSeekIcon,
  GeminiIcon,
  AnthropicIcon,
  MoonshotIcon,
  ZhipuIcon,
  MiniMaxIcon,
  YouDaoZhiYunIcon,
  QwenIcon,
  XiaomiIcon,
  StepfunIcon,
  OpenRouterIcon,
  OllamaIcon,
  VolcengineIcon,
  GitHubCopilotIcon,
  CustomProviderIcon,
  DefaultProviderIcon,
} from './icons/providers';

/**
 * Maps provider keys to their icon components.
 * Used by ModelSelector, Settings, and other UI that needs provider branding.
 */
const providerIconMap: Record<string, React.FC<{ className?: string }>> = {
  openai: OpenAIIcon,
  deepseek: DeepSeekIcon,
  gemini: GeminiIcon,
  anthropic: AnthropicIcon,
  moonshot: MoonshotIcon,
  zhipu: ZhipuIcon,
  minimax: MiniMaxIcon,
  youdaozhiyun: YouDaoZhiYunIcon,
  qwen: QwenIcon,
  xiaomi: XiaomiIcon,
  stepfun: StepfunIcon,
  volcengine: VolcengineIcon,
  openrouter: OpenRouterIcon,
  'github-copilot': GitHubCopilotIcon,
  ollama: OllamaIcon,
};

// Add custom_0 through custom_9
for (let i = 0; i <= 9; i++) {
  providerIconMap[`custom_${i}`] = CustomProviderIcon;
}

/**
 * Returns the icon component for a given provider key.
 * Falls back to DefaultProviderIcon if no specific icon is found.
 */
export function getProviderIcon(providerKey?: string): React.FC<{ className?: string }> {
  if (!providerKey) return DefaultProviderIcon;
  return providerIconMap[providerKey] ?? DefaultProviderIcon;
}

export { DefaultProviderIcon };
export default providerIconMap;
