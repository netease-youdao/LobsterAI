export const BrowserCredentialGuestChannel = {
  Command: 'lobster:browser-credential:command',
  Result: 'lobster:browser-credential:result',
} as const;

export const BrowserCredentialGuestCommandType = {
  Inspect: 'inspect',
  FillAndSubmit: 'fill-and-submit',
  ClearPasswordFields: 'clear-password-fields',
} as const;

export type BrowserCredentialGuestCommandType =
  typeof BrowserCredentialGuestCommandType[keyof typeof BrowserCredentialGuestCommandType];

export interface BrowserCredentialGuestCommand {
  requestId: string;
  type: BrowserCredentialGuestCommandType;
  username?: string;
  password?: string;
}
export const BrowserCredentialGuestResultKind = {
  PasswordForm: 'password-form',
  UsernameForm: 'username-form',
  MfaForm: 'mfa-form',
  Captcha: 'captcha',
  NoLoginForm: 'no-login-form',
  SubmittedUsername: 'submitted-username',
  SubmittedPassword: 'submitted-password',
  Cleared: 'cleared',
  Failed: 'failed',
} as const;

export type BrowserCredentialGuestResultKind =
  typeof BrowserCredentialGuestResultKind[keyof typeof BrowserCredentialGuestResultKind];

export interface BrowserCredentialGuestResult {
  requestId: string;
  kind: BrowserCredentialGuestResultKind;
  url: string;
  message?: string;
}
