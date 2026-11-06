// Wire values shared with LobsterAI's IPC presentation adapter. Keep secrets out
// of this protocol: only the gateway owns the remote confirmation token.
export const MailTool = {
  Profile: 'netease_mail_get_profile', Get: 'netease_mail_get_message',
  Send: 'netease_mail_send_message', Reply: 'netease_mail_reply_message',
  Forward: 'netease_mail_forward_message', Trash: 'netease_mail_trash_message',
} as const;
export const MailScope = { Read: 'mail:read', Profile: 'profile:read', Send: 'mail:send', Delete: 'mail:delete' } as const;
export const MailRpc = { Resolve: 'neteaseMail.confirmation.resolve', Status: 'neteaseMail.confirmation.status' } as const;
export const MailAction = { Confirm: 'confirm', Cancel: 'cancel' } as const;
export const MailForwardMode = { Quote: 'quote', Attach: 'attach' } as const;
export const MailStatus = {
  Pending: 'pending', Submitted: 'submitted', Sent: 'sent', Trashed: 'trashed',
  Cancelled: 'cancelled', Expired: 'expired', Unknown: 'unknown', Failed: 'failed',
} as const;
export const MailCode = { Invalid: 40001, AttachmentSize: 40002, AttachmentHash: 40003, Changed: 40004, Unauthorized: 40101, Scope: 40301, OutcomeUnknown: 40904, Confirmation: 42801, Limited: 42901 } as const;
export const MAIL_FAILURE_CODES = new Set<number>(Object.values(MailCode).filter(code => code !== MailCode.Confirmation && code !== MailCode.OutcomeUnknown));
export const MAIL_PROFILE_ID = 'netease-mail:default';
export const MAIL_CONFIRMATION_MS = 300_000;
export type MailResult = { content: { type: 'text'; text: string }[]; details: Record<string, unknown>; isError?: boolean };
export const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export function failureCode(error: unknown): number | undefined {
  const value = record(error);
  const code = Number(value?.code ?? (error instanceof Error ? error.message : undefined));
  if (MAIL_FAILURE_CODES.has(code)) return code;
  if (code === 429) return MailCode.Limited;
  if (code === 401) return MailCode.Unauthorized;
  if (code === 403) return MailCode.Scope;
  return undefined;
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
