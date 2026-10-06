export const AppIpcChannel = {
  GetKeyfromAttribution: 'app:getKeyfromAttribution',
  OpenSystemNotificationSettings: 'app:openSystemNotificationSettings',
} as const;

export type AppIpcChannel = (typeof AppIpcChannel)[keyof typeof AppIpcChannel];
