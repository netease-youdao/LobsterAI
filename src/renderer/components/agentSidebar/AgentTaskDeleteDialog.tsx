import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import { store } from '../../store';
import { sameAccountContext } from '../../store/accountSessionBoundary';
import Modal from '../common/Modal';

interface AgentTaskDeleteDialogProps {
  onDelete: () => Promise<void>;
  onClose: () => void;
  onSubmit?: () => void;
  onCancel?: () => void;
}

const AgentTaskDeleteDialog: React.FC<AgentTaskDeleteDialogProps> = ({ onDelete, onClose, onSubmit, onCancel }) => {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const active = useRef(true);
  const account = useRef(store.getState().auth);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    active.current = true;
    const checkAccount = () => {
      if (active.current && !sameAccountContext(account.current, store.getState().auth)) {
        active.current = false;
        close.current();
      }
    };
    const unsubscribe = store.subscribe(checkAccount);
    checkAccount();
    return () => { active.current = false; unsubscribe(); };
  }, []);

  const current = () => active.current && sameAccountContext(account.current, store.getState().auth);
  const dismiss = () => {
    if (pending.current) return;
    onCancel?.();
    onClose();
  };
  const confirm = async () => {
    if (pending.current || !current()) return;
    pending.current = true;
    setDeleting(true); setError(null);
    try {
      onSubmit?.();
      await onDelete();
      if (current()) onClose();
    } catch (failure) {
      if (current()) setError(failure instanceof Error && failure.message ? failure.message : i18nService.t('deleteTaskFailed'));
    } finally {
      if (current()) { pending.current = false; setDeleting(false); }
    }
  };

  return (
    <Modal onClose={dismiss} onEscape={dismiss} className="w-full max-w-sm mx-4 bg-surface rounded-2xl shadow-xl overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4">
        <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/30">
          <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-500" />
        </div>
        <h2 className="text-base font-semibold text-foreground">{i18nService.t('deleteTaskConfirmTitle')}</h2>
      </div>
      <div className="px-5 pb-4">
        <p className="text-sm text-secondary">{i18nService.t('deleteTaskConfirmMessage')}</p>
        {error && <p role="alert" className="mt-3 text-sm text-red-500 break-words">{error}</p>}
      </div>
      <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-border">
        <button type="button" disabled={deleting} onClick={dismiss}
          className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
          {i18nService.t('cancel')}
        </button>
        <button type="button" disabled={deleting} aria-busy={deleting} onClick={() => { void confirm(); }}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-red-500 text-white transition-colors hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed">
          {i18nService.t(deleting ? 'deletingTask' : 'deleteSession')}
        </button>
      </div>
    </Modal>
  );
};

export default AgentTaskDeleteDialog;
