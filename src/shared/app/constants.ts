export const AppIpcChannel = {
  GetKeyfromAttribution: 'app:getKeyfromAttribution',
} as const;

export type AppIpcChannel = (typeof AppIpcChannel)[keyof typeof AppIpcChannel];
