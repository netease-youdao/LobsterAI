import { CheckIcon, ChevronDownIcon, EnvelopeIcon, ExclamationTriangleIcon, PaperClipIcon } from '@heroicons/react/24/outline';
import DOMPurify from 'dompurify';
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';

import {
  NeteaseMailAction, NeteaseMailBodyFormat, NeteaseMailError, NeteaseMailFailure,
  NeteaseMailForwardMode, NeteaseMailLimits, NeteaseMailMessageMode, NeteaseMailOperationStatus, NeteaseMailOutcome, NeteaseMailTool, NeteaseMailView,
} from '../../../shared/neteaseMail/constants';
import type {
  NeteaseMailActionResult, NeteaseMailAddress, NeteaseMailPresentation,
} from '../../../shared/neteaseMail/types';
import { i18nService } from '../../services/i18n';
import { getNeteaseMailErrorKey, getNeteaseMailLimitKeys } from '../../services/neteaseMailPresentation';

type MessagePresentation = Extract<NeteaseMailPresentation, { kind: typeof NeteaseMailView.Message }>;

interface NeteaseMailCardProps {
  presentation: NeteaseMailPresentation;
  actionsAvailable?: boolean;
  onAction?: (action: NeteaseMailAction) => Promise<NeteaseMailActionResult>;
}

const frameClass = 'min-w-0 overflow-hidden rounded-2xl border border-border bg-surface text-foreground';
const buttonClass = 'rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45';
const operationStatusKeys: Record<NeteaseMailOperationStatus, string> = {
  [NeteaseMailOperationStatus.Submitted]: 'neteaseMailServerSubmitted',
  [NeteaseMailOperationStatus.Sent]: 'neteaseMailSent',
  [NeteaseMailOperationStatus.Trashed]: 'neteaseMailTrashed',
  [NeteaseMailOperationStatus.Cancelled]: 'neteaseMailCancelled',
  [NeteaseMailOperationStatus.Expired]: 'neteaseMailExpired',
  [NeteaseMailOperationStatus.Unknown]: 'neteaseMailUnknown',
  [NeteaseMailOperationStatus.Failed]: 'neteaseMailFailed',
};

function formatMailDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US');
}

function MailHeader({ label }: { label: string }) {
  return <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3.5">
    <div className="flex items-center gap-2.5 text-sm font-semibold">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/10 text-red-600 dark:text-red-400"><EnvelopeIcon className="h-5 w-5" aria-hidden="true" /></span>
      {i18nService.t('neteaseMailName')}
    </div>
    <span className="rounded-md bg-surface-raised px-2 py-1 text-xs text-secondary">{label}</span>
  </div>;
}

function AddressRow({ label, values }: { label: string; values: NeteaseMailAddress[] }) {
  if (!values.length) return null;
  return <div className="flex min-w-0 items-start gap-3 py-1.5 text-sm">
    <dt className="w-14 shrink-0 pt-0.5 text-secondary">{label}</dt>
    <dd className="flex min-w-0 flex-1 flex-wrap gap-1.5">
      {values.map((address, index) => <span key={`${address.email}-${index}`} className="max-w-full break-all rounded-md bg-surface-raised px-2 py-0.5">
        {address.name ? <><span className="font-medium">{address.name}</span> <span className="text-secondary">&lt;{address.email}&gt;</span></> : address.email}
      </span>)}
    </dd>
  </div>;
}

