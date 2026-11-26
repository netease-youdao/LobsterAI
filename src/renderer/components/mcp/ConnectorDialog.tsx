import { ArrowRightIcon, ChatBubbleLeftIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { createPortal } from 'react-dom';

import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';
import { McpIconTile } from './McpCard';

interface Props {
  title: string;
  icon?: string;
  description: string;
  examples: string[];
  connected: boolean;
  busy: boolean;
  connectLabel?: string;
  disconnectLabel?: string;
  error: string;
  onConnect: (example?: string) => void;
  onDisconnect: () => void;
  onReconnect?: () => void;
  onCancel: () => void;
  onClose: () => void;
}

export default function ConnectorDialog(props: Props) {
  const t = (key: string) => i18nService.t(key);
  return createPortal(
    <Modal onClose={props.onClose} onEscape={props.onClose}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      className="relative mx-4 max-h-[85vh] w-full max-w-lg overflow-auto rounded-2xl border border-border bg-surface p-6 text-foreground shadow-xl">
      <button type="button" aria-label={t('close')} onClick={props.onClose}
        className="absolute right-4 top-4 rounded-lg p-1 text-muted hover:bg-surface-raised">
        <XMarkIcon className="h-5 w-5" />
      </button>
      <div className="flex flex-col items-center gap-4 pt-4 text-center">
        <div className="flex items-center gap-4">
          <img src="logo.png" alt="LobsterAI" className="h-12 w-12 rounded-xl" />
          <ArrowRightIcon aria-hidden="true" className="h-4 w-4 text-muted" />
          <McpIconTile icon={props.icon} className="h-12 w-12 rounded-xl" />
        </div>
        <h2 className="text-lg font-semibold">{t('mcpConnectTitle').replace('{name}', props.title)}</h2>
        <p className="text-sm leading-relaxed text-secondary">{props.description}</p>
        {props.busy ? (
          <button type="button" onClick={props.onCancel} className="rounded-lg bg-surface-raised px-4 py-2 text-sm">
            {t('mcpWaitingForAuth')} · {t('cancel')}
          </button>
        ) : props.connected ? (
          <button type="button" onClick={props.onDisconnect} className="rounded-lg bg-surface-raised px-4 py-2 text-sm">
            {props.disconnectLabel ?? (t('mcpConnected') + ' · ' + t('mcpOAuthSignOut'))}
          </button>
        ) : (
          <button type="button" onClick={() => props.onConnect()} className="rounded-lg bg-action px-5 py-2 text-sm text-action-foreground">
            {props.connectLabel ?? t('mcpConnectAction')}
          </button>
        )}
        {props.onReconnect && !props.busy && (
          <button type="button" onClick={props.onReconnect} className="text-sm underline">
            {props.connectLabel ?? t('mcpOAuthSignIn')}
          </button>
        )}
        {props.error && <p role="alert" className="text-sm text-red-500">{props.error}</p>}
      </div>
      {props.examples.length > 0 && (
        <section className="mt-7">
          <h3 className="mb-2 text-sm font-medium">{t('mcpDetailExamples')}</h3>
          <div className="space-y-2">
            {props.examples.map(example => (
              <button type="button" key={example} disabled={props.busy} onClick={() => props.onConnect(example)}
                className="flex w-full items-center justify-between gap-4 rounded-xl bg-surface-raised px-4 py-3 text-left text-sm text-secondary hover:text-foreground disabled:opacity-60">
                {example}<ChatBubbleLeftIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>
      )}
    </Modal>, document.body,
  );
}
