import { AgentRulePolishDirective, AgentSource } from '@shared/agent';

import { getLastPathSegment } from '../../utils/path';

export const UnifiedInstructionSource = {
  Soul: 'soul',
  Identity: 'identity',
  Merged: 'merged',
} as const;

export type UnifiedInstructionSource =
  typeof UnifiedInstructionSource[keyof typeof UnifiedInstructionSource];

export interface UnifiedInstructionsState {
  text: string;
  source: UnifiedInstructionSource;
}

export const AgentRuleTemplateId = {
  GeneralAssistant: 'general_assistant',
  DocumentOrganizer: 'document_organizer',
  CodeCollaborator: 'code_collaborator',
  ResearchAnalyst: 'research_analyst',
} as const;

export type AgentRuleTemplateId =
  typeof AgentRuleTemplateId[keyof typeof AgentRuleTemplateId];

export const RulesUndoSource = {
  Ai: 'ai',
  Template: 'template',
} as const;

export type RulesUndoSource =
  typeof RulesUndoSource[keyof typeof RulesUndoSource];

export const AgentCreateAiActionKind = {
  Generate: 'generate',
  Refine: 'refine',
  Regenerate: 'regenerate',
} as const;

export type AgentCreateAiActionKind =
  typeof AgentCreateAiActionKind[keyof typeof AgentCreateAiActionKind];

const MAX_INLINE_FALLBACK_DESCRIPTION_CHARS = 120;

export interface AgentRuleTemplateOption {
  id: AgentRuleTemplateId;
  titleKey: string;
  descriptionKey: string;
  contentKey: string;
}

export interface AgentRulePolishOption {
  directive: AgentRulePolishDirective;
  labelKey: string;
  descriptionKey: string;
  separatorAfter?: boolean;
}

export const AGENT_RULE_TEMPLATES: readonly AgentRuleTemplateOption[] = [
  {
    id: AgentRuleTemplateId.GeneralAssistant,
    titleKey: 'agentRuleTemplateGeneralTitle',
    descriptionKey: 'agentRuleTemplateGeneralDesc',
    contentKey: 'agentRuleTemplateGeneralContent',
  },
  {
    id: AgentRuleTemplateId.DocumentOrganizer,
    titleKey: 'agentRuleTemplateDocumentTitle',
    descriptionKey: 'agentRuleTemplateDocumentDesc',
    contentKey: 'agentRuleTemplateDocumentContent',
  },
  {
    id: AgentRuleTemplateId.CodeCollaborator,
    titleKey: 'agentRuleTemplateCodeTitle',
    descriptionKey: 'agentRuleTemplateCodeDesc',
    contentKey: 'agentRuleTemplateCodeContent',
  },
  {
    id: AgentRuleTemplateId.ResearchAnalyst,
    titleKey: 'agentRuleTemplateResearchTitle',
    descriptionKey: 'agentRuleTemplateResearchDesc',
    contentKey: 'agentRuleTemplateResearchContent',
  },
];

export const AGENT_RULE_POLISH_OPTIONS: readonly AgentRulePolishOption[] = [
  {
    directive: AgentRulePolishDirective.Polish,
    labelKey: 'agentRulePolishFullTitle',
    descriptionKey: 'agentRulePolishFullDesc',
    separatorAfter: true,
  },
  {
    directive: AgentRulePolishDirective.Concise,
    labelKey: 'agentRulePolishConciseTitle',
    descriptionKey: 'agentRulePolishConciseDesc',
  },
  {
    directive: AgentRulePolishDirective.ConclusionFirst,
    labelKey: 'agentRulePolishConclusionTitle',
    descriptionKey: 'agentRulePolishConclusionDesc',
  },
  {
    directive: AgentRulePolishDirective.Rigorous,
    labelKey: 'agentRulePolishRigorousTitle',
    descriptionKey: 'agentRulePolishRigorousDesc',
  },
  {
    directive: AgentRulePolishDirective.Friendly,
    labelKey: 'agentRulePolishFriendlyTitle',
    descriptionKey: 'agentRulePolishFriendlyDesc',
  },
];

/**
 * Merge legacy IDENTITY.md and SOUL.md into a single user-facing "Role & Rules"
 * field without silently dropping content from either file.
 */
