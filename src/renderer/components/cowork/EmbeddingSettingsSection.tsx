import React, { useState } from 'react';

import { i18nService } from '../../services/i18n';

interface EmbeddingSettingsSectionProps {
  embeddingEnabled: boolean;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingVectorWeight: number;
  embeddingRemoteBaseUrl: string;
  embeddingRemoteApiKey: string;
  onEmbeddingEnabledChange: (value: boolean) => void;
  onEmbeddingProviderChange: (value: string) => void;
  onEmbeddingModelChange: (value: string) => void;
  onEmbeddingVectorWeightChange: (value: number) => void;
  onEmbeddingRemoteBaseUrlChange: (value: string) => void;
  onEmbeddingRemoteApiKeyChange: (value: string) => void;
}

const EmbeddingSettingsSection: React.FC<EmbeddingSettingsSectionProps> = ({
  embeddingEnabled,
  embeddingProvider,
  embeddingModel,
  embeddingVectorWeight,
  embeddingRemoteBaseUrl,
  embeddingRemoteApiKey,
  onEmbeddingEnabledChange,
  onEmbeddingProviderChange,
  onEmbeddingModelChange,
  onEmbeddingVectorWeightChange,
  onEmbeddingRemoteBaseUrlChange,
  onEmbeddingRemoteApiKeyChange,
}) => {
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div className="space-y-3 rounded-xl border px-4 py-4 border-border">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <div className="text-sm font-medium text-foreground">
            {i18nService.t('coworkMemoryEmbeddingEnabled')}
          </div>
          <div className="text-xs text-secondary">
            {i18nService.t('coworkMemoryEmbeddingEnabledHint')}
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={embeddingEnabled}
          onClick={() => onEmbeddingEnabledChange(!embeddingEnabled)}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
            embeddingEnabled ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              embeddingEnabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {embeddingEnabled && (
        <div className="space-y-3 pt-2">
          {/* Provider dropdown */}
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">
              {i18nService.t('coworkMemoryEmbeddingProvider')}
            </label>
            <select
              value={embeddingProvider}
              onChange={(e) => onEmbeddingProviderChange(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm border-border bg-surface"
            >
              <option value="openai">{i18nService.t('coworkMemoryEmbeddingProviderOpenai')}</option>
              <option value="gemini">{i18nService.t('coworkMemoryEmbeddingProviderGemini')}</option>
              <option value="voyage">{i18nService.t('coworkMemoryEmbeddingProviderVoyage')}</option>
              <option value="mistral">{i18nService.t('coworkMemoryEmbeddingProviderMistral')}</option>
              <option value="ollama">{i18nService.t('coworkMemoryEmbeddingProviderOllama')}</option>
            </select>
            <div className="text-xs text-secondary mt-1">
              {i18nService.t('coworkMemoryEmbeddingProviderHint')}
            </div>
          </div>

          {/* Model ID */}
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">
              {i18nService.t('coworkMemoryEmbeddingModel')}
            </label>
            <input
              type="text"
              value={embeddingModel}
              onChange={(e) => onEmbeddingModelChange(e.target.value)}
              placeholder="text-embedding-3-large"
              className="w-full rounded-lg border px-3 py-2 text-sm border-border bg-surface font-mono"
            />
            <div className="text-xs text-secondary mt-1">
              {i18nService.t('coworkMemoryEmbeddingModelHint')}
            </div>
          </div>

          {/* Remote config fields */}
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">
              {i18nService.t('coworkMemoryEmbeddingRemoteBaseUrl')}
            </label>
            <input
              type="text"
              value={embeddingRemoteBaseUrl}
              onChange={(e) => onEmbeddingRemoteBaseUrlChange(e.target.value)}
              placeholder="https://api.openai.com/v1"
              className="w-full rounded-lg border px-3 py-2 text-sm border-border bg-surface font-mono"
            />
            <div className="text-xs text-secondary mt-1">
              {i18nService.t('coworkMemoryEmbeddingRemoteBaseUrlHint')}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-foreground mb-1">
              {i18nService.t('coworkMemoryEmbeddingRemoteApiKey')}
            </label>
            <input
              type="password"
              value={embeddingRemoteApiKey}
              onChange={(e) => onEmbeddingRemoteApiKeyChange(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm border-border bg-surface font-mono"
            />
            <div className="text-xs text-secondary mt-1">
              {i18nService.t('coworkMemoryEmbeddingRemoteApiKeyHint')}
            </div>
          </div>

          {/* Collapsible advanced section */}
          <button
            type="button"
            onClick={() => setShowAdvanced((prev) => !prev)}
            className="text-xs text-primary hover:underline"
          >
            {showAdvanced
              ? i18nService.t('coworkMemoryAdvancedHide')
              : i18nService.t('coworkMemoryAdvancedShow')}
          </button>

          {showAdvanced && (
            <div className="space-y-3">
              {/* Vector weight slider */}
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">
                  {i18nService.t('coworkMemoryEmbeddingWeight')}: {embeddingVectorWeight.toFixed(2)}
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={embeddingVectorWeight}
                  onChange={(e) => onEmbeddingVectorWeightChange(Number(e.target.value))}
                  className="w-full"
                />
                <div className="text-xs text-secondary mt-1">
                  {i18nService.t('coworkMemoryEmbeddingWeightHint')}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default EmbeddingSettingsSection;
