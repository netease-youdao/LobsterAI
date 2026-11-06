import { expect, test } from 'vitest';

import { MailCode } from '../openclaw-extensions/netease-mail/protocol';
import { trashMessageSummary } from '../openclaw-extensions/netease-mail/trash';
import { getNeteaseMailPresentation } from '../src/renderer/services/neteaseMailPresentation';
import { NeteaseMailBodyFormat, NeteaseMailMessageMode, NeteaseMailTool } from '../src/shared/neteaseMail/constants';

const original = {
  message_id: 'received-id',
  header: { from: ['sender@example.com'], to: ['self@example.com'], subject: 'Delete this sample', sent_date: 1793956059000 },
  body: { content: 'Original message', format: NeteaseMailBodyFormat.Plain },
  attachments: [{ filename: 'note.txt', size: 32, part_id: 'part-1' }],
};

test('deletion previews preserve the verified message identity and flatten real nested mail fields', () => {
  const summary = trashMessageSummary({ structuredContent: original }, original.message_id);
  expect(summary).toMatchObject({ message_id: original.message_id, subject: original.header.subject,
    body: original.body.content, body_format: original.body.format, sent_date: original.header.sent_date });
  expect(summary).not.toHaveProperty('header');
  expect(getNeteaseMailPresentation({ toolName: NeteaseMailTool.TrashMessage, details: {
    code: MailCode.Confirmation, data: { operation_summary: summary, confirmation_id: 'pending', expires_at: Date.now() + 300_000 },
  } })).toMatchObject({ mode: NeteaseMailMessageMode.Confirmation,
    message: { id: original.message_id, subject: original.header.subject, body: original.body.content,
      from: [{ email: 'sender@example.com' }], attachments: [{ name: 'note.txt', size: 32 }] } });
  expect(trashMessageSummary({ structuredContent: { data: { message: { ...original, body: '' } } } }, original.message_id))
    .toMatchObject({ message_id: original.message_id, body: '' });
});

test.each([
  { structuredContent: { ...original, message_id: 'different-message' } },
  { structuredContent: { ...original, message_id: undefined } },
  { structuredContent: { ...original, header: {} } },
  { structuredContent: original, isError: true },
  { structuredContent: { error: { code: String(MailCode.Limited), details: original } } },
  { structuredContent: { code: 500, data: original } },
])('an unreadable or mismatched source cannot become a deletion preview', result => {
  expect(trashMessageSummary(result, original.message_id)).toBeUndefined();
});