export function deriveUnifiedInstructions(files: {
  identity: string;
  systemPrompt: string;
}): UnifiedInstructionsState {
  const identityTrimmed = files.identity.trim();
  const soulTrimmed = files.systemPrompt.trim();

  if (identityTrimmed && soulTrimmed) {
    return {
      text: `${identityTrimmed}\n\n${soulTrimmed}`,
      source: UnifiedInstructionSource.Merged,
    };
  }
  if (identityTrimmed && !soulTrimmed) {
    return {
      text: identityTrimmed,
      source: UnifiedInstructionSource.Identity,
    };
  }
  return {
    text: soulTrimmed,
    source: UnifiedInstructionSource.Soul,
  };
}

/**
 * Map an edited unified "Role & Rules" value back to IDENTITY.md / SOUL.md
 * while preserving the primary storage file of existing agents (e.g., main
 * keeps IDENTITY.md when SOUL.md was empty; new agents write SOUL.md).
 */
export function resolvePersonaFilesOnSave(input: {
  initialIdentity: string;
  initialSystemPrompt: string;
  rawIdentity: string;
  rawSystemPrompt: string;
  unifiedText: string;
  unifiedSource: UnifiedInstructionSource;
  unifiedEdited: boolean;
  rawFilesEdited: boolean;
}): { identity: string; systemPrompt: string } {
  if (input.rawFilesEdited) {
    return {
      identity: input.rawIdentity,
      systemPrompt: input.rawSystemPrompt,
    };
  }
  if (!input.unifiedEdited) {
    return {
      identity: input.initialIdentity,
      systemPrompt: input.initialSystemPrompt,
    };
  }

  const nextText = input.unifiedText.trim();
  if (input.unifiedSource === UnifiedInstructionSource.Identity) {
    return {
      identity: nextText,
      systemPrompt: input.initialSystemPrompt,
    };
  }
  if (input.unifiedSource === UnifiedInstructionSource.Merged) {
    // Consolidate edited unified content into SOUL.md and clear IDENTITY.md
    // so the runtime does not inject duplicated persona sections.
    return {
      identity: '',
      systemPrompt: nextText,
    };
  }
  return {
    identity: input.initialIdentity,
    systemPrompt: nextText,
  };
}

/**
 * Fill an empty agent description from a template or AI suggestion without
 * overwriting a description the user already wrote.
 */
export function resolveDescriptionOnAutoFill(
  currentDescription: string,
  candidateDescription: string,
): { nextDescription: string; didFill: boolean } {
  const candidate = candidateDescription.trim();
  if (currentDescription.trim() || !candidate) {
    return { nextDescription: currentDescription, didFill: false };
  }
  return { nextDescription: candidate, didFill: true };
}

/**
 * Derive a sensible default agent name from a selected folder path when the
 * user has not entered a custom name yet (Codex / Antigravity project flow).
 */
export function deriveAgentNameFromFolder(currentName: string, folderPath: string): string {
  if (currentName.trim()) return currentName;
  const segment = getLastPathSegment(folderPath).trim();
  return segment || currentName;
}

/**
 * Resolve the localized menu label key for a given polish directive.
 */
export function getPolishDirectiveLabelKey(directive: AgentRulePolishDirective): string {
  const match = AGENT_RULE_POLISH_OPTIONS.find(option => option.directive === directive);
  return match?.labelKey ?? 'agentRulePolishFullTitle';
}

/**
 * Decide whether the agent home hero should show conversational onboarding
 * cards. Only fresh custom agents without configured rules or starter prompts
 * need them; once rules are in place, the daily home view stays minimal.
 */
export function shouldShowAgentQuickSetup(input: {
  source: AgentSource;
  systemPrompt?: string;
  identity?: string;
  starterPromptCount?: number;
}): boolean {
  if (input.source !== AgentSource.Custom) return false;
  if ((input.starterPromptCount ?? 0) > 0) return false;
  return !input.systemPrompt?.trim() && !input.identity?.trim();
}

/**
 * Build conversational setup prompts for a newly created custom agent's
 * cold-start home screen (Living Bot / Grok Bot style onboarding).
 */
export function buildAgentInterviewPrompt(options: {
  agentName: string;
  workingDirectory?: string;
  language: 'zh' | 'en';
}): string {
  const name = options.agentName.trim() || (options.language === 'zh' ? '这个助手' : 'this agent');
  const folder = options.workingDirectory?.trim();
  if (options.language === 'zh') {
    const folderNote = folder ? `（已绑定工作目录：${folder}）` : '';
    return `你好！我想把你配置成「${name}」专属助手${folderNote}。请先用 2~3 个简短问题向我了解目标场景、输出风格和偏好；等我确认后，请调用 \`lobster_agent_rules\` 将长期规则保存到你的专属角色设定中（不要在工作目录创建或修改 AGENTS.md / CLAUDE.md）。`;
  }
  const folderNote = folder ? ` (linked folder: ${folder})` : '';
  return `Hi! I'd like to set you up as my "${name}" assistant${folderNote}. Please ask me 2–3 brief questions about my goals, output style, and preferences; once I confirm, call \`lobster_agent_rules\` to save these lasting guidelines to your own agent rules (do not create or edit AGENTS.md / CLAUDE.md in the working folder).`;
}

