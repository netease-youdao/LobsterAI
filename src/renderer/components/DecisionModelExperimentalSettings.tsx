import { ChevronDownIcon, EyeIcon, EyeSlashIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  type DecisionModelApiKeys,
  type DecisionModelConfigUpdate,
  type DecisionModelConfigView,
  DecisionModelErrorCode,
  DecisionModelProvider,
  type DecisionModelTestResult,
} from '../../shared/decisionModel/constants';
import { i18nService } from '../services/i18n';
import TypeSafeIcon from './icons/providers/TypeSafeIcon';
import {
  SETTINGS_ACTION_BUTTON_CLASS,
  SettingsCard,
  SettingsItem,
  SettingsSection,
  SettingsStatusBadge,
  SettingsStatusTone,
} from './settings/SettingsLayout';
import { SETTINGS_DESCRIPTION_TEXT, SETTINGS_ITEM_TITLE_TEXT, SETTINGS_META_TEXT } from './settings/settingsTypography';

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

interface DecisionModelDraft {
  enabled: boolean;
  provider: DecisionModelProvider;
  endpoint: string;
  apiKeys: DecisionModelApiKeys;
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
  apiKeys: view.apiKeys,
});

const draftApiKey = (draft: DecisionModelDraft): string => draft.apiKeys[draft.provider] ?? '';

