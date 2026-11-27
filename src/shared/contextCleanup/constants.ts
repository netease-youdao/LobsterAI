import { CoreSkillId } from '../skills/constants';

export const ContextCleanupIpcChannel = {
  Scan: 'contextCleanup:scan',
  Apply: 'contextCleanup:apply',
  Undo: 'contextCleanup:undo',
  Dismiss: 'contextCleanup:dismiss',
} as const;
export type ContextCleanupIpcChannel =
  typeof ContextCleanupIpcChannel[keyof typeof ContextCleanupIpcChannel];

export const CleanupCapabilityKind = {
  Skill: 'skill',
  McpServer: 'mcp_server',
  DecisionModel: 'decision_model',
  DshPlugin: 'dsh_plugin',
} as const;
export type CleanupCapabilityKind =
  typeof CleanupCapabilityKind[keyof typeof CleanupCapabilityKind];

export const CleanupDependencyKind = {
  ScheduledTask: 'scheduled_task',
  EnabledAgentSkill: 'enabled_agent_skill',
  CoreBuiltinSkill: 'core_builtin_skill',
} as const;
export type CleanupDependencyKind =
  typeof CleanupDependencyKind[keyof typeof CleanupDependencyKind];

export const CleanupActionMode = {
  Toggle: 'toggle',
  NavigatePlugins: 'navigate_plugins',
} as const;
export type CleanupActionMode =
  typeof CleanupActionMode[keyof typeof CleanupActionMode];

export const CONTEXT_CLEANUP_DEFAULTS = {
  IdleDaysThreshold: 30,
  GracePeriodDays: 14,
  PromptSavingsThresholdTokens: 1_500,
  DismissCooldownDays: 30,
  BackfillWindowDays: 90,
  FlushDebounceMs: 5 * 60 * 1_000,
  MaxUndoSnapshots: 5,
  DefaultCatalogDescriptionMaxChars: 100,
} as const;

export const CONTEXT_CLEANUP_KV_KEYS = {
  BackfilledV1: 'capability_usage_backfilled_v1',
  DismissedAt: 'context_cleanup_dismissed_at',
} as const;

export const DECISION_MODEL_JEV_ITEM_ID = 'jev' as const;

export const CORE_BUILTIN_SKILL_IDS: ReadonlySet<string> = new Set(
  Object.values(CoreSkillId),
);
