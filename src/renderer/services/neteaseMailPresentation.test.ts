import { describe, expect, test } from 'vitest';

import {
  NeteaseMailBodyFormat, NeteaseMailError, NeteaseMailFailure, NeteaseMailLimits,
  NeteaseMailMessageMode, NeteaseMailTool, NeteaseMailView,
} from '../../shared/neteaseMail/constants';
import type { NeteaseMailMessage } from '../../shared/neteaseMail/types';
import { getNeteaseMailLimitKeys, getNeteaseMailPresentation, resolveNeteaseMailTool } from './neteaseMailPresentation';

const summary = { from: { name: 'Sender', email: 'sender@example.com' }, to: ['to@example.com'], cc: ['cc@example.com'], bcc: ['bcc@example.com'], subject: 'Review', body: 'Body', attachments: [{ att_id: 'a', filename: 'notes.pdf', size: 1024 }] };

describe('mail result presentation', () => {
  test('renders the real nested header schema and millisecond dates without inventing read status', () => {
    const date = Date.parse('2026-11-04T06:00:00Z');
    expect(getNeteaseMailPresentation({ toolName: NeteaseMailTool.GetMessage, details: {
      message_id: 'synthetic-id', header: { subject: '项目进展', from: ['sender@example.com'], to: ['to@example.com'], cc: ['cc@example.com'], sent_date: date },
      body: '<p>正文</p>', body_format: NeteaseMailBodyFormat.Html, content_trust: 'UNTRUSTED_EMAIL',
      attachments: [{ part_id: 'part-1', filename: 'notes.pdf', size: 100 }],
    } })).toMatchObject({ kind: NeteaseMailView.Message, message: {
      subject: '项目进展', from: [{ email: 'sender@example.com' }], cc: [{ email: 'cc@example.com' }],
      date: new Date(date).toISOString(), format: NeteaseMailBodyFormat.Html, unread: undefined,
      attachments: [{ id: 'part-1', name: 'notes.pdf' }],
    } });
    expect(getNeteaseMailPresentation({ toolName: NeteaseMailTool.SearchMessages, details: {
      messages: [{ subject: '项目进展', from: 'sender@example.com', received_date: date, flags: {} }],
      truncated: true, pagination_supported: false,
    } })).toMatchObject({ kind: NeteaseMailView.List, hasMore: false, truncated: true, messages: [{ date: new Date(date).toISOString(), unread: undefined }] });
  });
  test('recognizes actual MCP tool suffixes without treating arbitrary matching text as a tool', () => {
    expect(resolveNeteaseMailTool(`mcp__mail__${NeteaseMailTool.GetMessage}`)).toBe(NeteaseMailTool.GetMessage);
    expect(resolveNeteaseMailTool(`fake${NeteaseMailTool.GetMessage}`)).toBeUndefined();
    expect(getNeteaseMailPresentation({ toolName: 'exec', details: summary })).toBeNull();
  });

  test('projects all recipients and attachment metadata without forwarding a confirmation token', () => {
    const result = getNeteaseMailPresentation({ toolName: NeteaseMailTool.SendMessage, isError: true, details: { structuredContent: {
      code: NeteaseMailError.ConfirmationRequired, operation_summary: summary,
      expires_at: '2026-10-28T07:05:00Z', confirmation_token: 'private-confirmation-token',
    } } });
    expect(result).toMatchObject({ kind: NeteaseMailView.Message, mode: NeteaseMailMessageMode.Confirmation, expiresAt: Date.parse('2026-10-28T07:05:00Z'), message: {
      from: [{ name: 'Sender', email: 'sender@example.com' }], cc: [{ email: 'cc@example.com' }], bcc: [{ email: 'bcc@example.com' }],
      attachments: [{ id: 'a', name: 'notes.pdf', size: 1024 }],
    } });
    expect(JSON.stringify(result)).not.toContain('private-confirmation-token');
  });

  test('does not invent a deadline for a historical confirmation or invent a missing summary', () => {
    const result = getNeteaseMailPresentation({ toolName: NeteaseMailTool.SendMessage, details: { code: NeteaseMailError.ConfirmationRequired, operation_summary: summary } });
    expect(result).toMatchObject({ expiresAt: undefined });
    expect(getNeteaseMailPresentation({ toolName: NeteaseMailTool.SendMessage, details: { code: NeteaseMailError.ConfirmationRequired } }))
      .toEqual({ kind: NeteaseMailView.Notice, code: NeteaseMailFailure.InvalidRequest });
  });

  test('supports a JSON tool result fallback and leaves unknown wire shapes untouched', () => {
    expect(getNeteaseMailPresentation({ toolName: NeteaseMailTool.GetMessage, text: JSON.stringify({ data: summary }) }))
      .toMatchObject({ kind: NeteaseMailView.Message, message: { subject: 'Review' } });
    expect(getNeteaseMailPresentation({ toolName: NeteaseMailTool.GetMessage, text: 'upstream returned unexpected text' })).toBeNull();
    expect(getNeteaseMailPresentation({ toolName: NeteaseMailTool.GetMessage, details: { data: summary }, isError: true }))
      .toEqual({ kind: NeteaseMailView.Notice, code: NeteaseMailFailure.Failed });
  });

  test('returns rate limits as notices and preserves list pagination', () => {
    expect(getNeteaseMailPresentation({ toolName: NeteaseMailTool.SearchMessages, details: { code: String(NeteaseMailError.RateLimited) } }))
      .toEqual({ kind: NeteaseMailView.Notice, code: NeteaseMailError.RateLimited });
    expect(getNeteaseMailPresentation({ toolName: NeteaseMailTool.ListMessages, details: { data: { messages: [summary], next_cursor: 'next' } } }))
      .toMatchObject({ kind: NeteaseMailView.List, hasMore: true, messages: [{ subject: 'Review' }] });
    expect(getNeteaseMailPresentation({ toolName: NeteaseMailTool.ListMessages, details: { messages: [summary, { unknown: true }] } })).toBeNull();
  });
});

test('mail limits accept exact boundaries and report excess without modifying the email', () => {
  const message: NeteaseMailMessage = {
    from: [], to: Array.from({ length: NeteaseMailLimits.Recipients }, (_, index) => ({ email: `${index}@example.com` })), cc: [], bcc: [],
    subject: '字'.repeat(NeteaseMailLimits.SubjectCharacters), body: '', format: NeteaseMailBodyFormat.Plain,
    attachments: Array.from({ length: NeteaseMailLimits.AttachmentCount }, (_, index) => ({ name: `${index}.pdf`, size: NeteaseMailLimits.AttachmentBytes })),
  };
  expect(getNeteaseMailLimitKeys(message)).toEqual([]);
  const excessive = { ...message, bcc: [{ email: 'extra@example.com' }], subject: `${message.subject}字`, attachments: [...message.attachments, { name: 'large.pdf', size: NeteaseMailLimits.AttachmentBytes + 1 }] };
  expect(getNeteaseMailLimitKeys(excessive)).toEqual(['neteaseMailRecipientLimit', 'neteaseMailSubjectLimit', 'neteaseMailAttachmentLimit']);
  expect(excessive.attachments).toHaveLength(4);
});
