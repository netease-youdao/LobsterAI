import {
  NeteaseMailBodyFormat, NeteaseMailError, NeteaseMailFailure, NeteaseMailLimits,
  NeteaseMailMessageMode, NeteaseMailTool, NeteaseMailView,
} from '../../shared/neteaseMail/constants';
import type {
  NeteaseMailAddress, NeteaseMailAttachment, NeteaseMailMessage, NeteaseMailPresentation,
} from '../../shared/neteaseMail/types';

const TOOLS = Object.values(NeteaseMailTool);
const ERROR_CODES = new Set<number>(Object.values(NeteaseMailError));
const LIST_TOOLS = new Set<NeteaseMailTool>([
  NeteaseMailTool.ListMessages, NeteaseMailTool.SearchMessages, NeteaseMailTool.ListDrafts,
]);
const CONFIRMATION_TOOLS = new Set<NeteaseMailTool>([
  NeteaseMailTool.SendMessage, NeteaseMailTool.ReplyMessage, NeteaseMailTool.ForwardMessage, NeteaseMailTool.TrashMessage,
]);

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

export function resolveNeteaseMailTool(name: string): NeteaseMailTool | undefined {
  return TOOLS.find(tool => name === tool || name.endsWith(`__${tool}`) || name.endsWith(`_${tool}`));
}

function addresses(value: unknown): NeteaseMailAddress[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.flatMap(item => {
    if (typeof item === 'string' && item.trim()) return [{ email: item.trim() }];
    const address = record(item);
    const email = string(address?.email) ?? string(address?.address);
    return email?.trim() ? [{ email: email.trim(), name: string(address?.name) }] : [];
  });
}

function attachments(value: unknown): NeteaseMailAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const attachment = record(item);
    const name = string(attachment?.filename) ?? string(attachment?.name);
    if (!name) return [];
    const size = attachment?.size;
    return [{
      name,
      id: string(attachment?.part_id) ?? string(attachment?.att_id),
      mimeType: string(attachment?.mime_type),
      size: typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : undefined,
    }];
  });
}

function message(value: unknown): NeteaseMailMessage | undefined {
  const data = record(value);
  if (!data) return undefined;
  const header = record(data.header) ?? data;
  const bodyObject = record(data.body);
  const body = string(bodyObject?.content) ?? string(data.body) ?? string(data.body_text)
    ?? string(data.body_html) ?? string(data.body_preview) ?? string(data.snippet) ?? string(data.summary);
  const subject = string(header.subject) ?? string(data.subject);
  if (subject === undefined && body === undefined) return undefined;
  const rawFormat = string(bodyObject?.format) ?? string(data.body_format) ?? string(data.format);
  const format = rawFormat === NeteaseMailBodyFormat.Html || (rawFormat === undefined && data.body_html !== undefined && data.body_text === undefined)
    ? NeteaseMailBodyFormat.Html
    : rawFormat === NeteaseMailBodyFormat.Markdown ? NeteaseMailBodyFormat.Markdown : NeteaseMailBodyFormat.Plain;
  return {
    id: string(data.message_id) ?? string(data.id),
    from: addresses(header.from), to: addresses(header.to), cc: addresses(header.cc), bcc: addresses(header.bcc),
    subject: subject ?? '', body: body ?? '', format, attachments: attachments(data.attachments),
    date: mailDate(header.sent_date ?? data.received_date ?? data.date ?? data.sent_at),
    // The service has not defined the flags schema yet; missing flags never mean read.
    unread: typeof data.is_read === 'boolean' ? !data.is_read : undefined,
  };
}

function mailDate(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value); // Provider timestamps are milliseconds, never guess seconds.
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function expiry(value: unknown): number | undefined {
  const timestamp = typeof value === 'number'
    ? (value < 1e12 ? value * 1000 : value)
    : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
}

function payloadOf(details: unknown, text?: string): Record<string, unknown> | undefined {
  const data = record(details);
  const structured = record(data?.structuredContent);
  if (structured) return structured;
  if (data && ('code' in data || 'data' in data || 'subject' in data || 'messages' in data || 'header' in data || 'drafts' in data || 'operation_summary' in data)) return data;
  // Tool text is a fallback for runtimes that do not forward structuredContent.
  if (!text || text.length > 2_000_000) return undefined;
  try {
    const parsed = record(JSON.parse(text));
    return record(parsed?.structuredContent) ?? parsed;
  } catch {
    return undefined;
  }
}

