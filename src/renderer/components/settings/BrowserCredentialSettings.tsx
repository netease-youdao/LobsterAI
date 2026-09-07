import {
  KeyIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import {
  BrowserCredentialAvailabilityReason,
  type BrowserCredentialSummary,
} from '@shared/browserCredentials/constants';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

import Modal from '../common/Modal';

const BrowserCredentialSettings: React.FC = () => {
  const [credentials, setCredentials] = useState<BrowserCredentialSummary[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [availabilityReason, setAvailabilityReason] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BrowserCredentialSummary | null>(null);
  const [origin, setOrigin] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const originInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const api = window.electron?.openclaw?.browser?.credentials;
    if (!api) {
      setAvailable(false);
      setError(i18nService.t('browserCredentialUnavailable'));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [availabilityResponse, listResponse] = await Promise.all([
        api.getAvailability(),
        api.list(),
      ]);
      if (!availabilityResponse.success || !availabilityResponse.availability) {
        setAvailable(false);
        setError(i18nService.t('browserCredentialLoadFailed'));
      } else {
        setAvailable(availabilityResponse.availability.available);
        setAvailabilityReason(availabilityResponse.availability.reason);
      }
      if (listResponse.success) {
        setCredentials(listResponse.credentials ?? []);
      } else {
        setError(i18nService.t('browserCredentialLoadFailed'));
      }
    } catch {
      setAvailable(false);
      setError(i18nService.t('browserCredentialLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (showAddDialog) originInputRef.current?.focus();
  }, [showAddDialog]);

  const closeAddDialog = (force = false) => {
    if (saving && !force) return;
    setShowAddDialog(false);
    setOrigin('');
    setUsername('');
    setPassword('');
    setError('');
  };

  const saveCredential = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The dialog is rendered through a portal, but React submit events still
    // bubble through the component tree to the settings form.
    event.stopPropagation();
    if (!origin.trim() || !username.trim() || !password) return;
    setSaving(true);
    setError('');
    try {
      const response = await window.electron.openclaw.browser.credentials.save({
        origin,
        username,
        password,
      });
      if (!response.success) {
        setError(i18nService.t('browserCredentialSaveFailed'));
        return;
      }
      closeAddDialog(true);
      await load();
    } catch {
      setError(i18nService.t('browserCredentialSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const deleteCredential = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setError('');
    try {
      const response = await window.electron.openclaw.browser.credentials.delete({
        id: deleteTarget.id,
      });
      if (!response.success) {
        setError(i18nService.t('browserCredentialDeleteFailed'));
        return;
      }
      setDeleteTarget(null);
      await load();
    } catch {
      setError(i18nService.t('browserCredentialDeleteFailed'));
    } finally {
      setDeleting(false);
    }
  };

  const unavailableMessage = availabilityReason === BrowserCredentialAvailabilityReason.InsecureStorageBackend
    ? i18nService.t('browserCredentialInsecureBackend')
    : i18nService.t('browserCredentialEncryptionUnavailable');

  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h4 className="text-sm font-medium text-foreground">
            {i18nService.t('browserCredentialManagerTitle')}
          </h4>
          <p className="mt-1 text-sm text-secondary">
            {i18nService.t('browserCredentialManagerDescription')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowAddDialog(true)}
          disabled={available !== true}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg bg-surface-raised px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <PlusIcon className="h-4 w-4" />
          {i18nService.t('browserCredentialAdd')}
        </button>
      </div>

      {available === false && !loading ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          {unavailableMessage}
        </div>
      ) : null}
      {error && !showAddDialog && !deleteTarget ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border bg-background">
        {loading ? (
          <div className="px-3 py-3 text-sm text-secondary">
            {i18nService.t('loading')}
          </div>
        ) : credentials.length > 0 ? (
          credentials.map((credential, index) => (
            <div
              key={credential.id}
              className={`flex min-h-14 items-center gap-3 px-3 py-2 ${index > 0 ? 'border-t border-border' : ''}`}
            >
              <KeyIcon className="h-4 w-4 shrink-0 text-secondary" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-foreground">{credential.username}</div>
                <div className="truncate text-xs text-secondary">{credential.origin}</div>
              </div>
              <button
                type="button"
                onClick={() => setDeleteTarget(credential)}
                className="rounded-md p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-red-500"
                title={i18nService.t('delete')}
                aria-label={i18nService.t('delete')}
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
          ))
        ) : (
          <div className="px-3 py-3 text-sm text-secondary">
            {i18nService.t('browserCredentialEmpty')}
          </div>
        )}
      </div>

      {showAddDialog ? (
        <Modal
          onClose={closeAddDialog}
          onEscape={closeAddDialog}
          overlayClassName="fixed inset-0 z-[70] flex items-center justify-center bg-black/25"
          className="w-full max-w-[460px] rounded-2xl border border-border bg-background p-5 shadow-modal"
        >
          <form onSubmit={saveCredential}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-foreground">
                  {i18nService.t('browserCredentialAddTitle')}
                </h3>
                <p className="mt-2 text-sm text-secondary">
                  {i18nService.t('browserCredentialAddDescription')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => closeAddDialog()}
                className="rounded-md p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
              >
                <XMarkIcon className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <input
                ref={originInputRef}
                type="text"
                value={origin}
                onChange={event => setOrigin(event.target.value)}
                placeholder={i18nService.t('browserCredentialOriginPlaceholder')}
                autoComplete="off"
                className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-secondary focus:border-primary focus:ring-1 focus:ring-primary/40"
              />
              <input
                type="text"
                value={username}
                onChange={event => setUsername(event.target.value)}
                placeholder={i18nService.t('browserCredentialUsernamePlaceholder')}
                autoComplete="off"
                className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-secondary focus:border-primary focus:ring-1 focus:ring-primary/40"
              />
              <input
                type="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                placeholder={i18nService.t('browserCredentialPasswordPlaceholder')}
                autoComplete="new-password"
                className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-secondary focus:border-primary focus:ring-1 focus:ring-primary/40"
              />
            </div>

            {error ? <p className="mt-3 text-sm text-red-500">{error}</p> : null}

            <div className="mt-5 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => closeAddDialog()}
                disabled={saving}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised disabled:opacity-50"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="submit"
                disabled={saving || !origin.trim() || !username.trim() || !password}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:bg-gray-400"
              >
                {saving ? i18nService.t('saving') : i18nService.t('save')}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {deleteTarget ? (
        <Modal
          onClose={() => !deleting && setDeleteTarget(null)}
          onEscape={() => !deleting && setDeleteTarget(null)}
          overlayClassName="fixed inset-0 z-[70] flex items-center justify-center bg-black/25"
          className="w-full max-w-[420px] rounded-2xl border border-border bg-background p-5 shadow-modal"
        >
          <h3 className="text-base font-semibold text-foreground">
            {i18nService.t('browserCredentialDeleteTitle')}
          </h3>
          <p className="mt-2 text-sm text-secondary">
            {i18nService.t('browserCredentialDeleteDescription')
              .replace('{username}', deleteTarget.username)
              .replace('{origin}', deleteTarget.origin)}
          </p>
          {error ? <p className="mt-3 text-sm text-red-500">{error}</p> : null}
          <div className="mt-5 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised disabled:opacity-50"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              onClick={() => void deleteCredential()}
              disabled={deleting}
              className="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
            >
              {i18nService.t('delete')}
            </button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
};

export default BrowserCredentialSettings;
