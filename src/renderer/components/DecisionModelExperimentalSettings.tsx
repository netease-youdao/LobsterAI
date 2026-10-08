import { EyeIcon, EyeSlashIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  type DecisionModelConfigUpdate,
  type DecisionModelConfigView,
  DecisionModelErrorCode,
  DecisionModelProvider,
  type DecisionModelTestResult,
} from '../../shared/decisionModel/constants';
import { i18nService } from '../services/i18n';

const PROVIDER_OPTIONS: Array<{ value: DecisionModelProvider; labelKey: string }> = [
  { value: DecisionModelProvider.TypeSafe, labelKey: 'decisionModelProviderTypeSafe' },
  { value: DecisionModelProvider.OpenRouter, labelKey: 'decisionModelProviderOpenRouter' },
  { value: DecisionModelProvider.Compatible, labelKey: 'decisionModelProviderCompatible' },
];

const API_KEY_URLS: Partial<Record<DecisionModelProvider, string>> = {
  [DecisionModelProvider.TypeSafe]: 'https://console.typesafe.ai/keys',
  [DecisionModelProvider.OpenRouter]: 'https://openrouter.ai/settings/keys',
};

const ERROR_LABEL_KEY: Record<DecisionModelErrorCode, string> = {
  [DecisionModelErrorCode.MissingApiKey]: 'decisionModelErrorMissingApiKey',
  [DecisionModelErrorCode.InvalidEndpoint]: 'decisionModelErrorInvalidEndpoint',
  [DecisionModelErrorCode.InvalidInput]: 'decisionModelErrorInvalidInput',
  [DecisionModelErrorCode.Unauthorized]: 'decisionModelErrorUnauthorized',
  [DecisionModelErrorCode.InsufficientCredits]: 'decisionModelErrorInsufficientCredits',
  [DecisionModelErrorCode.RateLimited]: 'decisionModelErrorRateLimited',
  [DecisionModelErrorCode.Timeout]: 'decisionModelErrorTimeout',
  [DecisionModelErrorCode.Cancelled]: 'decisionModelErrorTimeout',
  [DecisionModelErrorCode.Network]: 'decisionModelErrorNetwork',
  [DecisionModelErrorCode.UpstreamError]: 'decisionModelErrorUpstream',
  [DecisionModelErrorCode.InvalidResponse]: 'decisionModelErrorUpstream',
};

const EXAMPLE_KEYS = ['decisionModelExample1', 'decisionModelExample2', 'decisionModelExample3'];

// Field styles follow the model provider settings.
const LABEL_CLASS = 'block text-xs font-medium text-foreground';
const FIELD_CLASS =
  'block w-full rounded-xl bg-surface-inset border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-xs';
const ICON_BUTTON_CLASS = 'p-0.5 rounded text-secondary hover:text-primary transition-colors';
const SECONDARY_BUTTON_CLASS =
  'rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50';
const NOTE_CLASS = 'rounded-lg border px-3 py-2 text-[11px] leading-4';

interface DecisionModelDraft {
  enabled: boolean;
  provider: DecisionModelProvider;
  endpoint: string;
  apiKey: string;
}

interface DecisionModelExperimentalSettingsProps {
  /**
   * Unsaved edits. The Settings dialog owns them, so its Save button writes
   * them in one go (restarting the engine at most once) and Cancel drops them.
   */
  draftRef: React.MutableRefObject<DecisionModelConfigUpdate | null>;
}

const draftFromView = (view: DecisionModelConfigView): DecisionModelDraft => ({
  enabled: view.enabled,
  provider: view.provider,
  endpoint: view.endpoint,
  apiKey: view.apiKey,
});

const isDraftDirty = (draft: DecisionModelDraft, saved: DecisionModelConfigView): boolean => (
  draft.enabled !== saved.enabled
  || draft.provider !== saved.provider
  || draft.endpoint.trim() !== saved.endpoint
  || draft.apiKey.trim() !== saved.apiKey
);

function describeTestResult(result: DecisionModelTestResult): string {
  if (result.ok) {
    return i18nService
      .t('decisionModelTestOk')
      .replace('{model}', result.model ?? '')
      .replace('{ms}', String(result.elapsedMs ?? 0));
  }
  const labelKey = result.errorCode ? ERROR_LABEL_KEY[result.errorCode] : undefined;
  const reason = labelKey ? i18nService.t(labelKey) : (result.error ?? '');
  return i18nService.t('decisionModelTestFailed').replace('{error}', reason);
}

