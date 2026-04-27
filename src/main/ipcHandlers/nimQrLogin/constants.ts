export const NimQrLoginIpc = {
  Start: 'im:nim:qr-login:start',
  Poll: 'im:nim:qr-login:poll',
} as const;

export type NimQrLoginIpc = typeof NimQrLoginIpc[keyof typeof NimQrLoginIpc];
