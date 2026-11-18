import React, { useEffect, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import { ProviderTransferAction, ProviderTransferLimits, ProviderTransferMode } from '../../services/providerTransferTypes';
import Modal from '../common/Modal';
import { type ProviderTransferDialogState, providerTransferErrorMessage } from './useProviderTransfer';

interface ProviderTransferDialogProps {
  state: ProviderTransferDialogState;
  busy: boolean;
  onClose: () => void;
  onSubmit: (includeApiKeys: boolean, password: string) => Promise<void>;
}

const ProviderTransferDialog: React.FC<ProviderTransferDialogProps> = ({ state, busy, onClose, onSubmit }) => {
  const [includeApiKeys, setIncludeApiKeys] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const isExport = state.action === ProviderTransferAction.Export;
  const parsed = state.action === ProviderTransferAction.Import ? state.parsed : null;
  const needsPassword = isExport ? includeApiKeys : parsed?.mode === ProviderTransferMode.Encrypted;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setError(null);
    if (isExport && includeApiKeys && password !== confirmation) {
      setError(i18nService.t('passwordMismatch'));
      return;
    }
    try {
      await onSubmit(includeApiKeys, password);
    } catch (caught) {
      if (mounted.current) setError(providerTransferErrorMessage(caught, isExport ? 'exportProvidersFailed' : 'importProvidersFailed'));
    }
  };

  return (
    <Modal onClose={onClose} onEscape={onClose} className="w-full max-w-lg rounded-2xl border border-border bg-surface p-6 shadow-xl">
      <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="provider-transfer-title" className="space-y-4">
        <h2 id="provider-transfer-title" className="text-lg font-semibold text-foreground">
          {i18nService.t(isExport ? 'providersExportTitle' : 'providersImportTitle')}
        </h2>
        {isExport ? (
          <>
            <p className="text-sm text-secondary">{i18nService.t('providersExportConfigurationHint')}</p>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={includeApiKeys} disabled={busy} onChange={event => {
                setIncludeApiKeys(event.target.checked);
                setPassword('');
                setConfirmation('');
                setError(null);
              }} />
              {i18nService.t('providersIncludeApiKeys')}
            </label>
          </>
        ) : (
          <p className="text-sm text-secondary">{i18nService.t('providersImportReviewHint')}</p>
        )}
        {parsed?.legacy && <p role="note" className="rounded-lg bg-amber-500/10 p-3 text-sm text-foreground">{i18nService.t('providersLegacyWarning')}</p>}
        {parsed?.mode === ProviderTransferMode.Configuration && (
          <ul className="max-h-40 space-y-1 overflow-auto rounded-lg border border-border p-3 text-xs text-secondary">
            {Object.entries(parsed.providers).map(([key, provider]) => (
              <li key={key} className="break-all"><span className="font-medium">{key}</span> — {typeof provider.baseUrl === 'string' ? provider.baseUrl : ''}</li>
            ))}
          </ul>
        )}
        {needsPassword && (
          <>
            <p className="text-sm text-secondary">{i18nService.t(isExport ? 'providersExportPasswordHint' : 'importPasswordHint')}</p>
            <label className="block space-y-1 text-sm text-foreground">
              <span>{i18nService.t('password')}</span>
              <input type="password" value={password} autoFocus autoComplete={isExport ? 'new-password' : 'off'}
                maxLength={ProviderTransferLimits.PasswordMax} disabled={busy}
                onChange={event => setPassword(event.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2" />
            </label>
            {isExport && (
              <label className="block space-y-1 text-sm text-foreground">
                <span>{i18nService.t('confirmPassword')}</span>
                <input type="password" value={confirmation} autoComplete="new-password"
                  maxLength={ProviderTransferLimits.PasswordMax} disabled={busy}
                  onChange={event => setConfirmation(event.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2" />
              </label>
            )}
          </>
        )}
        {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-sm text-foreground hover:bg-surface-raised">
            {i18nService.t('cancel')}
          </button>
          <button type="submit" disabled={busy} className="rounded-lg bg-primary px-4 py-2 text-sm text-white hover:bg-primary-hover disabled:opacity-50">
            {i18nService.t(busy ? 'providersTransferWorking' : isExport ? 'export' : 'import')}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default ProviderTransferDialog;
