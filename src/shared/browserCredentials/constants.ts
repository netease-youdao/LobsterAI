export const BrowserCredentialUseMode = {
  AlwaysAsk: 'always-ask',
  OncePerTask: 'once-per-task',
  Disabled: 'disabled',
} as const;

export type BrowserCredentialUseMode =
  typeof BrowserCredentialUseMode[keyof typeof BrowserCredentialUseMode];

export const BrowserCredentialSaveMode = {
  Ask: 'ask',
  Never: 'never',
} as const;

export type BrowserCredentialSaveMode =
  typeof BrowserCredentialSaveMode[keyof typeof BrowserCredentialSaveMode];

export const BrowserCredentialSaveDecision = {
  Save: 'save',
  Dismiss: 'dismiss',
} as const;

export type BrowserCredentialSaveDecision =
  typeof BrowserCredentialSaveDecision[keyof typeof BrowserCredentialSaveDecision];

export const BrowserCredentialIpc = {
  GetAvailability: 'openclaw:browser:credentials:getAvailability',
  RequestAccess: 'openclaw:browser:credentials:requestAccess',
  List: 'openclaw:browser:credentials:list',
  Save: 'openclaw:browser:credentials:save',
  Delete: 'openclaw:browser:credentials:delete',
} as const;

export type BrowserCredentialIpc = typeof BrowserCredentialIpc[keyof typeof BrowserCredentialIpc];

export const BrowserCredentialAvailabilityReason = {
  AccessNotRequested: 'access-not-requested',
  EncryptionUnavailable: 'encryption-unavailable',
  InsecureStorageBackend: 'insecure-storage-backend',
} as const;

export type BrowserCredentialAvailabilityReason =
  typeof BrowserCredentialAvailabilityReason[keyof typeof BrowserCredentialAvailabilityReason];

export interface BrowserCredentialAvailability {
  available: boolean;
  reason?: BrowserCredentialAvailabilityReason;
  requiresRestart?: boolean;
}

export interface BrowserCredentialSummary {
  id: string;
  origin: string;
  username: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface BrowserCredentialSaveRequest {
  id?: string;
  origin: string;
  username: string;
  password: string;
}

export interface BrowserCredentialDeleteRequest {
  id: string;
}

export interface BrowserCredentialListResponse {
  success: boolean;
  credentials?: BrowserCredentialSummary[];
  error?: string;
}

export interface BrowserCredentialMutationResponse {
  success: boolean;
  credential?: BrowserCredentialSummary;
  error?: string;
}

export interface BrowserCredentialAvailabilityResponse {
  success: boolean;
  availability?: BrowserCredentialAvailability;
  error?: string;
}

export interface BrowserCredentialSavePrompt {
  requestId: string;
  pageId: number;
  origin: string;
  username: string;
  updatesExisting: boolean;
}

export const BrowserCredentialLoginStatus = {
  AwaitingApproval: 'awaiting-approval',
  SigningIn: 'signing-in',
  Authenticated: 'authenticated',
  Submitted: 'submitted',
  NeedsMfa: 'needs-mfa',
  NeedsCaptcha: 'needs-captcha',
  Denied: 'denied',
  Failed: 'failed',
} as const;

export type BrowserCredentialLoginStatus =
  typeof BrowserCredentialLoginStatus[keyof typeof BrowserCredentialLoginStatus];

export interface BrowserCredentialLoginState {
  status: BrowserCredentialLoginStatus;
  origin: string;
  username?: string;
  message?: string;
}

export const BrowserCredentialLoginOutcome = {
  Authenticated: 'authenticated',
  Submitted: 'submitted',
  NeedsMfa: 'needs-mfa',
  NeedsCaptcha: 'needs-captcha',
  Denied: 'denied',
  Failed: 'failed',
} as const;

export type BrowserCredentialLoginOutcome =
  typeof BrowserCredentialLoginOutcome[keyof typeof BrowserCredentialLoginOutcome];

export interface BrowserCredentialLoginResult {
  outcome: BrowserCredentialLoginOutcome;
  origin: string;
  username?: string;
  message: string;
}

export const BrowserCredentialLoginTool = {
  Name: 'login_with_saved_credential',
} as const;

export const BrowserCredentialMcpServer = {
  Name: 'lobster-browser-credentials',
  ToolSetArgument: '--lobster-tool-set=credentials',
  ModelToolName: 'lobster-browser-credentials__login_with_saved_credential',
} as const;