export function buildFolderScanSetupPrompt(options: {
  agentName: string;
  workingDirectory: string;
  language: 'zh' | 'en';
}): string {
  const name = options.agentName.trim() || (options.language === 'zh' ? '这个助手' : 'this agent');
  const folder = options.workingDirectory.trim();
  if (options.language === 'zh') {
    return `请先浏览已绑定的工作目录（${folder}）的文件结构与已有文档，帮我总结出一套适合「${name}」的工作规范与背景要点；征得我确认后，请调用 \`lobster_agent_rules\` 将工作规范保存到你的专属角色设定中，并将目录背景要点保存到项目记忆（不要在工作目录创建或修改 AGENTS.md / CLAUDE.md）。`;
  }
  return `Please inspect the linked folder (${folder}) — including its file structure and existing docs — summarize practical working guidelines and background notes for "${name}"; once I confirm, call \`lobster_agent_rules\` to save the guidelines to your own agent rules and save folder context to project memory (do not create or edit AGENTS.md / CLAUDE.md in the working folder).`;
}

/**
 * Determine the create-modal AI button label/behavior for the unified prompt box:
 * empty -> Generate, untouched AI output -> Regenerate, user text/edits -> Refine.
 */
export function resolveCreateAiActionKind(input: {
  instructions: string;
  isAiOutputUnmodified: boolean;
}): AgentCreateAiActionKind {
  if (!input.instructions.trim()) {
    return AgentCreateAiActionKind.Generate;
  }
  return input.isAiOutputUnmodified
    ? AgentCreateAiActionKind.Regenerate
    : AgentCreateAiActionKind.Refine;
}

/**
 * Build the prompt inputs for in-place AI generation in AgentCreateModal while
 * preserving the user's original plain-language seed across regenerations.
 */
export function buildCreateDraftInputs(input: {
  actionKind: AgentCreateAiActionKind;
  name: string;
  instructions: string;
  workingDirectory: string;
  seedGoal: string | null;
  hasExistingDraft: boolean;
}): {
  goal: string;
  existingInstructions?: string;
  nextSeedGoal: string;
} {
  const trimmedInstructions = input.instructions.trim();
  const trimmedSeedGoal = (input.seedGoal ?? '').trim();

  if (input.actionKind === AgentCreateAiActionKind.Generate) {
    return {
      goal: '',
      nextSeedGoal: '',
    };
  }

  if (input.actionKind === AgentCreateAiActionKind.Regenerate) {
    const hasSeedOrContext = Boolean(
      trimmedSeedGoal || input.name.trim() || input.workingDirectory.trim(),
    );
    return {
      goal: trimmedSeedGoal,
      ...(hasSeedOrContext || !trimmedInstructions ? {} : { existingInstructions: trimmedInstructions }),
      nextSeedGoal: trimmedSeedGoal,
    };
  }

  if (input.hasExistingDraft) {
    return {
      goal: trimmedSeedGoal,
      ...(trimmedInstructions ? { existingInstructions: trimmedInstructions } : {}),
      nextSeedGoal: trimmedSeedGoal,
    };
  }

  return {
    goal: trimmedInstructions,
    nextSeedGoal: trimmedInstructions,
  };
}

/**
 * Resolve the card/routing description saved on agent creation.
 * Prefers the silent AI-generated summary; falls back to a short single-line
 * user goal; leaves long/multiline rules blank for main-process summary backfill.
 */
export function resolveCreateSubmitDescription(input: {
  instructions: string;
  generatedDescription?: string | null;
}): string {
  const trimmedInstructions = input.instructions.trim();
  if (!trimmedInstructions) {
    return '';
  }
  const trimmedGenerated = typeof input.generatedDescription === 'string'
    ? input.generatedDescription.trim()
    : '';
  if (trimmedGenerated) {
    return trimmedGenerated;
  }
  if (!trimmedInstructions.includes('\n') && trimmedInstructions.length <= MAX_INLINE_FALLBACK_DESCRIPTION_CHARS) {
    return trimmedInstructions;
  }
  return '';
}