const isDraftDirty = (draft: DecisionModelDraft, saved: DecisionModelConfigView): boolean => (
  draft.enabled !== saved.enabled
  || draft.provider !== saved.provider
  || draft.endpoint.trim() !== saved.endpoint
  || PROVIDER_OPTIONS.some(({ value }) => (draft.apiKeys[value] ?? '').trim() !== (saved.apiKeys[value] ?? ''))
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
  const [configOpen, setConfigOpen] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    void window.electron.decisionModel.getConfig()
      .then((view) => {
        if (!mountedRef.current) return;
        setSaved(view);
        // Edits made before switching tabs survive until the dialog closes.
        const restored = { ...draftFromView(view), ...draftRef.current };
        setDraft(restored);
        // A working setup stays folded; one that still needs input opens.
        setConfigOpen(Boolean(draftRef.current) || !draftApiKey(restored).trim());
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

  // Each provider keeps its own key, so switching providers never overwrites another one.
  const updateApiKey = useCallback((apiKey: string) => {
    if (!draft) return;
    updateDraft({ apiKeys: { ...draft.apiKeys, [draft.provider]: apiKey } });
  }, [draft, updateDraft]);

  const handleTest = useCallback(async () => {
    if (!draft) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.electron.decisionModel.testConnection({
        provider: draft.provider,
        endpoint: draft.endpoint,
        apiKey: draftApiKey(draft),
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
  const apiKey = draftApiKey(draft);
  const needsApiKey = draft.enabled && !apiKey.trim();
  const dirty = isDraftDirty(draft, saved);
  const providerLabelKey = PROVIDER_OPTIONS.find(option => option.value === draft.provider)?.labelKey;
  const connectionSummary = [
    providerLabelKey ? i18nService.t(providerLabelKey) : draft.provider,
    i18nService.t(apiKey.trim() ? 'decisionModelApiKeySet' : 'decisionModelErrorMissingApiKey'),
  ].join(' · ');

  // Same precedence the old inline notes used: setup gaps first, then unsaved edits.
  const statusBadge = needsApiKey
    ? (
      <SettingsStatusBadge
        tone={SettingsStatusTone.Warning}
        label={i18nService.t('decisionModelBadgeNeedsSetup')}
        title={i18nService.t('decisionModelNeedsSetup')}
      />
    )
    : dirty
      ? (
        <SettingsStatusBadge
          tone={SettingsStatusTone.Warning}
          label={i18nService.t('decisionModelBadgeUnsaved')}
          title={i18nService.t('decisionModelUnsavedHint')}
        />
      )
      : saved.active
        ? (
          <SettingsStatusBadge
            tone={SettingsStatusTone.Success}
            label={i18nService.t('decisionModelBadgeActive')}
            title={i18nService.t('decisionModelActiveNote')}
          />
        )
        : null;

  const handleToggleEnabled = () => {
    const enabled = !draft.enabled;
    updateDraft({ enabled });
    if (enabled && !apiKey.trim()) setConfigOpen(true);
  };

  return (
    <SettingsSection
      icon={<TypeSafeIcon />}
      title={i18nService.t('decisionModelSettingsTitle')}
      description={i18nService.t('decisionModelSettingsDesc')}
      action={statusBadge}
    >
      <SettingsCard>
        <SettingsItem
          title={i18nService.t('decisionModelEnableLabel')}
          control={(
            <button
              type="button"
              role="switch"
              aria-checked={draft.enabled}
              aria-label={i18nService.t('decisionModelEnableLabel')}
              onClick={handleToggleEnabled}
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
          )}
        />

        {draft.enabled && (
          <button
            type="button"
            aria-expanded={configOpen}
            aria-controls="decision-model-connection"
            onClick={() => setConfigOpen(open => !open)}
            className="flex w-full items-center justify-between gap-6 px-4 py-3 text-left transition-colors last:rounded-b-xl hover:bg-surface-raised"
          >
            <div className="min-w-0 flex-1">
              <div className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
                {i18nService.t('decisionModelConnectionLabel')}
              </div>
              <div className={`mt-0.5 truncate ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>{connectionSummary}</div>
            </div>
            <ChevronDownIcon
              className={`h-4 w-4 shrink-0 text-secondary transition-transform ${configOpen ? 'rotate-180' : ''}`}
            />
          </button>
        )}

        {draft.enabled && configOpen && (
          <div id="decision-model-connection" className="space-y-4 px-4 py-4">
            <div className="flex items-center justify-between gap-6">
              <label htmlFor="decision-model-provider" className={LABEL_CLASS}>
                {i18nService.t('decisionModelProviderLabel')}
              </label>
              <select
                id="decision-model-provider"
                value={draft.provider}
                onChange={(event) => updateDraft({ provider: event.target.value as DecisionModelProvider })}
                className={`${FIELD_CLASS} max-w-56`}
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
                <p className={`mt-1 ${SETTINGS_META_TEXT} text-secondary`}>{i18nService.t('decisionModelEndpointHint')}</p>
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
                    className={`${SETTINGS_META_TEXT} text-claude-accent hover:underline transition-colors`}
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
                  value={apiKey}
                  onChange={(event) => updateApiKey(event.target.value)}
                  placeholder={i18nService.t('apiKeyPlaceholder')}
                  className={`${FIELD_CLASS} pr-16`}
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {apiKey && (
                    <button
                      type="button"
                      onClick={() => updateApiKey('')}
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

            <div className="flex items-center gap-6">
              {testResult && (
                <p
                  className={`min-w-0 flex-1 ${SETTINGS_META_TEXT} ${testResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}
                  title={testResult.ok ? undefined : testResult.error}
                >
                  {describeTestResult(testResult)}
                </p>
              )}
              <button
                type="button"
                onClick={() => void handleTest()}
                disabled={testing}
                className={`ml-auto ${SETTINGS_ACTION_BUTTON_CLASS}`}
              >
                {testing ? i18nService.t('decisionModelTesting') : i18nService.t('decisionModelTest')}
              </button>
            </div>
          </div>
        )}
      </SettingsCard>

      {draft.enabled && (
        <div className={`space-y-1.5 px-1 ${SETTINGS_META_TEXT} text-secondary`}>
          <p>{i18nService.t('decisionModelExamplesTitle')}</p>
          <ul className="list-disc space-y-0.5 pl-4">
            {EXAMPLE_KEYS.map(key => <li key={key}>{i18nService.t(key)}</li>)}
          </ul>
          <p className="pt-1">{i18nService.t('decisionModelDataNote')}</p>
        </div>
      )}
    </SettingsSection>
  );
};

export default DecisionModelExperimentalSettings;
