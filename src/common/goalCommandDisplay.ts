export const GoalDisplayAction = {
  Start: 'start',
  Create: 'create',
  Set: 'set',
} as const;

export type GoalDisplayAction = typeof GoalDisplayAction[keyof typeof GoalDisplayAction];

export interface GoalDisplayCommand {
  action: GoalDisplayAction;
  objective: string;
}

const GOAL_SETTING_ACTIONS = new Set<string>([
  GoalDisplayAction.Start,
  GoalDisplayAction.Create,
  GoalDisplayAction.Set,
]);

export function parseGoalSettingCommandForDisplay(input: string): GoalDisplayCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const match = /^\/goal(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return null;

  const rawAction = (match[1] ?? GoalDisplayAction.Start).toLowerCase();
  if (!GOAL_SETTING_ACTIONS.has(rawAction)) return null;

  const objective = (match[2] ?? '').trim();
  if (!objective) return null;

  return {
    action: rawAction as GoalDisplayAction,
    objective,
  };
}

export function buildGoalSettingMessageMetadata(input: string): Record<string, unknown> | undefined {
  const command = parseGoalSettingCommandForDisplay(input);
  if (!command) return undefined;

  return {
    goalSetting: {
      action: command.action,
      objective: command.objective,
    },
  };
}

export function hasGoalSettingMessageMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const goalSetting = (metadata as Record<string, unknown>).goalSetting;
  if (!goalSetting || typeof goalSetting !== 'object' || Array.isArray(goalSetting)) return false;
  const action = (goalSetting as Record<string, unknown>).action;
  return typeof action === 'string' && GOAL_SETTING_ACTIONS.has(action);
}