/** Normalize only recognized mail results; leave unknown payloads in the existing tool view. */
export function getNeteaseMailPresentation(input: {
  toolName: string; details?: unknown; text?: string; isError?: boolean;
}): NeteaseMailPresentation | null {
  const tool = resolveNeteaseMailTool(input.toolName);
  if (!tool) return null;
  if (input.isError && input.text) {
    if (input.text.includes('NETEASE_MAIL_AUTH_EXPIRED')) return { kind: NeteaseMailView.Notice, code: NeteaseMailError.Unauthorized };
    if (input.text.includes('NETEASE_MAIL_RATE_LIMITED')) return { kind: NeteaseMailView.Notice, code: NeteaseMailError.RateLimited };
  }
  const envelope = payloadOf(input.details, input.text);
  if (!envelope) return null;
  const data = record(envelope.data) ?? envelope;
  const rawCode = envelope.code ?? record(envelope.error)?.code ?? data.code;
  const code = typeof rawCode === 'number' ? rawCode : typeof rawCode === 'string' ? Number(rawCode) : undefined;
  if (code === NeteaseMailError.ConfirmationRequired && CONFIRMATION_TOOLS.has(tool)) {
    const summary = message(data.operation_summary ?? envelope.operation_summary);
    if (!summary) return { kind: NeteaseMailView.Notice, code: NeteaseMailFailure.InvalidRequest };
    return {
      kind: NeteaseMailView.Message, mode: NeteaseMailMessageMode.Confirmation, tool, message: summary,
      // Do not extend a historical confirmation by inventing a new deadline on render.
      expiresAt: expiry(data.expires_at ?? envelope.expires_at),
    };
  }
  if (code !== undefined && ERROR_CODES.has(code)) return { kind: NeteaseMailView.Notice, code: code as NeteaseMailError };
  if (input.isError) return { kind: NeteaseMailView.Notice, code: NeteaseMailFailure.Failed };
  if (LIST_TOOLS.has(tool)) {
    const items = data.messages ?? data.drafts;
    if (!Array.isArray(items)) return null;
    const messages = items.map(message).filter((item): item is NeteaseMailMessage => item !== undefined);
    // Never silently hide an unreadable result or truncate a valid provider page.
    if (messages.length !== items.length) return null;
    return { kind: NeteaseMailView.List, messages, hasMore: Boolean(data.next_cursor), ...(data.truncated === true ? { truncated: true } : {}) };
  }
  if (tool === NeteaseMailTool.GetMessage || tool === NeteaseMailTool.CreateDraft) {
    const parsed = message(data.message ?? data.draft ?? data);
    return parsed ? {
      kind: NeteaseMailView.Message, tool,
      mode: tool === NeteaseMailTool.CreateDraft ? NeteaseMailMessageMode.Draft : NeteaseMailMessageMode.Read,
      message: parsed,
    } : null;
  }
  return null;
}

export function getNeteaseMailLimitKeys(value: NeteaseMailMessage): string[] {
  const keys: string[] = [];
  if (value.to.length + value.cc.length + value.bcc.length > NeteaseMailLimits.Recipients) keys.push('neteaseMailRecipientLimit');
  if (Array.from(value.subject).length > NeteaseMailLimits.SubjectCharacters) keys.push('neteaseMailSubjectLimit');
  if (value.attachments.length > NeteaseMailLimits.AttachmentCount
    || value.attachments.some(item => (item.size ?? 0) > NeteaseMailLimits.AttachmentBytes)
    || value.attachments.reduce((size, item) => size + (item.size ?? 0), 0) > NeteaseMailLimits.TotalAttachmentBytes) {
    keys.push('neteaseMailAttachmentLimit');
  }
  return keys;
}

export function getNeteaseMailErrorKey(code: NeteaseMailError | NeteaseMailFailure): string {
  switch (code) {
    case NeteaseMailError.InvalidArgument: return 'neteaseMailInvalidArgument';
    case NeteaseMailError.AttachmentSizeMismatch:
    case NeteaseMailError.AttachmentHashMismatch: return 'neteaseMailAttachmentMismatch';
    case NeteaseMailError.ConfirmationChanged: return 'neteaseMailChanged';
    case NeteaseMailError.Unauthorized: return 'neteaseMailUnauthorized';
    case NeteaseMailError.InsufficientScope: return 'neteaseMailInsufficientScope';
    case NeteaseMailError.RateLimited: return 'neteaseMailRateLimited';
    case NeteaseMailFailure.NotReady: return 'neteaseMailSendPending';
    case NeteaseMailFailure.Unavailable: return 'neteaseMailUnavailable';
    case NeteaseMailFailure.PortBusy: return 'neteaseMailPortBusy';
    case NeteaseMailFailure.TimedOut: return 'neteaseMailAuthTimeout';
    case NeteaseMailFailure.Denied: return 'neteaseMailAuthDenied';
    case NeteaseMailFailure.StorageFailed: return 'neteaseMailStorageFailed';
    case NeteaseMailFailure.SyncFailed: return 'neteaseMailSyncFailed';
    case NeteaseMailError.ConfirmationRequired:
    case NeteaseMailFailure.InvalidRequest: return 'neteaseMailConfirmationIncomplete';
    default: return 'neteaseMailFailed';
  }
}
