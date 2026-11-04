export const NeteaseMail = {
  RegistryId: 'netease-mail',
  Endpoint: 'https://open.mail.163.com/api/mail/mcp',
} as const;

export const NeteaseMailTool = {
  GetProfile: 'netease_mail_get_profile',
  ListFolders: 'netease_mail_list_folders',
  ListMessages: 'netease_mail_list_messages',
  SearchMessages: 'netease_mail_search_messages',
  GetMessage: 'netease_mail_get_message',
  ListAttachments: 'netease_mail_list_attachments',
  DownloadAttachment: 'netease_mail_download_attachment',
  ListDrafts: 'netease_mail_list_drafts',
  CreateDraft: 'netease_mail_create_draft',
  SendMessage: 'netease_mail_send_message',
  ReplyMessage: 'netease_mail_reply_message',
  ForwardMessage: 'netease_mail_forward_message',
  TrashMessage: 'netease_mail_trash_message',
} as const;
export type NeteaseMailTool = typeof NeteaseMailTool[keyof typeof NeteaseMailTool];

export const NeteaseMailError = {
  InvalidArgument: 40001,
  AttachmentSizeMismatch: 40002,
  AttachmentHashMismatch: 40003,
  ConfirmationChanged: 40004,
  Unauthorized: 40101,
  InsufficientScope: 40301,
  ConfirmationRequired: 42801,
  RateLimited: 42901,
} as const;
export type NeteaseMailError = typeof NeteaseMailError[keyof typeof NeteaseMailError];

export const NeteaseMailFailure = {
  NotReady: 'not_ready',
  Unavailable: 'unavailable',
  InvalidRequest: 'invalid_request',
  Failed: 'failed',
  PortBusy: 'port_busy',
  TimedOut: 'timed_out',
  Denied: 'denied',
  StorageFailed: 'storage_failed',
  SyncFailed: 'sync_failed',
} as const;
export type NeteaseMailFailure = typeof NeteaseMailFailure[keyof typeof NeteaseMailFailure];

export const NeteaseMailBodyFormat = { Plain: 'PLAIN', Html: 'HTML', Markdown: 'MARKDOWN' } as const;
export type NeteaseMailBodyFormat = typeof NeteaseMailBodyFormat[keyof typeof NeteaseMailBodyFormat];

export const NeteaseMailView = { Message: 'message', List: 'list', Notice: 'notice' } as const;
export const NeteaseMailMessageMode = { Read: 'read', Draft: 'draft', Confirmation: 'confirmation' } as const;
export type NeteaseMailMessageMode = typeof NeteaseMailMessageMode[keyof typeof NeteaseMailMessageMode];
export const NeteaseMailAction = { Confirm: 'confirm', Cancel: 'cancel' } as const;
export type NeteaseMailAction = typeof NeteaseMailAction[keyof typeof NeteaseMailAction];
export const NeteaseMailOutcome = { Connected: 'connected', Disconnected: 'disconnected', Submitted: 'submitted', Cancelled: 'cancelled' } as const;
export type NeteaseMailOutcome = typeof NeteaseMailOutcome[keyof typeof NeteaseMailOutcome];

export const NeteaseMailLimits = {
  AttachmentBytes: 1_048_576,
  AttachmentCount: 3,
  TotalAttachmentBytes: 3_145_728,
  Recipients: 20,
  SubjectCharacters: 998,
  PageSize: 50,
} as const;

export const NeteaseMailIpc = {
  Availability: 'mcp:neteaseMail:availability',
  Authorize: 'mcp:neteaseMail:authorize',
  CancelAuthorization: 'mcp:neteaseMail:cancelAuthorization',
  Disconnect: 'mcp:neteaseMail:disconnect',
  ResolveConfirmation: 'mcp:neteaseMail:resolveConfirmation',
} as const;

export const NeteaseMailAuth = {
  Provider: 'netease-mail',
  ProfileId: 'netease-mail:default',
  CredentialType: 'oauth',
  Scope: 'mail:read',
  RedirectUri: 'http://localhost:8989/oauth/callback',
  AuthorizeUrl: 'https://mail.163.com/fgw/mailsrv-oauth2-fapi/oauth2/v2/authorize',
  TokenUrl: 'https://mail.163.com/fgw/mailsrv-oauth2-fapi/oauth2/token',
  TimeoutMs: 300_000,
} as const;

export const NeteaseMailReadTools = [
  NeteaseMailTool.ListFolders, NeteaseMailTool.ListMessages, NeteaseMailTool.SearchMessages,
  NeteaseMailTool.GetMessage, NeteaseMailTool.ListAttachments, NeteaseMailTool.DownloadAttachment,
  NeteaseMailTool.ListDrafts,
] as const;

export const NeteaseMailAuthStoreOperation = { Initialize: 'initialize', Status: 'status', Save: 'save', Remove: 'remove' } as const;

export const NeteaseMailRuntimeRpc = { ReloadCredentials: 'secrets.reload' } as const;
