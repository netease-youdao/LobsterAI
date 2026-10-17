export const DEFAULT_IM_EMPTY_REPLY = '处理完成，但没有生成回复。';

export const stripThinkingBlocks = (value: string): string => {
  return value
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();
};