function MailBody({ content, format, reading = false }: { content: string; format: NeteaseMailBodyFormat; reading?: boolean }) {
  const html = useMemo(() => format === NeteaseMailBodyFormat.Html && typeof DOMPurify.sanitize === 'function'
    ? DOMPurify.sanitize(content, {
      ALLOWED_TAGS: ['p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr'],
      ALLOWED_ATTR: ['colspan', 'rowspan'],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
    }) : undefined, [content, format]);
  if (!content) return <p className="text-sm text-muted">{i18nService.t(reading && format === NeteaseMailBodyFormat.Plain ? 'neteaseMailEmptyPlain' : 'neteaseMailNoBody')}</p>;
  const style = 'break-words text-sm leading-7 [&_p]:mb-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_pre]:whitespace-pre-wrap [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:border-border [&_td]:p-2 [&_th]:border [&_th]:border-border [&_th]:p-2';
  if (html !== undefined) return <div className={style} dangerouslySetInnerHTML={{ __html: html }} />;
  if (format === NeteaseMailBodyFormat.Markdown) return <div className={style}>
    <ReactMarkdown components={{ a: ({ children }) => <span>{children}</span>, img: () => null }}>{content}</ReactMarkdown>
  </div>;
  return <div className={`${style} whitespace-pre-wrap`}>{content}</div>;
}

