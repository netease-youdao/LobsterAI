import { type FSWatcher, watch } from 'node:fs';

import { Type } from '@sinclair/typebox';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/provider-auth';

import { AUTHORIZATION_FILE, readMailAuthorization } from './authorization';
import { connectMailClient } from './client';
import { getMailConfirmations } from './confirmation';
import { failureCode, MAIL_FAILURE_CODES, MAIL_PROFILE_ID, MailAction, MailCode, MailForwardMode, type MailResult, mailResult, MailRpc, MailScope, MailStatus, MailTool, payload, record, responseCode, responseData } from './protocol';
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

function managedEndpoint(config: OpenClawConfig): string | undefined {
  const entry = Object.values(config.mcp?.servers ?? {}).find(server =>
    server.enabled !== false && server.oauth?.authProfileId === MAIL_PROFILE_ID);
  if (!entry?.url) return undefined;
  try {
    const url = new URL(entry.url);
    return url.protocol === 'https:' && !url.username && !url.password ? entry.url : undefined;
  } catch { return undefined; }
}

export function registerMailTools(api: OpenClawPluginApi, clientId: string): void {
  const stateDir = api.runtime.state.resolveStateDir();
  const pending = getMailConfirmations(stateDir);
  const authorization = () => readMailAuthorization(stateDir, clientId);
  let watcher: FSWatcher | undefined;
  api.registerService({
    id: 'netease-mail-confirmations',
    start: () => {
      watcher = watch(stateDir, { persistent: false }, (_event, filename) => {
        if (filename === AUTHORIZATION_FILE) pending.invalidate(authorization()?.id);
      });
    },
    stop: () => { watcher?.close(); pending.invalidate(); },
  });
  for (const method of [MailRpc.Status, MailRpc.Resolve]) {
    api.registerGatewayMethod(method, ({ params, respond }) => {
      const id = typeof params.confirmationId === 'string' ? params.confirmationId : '';
      const toolCallId = typeof params.toolCallId === 'string' ? params.toolCallId : '';
      const grantId = authorization()?.id;
      if (method === MailRpc.Status) {
        respond(true, { pending: pending.status(id, toolCallId, grantId) });
      } else {
        const success = pending.resolve(id, toolCallId, params.action, grantId);
        respond(true, success ? { success: true, outcome: params.action === MailAction.Cancel ? 'cancelled' : 'submitted' }
          : { success: false, code: MailCode.Changed });
      }
    }, { scope: 'operator.approvals' });
  }
  api.registerTool(ctx => {
    // Subagents, cron and IM cannot display a trusted desktop confirmation.
    if (!/^(?:agent:[^:]+:)?lobsterai:[^:]+$/.test(ctx.sessionKey ?? '')) return null;
    const config = () => (ctx.getRuntimeConfig?.() ?? api.runtime.config.current()) as OpenClawConfig;
    const grant = authorization();
    if (!grant || !managedEndpoint(config())) return null;
    return Object.entries(schemas).filter(([name]) => grant.scopes.includes(name === MailTool.Trash ? MailScope.Delete : MailScope.Send))
      .map(([name, parameters]) => ({
        name, label: 'NetEase Mail', parameters,
        description: `${descriptions[name as keyof typeof descriptions]} This call waits for the card action and returns the final outcome. A submitted or trashed result means the user already approved and the email service accepted the execution; no further click or execution is needed. Text approval cannot replace the card. Do not retry an unknown outcome or repeat an operation. Quota errors must be reported to the user without queuing.`,
        async execute(toolCallId: string, raw: unknown, signal?: AbortSignal, onUpdate?: (result: MailResult) => void) {
          const args = record(raw);
          if (!args || !onUpdate) return mailResult({ code: MailCode.Invalid }, true);
          if ((name === MailTool.Reply || name === MailTool.Forward) && !String(args.subject ?? '').trim()) return mailResult({ code: MailCode.Invalid }, true);
          const currentGrant = authorization();
          const endpoint = managedEndpoint(config());
          const requiredScope = name === MailTool.Trash ? MailScope.Delete : MailScope.Send;
          if (!currentGrant?.scopes.includes(requiredScope) || !endpoint) return mailResult({ code: MailCode.Scope }, true);
          const assertGrant = () => {
            if (authorization()?.id !== currentGrant.id || !authorization()?.scopes.includes(requiredScope)
              || managedEndpoint(config()) !== endpoint) throw new Error(String(MailCode.Unauthorized));
          };
          let client: Awaited<ReturnType<typeof connectMailClient>> | undefined;
          try {
            client = await connectMailClient({ stateDir, clientId, endpoint, requiredScope, grantId: currentGrant.id, config });
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
            return await pending.execute({ tool: name, toolCallId, grantId: currentGrant.id, args, summary,
              assertGrant, call: client.call, signal, onUpdate });
          } catch (error) {
            return mailResult({ code: failureCode(error), status: MailStatus.Failed }, true);
          } finally { await client?.close(); }
        },
      }));
  }, { names: Object.keys(schemas) });
}
