export const PLAN_MODE_PROMPT_MARKER = '# Plan Mode';
export const PLAN_MODE_EXECUTION_OVERRIDE_MARKER = '# Plan Mode Execution Override';

export const containsPlanModePrompt = (systemPrompt?: string): boolean =>
  Boolean(systemPrompt && /(?:^|\n)# Plan Mode(?:\r?\n|$)/.test(systemPrompt));

export const isPlanImplementationApproval = (prompt: string): boolean => {
  const normalized = prompt.trim().replace(/\s+/g, ' ');
  if (!normalized) return false;

  const chinesePatterns = [
    /(?:按照|按|依照|根据)(?:这个|该|上述|上面|前面|之前|刚才|刚才的|已有|已定)?计划(?:来)?(?:实现|执行|开发|编码|落地|开始|做)/,
    /(?:开始|直接|立即|继续)(?:按计划)?(?:实现|执行|开发|编码|落地)/,
    /(?:实现|执行|落实|落地)(?:这个|该|上述|上面|前面|之前|已有|已定)?计划/,
    /计划(?:没问题|可以|通过|确认|批准).*(?:实现|执行|开始|开发|编码|落地|做)/,
  ];
  const englishPatterns = [
    /\b(?:implement|execute|build|apply)\s+(?:the\s+|this\s+|that\s+|approved\s+|above\s+)?plan\b/i,
    /^\s*(?:please\s+)?(?:implement|execute|build)\s+it\b/i,
    /\b(?:start|begin|proceed with|go ahead with)\s+(?:the\s+)?implementation\b/i,
    /\bgo ahead(?:\s+and)?\s+(?:implement|build|execute)\b/i,
  ];
  return [...chinesePatterns, ...englishPatterns].some((pattern) => pattern.test(normalized));
};
