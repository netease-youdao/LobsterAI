export const AppSettingsIpc = {
  GetAutoLaunch: 'app:getAutoLaunch',
  SetAutoLaunch: 'app:setAutoLaunch',
  GetPreventSleep: 'app:getPreventSleep',
  SetPreventSleep: 'app:setPreventSleep',
} as const;

export type AppSettingsIpc = typeof AppSettingsIpc[keyof typeof AppSettingsIpc];

export const AppSettingsAutoLaunchErrorCode = {
  RequiresApproval: 'requires_approval',
  UpdateFailed: 'update_failed',
} as const;

export type AppSettingsAutoLaunchErrorCode =
  typeof AppSettingsAutoLaunchErrorCode[keyof typeof AppSettingsAutoLaunchErrorCode];
