import { ProviderName } from '@shared/providers';
import React from 'react';

import {
  AnthropicIcon,
  BananaIcon,
  CustomProviderIcon,
  DeepSeekIcon,
  DoubaoIcon,
  GeminiIcon,
  GitHubCopilotIcon,
  HappyHorseIcon,
  KlingIcon,
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
  XaiIcon,
  XiaomiIcon,
  YouDaoZhiYunIcon,
  ZhipuIcon,
} from '../components/icons/providers';

export const ProviderIconId = {
  Banana: 'banana',
  Doubao: 'doubao',
  HappyHorse: 'happyhorse',
  Kling: 'kling',
} as const;
export type ProviderIconId = typeof ProviderIconId[keyof typeof ProviderIconId];

const PROVIDER_ICON_MAP: Record<string, React.ReactNode> = {
  [ProviderName.OpenAI]:       <OpenAIIcon />,
  [ProviderName.DeepSeek]:     <DeepSeekIcon />,
  [ProviderIconId.Banana]:     <BananaIcon />,
  [ProviderIconId.Doubao]:     <DoubaoIcon />,
  [ProviderIconId.HappyHorse]: <HappyHorseIcon />,
  [ProviderIconId.Kling]:      <KlingIcon />,
  [ProviderName.Gemini]:       <GeminiIcon />,
  [ProviderName.Xai]:          <XaiIcon />,
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
