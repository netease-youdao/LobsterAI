import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PhotoIcon,
  SparklesIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useState } from 'react';

import {
  findKimiK3ReservedCustomParamKeys,
  ModelRuntimeProfile,
  ModelRuntimeProfileSource,
  OpenClawApi,
  resolveModelRuntimeProfile,
} from '../../../shared/providers';
import { isCustomProvider } from '../../config';
import { i18nService } from '../../services/i18n';
import {
  CONTEXT_WINDOW_PRESETS,
  getEffectiveApiFormat,
  parseContextWindowInput,
  type ProviderConfig,
  type ProviderType,
} from './modelProviderUtils';
import { SETTINGS_META_TEXT } from './settingsTypography';

export interface ModelEditorDialogProps {
  activeProvider: ProviderType;
  isAddingModel: boolean;
  isEditingModel: boolean;
  newModelName: string;
  setNewModelName: (v: string) => void;
  newModelId: string;
  setNewModelId: (v: string) => void;
  newModelSupportsImage: boolean;
  setNewModelSupportsImage: (v: boolean) => void;
  newModelSupportsThinking: boolean;
  setNewModelSupportsThinking: (v: boolean) => void;
  newModelContextWindow: string;
  setNewModelContextWindow: (v: string) => void;
  newModelMaxTokens: string;
  setNewModelMaxTokens: (v: string) => void;
  newModelCustomParams: string;
  setNewModelCustomParams: (v: string) => void;
  activeProviderConfig: ProviderConfig;
  modelFormError: string | null;
  setModelFormError: (v: string | null) => void;
  handleSaveNewModel: () => void;
  handleCancelModelEdit: () => void;
  handleModelDialogKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}

function getModelIdPlaceholder(provider: ProviderType): string {
  if (provider === 'ollama') return i18nService.t('ollamaModelNamePlaceholder');
  if (provider === 'lm-studio') return i18nService.t('lmStudioModelNamePlaceholder');
  return 'deepseek-chat';
}

function getManagedKimiK3CustomParamKeys(rawJson: string): string[] {
  const trimmed = rawJson.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [];
    }
    return findKimiK3ReservedCustomParamKeys(parsed as Record<string, unknown>);
  } catch {
    return [];
  }
}

