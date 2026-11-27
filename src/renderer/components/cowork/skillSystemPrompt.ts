import { PLAN_MODE_PROMPT_MARKER } from '../../../shared/cowork/planMode';

const normalizePromptPart = (value?: string): string => value?.trim() ?? '';

export const buildPlanModeSystemPrompt = (): string => [
  PLAN_MODE_PROMPT_MARKER,
  '',
  '本轮已开启规划模式（Plan Mode）。先与用户产出决策完备的实施方案，待确认后再编码实施。',
  '',
  '规则：',
  '- 规划模式优先级高于已选技能及用户“实现/开发/修复/生成”等措辞；若技能要求直接写代码，本轮仅作规划参考。',
  '- 优先用只读工具调研本地环境与源码；仅针对无法从项目推导的产品或实现决策向用户提问。',
  '- 严禁编辑或写入文件、执行修改工作区的命令、格式化/打补丁或调用任何变更类工具（write、edit、apply_patch 等）；允许只读检索与非破坏性检查。',
  '- 方案就绪后，将完整方案包裹在 `<proposed_plan>` 与 `</proposed_plan>` 中作为最终回复，不要只输出一句引导语。',
  '- 使用与用户请求相同的语言，简洁完整（通常 8-16 条要点或短段），包含：概述、实现方案、核心改动、验证方式、假设与待确认问题；涉及 UI 时补充布局、视觉方向、响应式与交互状态。',
].join('\n');

export const buildCoworkSystemPrompt = (
  skillPrompt?: string,
  baseSystemPrompt?: string,
): string | undefined => {
  const combined = [
    normalizePromptPart(skillPrompt),
    normalizePromptPart(baseSystemPrompt),
  ]
    .filter(Boolean)
    .join('\n\n');

  return combined || undefined;
};

export const buildCoworkContinuationSystemPrompt = (
  skillPrompt?: string,
  baseSystemPrompt?: string,
): string | undefined => {
  if (!normalizePromptPart(skillPrompt)) {
    return undefined;
  }

  return buildCoworkSystemPrompt(skillPrompt, baseSystemPrompt);
};
