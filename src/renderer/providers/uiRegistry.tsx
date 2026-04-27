import { ProviderName } from '@shared/providers';
import React from 'react';

import {
  AnthropicIcon,
  CustomProviderIcon,
  DeepSeekIcon,
  GeminiIcon,
  GitHubCopilotIcon,
  LmStudioIcon,
  MiniMaxIcon,
  MoonshotIcon,
  OllamaIcon,
  OpenAIIcon,
  OpenRouterIcon,
  QianfanIcon,
  QwenIcon,
  StepfunIcon,
  VolcengineIcon,
  XiaomiIcon,
  YouDaoZhiYunIcon,
  ZhipuIcon,
} from '../components/icons/providers';

const PROVIDER_ICON_MAP: Record<string, React.ReactNode> = {
  [ProviderName.OpenAI]:       <OpenAIIcon />,
  [ProviderName.DeepSeek]:     <DeepSeekIcon />,
  [ProviderName.Gemini]:       <GeminiIcon />,
  [ProviderName.Anthropic]:    <AnthropicIcon />,
  [ProviderName.Moonshot]:     <MoonshotIcon />,
  [ProviderName.Zhipu]:        <ZhipuIcon />,
  [ProviderName.Minimax]:      <MiniMaxIcon />,
  [ProviderName.Youdaozhiyun]: <YouDaoZhiYunIcon />,
  [ProviderName.Qwen]:         <QwenIcon />,
  [ProviderName.Xiaomi]:       <XiaomiIcon />,
  [ProviderName.StepFun]:      <StepfunIcon />,
  [ProviderName.Volcengine]:   <VolcengineIcon />,
  [ProviderName.OpenRouter]:   <OpenRouterIcon />,
  [ProviderName.Copilot]:      <GitHubCopilotIcon />,
  [ProviderName.Ollama]:       <OllamaIcon />,
  [ProviderName.LmStudio]:     <LmStudioIcon />,
  [ProviderName.Qianfan]:      <QianfanIcon />,
};

export function getProviderIcon(id: string): React.ReactNode {
  return PROVIDER_ICON_MAP[id] ?? <CustomProviderIcon />;
}
