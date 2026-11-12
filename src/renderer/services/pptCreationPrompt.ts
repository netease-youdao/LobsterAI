import { type PptExample, PptWorkflow } from '../../shared/pptCreation/constants';
import type { LanguageType } from './i18n';

export interface PptPromptOptions {
  language: LanguageType; useDemo: boolean; topic: string; audience: string; slideCount: number;
  workflow: PptWorkflow; templateName?: string; sourceDeck?: boolean;
}

export function buildPptDirectPrompt(prompt: string, language: LanguageType, templateName?: string): string {
  const zh = language === 'zh';
  const lines = [prompt.trim()];
  if (templateName) lines.push(zh
    ? `使用附件模板「${templateName}」的原生布局与配色；模板文字和数值只是占位，不作为本次事实。保留模板并另存成品。`
    : `Use the native layouts and colors of the attached template "${templateName}". Its text and figures are placeholders, not facts for this task. Preserve the template and save a new deck.`);
  lines.push(zh
    ? '本次选择直接制作：即使示例文字提到先确认大纲，也请在资料齐全后直接完成 PPTX，不另行等待大纲确认。'
    : 'For this attempt, create the PPTX directly once the supplied materials are sufficient, even if the example mentions an outline step. Do not wait for separate outline approval.');
  return lines.join('\n\n');
}

export function buildPptCreationPrompt(example: PptExample, options: PptPromptOptions): string {
  const zh = options.language === 'zh';
  const lines = [options.useDemo ? example.prompt[options.language] : example.customPrompt[options.language]];
  lines.push(zh
    ? '以下是本次实际设置，优先于示例的默认内容、受众、页数和修改范围；目标页数包含封面。'
    : 'The settings below take precedence over the example defaults for content, audience, slide count and editing scope. The target slide count includes the cover.');
  if (options.topic.trim()) lines.push(`${zh ? '本次主题与内容' : 'Topic and content'}：${options.topic.trim()}`);
  if (options.audience.trim()) lines.push(`${zh ? '受众' : 'Audience'}：${options.audience.trim()}`);
  lines.push(`${zh ? '目标页数' : 'Target slide count'}：${options.slideCount}`);
  if (options.templateName) {
    const sourceDeck = options.sourceDeck || options.workflow === PptWorkflow.Strict;
    lines.push(sourceDeck ? (zh
      ? '原稿：沿用上传的 PPTX，内容、数字、图表数据与备注均作为原稿保留；仅按明确要求修改。另存副本，保留原始文件。'
      : 'Source deck: preserve the uploaded PPTX content, figures, chart data and notes. Change only what was explicitly requested, save a copy and keep the original file.') : (zh
      ? `模板：使用附件中的「${options.templateName}」，先检查原生布局、配色和占位符；模板中的示例文字与数值不作为本次事实材料。另存新文件，保留原始模板。`
      : `Template: inspect the native layouts, colors and placeholders in the attached "${options.templateName}". Do not treat its example text or figures as facts for this task. Save a new file and preserve the original.`));
  }
  lines.push(zh
    ? '交付可编辑的 PPTX；文字、表格及关键图表使用原生对象。检查每页的溢出、遮挡与字号，提供最终文件链接。保留原始资料，不编造来源、履历或经营事实；演示数据明确标注。已有信息足够时不重复追问。'
    : 'Deliver an editable PPTX with native text, tables and key charts. Check every slide for overflow, overlap and readable font sizes; link the final file. Preserve source files. Do not invent sources, career history or business facts. Label demonstration data. Do not repeat questions already answered.');
  if (options.workflow === PptWorkflow.Outline) lines.push(zh
    ? '本轮先整理逐页大纲：每页标题、主要内容、证据或素材、图表和模板布局。放在一个 <proposed_plan> 中，等待我确认后再制作 PPTX。'
    : 'First prepare a slide-by-slide outline with titles, key content, evidence/materials, charts and template layouts. Put it in one <proposed_plan> block and wait for confirmation before creating the PPTX.');
  else if (options.workflow === PptWorkflow.Strict) lines.push(zh
    ? '严格执行：沿用原稿事实和结构，只修改我指定的内容或页面；没有明确要求的页面不改动。缺少关键原稿才询问，不增加无关的大纲确认。'
    : 'Follow the source deck strictly: preserve its facts and structure, modifying only requested content or slides. Ask only if essential source material is missing; do not add another outline confirmation.');
  else lines.push(zh ? '资料和要求齐全后直接开始制作，无须再次确认大纲。' : 'When the provided materials are sufficient, start creating without another outline confirmation.');
  return lines.join('\n\n');
}
