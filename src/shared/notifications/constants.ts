import { ASK_USER_QUESTION_TOOL_NAME } from '../cowork/constants';
import { OpenClawQuestion } from '../cowork/openclawQuestion';

/** When task-completion notifications are shown. */
export const TaskCompletionNotificationMode = {
  Always: 'always',
  Unfocused: 'unfocused',
  Off: 'off',
} as const;
export type TaskCompletionNotificationMode =
  typeof TaskCompletionNotificationMode[keyof typeof TaskCompletionNotificationMode];

/** Category of a "session is waiting for the user" notification. */
export const WaitingNotificationKind = {
  Permission: 'permission',
  Question: 'question',
} as const;
export type WaitingNotificationKind =
  typeof WaitingNotificationKind[keyof typeof WaitingNotificationKind];

export const classifyWaitingNotificationKind = (
  toolName: string | null | undefined,
): WaitingNotificationKind =>
  toolName === ASK_USER_QUESTION_TOOL_NAME || toolName === OpenClawQuestion.ToolName
    ? WaitingNotificationKind.Question
    : WaitingNotificationKind.Permission;

export interface NotificationSettings {
  taskCompletionNotificationMode: TaskCompletionNotificationMode;
  permissionNotificationsEnabled: boolean;
  questionNotificationsEnabled: boolean;
  /**
   * @deprecated Legacy single switch kept only for downgrade compatibility.
   * normalizeNotificationSettings() folds it into
   * taskCompletionNotificationMode and keeps it in sync when saving.
   */
  taskCompletionNotificationsEnabled?: boolean;
}

export const defaultNotificationSettings: NotificationSettings = {
  taskCompletionNotificationMode: TaskCompletionNotificationMode.Unfocused,
  permissionNotificationsEnabled: true,
  questionNotificationsEnabled: true,
  taskCompletionNotificationsEnabled: true,
};

const isTaskCompletionNotificationMode = (
  value: unknown,
): value is TaskCompletionNotificationMode =>
  value === TaskCompletionNotificationMode.Always ||
  value === TaskCompletionNotificationMode.Unfocused ||
  value === TaskCompletionNotificationMode.Off;

export const normalizeNotificationSettings = (
  value?: Partial<NotificationSettings> | null,
): NotificationSettings => {
  let mode: TaskCompletionNotificationMode;
  if (isTaskCompletionNotificationMode(value?.taskCompletionNotificationMode)) {
    mode = value.taskCompletionNotificationMode;
  } else if (typeof value?.taskCompletionNotificationsEnabled === 'boolean') {
    // Migrate the legacy single switch: on used to mean "notify while the app
    // is not in the foreground", off meant "never notify".
    mode = value.taskCompletionNotificationsEnabled
      ? TaskCompletionNotificationMode.Unfocused
      : TaskCompletionNotificationMode.Off;
  } else {
    mode = defaultNotificationSettings.taskCompletionNotificationMode;
  }
  return {
    taskCompletionNotificationMode: mode,
    permissionNotificationsEnabled:
      typeof value?.permissionNotificationsEnabled === 'boolean'
        ? value.permissionNotificationsEnabled
        : defaultNotificationSettings.permissionNotificationsEnabled,
    questionNotificationsEnabled:
      typeof value?.questionNotificationsEnabled === 'boolean'
        ? value.questionNotificationsEnabled
        : defaultNotificationSettings.questionNotificationsEnabled,
    taskCompletionNotificationsEnabled: mode !== TaskCompletionNotificationMode.Off,
  };
};
