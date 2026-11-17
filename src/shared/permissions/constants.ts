export const PermissionIpcChannel = {
  CheckCalendar: 'permissions:checkCalendar',
  RequestCalendar: 'permissions:requestCalendar',
} as const;

export type PermissionIpcChannel = typeof PermissionIpcChannel[keyof typeof PermissionIpcChannel];

export const SystemPermissionStatus = {
  Authorized: 'authorized',
  Denied: 'denied',
  Restricted: 'restricted',
  NotDetermined: 'not-determined',
  NotSupported: 'not-supported',
} as const;

export type SystemPermissionStatus = typeof SystemPermissionStatus[keyof typeof SystemPermissionStatus];

/** What Electron's `systemPreferences.getMediaAccessStatus()` reports. */
export const MediaAccessStatus = {
  Granted: 'granted',
  Denied: 'denied',
  Restricted: 'restricted',
  NotDetermined: 'not-determined',
  Unknown: 'unknown',
} as const;

export type MediaAccessStatus = typeof MediaAccessStatus[keyof typeof MediaAccessStatus];
