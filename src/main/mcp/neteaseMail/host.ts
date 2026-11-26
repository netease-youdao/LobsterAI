import { Type } from '@sinclair/typebox';

import { DSH_SESSION_ID_PREFIX } from '../../../shared/dshEngine/hostConstants';
import type { NeteaseMailConfirmationReference, NeteaseMailConfirmationRequest } from '../../../shared/neteaseMail/types';
import type { HostToolProvider } from '../../libs/dsh/dshHostBridgeWiring';
import type { McpOAuthManager } from '../mcpOAuthManager';
import type { McpServerRecord } from '../mcpStore';
import type { NeteaseMailOAuthConfig } from '../neteaseMailConfig';
import { connectMailClient } from './client';
import { MailConfirmations } from './confirmation';
import { failureCode, MAIL_CONFIRMATION_MS, MAIL_FAILURE_CODES, MailCode, MailForwardMode, type MailResult, mailResult, MailScope, MailStatus, MailTool, payload, record, responseCode, responseData } from './protocol';
import { trashMessageSummary } from './trash';

const addressList = Type.Array(Type.String({ minLength: 1, maxLength: 254 }), { maxItems: 20 });
const messageId = Type.String({ minLength: 1, maxLength: 512 });
const composeFields = {
  to: addressList, cc: Type.Optional(addressList), bcc: Type.Optional(addressList),
  subject: Type.String({ maxLength: 998 }), body: Type.String(),
  body_format: Type.Optional(Type.Union([Type.Literal('PLAIN'), Type.Literal('HTML')])),
  attachments: Type.Optional(Type.Array(Type.Object({
    file_name: Type.String({ minLength: 1, maxLength: 255 }), content_type: Type.String({ maxLength: 128 }),
    content_base64: Type.String({ maxLength: 1_398_104 }), declared_size: Type.Integer({ minimum: 0, maximum: 1_048_576 }),
    declared_sha1: Type.Optional(Type.String()),
  }, { additionalProperties: false }), { maxItems: 3 })),
};
const schemas = {
  [MailTool.Send]: Type.Object(composeFields, { additionalProperties: false }),
  [MailTool.Reply]: Type.Object({ ...composeFields, message_id: messageId, reply_all: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  [MailTool.Forward]: Type.Object({ ...composeFields, message_id: messageId, mode: Type.Union([Type.Literal(MailForwardMode.Quote), Type.Literal(MailForwardMode.Attach)]) }, { additionalProperties: false }),
  [MailTool.Trash]: Type.Object({ message_id: messageId }, { additionalProperties: false }),
};
const descriptions = {
  [MailTool.Send]: 'Prepare a new email and wait for the user to click Send on the LobsterAI card.',
  [MailTool.Reply]: 'Reply to a message. Recipients and a nonempty subject must be explicit. Wait for the user to click Send reply on the LobsterAI card.',
  [MailTool.Forward]: 'Forward a message as quote or attachment. Provide a nonempty subject. Wait for the user to click Forward on the LobsterAI card.',
  [MailTool.Trash]: 'Move one email to trash (recoverable for 30 days). Wait for the user to click Move to trash on the LobsterAI card.',
};

interface MailHostDeps {
  config?: NeteaseMailOAuthConfig;
  getServer: () => McpServerRecord | undefined;
  getManager: () => McpOAuthManager | null;
  getSession: (id: string) => { claudeSessionId: string | null; imPlatform?: string | null; scheduledTaskId?: string | null } | null;
  getTurnSignal: (id: string) => AbortSignal | undefined;
  publish: (sessionId: string, callId: string, result: MailResult) => void;
  fetch: typeof fetch;
}

export class NeteaseMailHost implements HostToolProvider {
  private readonly pending = new MailConfirmations();
  constructor(private readonly deps: MailHostDeps) {}

  private grant() {
    const server = this.deps.getServer();
    const manager = this.deps.getManager();
    const token = server?.enabled && manager ? manager.getToken(server.id) : null;
    if (!server || !manager || !this.deps.config || !token?.mailAuthorizationId || token.clientId !== this.deps.config.clientId) return undefined;
    return { id: token.mailAuthorizationId, scopes: token.scope?.split(/\s+/) ?? [],
      serverId: server.id, manager, endpoint: this.deps.config.mcpUrl };
  }

  invalidate() { this.pending.invalidate(); }

  status(ref: NeteaseMailConfirmationReference) {
    return this.pending.status(ref.confirmationId, ref.toolCallId, this.grant()?.id);
  }

  resolve(request: NeteaseMailConfirmationRequest) {
    return this.pending.resolve(request.confirmationId, request.toolCallId, request.action, this.grant()?.id);
  }

  listDescriptors() {
    const scopes = this.grant()?.scopes ?? [];
    return Object.entries(schemas).filter(([name]) => scopes.includes(name === MailTool.Trash ? MailScope.Delete : MailScope.Send))
      .map(([name, inputSchema]) => ({ name, inputSchema, timeoutMs: MAIL_CONFIRMATION_MS + 120_000,
        description: descriptions[name as keyof typeof descriptions] + ' The card click is required even if chat text approves. Return the final result. Never repeat an ambiguous or rate-limited operation.' }));
  }

  async execute(name: string, args: Record<string, unknown>, context: Parameters<HostToolProvider['execute']>[2]) {
    const { coworkSessionId, callId: toolCallId } = context;
    if (!coworkSessionId) return mailResult({ code: MailCode.Scope }, true);
    const session = this.deps.getSession(coworkSessionId);
    const turn = this.deps.getTurnSignal(coworkSessionId);
    const boundSession = context.sessionId && (session?.claudeSessionId === context.sessionId
      || session?.claudeSessionId === DSH_SESSION_ID_PREFIX + context.sessionId);
    if (!Object.hasOwn(schemas, name) || !session || !turn || !toolCallId || !boundSession
      || session.imPlatform || session.scheduledTaskId) {
      return mailResult({ code: MailCode.Scope }, true);
    }
    if ((name === MailTool.Reply || name === MailTool.Forward) && !String(args.subject ?? '').trim()) return mailResult({ code: MailCode.Invalid }, true);
    const grant = this.grant();
    const scope = name === MailTool.Trash ? MailScope.Delete : MailScope.Send;
    if (!grant?.scopes.includes(scope)) return mailResult({ code: MailCode.Scope }, true);
    const signal = context.signal ? AbortSignal.any([turn, context.signal]) : turn;
    const assertGrant = () => {
      signal.throwIfAborted();
      if (this.grant()?.id !== grant.id) throw new Error(String(MailCode.Unauthorized));
    };
    let client: Awaited<ReturnType<typeof connectMailClient>> | undefined;
    try {
      client = await connectMailClient(grant, assertGrant, this.deps.fetch);
      let summary: Record<string, unknown>;
      if (name === MailTool.Trash) {
        const result = await client.call(MailTool.Get, { message_id: args.message_id, mark_read: false }, signal);
        const original = trashMessageSummary(result, args.message_id);
        if (!original) {
          const code = responseCode(payload(result));
          return mailResult({ code: MAIL_FAILURE_CODES.has(code) ? code : MailCode.Invalid }, true);
        }
        summary = original;
      } else {
        const profile = payload(await client.call(MailTool.Profile, {}, signal));
        if (MAIL_FAILURE_CODES.has(responseCode(profile))) return mailResult({ code: responseCode(profile) }, true);
        const data = responseData(profile);
        const account = [data.primary_account, data.email, data.account, record(data.account)?.email, record(data.profile)?.email]
          .find(value => typeof value === 'string' && value.includes('@'));
        if (typeof account !== 'string' || !account.includes('@')) return mailResult({ code: MailCode.Scope }, true);
        summary = { ...args, from: [account], attachments: Array.isArray(args.attachments)
          ? args.attachments.map(item => ({ filename: item.file_name, size: item.declared_size, mime_type: item.content_type })) : [] };
        if (name === MailTool.Forward) {
          let source = payload(await client.call(MailTool.Get, { message_id: args.message_id, body_format: 'PLAIN', mark_read: false }, signal));
          let originalData = responseData(source);
          let original = record(originalData.message) ?? originalData;
          if (original.body === '' || record(original.body)?.content === '') {
            source = payload(await client.call(MailTool.Get, { message_id: args.message_id, body_format: 'HTML', mark_read: false }, signal));
            originalData = responseData(source);
            original = record(originalData.message) ?? originalData;
          }
          if (responseCode(source) !== 0 && responseCode(source) !== 200) return mailResult({ code: responseCode(source) }, true);
          if (typeof (record(original.header) ?? original).subject !== 'string'
            || (typeof original.body !== 'string' && typeof record(original.body)?.content !== 'string')) {
            return mailResult({ code: MailCode.Invalid }, true);
          }
          // The service adds quoted content or the original message as an
          // attachment. Show that source separately from the user's new body.
          const originalHeader = record(original.header) ?? original;
          // Keep this flat: gateway tool-update depth limits truncate a
          // nested source_message.header and its attachment array.
          summary.source_subject = originalHeader.subject;
          summary.source_from = originalHeader.from;
          summary.source_body = typeof original.body === 'string' ? original.body : record(original.body)?.content;
          summary.source_body_format = record(original.body)?.format ?? original.body_format;
          summary.source_attachment_names = Array.isArray(original.attachments)
            ? original.attachments.map(item => item.filename ?? item.file_name ?? item.name).filter(value => typeof value === 'string') : [];
          summary.forward_mode = args.mode;
        }
      }
      return await this.pending.execute({ tool: name, toolCallId, grantId: grant.id, args, summary,
        assertGrant, call: client.call, signal, onUpdate: result => this.deps.publish(coworkSessionId, toolCallId, result) });
    } catch (error) {
      return mailResult({ code: failureCode(error), status: MailStatus.Failed }, true);
    } finally { await client?.close(); }
  }
}
