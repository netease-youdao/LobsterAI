export const APP_NAME = 'LobsterAI';
export const APP_ID = 'lobsterai';
export const DB_FILENAME = 'lobsterai.sqlite';

/** 点击关闭按钮时的行为（仅 Windows） */
export const CloseButtonAction = {
  MinimizeToTaskbar: 'minimize_to_taskbar',
  QuitApp: 'quit_app',
} as const;
export type CloseButtonAction = typeof CloseButtonAction[keyof typeof CloseButtonAction];

/** SQLite kv 存储键名 */
export const KvKey = {
  CloseButtonAction: 'closeButtonAction',
  CloseButtonActionPromptShown: 'closeButtonActionPromptShown',
} as const;

/** IPC channel names for close-button-action feature */
export const CloseButtonIpc = {
  GetAction: 'app:getCloseButtonAction',
  SetAction: 'app:setCloseButtonAction',
} as const;
