// Wire values shared with LobsterAI's IPC presentation adapter. Keep secrets out
// of this protocol: only the main process owns the remote confirmation token.
export const MailTool = {
  Profile: 'netease_mail_get_profile', Get: 'netease_mail_get_message',
  Send: 'netease_mail_send_message', Reply: 'netease_mail_reply_message',
  Forward: 'netease_mail_forward_message', Trash: 'netease_mail_trash_message',
} as const;
export const MailScope = { Read: 'mail:read', Profile: 'profile:read', Send: 'mail:send', Delete: 'mail:delete' } as const;
export const MailAction = { Confirm: 'confirm', Cancel: 'cancel' } as const;
export const MailForwardMode = { Quote: 'quote', Attach: 'attach' } as const;
export const MailStatus = {
  InProgress: 'in_progress',
  Pending: 'pending', Submitted: 'submitted', Sent: 'sent', Trashed: 'trashed',
  Cancelled: 'cancelled', Expired: 'expired', Unknown: 'unknown', Failed: 'failed',
} as const;
export const MailCode = {
  Invalid: 40001, AttachmentSize: 40002, AttachmentHash: 40003, Changed: 40004,
  ConfirmationExpired: 40005, AttachmentInvalid: 40006, CursorInvalid: 40007, CursorExpired: 40008,
  Unauthorized: 40101, Scope: 40301, MessageNotFound: 40401, PartNotFound: 40402,
  IdempotencyConflict: 40901, OperationInProgress: 40902, IdempotencyRecordExpired: 40903, OutcomeUnknown: 40904,
  AttachmentTooLarge: 41301, AttachmentSizeUnknown: 41302, MtaRejected: 42201, Confirmation: 42801, Limited: 42901,
} as const;
const MAIL_ERROR_CODES = new Set<number>(Object.values(MailCode).filter(code => code !== MailCode.Confirmation));
export const MAIL_FAILURE_CODES = new Set<number>([...MAIL_ERROR_CODES].filter(code => code !== MailCode.OperationInProgress && code !== MailCode.OutcomeUnknown));
export const MAIL_CONFIRMATION_MS = 300_000;
export type MailResult = { content: { type: 'text'; text: string }[]; details: Record<string, unknown>; isError?: boolean };
export const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export function failureCode(error: unknown): number | undefined {
  const value = record(error);
  const code = Number(value?.code ?? (error instanceof Error ? error.message : undefined));
  if (MAIL_ERROR_CODES.has(code)) return code;
  if (code === 429) return MailCode.Limited;
  if (code === 401) return MailCode.Unauthorized;
  if (code === 403) return MailCode.Scope;
  return undefined;
}

export function operationErrorStatus(code: number | undefined) {
  if (code === MailCode.OperationInProgress) return MailStatus.InProgress;
  return code !== undefined && MAIL_FAILURE_CODES.has(code) ? MailStatus.Failed : MailStatus.Unknown;
}

export function operationErrorInstruction(code: number | undefined): string {
  if (code === MailCode.MessageNotFound) return 'The requested message does not exist. This request failed without executing. Do not retry or reconcile it; obtain a valid message ID before a new operation.';
  if (code === MailCode.OperationInProgress) return 'The original request is still executing. Do not repeat the operation or create a new request ID. Wait, then check the outcome using the original request_id.';
  if (code !== undefined && MAIL_FAILURE_CODES.has(code)) return 'The email service rejected this request. Report the specific failure. Do not automatically retry or repeat the operation.';
  return 'Outcome unknown. Do not retry or create a new request. Reconcile the original request with the email service; an empty mailbox search does not prove that the operation failed.';
}
export function payload(value: unknown): Record<string, unknown> {
  const result = record(value) ?? {};
  if (record(result.structuredContent)) return result.structuredContent as Record<string, unknown>;
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      try { const parsed = record(JSON.parse(block.text)); if (parsed) return parsed; } catch { /* Not a JSON block. */ }
    }
  }
  return result;
}
export function responseData(result: Record<string, unknown>): Record<string, unknown> {
  return record(record(result.error)?.details) ?? record(result.data) ?? result;
}
export function responseCode(result: Record<string, unknown>): number {
  return Number(record(result.error)?.code ?? result.code ?? responseData(result).code ?? 0);
}
export function mailResult(details: Record<string, unknown>, isError = false): MailResult {
  return { content: [{ type: 'text', text: JSON.stringify(details) }], details, ...(isError ? { isError: true } : {}) };
}

/** Keep the attachment descriptors in a live confirmation within Electron's IPC depth limit. */
export function mailConfirmationDetailsForIpc(details: Record<string, unknown>): Record<string, unknown> {
  const data = record(details.data);
  return details.code === MailCode.Confirmation && data ? { ...data, code: MailCode.Confirmation } : details;
}
