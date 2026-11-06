import { payload, record, responseCode, responseData } from './protocol';

/** Keep the identity checked by the service and flatten fields for streamed cards. */
export function trashMessageSummary(result: unknown, messageId: unknown): Record<string, unknown> | undefined {
  const envelope = payload(result);
  const code = responseCode(envelope);
  const data = responseData(envelope);
  const source = record(data.message) ?? data;
  const header = record(source.header) ?? source;
  if (record(result)?.isError || (code !== 0 && code !== 200)
    || typeof messageId !== 'string' || !messageId.trim() || source.message_id !== messageId
    || typeof header.subject !== 'string') return undefined;
  const body = record(source.body);
  return {
    message_id: messageId, subject: header.subject,
    from: header.from, to: header.to, cc: header.cc, bcc: header.bcc,
    sent_date: header.sent_date, body: typeof source.body === 'string' ? source.body : body?.content,
    body_format: source.body_format ?? body?.format, attachments: source.attachments,
  };
}
