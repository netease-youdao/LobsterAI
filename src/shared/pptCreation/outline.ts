import { PLAN_MODE_PROMPT_MARKER } from '../cowork/planMode';
import { PptCreation } from './constants';

export const PPT_OUTLINE_PROMPT_MARKER = '# Presentation Outline';
export const PPT_OUTLINE_CONTENT_GUIDANCE = '包含演示目标、按页编号的逐页大纲（内容与依据）、模板/素材映射以及明确假设。';

export function isPptOutlineSystemPrompt(prompt: string): boolean {
  return prompt.split(/\r?\n/).includes(PPT_OUTLINE_PROMPT_MARKER);
}

export function shouldUsePptOutlinePrompt(selectedSkillIds: readonly string[], agentSkillIds: readonly string[], sessionPrompt = ''): boolean {
  return selectedSkillIds.includes(PptCreation.ActionId)
    || agentSkillIds.includes(PptCreation.ActionId)
    || isPptOutlineSystemPrompt(sessionPrompt);
}

/** Retains the existing planning flow while requesting presentation-specific output. */
export function buildPptOutlineSystemPrompt(): string {
  return [
    PLAN_MODE_PROMPT_MARKER,
    PPT_OUTLINE_PROMPT_MARKER,
    '本轮仅制作演示文稿大纲，不要输出软件开发实施方案。',
    '本轮为只读模式：仅用只读工具检视素材，严禁创建、修改、渲染、导出文件或调用变更工具；不要运行环境安装、依赖检查、转换脚本或 shell 解释器。',
    '文本/Markdown/CSV 直接用 read 读取，Office 文件使用只读工具查看；联网查证仅用 web_fetch 或只读浏览，为每项数据记录来源 URL、日期与口径。',
    '遵循给定的主题、受众、页数与模板；仅就关键缺失事实提问一次，绝不编造业务数据或经历，附件无法读取时明确指出缺失而非占位猜测。',
    `最终回复必须且仅包含一个使用用户语言的 <proposed_plan> 区块，${PPT_OUTLINE_CONTENT_GUIDANCE}`,
    '等待用户通过确认控件批准大纲后再生成 PPTX；对大纲提出调整意见不代表批准生成。',
  ].join('\n');
}
