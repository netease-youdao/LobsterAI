import { configureStore } from '@reduxjs/toolkit';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { expect, test } from 'vitest';

import { NeteaseMailBodyFormat, NeteaseMailError, NeteaseMailLimits, NeteaseMailMessageMode, NeteaseMailTool, NeteaseMailView } from '../../../shared/neteaseMail/constants';
import type { NeteaseMailMessage } from '../../../shared/neteaseMail/types';
import { i18nService } from '../../services/i18n';
import type { CoworkMessage } from '../../types/cowork';
import AssistantTurnBlock from '../cowork/AssistantTurnBlock';
import { buildConversationTurns, buildDisplayItems } from '../cowork/messageDisplayUtils';
import NeteaseMailCard from './NeteaseMailCard';
import { buildNeteaseMailPresentations } from './NeteaseMailToolResult';

const message: NeteaseMailMessage = {
  from: [{ email: 'sender@example.com' }], to: [{ email: 'reader@example.com' }],
  cc: [], bcc: [{ email: 'archive@example.com' }], subject: 'Test subject',
  body: 'Test body', format: NeteaseMailBodyFormat.Plain, attachments: [],
};
const confirmation = {
  kind: NeteaseMailView.Message, mode: NeteaseMailMessageMode.Confirmation,
  tool: NeteaseMailTool.SendMessage, message,
} as const;

test('pending and expired confirmation cards cannot send without an available adapter', () => {
  const pending = renderToStaticMarkup(React.createElement(NeteaseMailCard, { presentation: { ...confirmation, expiresAt: Date.now() + 300_000 } }));
  expect(pending).toContain(i18nService.t('neteaseMailSendPending'));
  expect(pending.match(/disabled=""/g)).toHaveLength(2);
  expect(pending).toContain('archive@example.com');
  const expired = renderToStaticMarkup(React.createElement(NeteaseMailCard, { presentation: { ...confirmation, expiresAt: Date.now() - 1 }, actionsAvailable: true }));
  expect(expired).toContain(i18nService.t('neteaseMailExpired'));
  expect(expired.match(/disabled=""/g)).toHaveLength(2);
});

test('a quota notice explains the limit without offering an automatic action', () => {
  const html = renderToStaticMarkup(React.createElement(NeteaseMailCard, { presentation: { kind: NeteaseMailView.Notice, code: NeteaseMailError.RateLimited } }));
  expect(html).toContain(i18nService.t('neteaseMailRateLimited'));
  expect(html).toContain(i18nService.t('neteaseMailQuota'));
  expect(html).not.toContain('<button');
});

test('deleting existing mail requires its identity but does not apply sending limits', () => {
  const received = {
    ...message, id: 'received-id', from: [],
    subject: 'x'.repeat(NeteaseMailLimits.SubjectCharacters + 1),
    to: Array.from({ length: NeteaseMailLimits.Recipients + 1 }, () => ({ email: 'reader@example.com' })),
    attachments: Array.from({ length: NeteaseMailLimits.AttachmentCount + 1 }, () => ({ name: 'large.pdf', size: NeteaseMailLimits.AttachmentBytes + 1 })),
  };
  const presentation = { ...confirmation, tool: NeteaseMailTool.TrashMessage, message: received, expiresAt: Date.now() + 300_000 };
  const props = { actionsAvailable: true, onAction: async () => ({ success: false as const, code: NeteaseMailError.InvalidArgument }) };
  const html = renderToStaticMarkup(React.createElement(NeteaseMailCard, { ...props, presentation }));
  expect(html).toContain(i18nService.t('neteaseMailDeleteWarning'));
  expect(html).toContain(i18nService.t('neteaseMailTrash'));
  expect(html).not.toContain('disabled=""');
  expect(html).not.toContain(i18nService.t('neteaseMailRecipientLimit'));
  expect(html).not.toContain(i18nService.t('neteaseMailSubjectLimit'));
  expect(html).not.toContain(i18nService.t('neteaseMailAttachmentLimit'));
  const unidentified = renderToStaticMarkup(React.createElement(NeteaseMailCard, {
    ...props, presentation: { ...presentation, message: { ...received, id: undefined } },
  }));
  expect(unidentified).toContain(i18nService.t('neteaseMailConfirmationIncomplete'));
  expect(unidentified.match(/disabled=""/g)).toHaveLength(1);
  const sending = renderToStaticMarkup(React.createElement(NeteaseMailCard, {
    ...props, presentation: { ...presentation, tool: NeteaseMailTool.SendMessage, message: { ...received, from: message.from } },
  }));
  expect(sending).toContain(i18nService.t('neteaseMailAttachmentLimit'));
  expect(sending.match(/disabled=""/g)).toHaveLength(1);
});

