import { type ChangeEvent, useEffect, useRef, useState } from 'react';

import { APP_ID } from '../../constants/app';
import { i18nService } from '../../services/i18n';
import { buildProvidersExport, importProviders, type ParsedProvidersImport, parseProvidersImport } from '../../services/providerTransfer';
import {
  ProviderTransferAction,
  ProviderTransferError,
  ProviderTransferErrorCode,
  ProviderTransferLimits,
} from '../../services/providerTransferTypes';
import type { ProvidersConfig } from './modelProviderUtils';

export type ProviderTransferDialogState =
  | { action: typeof ProviderTransferAction.Export }
  | { action: typeof ProviderTransferAction.Import; parsed: ParsedProvidersImport };

export const providerTransferErrorMessage = (error: unknown, fallback: string): string => (
  i18nService.t(error instanceof ProviderTransferError ? error.code : fallback)
);

const downloadProviders = (json: string): void => {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  try {
    link.href = url;
    link.download = `${APP_ID}-providers-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
};

export const useProviderTransfer = ({ providers, onImport, onError }: {
  providers: ProvidersConfig;
  onImport: (next: ProvidersConfig, legacy: boolean) => void;
  onError: (message: string | null) => void;
}) => {
  const [dialog, setDialog] = useState<ProviderTransferDialogState | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const generation = useRef(0);
  const submitting = useRef(false);
  const latestProviders = useRef(providers);
  latestProviders.current = providers;

  useEffect(() => () => { generation.current += 1; }, []);

  const close = () => {
    generation.current += 1;
    submitting.current = false;
    setBusy(false);
    setReading(false);
    setDialog(null);
  };

  const openExport = () => {
    close();
    onError(null);
    setDialog({ action: ProviderTransferAction.Export });
  };

  const readImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    close();
    const operation = generation.current;
    onError(null);
    setReading(true);
    try {
      if (file.size > ProviderTransferLimits.FileBytes) throw new ProviderTransferError(ProviderTransferErrorCode.TooLarge);
      const parsed = parseProvidersImport(await file.text());
      if (operation === generation.current) setDialog({ action: ProviderTransferAction.Import, parsed });
    } catch (error) {
      if (operation === generation.current) onError(providerTransferErrorMessage(error, 'importProvidersFailed'));
    } finally {
      if (operation === generation.current) setReading(false);
    }
  };

  const submit = async (includeApiKeys: boolean, password: string) => {
    if (!dialog || submitting.current) return;
    const operation = generation.current;
    const snapshot = latestProviders.current;
    submitting.current = true;
    setBusy(true);
    try {
      if (dialog.action === ProviderTransferAction.Export) {
        const json = await buildProvidersExport(snapshot, { includeApiKeys, password });
        if (operation !== generation.current) return;
        downloadProviders(json);
      } else {
        const next = await importProviders(dialog.parsed, snapshot, password);
        if (operation !== generation.current) return;
        if (snapshot !== latestProviders.current) throw new ProviderTransferError(ProviderTransferErrorCode.ConfigurationChanged);
        onImport(next, dialog.parsed.legacy);
      }
      close();
    } catch (error) {
      if (operation === generation.current) throw error;
    } finally {
      if (operation === generation.current) {
        submitting.current = false;
        setBusy(false);
      }
    }
  };

  return { dialog, busy, reading, close, openExport, readImport, submit };
};