const ModelEditorDialog: React.FC<ModelEditorDialogProps> = ({
  activeProvider,
  isAddingModel,
  isEditingModel,
  newModelName,
  setNewModelName,
  newModelId,
  setNewModelId,
  newModelSupportsImage,
  setNewModelSupportsImage,
  newModelSupportsThinking,
  setNewModelSupportsThinking,
  newModelContextWindow,
  setNewModelContextWindow,
  newModelMaxTokens,
  setNewModelMaxTokens,
  newModelCustomParams,
  setNewModelCustomParams,
  activeProviderConfig,
  modelFormError,
  setModelFormError,
  handleSaveNewModel,
  handleCancelModelEdit,
  handleModelDialogKeyDown,
}) => {
  const isOpen = isAddingModel || isEditingModel;
  const hasCustomParams = newModelCustomParams.trim().length > 0;
  const [advancedOpen, setAdvancedOpen] = useState(hasCustomParams);

  if (!isOpen) {
    return null;
  }

  const effectiveApiFormat = getEffectiveApiFormat(activeProvider, activeProviderConfig.apiFormat);
  const usesKimiK3RuntimeProfile = resolveModelRuntimeProfile({
    source: isCustomProvider(activeProvider)
      ? ModelRuntimeProfileSource.Custom
      : ModelRuntimeProfileSource.BuiltIn,
    providerId: activeProvider,
    modelId: newModelId,
    api: effectiveApiFormat === 'openai'
      ? OpenClawApi.OpenAICompletions
      : OpenClawApi.AnthropicMessages,
  }) === ModelRuntimeProfile.MoonshotKimiK3;
  const kimiK3ManagedCustomParamKeys = usesKimiK3RuntimeProfile
    ? getManagedKimiK3CustomParamKeys(newModelCustomParams)
    : [];
  const parsedContextWindow = parseContextWindowInput(newModelContextWindow);

  const clearError = () => {
    if (modelFormError) {
      setModelFormError(null);
    }
  };

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center rounded-2xl bg-background/90 px-4 py-4 backdrop-blur-[2px]"
      onClick={handleCancelModelEdit}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isEditingModel ? i18nService.t('editModel') : i18nService.t('addNewModel')}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleModelDialogKeyDown}
        className="flex max-h-full min-h-0 w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-modal"
      >
        <div className="flex shrink-0 items-center justify-between px-4 pt-4 pb-3">
          <h4 className="text-sm font-semibold text-foreground">
            {isEditingModel ? i18nService.t('editModel') : i18nService.t('addNewModel')}
          </h4>
          <button
            type="button"
            onClick={handleCancelModelEdit}
            aria-label={i18nService.t('close')}
            className="rounded-md p-1 text-secondary hover:bg-surface-raised hover:text-foreground"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 [scrollbar-gutter:stable]">
          {modelFormError && (
            <p role="alert" className="mb-3 rounded-xl border border-red-500/25 bg-red-500/10 px-2.5 py-2 text-xs text-red-600 dark:text-red-400">
              {modelFormError}
            </p>
          )}

          <div className="space-y-3.5">
            {/* Model ID (primary required field) */}
            <div>
              <label htmlFor={`${activeProvider}-modelId`} className="mb-1 block text-xs font-medium text-foreground">
                {i18nService.t('modelId')}<span className="ml-0.5 text-red-500 dark:text-red-400">*</span>
              </label>
              <input
                id={`${activeProvider}-modelId`}
                autoFocus
                type="text"
                value={newModelId}
                onChange={(e) => {
                  setNewModelId(e.target.value);
                  clearError();
                }}
                className="block w-full rounded-xl border border-border bg-surface-inset px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                placeholder={getModelIdPlaceholder(activeProvider)}
              />
              <p className={`mt-1 ${SETTINGS_META_TEXT} text-muted`}>
                {i18nService.t('modelIdHint')}
              </p>
            </div>

            {/* Display Name (optional for all providers) */}
            <div>
              <label htmlFor={`${activeProvider}-modelName`} className="mb-1 block text-xs font-medium text-foreground">
                {i18nService.t('modelDisplayNameOptional')}
              </label>
              <input
                id={`${activeProvider}-modelName`}
                type="text"
                value={newModelName}
                onChange={(e) => {
                  setNewModelName(e.target.value);
                  clearError();
                }}
                className="block w-full rounded-xl border border-border bg-surface-inset px-3 py-2 text-xs text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                placeholder={newModelId.trim() || i18nService.t('modelDisplayNameOptionalPlaceholder')}
              />
              <p className={`mt-1 ${SETTINGS_META_TEXT} text-muted`}>
                {i18nService.t('modelDisplayNameOptionalHint')}
              </p>
            </div>

            {/* Model Capabilities (compact pill toggles) */}
            <div>
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                {i18nService.t('modelCapabilities')}
              </span>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={newModelSupportsImage}
                  onClick={() => setNewModelSupportsImage(!newModelSupportsImage)}
                  className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors ${
                    newModelSupportsImage
                      ? 'border-primary/40 bg-primary-muted text-primary'
                      : 'border-border bg-surface text-secondary hover:bg-surface-raised hover:text-foreground'
                  }`}
                >
                  <PhotoIcon className="h-3.5 w-3.5" />
                  {i18nService.t('modelCapabilityVision')}
                  {newModelSupportsImage && <CheckIcon className="h-3 w-3" />}
                </button>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={newModelSupportsThinking}
                  onClick={() => setNewModelSupportsThinking(!newModelSupportsThinking)}
                  className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors ${
                    newModelSupportsThinking
                      ? 'border-primary/40 bg-primary-muted text-primary'
                      : 'border-border bg-surface text-secondary hover:bg-surface-raised hover:text-foreground'
                  }`}
                >
                  <SparklesIcon className="h-3.5 w-3.5" />
                  {i18nService.t('modelCapabilityReasoning')}
                  {newModelSupportsThinking && <CheckIcon className="h-3 w-3" />}
                </button>
              </div>
              <p className={`mt-1 ${SETTINGS_META_TEXT} text-muted`}>
                {i18nService.t('modelCapabilitiesHint')}
              </p>
            </div>

            {/* Context Window & Max Output Tokens side-by-side */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={`${activeProvider}-contextWindow`} className="mb-1 block text-xs font-medium text-foreground">
                  {i18nService.t('contextWindow')}
                </label>
                <input
                  id={`${activeProvider}-contextWindow`}
                  type="text"
                  value={newModelContextWindow}
                  onChange={(e) => {
                    setNewModelContextWindow(e.target.value);
                    clearError();
                  }}
                  placeholder={i18nService.t('contextWindowPlaceholder')}
                  className="block w-full rounded-xl border border-border bg-surface-inset px-3 py-2 text-xs tabular-nums text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
                <div className="mt-1.5 flex items-center gap-1">
                  {CONTEXT_WINDOW_PRESETS.map((preset) => {
                    const active = parsedContextWindow === preset.value;
                    return (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => {
                          setNewModelContextWindow(active ? '' : preset.label);
                          clearError();
                        }}
                        className={`rounded-md border px-1.5 py-0.5 ${SETTINGS_META_TEXT} tabular-nums transition-colors ${
                          active
                            ? 'border-primary/40 bg-primary-muted text-primary font-medium'
                            : 'border-border-subtle bg-surface text-secondary hover:border-border hover:text-foreground'
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label htmlFor={`${activeProvider}-maxOutputTokens`} className="mb-1 block text-xs font-medium text-foreground">
                  {i18nService.t('maxOutputTokens')}
                </label>
                <input
                  id={`${activeProvider}-maxOutputTokens`}
                  type="text"
                  inputMode="numeric"
                  value={newModelMaxTokens}
                  onChange={(e) => {
                    setNewModelMaxTokens(e.target.value);
                    clearError();
                  }}
                  placeholder={i18nService.t('maxOutputTokensPlaceholder')}
                  className="block w-full rounded-xl border border-border bg-surface-inset px-3 py-2 text-xs tabular-nums text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
                <p className={`mt-1.5 ${SETTINGS_META_TEXT} text-muted`}>
                  {i18nService.t('maxOutputTokensCompactHint')}
                </p>
              </div>
            </div>

            {/* Collapsible Advanced Settings (Custom JSON Params) */}
            <div className="rounded-xl border border-border-subtle bg-surface/60">
              <button
                type="button"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen((prev) => !prev)}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-secondary hover:text-foreground transition-colors"
              >
                <span className="inline-flex items-center gap-1.5">
                  {advancedOpen
                    ? <ChevronDownIcon className="h-3.5 w-3.5" />
                    : <ChevronRightIcon className="h-3.5 w-3.5" />}
                  {i18nService.t('advancedSettings')}
                </span>
                {hasCustomParams && (
                  <span className={`${SETTINGS_META_TEXT} rounded-md bg-primary-muted px-1.5 py-0.5 text-primary`}>
                    JSON
                  </span>
                )}
              </button>
              {advancedOpen && (
                <div className="border-t border-border-subtle px-3 pt-2.5 pb-3">
                  <label htmlFor={`${activeProvider}-customParams`} className="mb-1 block text-xs font-medium text-foreground">
                    {i18nService.t('customParams')}
                  </label>
                  <textarea
                    id={`${activeProvider}-customParams`}
                    value={newModelCustomParams}
                    onChange={(e) => {
                      setNewModelCustomParams(e.target.value);
                      clearError();
                    }}
                    placeholder={usesKimiK3RuntimeProfile ? '{\n}' : '{\n  "temperature": 0.7\n}'}
                    rows={3}
                    className="w-full resize-y rounded-lg border border-border bg-surface-inset px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                  />
                  <p className={`mt-1 ${SETTINGS_META_TEXT} text-muted`}>
                    {i18nService.t('customParamsOptionalHint')}
                  </p>
                  {kimiK3ManagedCustomParamKeys.length > 0 && (
                    <p className={`mt-1.5 rounded-lg border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5 ${SETTINGS_META_TEXT} text-amber-700 dark:text-amber-300`}>
                      {i18nService.t('kimiK3ManagedCustomParamsNotice').replace(
                        '{keys}',
                        kimiK3ManagedCustomParamKeys.join(', '),
                      )}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 justify-end space-x-2 border-t border-border bg-background px-4 py-3">
          <button
            type="button"
            onClick={handleCancelModelEdit}
            className="rounded-xl border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface-raised transition-colors"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            onClick={handleSaveNewModel}
            className="rounded-xl bg-action px-3 py-1.5 text-xs font-medium text-action-foreground hover:bg-action-hover active:scale-[0.98] transition-colors"
          >
            {i18nService.t('save')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ModelEditorDialog;