test('mail content is not executed as markup in the plain-text card', () => {
  const html = renderToStaticMarkup(React.createElement(NeteaseMailCard, { presentation: {
    ...confirmation, message: { ...message, subject: '<img src=x onerror=alert(1)>', body: '<script>alert(1)</script>' },
  } }));
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<img');
});

test('an empty plain-text body offers HTML reading while a list without previews does not claim empty mail', () => {
  const emptyMessage = { ...message, body: '' };
  const html = renderToStaticMarkup(React.createElement(NeteaseMailCard, { presentation: {
    kind: NeteaseMailView.Message, mode: NeteaseMailMessageMode.Read, tool: NeteaseMailTool.GetMessage, message: emptyMessage,
  } }));
  expect(html).toContain(i18nService.t('neteaseMailEmptyPlain'));
  const list = renderToStaticMarkup(React.createElement(NeteaseMailCard, { presentation: { kind: NeteaseMailView.List, messages: [emptyMessage], hasMore: false } }));
  expect(list).not.toContain(i18nService.t('neteaseMailNoBody'));
});

test('mail results remain visible when a completed conversation folds its process', () => {
  const store = configureStore({ reducer: {
    auth: () => ({ creditQuotaSnapshot: null }),
    cowork: () => ({ isStreaming: false }),
  } });
  const messages: CoworkMessage[] = [
    { id: 'user', type: 'user', content: '查邮件', timestamp: 1000 },
    { id: 'thinking', type: 'assistant', content: '查找邮件', timestamp: 2000, metadata: { isThinking: true } },
    { id: 'tool', type: 'tool_use', content: '', timestamp: 3000, metadata: { toolName: NeteaseMailTool.GetMessage, toolUseId: 'call' } },
    { id: 'result', type: 'tool_result', content: '', timestamp: 4000, metadata: { toolUseId: 'call', toolResultDetails: { structuredContent: { subject: 'Visible email subject', from: 'sender@example.com', body: 'Visible email body' } } } },
    { id: 'answer', type: 'assistant', content: '找到这封邮件。', timestamp: 5000 },
  ];
  const turn = buildConversationTurns(buildDisplayItems(messages))[0];
  const html = renderToStaticMarkup(React.createElement(Provider, {
    store, children: React.createElement(AssistantTurnBlock, { turn, isStreamingTurn: false }),
  }));
  expect(html).toContain('Visible email subject');
  expect(html).toContain('Visible email body');
  expect(html).toContain('aria-expanded="false"');
  expect(html.match(/data-netease-mail-card="read"/g)).toHaveLength(1);
});

test('a streaming confirmation is visible while the tool waits, but incomplete ordinary results are not', () => {
  const use: CoworkMessage = { id: 'use', type: 'tool_use', content: '', timestamp: 1,
    metadata: { toolName: NeteaseMailTool.SendMessage, toolUseId: 'call' } };
  const result: CoworkMessage = { id: 'result', type: 'tool_result', content: '', timestamp: 2,
    metadata: { toolUseId: 'call', isFinal: false, isStreaming: true, toolResultDetails: {
      code: NeteaseMailError.ConfirmationRequired, data: { confirmation_id: 'confirmation', expires_at: Date.now() + 300_000,
        operation_summary: { from: ['self@example.com'], to: ['self@example.com'], subject: 'Review', body: 'Body' } },
    } } };
  const presentations = buildNeteaseMailPresentations([{ type: 'tool_group', group: { type: 'tool_group', toolUse: use, toolResult: result } }]);
  expect(presentations.get('use')).toMatchObject({ mode: NeteaseMailMessageMode.Confirmation, confirmationId: 'confirmation' });
  use.metadata!.toolName = NeteaseMailTool.GetMessage;
  result.metadata!.toolResultDetails = { subject: 'partial body', body: 'in progress' };
  expect(buildNeteaseMailPresentations([{ type: 'tool_group', group: { type: 'tool_group', toolUse: use, toolResult: result } }]).size).toBe(0);
});