export const DecisionModelExperimentalSettings: React.FC<DecisionModelExperimentalSettingsProps> = ({ draftRef }) => {
  const [saved, setSaved] = useState<DecisionModelConfigView | null>(null);
  const [draft, setDraft] = useState<DecisionModelDraft | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<DecisionModelTestResult | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    void window.electron.decisionModel.getConfig()
      .then((view) => {
        if (!mountedRef.current) return;
        setSaved(view);
        // Edits made before switching tabs survive until the dialog closes.
        setDraft({ ...draftFromView(view), ...draftRef.current });
      })
      .catch(() => {
        // Bridge unavailable (old main process) — keep the card hidden.
      });
    return () => {
      mountedRef.current = false;
    };
  }, [draftRef]);

  const updateDraft = useCallback((patch: Partial<DecisionModelDraft>) => {
    if (!draft) return;
    const next = { ...draft, ...patch };
    draftRef.current = next;
    setDraft(next);
    setTestResult(null);
  }, [draft, draftRef]);

  const handleTest = useCallback(async () => {
    if (!draft) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.electron.decisionModel.testConnection({
        provider: draft.provider,
        endpoint: draft.endpoint,
        apiKey: draft.apiKey,
      });
      if (mountedRef.current) setTestResult(result);
    } catch (error) {
      if (mountedRef.current) {
        setTestResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (mountedRef.current) setTesting(false);
    }
  }, [draft]);

  if (!saved || !draft) return null;

  const apiKeyUrl = API_KEY_URLS[draft.provider];
  const needsApiKey = draft.enabled && !draft.apiKey.trim();
  const dirty = isDraftDirty(draft, saved);

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-foreground">{i18nService.t('decisionModelSettingsTitle')}</h4>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">{i18nService.t('decisionModelSettingsDesc')}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={draft.enabled}
          aria-label={i18nService.t('decisionModelEnableLabel')}
          onClick={() => updateDraft({ enabled: !draft.enabled })}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
            draft.enabled ? 'bg-primary' : 'bg-muted'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
              draft.enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {draft.enabled && (
        <div className="mt-4 space-y-4 border-t border-border pt-4">
          <div>
            <label htmlFor="decision-model-provider" className={`${LABEL_CLASS} mb-1`}>
              {i18nService.t('decisionModelProviderLabel')}
            </label>
            <select
              id="decision-model-provider"
              value={draft.provider}
              onChange={(event) => updateDraft({ provider: event.target.value as DecisionModelProvider })}
              className={FIELD_CLASS}
            >
              {PROVIDER_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{i18nService.t(option.labelKey)}</option>
              ))}
            </select>
          </div>

          {draft.provider === DecisionModelProvider.Compatible && (
            <div>
              <label htmlFor="decision-model-endpoint" className={`${LABEL_CLASS} mb-1`}>
                {i18nService.t('decisionModelEndpointLabel')}
              </label>
              <input
                id="decision-model-endpoint"
                type="text"
                value={draft.endpoint}
                onChange={(event) => updateDraft({ endpoint: event.target.value })}
                placeholder="https://example.com/v1/systemone"
                className={FIELD_CLASS}
              />
              <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{i18nService.t('decisionModelEndpointHint')}</p>
            </div>
          )}

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label htmlFor="decision-model-api-key" className={LABEL_CLASS}>
                {i18nService.t('apiKey')}
              </label>
              {apiKeyUrl && (
                <button
                  type="button"
                  onClick={() => void window.electron.shell.openExternal(apiKeyUrl)}
                  className="text-[11px] text-claude-accent hover:underline transition-colors"
                >
                  {i18nService.t('getApiKey')} →
                </button>
              )}
            </div>
            <div className="relative">
              <input
                id="decision-model-api-key"
                type={showApiKey ? 'text' : 'password'}
                autoComplete="off"
                value={draft.apiKey}
                onChange={(event) => updateDraft({ apiKey: event.target.value })}
                placeholder={i18nService.t('apiKeyPlaceholder')}
                className={`${FIELD_CLASS} pr-16`}
              />
              <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                {draft.apiKey && (
                  <button
                    type="button"
                    onClick={() => updateDraft({ apiKey: '' })}
                    className={ICON_BUTTON_CLASS}
                    title={i18nService.t('clear') || 'Clear'}
                  >
                    <XCircleIconSolid className="h-4 w-4" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className={ICON_BUTTON_CLASS}
                  title={showApiKey ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
                >
                  {showApiKey ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>

          <div>
            <button type="button" onClick={() => void handleTest()} disabled={testing} className={SECONDARY_BUTTON_CLASS}>
              {testing ? i18nService.t('decisionModelTesting') : i18nService.t('decisionModelTest')}
            </button>
          </div>

          {testResult && (
            <p
              className={`text-xs ${testResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}
              title={testResult.ok ? undefined : testResult.error}
            >
              {describeTestResult(testResult)}
            </p>
          )}

          {needsApiKey ? (
            <p className={`${NOTE_CLASS} border-amber-400/40 bg-amber-400/10 text-amber-700 dark:text-amber-400`}>
              {i18nService.t('decisionModelNeedsSetup')}
            </p>
          ) : dirty ? (
            <p className={`${NOTE_CLASS} border-border bg-muted/40 text-muted-foreground`}>
              {i18nService.t('decisionModelUnsavedHint')}
            </p>
          ) : saved.active && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span>{i18nService.t('decisionModelActiveNote')}</span>
            </div>
          )}

          <div className="space-y-1.5">
            <p className={LABEL_CLASS}>{i18nService.t('decisionModelExamplesTitle')}</p>
            <ul className="list-disc space-y-1 pl-4 text-xs leading-5 text-muted-foreground">
              {EXAMPLE_KEYS.map(key => <li key={key}>{i18nService.t(key)}</li>)}
            </ul>
          </div>

          <p className="text-[11px] leading-4 text-muted-foreground">{i18nService.t('decisionModelDataNote')}</p>
        </div>
      )}

      {!draft.enabled && dirty && (
        <p className={`${NOTE_CLASS} mt-4 border-border bg-muted/40 text-muted-foreground`}>
          {i18nService.t('decisionModelUnsavedHint')}
        </p>
      )}
    </div>
  );
};

export default DecisionModelExperimentalSettings;
