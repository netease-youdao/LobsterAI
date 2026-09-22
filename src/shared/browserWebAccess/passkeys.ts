export const BrowserPasskeyChannel = {
  Event: 'lobster:browser-passkey:event',
  Cancel: 'lobster:browser-passkey:cancel',
} as const;

export const BrowserPasskeyStatus = {
  Waiting: 'waiting',
  Succeeded: 'succeeded',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;
export type BrowserPasskeyStatus = typeof BrowserPasskeyStatus[keyof typeof BrowserPasskeyStatus];

export const BrowserPasskeyAction = {
  Cancel: 'cancel',
  Dismiss: 'dismiss',
} as const;
export type BrowserPasskeyAction = typeof BrowserPasskeyAction[keyof typeof BrowserPasskeyAction];

export const BrowserPasskeyUiEvent = {
  OpenBrowserSettings: 'lobster:browser-passkey:open-settings',
} as const;

export const BrowserCredentialMethod = { Get: 'get', Create: 'create' } as const;
export const BrowserCredentialMediation = { Conditional: 'conditional' } as const;

export interface BrowserPasskeyEvent {
  requestId: string;
  status: BrowserPasskeyStatus;
}

export interface BrowserPasskeyNotice extends BrowserPasskeyEvent {
  pageId: number;
  origin: string;
  platformAuthenticatorAvailable?: boolean;
}

export interface BrowserPasskeyRequest {
  pageId: number;
  requestId: string;
  action: BrowserPasskeyAction;
}

export const parseBrowserPasskeyEvent = (value: unknown): BrowserPasskeyEvent | null => {
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  if (typeof event.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(event.requestId)) return null;
  if (!Object.values(BrowserPasskeyStatus).includes(event.status as BrowserPasskeyStatus)) return null;
  return { requestId: event.requestId, status: event.status as BrowserPasskeyStatus };
};