function MessageCard({ presentation, actionsAvailable = false, onAction }: NeteaseMailCardProps & { presentation: MessagePresentation }) {
  const { message, mode, tool, expiresAt } = presentation;
  const t = i18nService.t.bind(i18nService);
  const confirmation = mode === NeteaseMailMessageMode.Confirmation;
  const deleting = tool === NeteaseMailTool.TrashMessage;
  const [expanded, setExpanded] = useState(confirmation);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyOverflowing, setBodyOverflowing] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [outcome, setOutcome] = useState<NeteaseMailOutcome | null>(null);
  const [failure, setFailure] = useState<NeteaseMailError | NeteaseMailFailure | null>(null);
  const expired = expiresAt !== undefined && expiresAt <= now;
  // Received mail can exceed compose limits; deleting it does not upload or send it.
  const limitKeys = deleting ? [] : getNeteaseMailLimitKeys(message);
  const incomplete = expiresAt === undefined || (deleting ? !message.id : !message.from.length || !message.to.length);
  const disabled = busy || Boolean(outcome) || expired || incomplete || !actionsAvailable || !onAction || limitKeys.length > 0;
  const cancelDisabled = busy || Boolean(outcome) || expired || !actionsAvailable || !onAction;

  useEffect(() => {
    if (!confirmation || expiresAt === undefined || expired) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(Math.max(0, expiresAt - Date.now() + 1), 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [confirmation, expiresAt, expired, now]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || expanded) return;
    // Short messages with many line breaks can overflow too; measure the rendered body.
    const measure = () => setBodyOverflowing(body.scrollHeight > body.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    if (body.firstElementChild) observer.observe(body.firstElementChild);
    return () => observer.disconnect();
  }, [expanded, message.body, message.format]);

  const act = async (action: NeteaseMailAction) => {
    if ((action === NeteaseMailAction.Confirm ? disabled : cancelDisabled) || busyRef.current || !onAction || (expiresAt !== undefined && Date.now() >= expiresAt)) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const result = await onAction(action);
      if (!result.success) setFailure(result.code);
      else if (result.outcome === (action === NeteaseMailAction.Cancel ? NeteaseMailOutcome.Cancelled : NeteaseMailOutcome.Submitted)) setOutcome(result.outcome);
      else setFailure(NeteaseMailFailure.Failed);
    } catch {
      setFailure(NeteaseMailFailure.Unavailable);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const title = presentation.status ? t(operationStatusKeys[presentation.status])
    : confirmation ? t(deleting ? 'neteaseMailDeleteTitle' : 'neteaseMailConfirmTitle')
    : t(mode === NeteaseMailMessageMode.Draft ? 'neteaseMailDraft' : 'neteaseMailRead');
  const sendLabel = t(deleting ? 'neteaseMailTrash' : tool === NeteaseMailTool.ReplyMessage ? 'neteaseMailReply'
    : tool === NeteaseMailTool.ForwardMessage ? 'neteaseMailForward' : 'neteaseMailSend');

  return <article className={frameClass} aria-label={title} data-netease-mail-card={mode}>
    <MailHeader label={title} />
    {mode === NeteaseMailMessageMode.Draft && <p className="mx-5 mt-3 text-xs text-secondary">{t('neteaseMailDraftSaved')}</p>}
    {presentation.status === NeteaseMailOperationStatus.Unknown && <p role="alert" className="mx-5 mt-3 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">{t('neteaseMailUnknownHelp')}</p>}
    <div className="px-5 pb-4 pt-3">
      <dl>
        <AddressRow label={t('neteaseMailFrom')} values={message.from} />
        <AddressRow label={t('neteaseMailTo')} values={message.to} />
        <AddressRow label={t('neteaseMailCc')} values={message.cc} />
        <AddressRow label={t('neteaseMailBcc')} values={message.bcc} />
        <div className="flex gap-3 border-b border-border py-3 text-sm">
          <dt className="w-14 shrink-0 text-secondary">{t('neteaseMailSubject')}</dt>
          <dd className="min-w-0 flex-1 break-words font-medium">{message.subject || t('neteaseMailNoSubject')}</dd>
        </div>
      </dl>
      {message.date && <time className="mt-3 block text-xs text-muted" dateTime={message.date}>{formatMailDate(message.date)}</time>}
      <div ref={bodyRef} className={`mt-4 ${expanded ? 'max-h-[32rem] overflow-y-auto' : 'max-h-48 overflow-hidden'}`}>
        <MailBody content={message.body} format={message.format} reading={mode === NeteaseMailMessageMode.Read} />
      </div>
      {(bodyOverflowing || message.body.length > 400) && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} className="mt-3 flex items-center gap-1 text-xs text-secondary hover:text-foreground">
        {t(expanded ? 'neteaseMailCollapse' : 'neteaseMailExpand')}<ChevronDownIcon className={`h-3.5 w-3.5 ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>}
      {presentation.sourceMessage && <div className="mt-4 rounded-lg border border-border bg-surface-raised/30 p-3">
        <p className="mb-2 text-xs font-medium text-secondary">{t(presentation.forwardMode === NeteaseMailForwardMode.Attach ? 'neteaseMailForwardAttachSource' : 'neteaseMailForwardQuoteSource')}</p>
        <p className="mb-1 break-words text-sm font-medium">{presentation.sourceMessage.subject || t('neteaseMailNoSubject')}</p>
        <p className="mb-2 break-all text-xs text-secondary">{presentation.sourceMessage.from.map(address => address.email).join(', ')}</p>
        <div className="max-h-48 overflow-y-auto"><MailBody content={presentation.sourceMessage.body} format={presentation.sourceMessage.format} /></div>
        {presentation.sourceMessage.attachments.length > 0 && <p className="mt-2 break-words text-xs text-secondary">{t('neteaseMailAttachments')}: {presentation.sourceMessage.attachments.map(attachment => attachment.name).join(', ')}</p>}
      </div>}
      {message.attachments.length > 0 && <div className="mt-5 border-t border-border pt-3">
        <div className="mb-2 text-xs font-medium text-secondary">{t('neteaseMailAttachments')} · {message.attachments.length}</div>
        <ul className="space-y-2">{message.attachments.map((attachment, index) => <li key={`${attachment.id ?? attachment.name}-${index}`} className="rounded-lg border border-border px-3 py-2.5">
          <div className="flex items-start gap-2 text-sm"><PaperClipIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
            <span className="min-w-0 flex-1 break-all">{attachment.name}</span>
            {attachment.size !== undefined && <span className="shrink-0 text-xs tabular-nums text-secondary">{attachment.size < 1024 ? `${attachment.size} B` : attachment.size < 1_048_576 ? `${(attachment.size / 1024).toFixed(1)} KiB` : `${(attachment.size / 1_048_576).toFixed(1)} MiB`}</span>}
          </div>
          {(attachment.size ?? 0) > NeteaseMailLimits.AttachmentBytes && <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">{t('neteaseMailOversizedAttachment')}</p>}
        </li>)}</ul>
      </div>}
      {confirmation && deleting && <p className="mt-4 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">{t('neteaseMailDeleteWarning')}</p>}
      {confirmation && limitKeys.map(key => <p key={key} className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">{t(key)}</p>)}
    </div>
    {confirmation && <div className="border-t border-border bg-surface-raised/40 px-5 py-4">
      <div aria-live="polite">
        {failure && <p className="mb-3 text-sm text-red-600 dark:text-red-400" role="alert">{t(getNeteaseMailErrorKey(failure))}</p>}
        {outcome ? <p className="flex items-center gap-2 text-sm text-secondary"><CheckIcon className="h-4 w-4" aria-hidden="true" />{t(outcome === NeteaseMailOutcome.Cancelled ? 'neteaseMailCancelled' : 'neteaseMailSubmitted')}</p> : <>
          {(expired || incomplete || !actionsAvailable) && <p className="mb-3 text-xs leading-5 text-secondary">{t(expired ? 'neteaseMailExpired' : incomplete ? 'neteaseMailConfirmationIncomplete' : 'neteaseMailSendPending')}</p>}
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void act(NeteaseMailAction.Confirm)} disabled={disabled} className={`${buttonClass} bg-primary text-white hover:brightness-95`}>
              {busy ? t('neteaseMailSubmitting') : sendLabel}
            </button>
            <button type="button" onClick={() => void act(NeteaseMailAction.Cancel)} disabled={cancelDisabled} className={`${buttonClass} border border-border text-secondary hover:bg-surface-raised`}>{t('neteaseMailCancel')}</button>
          </div>
        </>}
      </div>
    </div>}
  </article>;
}

export default function NeteaseMailCard(props: NeteaseMailCardProps) {
  const { presentation } = props;
  const t = i18nService.t.bind(i18nService);
  if (presentation.kind === NeteaseMailView.Message) return <MessageCard {...props} presentation={presentation} />;
  if (presentation.kind === NeteaseMailView.Notice) return <div className={frameClass} data-netease-mail-card={NeteaseMailView.Notice} role="status">
    <MailHeader label={t('neteaseMailName')} />
    <div className="flex items-start gap-3 px-5 py-4">
      <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden="true" />
      <div className="text-sm leading-6"><p>{t(getNeteaseMailErrorKey(presentation.code))}</p>
        {presentation.code === NeteaseMailError.RateLimited && <p className="mt-1 text-xs text-secondary">{t('neteaseMailQuota')}</p>}
      </div>
    </div>
  </div>;
  return <section className={frameClass} data-netease-mail-card={NeteaseMailView.List}>
    <MailHeader label={t('neteaseMailResults').replace('{count}', String(presentation.messages.length))} />
    {presentation.messages.length === 0 ? <p className="px-5 py-6 text-sm text-secondary">{t('neteaseMailEmpty')}</p> : <ul className="divide-y divide-border">
      {presentation.messages.map((message, index) => <li key={`${message.id ?? index}`} className="px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-secondary">
          <span className="min-w-0 break-all">{message.from.map(address => address.name || address.email).join(', ')}</span>
          {message.date && <time dateTime={message.date}>{formatMailDate(message.date)}</time>}
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-sm font-medium">
          {message.unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-label={t('neteaseMailUnread')} />}
          <span className="min-w-0 break-words">{message.subject || t('neteaseMailNoSubject')}</span>
          {message.attachments.length > 0 && <PaperClipIcon className="h-4 w-4 shrink-0 text-muted" aria-label={t('neteaseMailAttachments')} />}
        </div>
        {message.body && <div className="mt-1.5 line-clamp-2 text-sm leading-6 text-secondary"><MailBody content={message.body} format={message.format} /></div>}
      </li>)}
    </ul>}
    {presentation.hasMore && <p className="border-t border-border px-5 py-3 text-xs text-secondary">{t('neteaseMailMore')}</p>}
    {presentation.truncated && <p className="border-t border-border px-5 py-3 text-xs text-secondary">{t('neteaseMailSearchTruncated')}</p>}
  </section>;
}
