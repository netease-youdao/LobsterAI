import { EyeIcon, EyeSlashIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { ArrowTopRightOnSquareIcon, CheckCircleIcon, ExclamationCircleIcon, KeyIcon, MagnifyingGlassIcon, ShieldCheckIcon, SignalIcon, XCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React from 'react';

import { ProviderAuthType, ProviderName, ProviderRegistry } from '../../../shared/providers';
import { defaultConfig, getCustomProviderDefaultName, getProviderDisplayName, isCustomProvider } from '../../config';
import { getProviderIcon } from '../../providers/uiRegistry';
import { i18nService } from '../../services/i18n';
import EditIcon from '../icons/EditIcon';
import PlusCircleIcon from '../icons/PlusCircleIcon';
import { GitHubCopilotIcon } from '../icons/providers';
import TrashIcon from '../icons/TrashIcon';
import {
  CUSTOM_PROVIDER_KEYS,
  getEffectiveApiFormat,
  getProviderDefaultBaseUrl,
  hasProviderAuthConfigured,
  type ProviderConfig,
  providerRequiresApiKey,
  type ProvidersConfig,
  type ProviderType,
  shouldShowApiFormatSelector,
} from './modelProviderUtils';

// Context Window slider constants & helpers
const CW_MIN = 32000;
const CW_MAX = 2_000_000;
const CW_LOG_MIN = Math.log(CW_MIN);
const CW_LOG_MAX = Math.log(CW_MAX);
const CW_DEFAULT = 200_000;
const CW_SCALE_EXP = 1.5;
const CW_SLIDER_THUMB_SIZE = 14;
const CW_SLIDER_THUMB_RADIUS = CW_SLIDER_THUMB_SIZE / 2;

function contextWindowToSlider(value: number): number {
  const t = (Math.log(Math.max(CW_MIN, Math.min(CW_MAX, value))) - CW_LOG_MIN) / (CW_LOG_MAX - CW_LOG_MIN);
  return Math.pow(t, CW_SCALE_EXP);
}
function sliderToContextWindow(t: number): number {
  const logT = Math.pow(Math.max(0, Math.min(1, t)), 1 / CW_SCALE_EXP);
  return Math.round(Math.exp(CW_LOG_MIN + logT * (CW_LOG_MAX - CW_LOG_MIN)) / 1000) * 1000;
}
const CW_SNAP_THRESHOLD = 0.025;
const CW_MARKER_STOPS = [
  { label: '32K', value: CW_MIN },
  { label: '64K', value: 64000 },
  { label: '200K', value: 200000 },
  { label: '1M', value: 1000000 },
  { label: '2M', value: CW_MAX },
].map(m => ({ ...m, pos: contextWindowToSlider(m.value) }));

function sliderThumbCenterPosition(pos: number): string {
  return `calc(${pos * 100}% + ${(0.5 - pos) * CW_SLIDER_THUMB_SIZE}px)`;
}

function snapSliderValue(t: number): number {
  for (const m of CW_MARKER_STOPS) {
    if (Math.abs(t - m.pos) < CW_SNAP_THRESHOLD) return m.pos;
  }
  return t;
}

function parseContextWindowInput(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/,/g, '');
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(k|m)?$/);
  if (!match) return null;
  let num = parseFloat(match[1]);
  if (match[2] === 'k') num *= 1000;
  else if (match[2] === 'm') num *= 1_000_000;
  const result = Math.round(num);
  if (result < CW_MIN || result > CW_MAX) return null;
  return result;
}

function formatContextWindow(value: number): string {
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}K`;
  return value.toLocaleString();
}

type MiniMaxOAuthPhase =
  | { kind: 'idle' }
  | { kind: 'requesting_code' }
  | { kind: 'pending'; userCode: string; verificationUri: string }
  | { kind: 'success' }
  | { kind: 'error'; message: string };

type OpenAIOAuthPhase =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'success'; email?: string }
  | { kind: 'error'; message: string };

type XaiOAuthPhase =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'device_code'; userCode: string; verificationUri: string }
  | { kind: 'success'; email?: string }
  | { kind: 'error'; message: string };

type MiniMaxRegion = 'cn' | 'global';

type ProviderConnectionTestResult = {
  success: boolean;
  message: string;
  provider: ProviderType;
};

export interface ModelSettingsSectionProps {
  providers: ProvidersConfig;
  activeProvider: ProviderType;
  visibleProviders: ProvidersConfig;
  showApiKey: boolean;
  setShowApiKey: (v: boolean) => void;
  isImportingProviders: boolean;
  isExportingProviders: boolean;
  minimaxIsOAuthMode: boolean;
  openaiIsOAuthMode: boolean;
  isBaseUrlLocked: boolean;
  minimaxOAuthPhase: MiniMaxOAuthPhase;
  minimaxOAuthRegion: MiniMaxRegion;
  setMinimaxOAuthRegion: (v: MiniMaxRegion) => void;
  setMinimaxOAuthPhase: (v: MiniMaxOAuthPhase) => void;
  openaiOAuthPhase: OpenAIOAuthPhase;
  setOpenaiOAuthPhase: (v: OpenAIOAuthPhase) => void;
  openaiOAuthStatus: { loggedIn: false } | { loggedIn: true; email?: string } | null;
  xaiIsOAuthMode: boolean;
  xaiOAuthPhase: XaiOAuthPhase;
  setXaiOAuthPhase: (v: XaiOAuthPhase) => void;
  xaiOAuthStatus: { loggedIn: false } | { loggedIn: true; email?: string } | null;
  copilotAuthStatus: 'idle' | 'requesting' | 'awaiting_user' | 'polling' | 'authenticated' | 'error';
  copilotUserCode: string;
  copilotVerificationUri: string;
  copilotGithubUser: string;
  copilotError: string | null;
  isTesting: boolean;
  testResult: ProviderConnectionTestResult | null;
  isTestResultModalOpen: boolean;
  setIsTestResultModalOpen: (v: boolean) => void;
  importInputRef: React.RefObject<HTMLInputElement>;
  // Handlers
  handleImportProvidersClick: () => void;
  handleExportProviders: () => void;
  handleImportProviders: (event: React.ChangeEvent<HTMLInputElement>) => void;
  handleProviderChange: (provider: ProviderType) => void;
  toggleProviderEnabled: (provider: ProviderType) => void;
  handleAddCustomProvider: () => void;
  handleDeleteCustomProvider: (key: ProviderType) => void;
  handleProviderConfigChange: (provider: ProviderType, field: string, value: string) => void;
  setProviders: React.Dispatch<React.SetStateAction<ProvidersConfig>>;
  handleMiniMaxDeviceLogin: (region: MiniMaxRegion) => void;
  handleCancelMiniMaxLogin: () => void;
  handleMiniMaxOAuthLogout: () => void;
  handleOpenAIOAuthLogin: () => void;
  handleCancelOpenAIOAuthLogin: () => void;
  handleOpenAIOAuthLogout: () => void;
  handleXaiOAuthLogin: () => void;
  handleCancelXaiOAuthLogin: () => void;
  handleXaiOAuthLogout: () => void;
  handleCopilotSignIn: () => void;
  handleCopilotSignOut: () => void;
  handleCopilotCancelAuth: () => void;
  handleTestConnection: () => void;
  handleAddModel: () => void;
  handleEditModel: (modelId: string, modelName: string, supportsImage?: boolean, supportsThinking?: boolean, contextWindow?: number, customParams?: Record<string, unknown>) => void;
  handleDeleteModel: (modelId: string) => void;
}

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
  newModelContextWindow: number | undefined;
  setNewModelContextWindow: (v: number | undefined) => void;
  newModelCustomParams: string;
  setNewModelCustomParams: (v: string) => void;
  modelFormError: string | null;
  setModelFormError: (v: string | null) => void;
  handleSaveNewModel: () => void;
  handleCancelModelEdit: () => void;
  handleModelDialogKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}

export const ModelEditorDialog: React.FC<ModelEditorDialogProps> = ({
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
  newModelCustomParams,
  setNewModelCustomParams,
  modelFormError,
  setModelFormError,
  handleSaveNewModel,
  handleCancelModelEdit,
  handleModelDialogKeyDown,
}) => {
  const [newModelContextWindowText, setNewModelContextWindowText] = React.useState<string | null>(null);

  if (!isAddingModel && !isEditingModel) {
    return null;
  }

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
        className="flex max-h-full min-h-0 w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-background border-border border shadow-modal"
      >
        <div className="flex shrink-0 items-center justify-between px-4 pt-4 pb-3">
          <h4 className="text-sm font-semibold text-foreground">
            {isEditingModel ? i18nService.t('editModel') : i18nService.t('addNewModel')}
          </h4>
          <button
            type="button"
            onClick={handleCancelModelEdit}
            className="p-1 text-secondary hover:text-foreground rounded-md hover:bg-surface-raised"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 [scrollbar-gutter:stable]">
          {modelFormError && (
            <p className="mb-3 text-xs text-red-600 dark:text-red-400">
              {modelFormError}
            </p>
          )}

          <div className="space-y-4">
            {(activeProvider === 'ollama' || activeProvider === 'lm-studio') ? (
              <>
                <div className="flex items-start gap-3">
                  <label className="w-24 shrink-0 text-xs font-medium text-secondary pt-2 text-right">
                    {i18nService.t(activeProvider === 'lm-studio' ? 'lmStudioModelName' : 'ollamaModelName')}<span className="text-red-500 dark:text-red-400 ml-0.5">*</span>
                  </label>
                  <div className="flex-1 min-w-0">
                    <input
                      autoFocus
                      type="text"
                      value={newModelId}
                      onChange={(e) => {
                        setNewModelId(e.target.value);
                        if (!newModelName || newModelName === newModelId) {
                          setNewModelName(e.target.value);
                        }
                        if (modelFormError) {
                          setModelFormError(null);
                        }
                      }}
                      className="block w-full rounded-xl bg-surface-inset border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-xs"
                      placeholder={i18nService.t(activeProvider === 'lm-studio' ? 'lmStudioModelNamePlaceholder' : 'ollamaModelNamePlaceholder')}
                    />
                    <p className="mt-1 text-[11px] text-muted">
                      {i18nService.t(activeProvider === 'lm-studio' ? 'lmStudioModelNameHint' : 'ollamaModelNameHint')}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <label className="w-24 shrink-0 text-xs font-medium text-secondary pt-2 text-right">
                    {i18nService.t(activeProvider === 'lm-studio' ? 'lmStudioDisplayName' : 'ollamaDisplayName')}
                  </label>
                  <div className="flex-1 min-w-0">
                    <input
                      type="text"
                      value={newModelName === newModelId ? '' : newModelName}
                      onChange={(e) => {
                        setNewModelName(e.target.value || newModelId);
                        if (modelFormError) {
                          setModelFormError(null);
                        }
                      }}
                      className="block w-full rounded-xl bg-surface-inset border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-xs"
                      placeholder={i18nService.t(activeProvider === 'lm-studio' ? 'lmStudioDisplayNamePlaceholder' : 'ollamaDisplayNamePlaceholder')}
                    />
                    <p className="mt-1 text-[11px] text-muted">
                      {i18nService.t(activeProvider === 'lm-studio' ? 'lmStudioDisplayNameHint' : 'ollamaDisplayNameHint')}
                    </p>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-start gap-3">
                  <label className="w-24 shrink-0 text-xs font-medium text-secondary pt-2 text-right">
                    {i18nService.t('modelName')}<span className="text-red-500 dark:text-red-400 ml-0.5">*</span>
                  </label>
                  <div className="flex-1 min-w-0">
                    <input
                      autoFocus
                      type="text"
                      value={newModelName}
                      onChange={(e) => {
                        setNewModelName(e.target.value);
                        if (modelFormError) {
                          setModelFormError(null);
                        }
                      }}
                      className="block w-full rounded-xl bg-surface-inset border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-xs"
                      placeholder="GPT-4"
                    />
                    <p className="mt-1 text-[11px] text-muted">
                      {i18nService.t('modelNameHint')}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <label className="w-24 shrink-0 text-xs font-medium text-secondary pt-2 text-right">
                    {i18nService.t('modelId')}<span className="text-red-500 dark:text-red-400 ml-0.5">*</span>
                  </label>
                  <div className="flex-1 min-w-0">
                    <input
                      type="text"
                      value={newModelId}
                      onChange={(e) => {
                        setNewModelId(e.target.value);
                        if (modelFormError) {
                          setModelFormError(null);
                        }
                      }}
                      className="block w-full rounded-xl bg-surface-inset border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-xs"
                      placeholder="gpt-4"
                    />
                    <p className="mt-1 text-[11px] text-muted">
                      {i18nService.t('modelIdHint')}
                    </p>
                  </div>
                </div>
              </>
            )}
            <div className="flex items-start gap-3">
              <label
                htmlFor={`${activeProvider}-supportsImage`}
                className="w-24 shrink-0 text-xs font-medium text-secondary pt-0.5 text-right"
              >
                {i18nService.t('supportsImageInput')}
              </label>
              <div className="flex-1 min-w-0">
                <input
                  id={`${activeProvider}-supportsImage`}
                  type="checkbox"
                  checked={newModelSupportsImage}
                  onChange={(e) => setNewModelSupportsImage(e.target.checked)}
                  className="h-3.5 w-3.5 text-primary focus:ring-primary bg-surface border-border rounded"
                />
                <p className="mt-1 text-[11px] text-muted">
                  {i18nService.t('supportsImageInputHint')}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <label
                htmlFor={`${activeProvider}-supportsThinking`}
                className="w-24 shrink-0 text-xs font-medium text-secondary pt-0.5 text-right"
              >
                {i18nService.t('supportsThinkingOutput')}
              </label>
              <div className="flex-1 min-w-0">
                <input
                  id={`${activeProvider}-supportsThinking`}
                  type="checkbox"
                  checked={newModelSupportsThinking}
                  onChange={(e) => setNewModelSupportsThinking(e.target.checked)}
                  className="h-3.5 w-3.5 text-primary focus:ring-primary bg-surface border-border rounded"
                />
                <p className="mt-1 text-[11px] text-muted">
                  {i18nService.t('supportsThinkingOutputHint')}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <label className="w-24 shrink-0 text-xs font-medium text-secondary pt-2 text-right">
                {i18nService.t('contextWindow')}
              </label>
              <div className="flex-1 min-w-0">
                <input
                  type="text"
                  value={newModelContextWindowText ?? formatContextWindow(newModelContextWindow ?? CW_DEFAULT)}
                  onFocus={(e) => setNewModelContextWindowText(e.target.value)}
                  onChange={(e) => setNewModelContextWindowText(e.target.value)}
                  onBlur={() => {
                    if (newModelContextWindowText != null) {
                      const parsed = parseContextWindowInput(newModelContextWindowText);
                      if (parsed != null) setNewModelContextWindow(parsed);
                      setNewModelContextWindowText(null);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  className="w-24 rounded-lg bg-surface-inset border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-2.5 py-1 text-xs text-center tabular-nums mb-2"
                />
                <div className="relative h-3">
                  <div
                    className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-border"
                    style={{ left: CW_SLIDER_THUMB_RADIUS, right: CW_SLIDER_THUMB_RADIUS }}
                  />
                  {CW_MARKER_STOPS.map((m) => (
                    <div
                      key={m.label}
                      className="pointer-events-none absolute top-1/2 z-[1] flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full"
                      style={{ left: sliderThumbCenterPosition(m.pos) }}
                    >
                      <div className="h-1.5 w-1.5 rounded-full border border-border bg-surface" />
                    </div>
                  ))}
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.001}
                    value={contextWindowToSlider(newModelContextWindow ?? CW_DEFAULT)}
                    onChange={(e) => setNewModelContextWindow(sliderToContextWindow(snapSliderValue(Number(e.target.value))))}
                    className="absolute inset-0 w-full h-full appearance-none cursor-pointer bg-transparent z-[2] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-[0_1px_3px_rgba(0,0,0,0.2)] [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-runnable-track]:bg-transparent"
                  />
                </div>
                <div className="relative h-4 mt-0.5">
                  {CW_MARKER_STOPS.map((m) => (
                    <span
                      key={m.label}
                      className="absolute text-[9px] text-muted select-none -translate-x-1/2"
                      style={{ left: sliderThumbCenterPosition(m.pos) }}
                    >
                      {m.label}
                    </span>
                  ))}
                </div>
                <p className="mt-1 text-[11px] text-muted">
                  {i18nService.t('contextWindowHint')}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <label className="w-24 shrink-0 text-xs font-medium text-secondary pt-2 text-right">
                {i18nService.t('customParams')}
              </label>
              <div className="flex-1 min-w-0">
                <textarea
                  value={newModelCustomParams}
                  onChange={(e) => setNewModelCustomParams(e.target.value)}
                  placeholder={'{\n  "reasoning_effort": "high"\n}'}
                  rows={3}
                  className="w-full rounded-lg bg-surface-inset border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-2.5 py-1.5 text-xs font-mono resize-y"
                />
                <p className="mt-1 text-[11px] text-muted">
                  {i18nService.t('customParamsHint')}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 justify-end space-x-2 border-t border-border bg-background px-4 py-3">
          <button
            type="button"
            onClick={handleCancelModelEdit}
            className="px-3 py-1.5 text-xs text-foreground hover:bg-surface-raised rounded-xl border border-border"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            onClick={handleSaveNewModel}
            className="px-3 py-1.5 text-xs text-white bg-primary hover:bg-primary-hover rounded-xl active:scale-[0.98]"
          >
            {i18nService.t('save')}
          </button>
        </div>
      </div>
    </div>
  );
};

export interface DeleteProviderConfirmDialogProps {
  pendingDeleteProvider: ProviderType | null;
  providers: ProvidersConfig;
  onCancel: () => void;
  onConfirm: () => void;
}

export const DeleteProviderConfirmDialog: React.FC<DeleteProviderConfirmDialogProps> = ({
  pendingDeleteProvider,
  providers,
  onCancel,
  onConfirm,
}) => {
  if (!pendingDeleteProvider) {
    return null;
  }

  const config = providers[pendingDeleteProvider] as ProviderConfig | undefined;
  const providerName = config?.displayName || getCustomProviderDefaultName(pendingDeleteProvider);

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center rounded-2xl bg-black/40 px-4 animate-fade-in"
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={i18nService.t('deleteCustomProviderTitle')}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          }
        }}
        className="w-full max-w-sm rounded-2xl bg-background border-border border shadow-modal p-5 animate-scale-in"
      >
        <div className="flex flex-col items-center text-center">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
            <TrashIcon className="h-5 w-5 text-red-500 dark:text-red-400" />
          </div>
          <h4 className="mt-3 text-sm font-semibold text-foreground">
            {i18nService.t('deleteCustomProviderTitle')}
          </h4>
          <p className="mt-1.5 text-xs leading-5 text-secondary break-words">
            {i18nService.t('confirmDeleteCustomProviderNamed').replace('{name}', providerName)}
          </p>
        </div>
        <div className="mt-5 flex gap-2.5">
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            className="flex-1 px-4 py-2 text-sm font-medium rounded-xl border border-border text-foreground hover:bg-surface-raised transition-colors active:scale-[0.98]"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 px-4 py-2 text-sm font-medium rounded-xl bg-red-500 hover:bg-red-600 text-white transition-colors active:scale-[0.98]"
          >
            {i18nService.t('deleteCustomProvider')}
          </button>
        </div>
      </div>
    </div>
  );
};

const ModelSettingsSection: React.FC<ModelSettingsSectionProps> = ({
  providers, activeProvider, visibleProviders,
  showApiKey, setShowApiKey,
  isImportingProviders, isExportingProviders,
  minimaxIsOAuthMode, openaiIsOAuthMode, isBaseUrlLocked,
  minimaxOAuthPhase, minimaxOAuthRegion, setMinimaxOAuthRegion, setMinimaxOAuthPhase,
  openaiOAuthPhase, setOpenaiOAuthPhase, openaiOAuthStatus,
  xaiIsOAuthMode, xaiOAuthPhase, setXaiOAuthPhase, xaiOAuthStatus,
  copilotAuthStatus, copilotUserCode, copilotVerificationUri, copilotGithubUser, copilotError,
  isTesting, testResult, isTestResultModalOpen, setIsTestResultModalOpen,
  importInputRef,
  handleImportProvidersClick, handleExportProviders, handleImportProviders,
  handleProviderChange, toggleProviderEnabled,
  handleAddCustomProvider, handleDeleteCustomProvider,
  handleProviderConfigChange, setProviders,
  handleMiniMaxDeviceLogin, handleCancelMiniMaxLogin, handleMiniMaxOAuthLogout,
  handleOpenAIOAuthLogin, handleCancelOpenAIOAuthLogin, handleOpenAIOAuthLogout,
  handleXaiOAuthLogin, handleCancelXaiOAuthLogin, handleXaiOAuthLogout,
  handleCopilotSignIn, handleCopilotSignOut, handleCopilotCancelAuth,
  handleTestConnection,
  handleAddModel, handleEditModel, handleDeleteModel,
}) => {
  const copilotProvider = providers[ProviderName.Copilot];
  const copilotAuthInProgress = copilotAuthStatus === 'requesting'
    || copilotAuthStatus === 'awaiting_user'
    || copilotAuthStatus === 'polling';
  const copilotSignedIn = copilotAuthStatus === 'authenticated'
    || copilotProvider?.authType === ProviderAuthType.OAuth;

  // Guides users who click a toggle that cannot be enabled yet: highlights the
  // missing auth requirement (API key input / login) instead of ignoring the click.
  const [authAttention, setAuthAttention] = React.useState<{ provider: ProviderType; nonce: number } | null>(null);

  const [providerFilter, setProviderFilter] = React.useState('');
  const providerEntries = Object.entries(visibleProviders).map(([provider, config]) => {
    const providerKey = provider as ProviderType;
    const isCustom = isCustomProvider(provider);
    const displayLabel = isCustom
      ? ((config as ProviderConfig).displayName || getCustomProviderDefaultName(provider))
      : (ProviderRegistry.get(providerKey)?.label ?? getProviderDisplayName(provider));
    return { providerKey, config, isCustom, displayLabel };
  });
  const providerFilterText = providerFilter.trim().toLowerCase();
  const filteredProviderEntries = providerFilterText
    ? providerEntries.filter(({ providerKey, displayLabel }) =>
      displayLabel.toLowerCase().includes(providerFilterText) || providerKey.toLowerCase().includes(providerFilterText))
    : providerEntries;
  const enabledProviderCount = providerEntries.filter(({ providerKey, config }) =>
    config.enabled && hasProviderAuthConfigured(providerKey, config)).length;

  const getProviderAuthRequirementHint = (providerKey: ProviderType, config: ProviderConfig): string => {
    const requiresLogin = providerKey === ProviderName.Copilot
      || (providerKey === ProviderName.Minimax && config.authType !== ProviderAuthType.ApiKey);
    return requiresLogin ? i18nService.t('enableRequiresLogin') : i18nService.t('enableRequiresApiKey');
  };

  const requestProviderAuthAttention = (providerKey: ProviderType) => {
    if (activeProvider !== providerKey) {
      handleProviderChange(providerKey);
    }
    setAuthAttention(prev => ({ provider: providerKey, nonce: (prev?.nonce ?? 0) + 1 }));
    window.setTimeout(() => {
      const input = document.getElementById(`${providerKey}-apiKey`);
      if (input instanceof HTMLInputElement) {
        input.focus({ preventScroll: true });
        input.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }, 80);
  };

  const showAuthAttentionHint = authAttention?.provider === activeProvider
    && !hasProviderAuthConfigured(activeProvider, providers[activeProvider]);
  const authAttentionRingClass = showAuthAttentionHint
    ? 'rounded-xl ring-2 ring-red-400/60 dark:ring-red-500/50'
    : '';
  const authAttentionHint = showAuthAttentionHint ? (
    <p
      key={`auth-attention-${authAttention?.nonce ?? 0}`}
      className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-red-500 dark:text-red-400 animate-fade-in-down"
    >
      <ExclamationCircleIcon className="h-3.5 w-3.5 shrink-0" />
      {getProviderAuthRequirementHint(activeProvider, providers[activeProvider])}
    </p>
  ) : null;

  return (
    <>
          <div className="flex h-full">
            {/* Provider List - Left Side */}
            <div className="w-2/5 border-r border-border pr-3 flex flex-col min-h-0">
              <div className="shrink-0 space-y-2 pb-2">
                <div className="flex items-center justify-between px-1">
                  <h3 className="flex items-baseline gap-1.5 text-sm font-medium text-foreground">
                    {i18nService.t('modelProviders')}
                    <span className="text-[10px] font-normal text-muted">
                      {enabledProviderCount}/{providerEntries.length} {i18nService.t('providersEnabledSuffix')}
                    </span>
                  </h3>
                  <div className="flex items-center space-x-1">
                    <button
                      type="button"
                      onClick={handleImportProvidersClick}
                      disabled={isImportingProviders || isExportingProviders}
                      className="inline-flex items-center px-2 py-1 text-[11px] font-medium rounded-lg border border-border text-foreground hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                    >
                      {i18nService.t('import')}
                    </button>
                    <button
                      type="button"
                      onClick={handleExportProviders}
                      disabled={isImportingProviders || isExportingProviders}
                      className="inline-flex items-center px-2 py-1 text-[11px] font-medium rounded-lg border border-border text-foreground hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                    >
                      {i18nService.t('export')}
                    </button>
                  </div>
                </div>
                <div className="relative">
                  <MagnifyingGlassIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                  <input
                    type="text"
                    value={providerFilter}
                    onChange={(e) => setProviderFilter(e.target.value)}
                    placeholder={i18nService.t('searchProviders')}
                    className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text pl-8 pr-7 py-1.5 text-xs"
                  />
                  {providerFilter && (
                    <button
                      type="button"
                      onClick={() => setProviderFilter('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                      title={i18nService.t('clear') || 'Clear'}
                    >
                      <XCircleIconSolid className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={handleImportProviders}
              />
              <div className="flex-1 space-y-1.5 overflow-y-auto pb-1">
              {filteredProviderEntries.map(({ providerKey, config, isCustom, displayLabel }) => {
                const provider = providerKey as string;
                const hasValidAuth = hasProviderAuthConfigured(providerKey, config);
                const effectiveEnabled = config.enabled && hasValidAuth;
                const canToggleProvider = effectiveEnabled || hasValidAuth;
                const attentionNonce = authAttention && authAttention.provider === providerKey && !canToggleProvider
                  ? authAttention.nonce
                  : null;
                return (
                  <div
                    key={provider}
                    onClick={() => handleProviderChange(providerKey)}
                    className={`group flex items-center p-2 rounded-xl cursor-pointer transition-colors ${
                      activeProvider === provider
                        ? 'bg-primary-muted border border-primary shadow-subtle'
                        : 'bg-surface hover:bg-surface-raised border border-transparent'
                    }`}
                  >
                    <div className="flex flex-1 items-center min-w-0">
                      <div className="mr-2 flex h-7 w-7 items-center justify-center shrink-0">
                        <span className="text-foreground">
                          {getProviderIcon(provider)}
                        </span>
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className={`text-sm font-medium truncate ${
                          activeProvider === provider
                            ? 'text-primary'
                            : 'text-foreground'
                        }`}>
                          {displayLabel}
                        </span>
                        {isCustom && (
                          <span className="text-[9px] leading-tight mt-0.5 text-primary">
                            {i18nService.t('customBadge')}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center ml-2 gap-1">
                      {isCustom && (
                        <button
                          type="button"
                          className="p-1 rounded-lg opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-secondary hover:text-red-500 hover:bg-red-500/10 dark:hover:text-red-400 dark:hover:bg-red-400/10 transition-all"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteCustomProvider(providerKey);
                          }}
                          title={i18nService.t('deleteCustomProvider')}
                        >
                          <TrashIcon className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <div
                        key={attentionNonce === null ? undefined : `provider-toggle-attention-${attentionNonce}`}
                        title={!canToggleProvider ? getProviderAuthRequirementHint(providerKey, config) : undefined}
                        className={`w-7 h-4 rounded-full flex items-center transition-colors ${
                          effectiveEnabled ? 'bg-primary' : 'bg-gray-400 dark:bg-gray-600'
                        } ${
                          canToggleProvider ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
                        } ${attentionNonce === null ? '' : 'animate-shake'}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!canToggleProvider) {
                            requestProviderAuthAttention(providerKey);
                            return;
                          }
                          toggleProviderEnabled(providerKey);
                        }}
                      >
                        <div
                          className={`w-3 h-3 rounded-full bg-white shadow-md transform transition-transform ${
                            effectiveEnabled ? 'translate-x-3.5' : 'translate-x-0.5'
                          }`}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
              {filteredProviderEntries.length === 0 && (
                <div className="px-2 py-6 text-center text-xs text-secondary">
                  {i18nService.t('noProvidersFound')}
                </div>
              )}
              {/* Add Custom Provider Button */}
              {CUSTOM_PROVIDER_KEYS.some(k => !providers[k]) && (
              <button
                type="button"
                onClick={handleAddCustomProvider}
                className="w-full flex items-center justify-center p-2 rounded-xl border border-dashed border-claude-border dark:border-claude-darkBorder text-claude-secondaryText dark:text-claude-darkSecondaryText hover:border-claude-accent hover:text-claude-accent transition-colors text-sm"
              >
                {i18nService.t('addCustomProvider')}
              </button>
              )}
              </div>
            </div>

            {/* Provider Settings - Right Side */}
            <div className="w-3/5 pl-4 pr-2 space-y-4 overflow-y-auto [scrollbar-gutter:stable]">
              <div className="flex items-center justify-between pb-2 border-b border-border">
                <div className="flex items-center gap-1.5">
                  <h3 className="text-base font-medium text-foreground">
                    {isCustomProvider(activeProvider)
                      ? ((providers[activeProvider] as ProviderConfig)?.displayName || getCustomProviderDefaultName(activeProvider))
                      : (ProviderRegistry.get(activeProvider)?.label ?? getProviderDisplayName(activeProvider))
                    } {i18nService.t('providerSettings')}
                  </h3>
                  {ProviderRegistry.get(activeProvider)?.website && (
                    <button
                      type="button"
                      onClick={() => void window.electron.shell.openExternal(ProviderRegistry.get(activeProvider)!.website!)}
                      className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                      title={i18nService.t('visitOfficialSite')}
                      aria-label={i18nService.t('visitOfficialSite')}
                    >
                      <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <div
                  className={`px-2 py-0.5 rounded-lg text-xs font-medium ${
                    providers[activeProvider].enabled && hasProviderAuthConfigured(activeProvider, providers[activeProvider])
                      ? 'bg-green-500/20 text-green-600 dark:text-green-400'
                      : 'bg-surface-raised text-secondary'
                  }`}
                >
                  {providers[activeProvider].enabled && hasProviderAuthConfigured(activeProvider, providers[activeProvider])
                    ? i18nService.t('providerStatusOn')
                    : i18nService.t('providerStatusOff')}
                </div>
              </div>

              {/* MiniMax OAuth auth section */}
              {activeProvider === 'minimax' && (
                <div className="space-y-3">
                  {/* Auth type radio cards */}
                  <div>
                    <p className="text-xs font-medium text-foreground mb-2">
                      {i18nService.t('minimaxAuthMethodLabel')}
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setProviders(prev => ({
                            ...prev,
                            minimax: {
                              ...prev.minimax,
                              authType: 'apikey',
                              enabled: prev.minimax.enabled && prev.minimax.apiKey.trim().length > 0,
                            },
                          }));
                          setMinimaxOAuthPhase({ kind: 'idle' });
                        }}
                        className={`flex-1 p-3 rounded-xl border-2 text-left transition-all ${!minimaxIsOAuthMode ? 'border-primary bg-primary/5' : 'border-border opacity-60 hover:opacity-80'}`}
                      >
                        <div className="flex items-start justify-between">
                          <KeyIcon className="h-4 w-4 text-foreground mt-0.5 shrink-0" />
                          {!minimaxIsOAuthMode && <CheckCircleIcon className="h-4 w-4 text-primary shrink-0" />}
                        </div>
                        <p className="text-xs font-semibold text-foreground mt-1.5">{i18nService.t('minimaxOAuthTabApiKey')}</p>
                        <p className="text-[11px] text-secondary mt-0.5 leading-relaxed">{i18nService.t('minimaxAuthApiKeyDesc')}</p>
                      </button>
                      <button
                        type="button"
                        onClick={() => setProviders(prev => ({
                          ...prev,
                          minimax: {
                            ...prev.minimax,
                            authType: 'oauth',
                            enabled: prev.minimax.enabled && (prev.minimax.oauthAccessToken?.trim().length ?? 0) > 0,
                          },
                        }))}
                        className={`flex-1 p-3 rounded-xl border-2 text-left transition-all ${minimaxIsOAuthMode ? 'border-primary bg-primary/5' : 'border-border opacity-60 hover:opacity-80'}`}
                      >
                        <div className="flex items-start justify-between">
                          <ShieldCheckIcon className="h-4 w-4 text-foreground mt-0.5 shrink-0" />
                          {minimaxIsOAuthMode && <CheckCircleIcon className="h-4 w-4 text-primary shrink-0" />}
                        </div>
                        <p className="text-xs font-semibold text-foreground mt-1.5">{i18nService.t('minimaxOAuthTabOAuth')}</p>
                        <p className="text-[11px] text-secondary mt-0.5 leading-relaxed">{i18nService.t('minimaxAuthOAuthDesc')}</p>
                      </button>
                    </div>
                  </div>

                  {/* API Key mode */}
                  {!minimaxIsOAuthMode && (
                    <div className="min-h-[68px]">
                      <div className="flex items-center justify-between mb-1">
                        <label htmlFor="minimax-apiKey" className="block text-xs font-medium dark:text-claude-darkText text-claude-text">
                          {i18nService.t('apiKey')}<span className="text-red-500 dark:text-red-400 ml-0.5">*</span>
                        </label>
                        {ProviderRegistry.get('minimax')?.apiKeyUrl && (
                          <button
                            type="button"
                            onClick={() => void window.electron.shell.openExternal(ProviderRegistry.get('minimax')!.apiKeyUrl!)}
                            className="text-[11px] text-claude-accent hover:underline transition-colors"
                          >
                            {i18nService.t('getApiKey')} →
                          </button>
                        )}
                      </div>
                      <div className={`relative ${authAttentionRingClass}`}>
                      <input
                        type={showApiKey ? 'text' : 'password'}
                        id="minimax-apiKey"
                        value={providers.minimax.apiKey}
                        onChange={(e) => handleProviderConfigChange('minimax', 'apiKey', e.target.value)}
                        className="block w-full rounded-xl bg-surface-inset border-border border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-16 text-xs"
                        placeholder={i18nService.t('apiKeyPlaceholder')}
                      />
                      <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                        {providers.minimax.apiKey && (
                          <button
                            type="button"
                            onClick={() => handleProviderConfigChange('minimax', 'apiKey', '')}
                            className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                            title={i18nService.t('clear') || 'Clear'}
                          >
                            <XCircleIconSolid className="h-4 w-4" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setShowApiKey(!showApiKey)}
                          className="p-0.5 rounded text-secondary hover:text-primary transition-colors"
                          title={showApiKey ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
                        >
                          {showApiKey ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                        </button>
                      </div>
                      </div>
                      {authAttentionHint}
                    </div>
                  )}

                  {/* OAuth mode */}
                  {minimaxIsOAuthMode && (
                    <div className="space-y-2 min-h-[68px]">
                      {/* Already logged in */}
                      {minimaxOAuthPhase.kind === 'idle' && providers.minimax.oauthAccessToken && (
                        <div className="p-3 rounded-xl bg-green-500/10 border border-green-500/20 space-y-2">
                          <p className="text-xs text-green-600 dark:text-green-400 font-medium">
                            {i18nService.t('minimaxOAuthLoggedIn')}
                          </p>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => handleMiniMaxDeviceLogin(minimaxOAuthRegion)}
                              className="px-2.5 py-1 text-[11px] font-medium rounded-lg border border-border text-foreground hover:bg-surface-raised transition-colors"
                            >
                              {i18nService.t('minimaxOAuthRelogin')}
                            </button>
                            <button
                              type="button"
                              onClick={handleMiniMaxOAuthLogout}
                              className="px-2.5 py-1 text-[11px] font-medium rounded-lg border border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
                            >
                              {i18nService.t('minimaxOAuthLogout')}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Not logged in yet — show region selector + login button */}
                      {minimaxOAuthPhase.kind === 'idle' && !providers.minimax.oauthAccessToken && (
                        <div className="space-y-2">
                          {authAttentionHint}
                          <div>
                            <label className="block text-xs font-medium text-foreground mb-1">
                              {i18nService.t('minimaxOAuthRegionLabel')}
                            </label>
                            <div className="flex rounded-xl overflow-hidden border border-border">
                              <button
                                type="button"
                                onClick={() => setMinimaxOAuthRegion('cn')}
                                className={`flex-1 py-1.5 text-xs font-medium transition-colors ${minimaxOAuthRegion === 'cn' ? 'bg-primary text-white' : 'text-secondary hover:bg-surface-raised'}`}
                              >
                                {i18nService.t('minimaxOAuthRegionCN')}
                              </button>
                              <button
                                type="button"
                                onClick={() => setMinimaxOAuthRegion('global')}
                                className={`flex-1 py-1.5 text-xs font-medium transition-colors ${minimaxOAuthRegion === 'global' ? 'bg-primary text-white' : 'text-secondary hover:bg-surface-raised'}`}
                              >
                                {i18nService.t('minimaxOAuthRegionGlobal')}
                              </button>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleMiniMaxDeviceLogin(minimaxOAuthRegion)}
                            className="w-full py-2 text-xs font-medium rounded-xl bg-primary text-white hover:bg-primary-hover transition-colors"
                          >
                            {i18nService.t('minimaxOAuthLogin')}
                          </button>
                          <p className="text-[11px] text-secondary">
                            {i18nService.t('minimaxOAuthHint')}
                          </p>
                        </div>
                      )}

                      {/* Requesting code */}
                      {minimaxOAuthPhase.kind === 'requesting_code' && (
                        <div className="p-3 rounded-xl bg-surface-inset border border-border">
                          <p className="text-xs text-secondary">
                            {i18nService.t('minimaxOAuthLoggingIn')}
                          </p>
                        </div>
                      )}

                      {/* Pending — show user code */}
                      {minimaxOAuthPhase.kind === 'pending' && (
                        <div className="p-3 rounded-xl bg-surface-inset border border-border space-y-2">
                          <p className="text-xs text-foreground font-medium">
                            {i18nService.t('minimaxOAuthOpenBrowserHint')}
                          </p>
                          <div>
                            <span className="text-[11px] text-secondary">
                              {i18nService.t('minimaxOAuthUserCode')}:&nbsp;
                            </span>
                            <code className="text-xs font-mono text-primary">
                              {minimaxOAuthPhase.userCode}
                            </code>
                          </div>
                          <a
                            href={minimaxOAuthPhase.verificationUri}
                            onClick={(e) => { e.preventDefault(); void window.electron.shell.openExternal(minimaxOAuthPhase.verificationUri); }}
                            className="block text-[11px] text-primary underline truncate"
                          >
                            {minimaxOAuthPhase.verificationUri}
                          </a>
                          <p className="text-[11px] text-secondary">
                            {i18nService.t('minimaxOAuthStatusPending')}
                          </p>
                          <button
                            type="button"
                            onClick={handleCancelMiniMaxLogin}
                            className="px-2.5 py-1 text-[11px] font-medium rounded-lg border border-border text-foreground hover:bg-surface-raised transition-colors"
                          >
                            {i18nService.t('minimaxOAuthCancel')}
                          </button>
                        </div>
                      )}

                      {/* Success */}
                      {minimaxOAuthPhase.kind === 'success' && (
                        <div className="p-3 rounded-xl bg-green-500/10 border border-green-500/20">
                          <p className="text-xs text-green-600 dark:text-green-400 font-medium">
                            {i18nService.t('minimaxOAuthStatusSuccess')}
                          </p>
                        </div>
                      )}

                      {/* Error */}
                      {minimaxOAuthPhase.kind === 'error' && (
                        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 space-y-2">
                          <p className="text-xs text-red-600 dark:text-red-400 font-medium">
                            {i18nService.t('minimaxOAuthStatusError')}
                          </p>
                          <p className="text-[11px] text-red-600/80 dark:text-red-400/80 break-words">
                            {minimaxOAuthPhase.message}
                          </p>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => handleMiniMaxDeviceLogin(minimaxOAuthRegion)}
                              className="px-2.5 py-1 text-[11px] font-medium rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors"
                            >
                              {i18nService.t('minimaxOAuthRelogin')}
                            </button>
                            <button
                              type="button"
                              onClick={() => setMinimaxOAuthPhase({ kind: 'idle' })}
                              className="px-2.5 py-1 text-[11px] font-medium rounded-lg border border-border text-foreground hover:bg-surface-raised transition-colors"
                            >
                              {i18nService.t('minimaxOAuthCancel')}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* OpenAI ChatGPT (Codex) OAuth auth section */}
              {activeProvider === 'openai' && (
                <div className="space-y-3">
                  {/* Auth type radio cards */}
                  <div>
                    <p className="text-xs font-medium text-foreground mb-2">
                      {i18nService.t('openaiAuthMethodLabel')}
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setProviders(prev => ({
                            ...prev,
                            openai: {
                              ...prev.openai,
                              authType: 'apikey',
                            },
                          }));
                          setOpenaiOAuthPhase({ kind: 'idle' });
                        }}
                        className={`flex-1 p-3 rounded-xl border-2 text-left transition-all ${!openaiIsOAuthMode ? 'border-primary bg-primary/5' : 'border-border opacity-60 hover:opacity-80'}`}
                      >
                        <div className="flex items-start justify-between">
                          <KeyIcon className="h-4 w-4 text-foreground mt-0.5 shrink-0" />
                          {!openaiIsOAuthMode && <CheckCircleIcon className="h-4 w-4 text-primary shrink-0" />}
                        </div>
                        <p className="text-xs font-semibold text-foreground mt-1.5">{i18nService.t('openaiOAuthTabApiKey')}</p>
                        <p className="text-[11px] text-secondary mt-0.5 leading-relaxed">{i18nService.t('openaiAuthApiKeyDesc')}</p>
                      </button>
                      <button
                        type="button"
                        onClick={() => setProviders(prev => ({
                          ...prev,
                          openai: {
                            ...prev.openai,
                            authType: 'oauth',
                          },
                        }))}
                        className={`flex-1 p-3 rounded-xl border-2 text-left transition-all ${openaiIsOAuthMode ? 'border-primary bg-primary/5' : 'border-border opacity-60 hover:opacity-80'}`}
                      >
                        <div className="flex items-start justify-between">
                          <ShieldCheckIcon className="h-4 w-4 text-foreground mt-0.5 shrink-0" />
                          {openaiIsOAuthMode && <CheckCircleIcon className="h-4 w-4 text-primary shrink-0" />}
                        </div>
                        <p className="text-xs font-semibold text-foreground mt-1.5">{i18nService.t('openaiOAuthTabOAuth')}</p>
                        <p className="text-[11px] text-secondary mt-0.5 leading-relaxed">{i18nService.t('openaiAuthOAuthDesc')}</p>
                      </button>
                    </div>
                  </div>

                  {/* OAuth mode UI */}
                  {openaiIsOAuthMode && (
                    <div className="space-y-2 min-h-[68px]">
                      {/* Idle + already logged in */}
                      {openaiOAuthPhase.kind === 'idle' && openaiOAuthStatus?.loggedIn && (
                        <div className="p-3 rounded-xl bg-green-500/10 border border-green-500/20 space-y-2">
                          <p className="text-xs text-green-600 dark:text-green-400 font-medium">
                            {i18nService.t('openaiOAuthLoggedIn')}
                            {openaiOAuthStatus.email ? ` (${openaiOAuthStatus.email})` : ''}
                          </p>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={handleOpenAIOAuthLogin}
                              className="px-2.5 py-1 text-[11px] font-medium rounded-lg border border-border text-foreground hover:bg-surface-raised transition-colors"
                            >
                              {i18nService.t('openaiOAuthRelogin')}
                            </button>
                            <button
                              type="button"
                              onClick={() => { void handleOpenAIOAuthLogout(); }}
                              className="px-2.5 py-1 text-[11px] font-medium rounded-lg border border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
                            >
                              {i18nService.t('openaiOAuthLogout')}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Idle + not logged in — show login CTA */}
                      {openaiOAuthPhase.kind === 'idle' && openaiOAuthStatus && !openaiOAuthStatus.loggedIn && (
                        <div className="space-y-2">
                          <button
                            type="button"
                            onClick={handleOpenAIOAuthLogin}
                            className="w-full py-2 text-xs font-medium rounded-xl bg-primary text-white hover:bg-primary-hover transition-colors"
                          >
                            {i18nService.t('openaiOAuthLogin')}
                          </button>
                          <p className="text-[11px] text-secondary">
                            {i18nService.t('openaiOAuthHint')}
                          </p>
                        </div>
                      )}

                      {/* Pending — browser opened, waiting for callback */}
                      {openaiOAuthPhase.kind === 'pending' && (
                        <div className="p-3 rounded-xl bg-surface-inset border border-border space-y-2">
                          <p className="text-xs text-foreground font-medium">
                            {i18nService.t('openaiOAuthOpenBrowserHint')}
                          </p>
                          <p className="text-[11px] text-secondary">
                            {i18nService.t('openaiOAuthStatusPending')}
                          </p>
                          <button
                            type="button"
                            onClick={() => { void handleCancelOpenAIOAuthLogin(); }}
                            className="px-2.5 py-1 text-[11px] font-medium rounded-lg border border-border text-foreground hover:bg-surface-raised transition-colors"
                          >
                            {i18nService.t('openaiOAuthCancel')}
                          </button>
                        </div>
                      )}

                      {/* Success */}
                      {openaiOAuthPhase.kind === 'success' && (
                        <div className="p-3 rounded-xl bg-green-500/10 border border-green-500/20">
                          <p className="text-xs text-green-600 dark:text-green-400 font-medium">
                            {i18nService.t('openaiOAuthStatusSuccess')}
                            {openaiOAuthPhase.email ? ` (${openaiOAuthPhase.email})` : ''}
                          </p>
                        </div>
                      )}

                      {/* Error */}
                      {openaiOAuthPhase.kind === 'error' && (
                        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 space-y-2">
                          <p className="text-xs text-red-600 dark:text-red-400 font-medium">
                            {i18nService.t('openaiOAuthStatusError')}
                          </p>
                          <p className="text-[11px] text-red-600/80 dark:text-red-400/80 break-words">
                            {openaiOAuthPhase.message}
                          </p>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={handleOpenAIOAuthLogin}
                              className="px-2.5 py-1 text-[11px] font-medium rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors"
                            >
                              {i18nService.t('openaiOAuthRelogin')}
                            </button>
                            <button
                              type="button"
                              onClick={() => setOpenaiOAuthPhase({ kind: 'idle' })}
                              className="px-2.5 py-1 text-[11px] font-medium rounded-lg border border-border text-foreground hover:bg-surface-raised transition-colors"
                            >
                              {i18nService.t('openaiOAuthCancel')}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* xAI (Grok) OAuth auth section */}
              {activeProvider === 'xai' && (
                <div className="space-y-3">
                  {/* Auth type radio cards */}
                  <div>
                    <p className="text-xs font-medium text-foreground mb-2">
                      {i18nService.t('xaiAuthMethodLabel')}
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setProviders(prev => ({
                            ...prev,
                            xai: {
                              ...prev.xai,
                              authType: 'apikey',
                            },
                          }));
                          setXaiOAuthPhase({ kind: 'idle' });
                        }}
                        className={`flex-1 p-3 rounded-xl border-2 text-left transition-all ${!xaiIsOAuthMode ? 'border-primary bg-primary/5' : 'border-border opacity-60 hover:opacity-80'}`}
                      >
                        <div className="flex items-start justify-between">
                          <KeyIcon className="h-4 w-4 text-foreground mt-0.5 shrink-0" />
                          {!xaiIsOAuthMode && <CheckCircleIcon className="h-4 w-4 text-primary shrink-0" />}
                        </div>
                        <p className="text-xs font-semibold text-foreground mt-1.5">{i18nService.t('xaiOAuthTabApiKey')}</p>
                        <p className="text-[11px] text-secondary mt-0.5 leading-relaxed">{i18nService.t('xaiAuthApiKeyDesc')}</p>
                      </button>
                      <button
                        type="button"
                        onClick={() => setProviders(prev => ({
                          ...prev,
                          xai: {
                            ...prev.xai,
                            authType: 'oauth',
                          },
                        }))}
                        className={`flex-1 p-3 rounded-xl border-2 text-left transition-all ${xaiIsOAuthMode ? 'border-primary bg-primary/5' : 'border-border opacity-60 hover:opacity-80'}`}
                      >
                        <div className="flex items-start justify-between">
                          <ShieldCheckIcon className="h-4 w-4 text-foreground mt-0.5 shrink-0" />
                          {xaiIsOAuthMode && <CheckCircleIcon className="h-4 w-4 text-primary shrink-0" />}
                        </div>
                        <p className="text-xs font-semibold text-foreground mt-1.5">{i18nService.t('xaiOAuthTabOAuth')}</p>
                        <p className="text-[11px] text-secondary mt-0.5 leading-relaxed">{i18nService.t('xaiAuthOAuthDesc')}</p>
                      </button>
                    </div>
                  </div>

                  {/* OAuth mode UI */}
                  {xaiIsOAuthMode && (
                    <div className="space-y-2 min-h-[68px]">
                      {/* Idle + already logged in */}
                      {xaiOAuthPhase.kind === 'idle' && xaiOAuthStatus?.loggedIn && (
                        <div className="p-3 rounded-xl bg-green-500/10 border border-green-500/20 space-y-2">
                          <p className="text-xs text-green-600 dark:text-green-400 font-medium">
                            {i18nService.t('xaiOAuthLoggedIn')}
                            {xaiOAuthStatus.email ? ` (${xaiOAuthStatus.email})` : ''}
                          </p>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={handleXaiOAuthLogin}
                              className="px-2.5 py-1 text-[11px] font-medium rounded-lg border border-border text-foreground hover:bg-surface-raised transition-colors"
                            >
                              {i18nService.t('xaiOAuthRelogin')}
                            </button>
                            <button
                              type="button"
                              onClick={() => { void handleXaiOAuthLogout(); }}
                              className="px-2.5 py-1 text-[11px] font-medium rounded-lg border border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
                            >
                              {i18nService.t('xaiOAuthLogout')}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Idle + not logged in — show login CTA */}
                      {xaiOAuthPhase.kind === 'idle' && xaiOAuthStatus && !xaiOAuthStatus.loggedIn && (
                        <div className="space-y-2">
                          <button
                            type="button"
                            onClick={handleXaiOAuthLogin}
                            className="w-full py-2 text-xs font-medium rounded-xl bg-primary text-white hover:bg-primary-hover transition-colors"
                          >
                            {i18nService.t('xaiOAuthLogin')}
                          </button>
                          <p className="text-[11px] text-secondary">
                            {i18nService.t('xaiOAuthHint')}
                          </p>
                        </div>
                      )}

                      {/* Pending — browser opened, waiting for callback */}
                      {xaiOAuthPhase.kind === 'pending' && (
                        <div className="p-3 rounded-xl bg-surface-inset border border-border space-y-2">
                          <p className="text-xs text-foreground font-medium">
                            {i18nService.t('xaiOAuthOpenBrowserHint')}
                          </p>
                          <p className="text-[11px] text-secondary">
                            {i18nService.t('xaiOAuthStatusPending')}
                          </p>
                          <button
                            type="button"
                            onClick={() => { void handleCancelXaiOAuthLogin(); }}
                            className="px-2.5 py-1 text-[11px] font-medium rounded-lg border border-border text-foreground hover:bg-surface-raised transition-colors"
                          >
                            {i18nService.t('xaiOAuthCancel')}
                          </button>
                        </div>
                      )}

                      {/* Device code fallback — show user code + verification link */}
                      {xaiOAuthPhase.kind === 'device_code' && (
                        <div className="p-3 rounded-xl bg-surface-inset border border-border space-y-2">
                          <p className="text-xs text-foreground font-medium">
                            {i18nService.t('xaiOAuthDeviceCodeHint')}
                          </p>
                          <div>
                            <span className="text-[11px] text-secondary">
                              {i18nService.t('xaiOAuthUserCode')}:&nbsp;
                            </span>
                            <code className="text-xs font-mono text-primary">
                              {xaiOAuthPhase.userCode}
                            </code>
                          </div>
                          <a
                            href={xaiOAuthPhase.verificationUri}
                            onClick={(e) => { e.preventDefault(); void window.electron.shell.openExternal(xaiOAuthPhase.verificationUri); }}
                            className="block text-[11px] text-primary underline truncate"
                          >
                            {xaiOAuthPhase.verificationUri}
                          </a>
                          <button
                            type="button"
                            onClick={() => { void handleCancelXaiOAuthLogin(); }}
                            className="px-2.5 py-1 text-[11px] font-medium rounded-lg border border-border text-foreground hover:bg-surface-raised transition-colors"
                          >
                            {i18nService.t('xaiOAuthCancel')}
                          </button>
                        </div>
                      )}

                      {/* Success */}
                      {xaiOAuthPhase.kind === 'success' && (
                        <div className="p-3 rounded-xl bg-green-500/10 border border-green-500/20">
                          <p className="text-xs text-green-600 dark:text-green-400 font-medium">
                            {i18nService.t('xaiOAuthStatusSuccess')}
                            {xaiOAuthPhase.email ? ` (${xaiOAuthPhase.email})` : ''}
                          </p>
                        </div>
                      )}

                      {/* Error */}
                      {xaiOAuthPhase.kind === 'error' && (
                        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 space-y-2">
                          <p className="text-xs text-red-600 dark:text-red-400 font-medium">
                            {i18nService.t('xaiOAuthStatusError')}
                          </p>
                          <p className="text-[11px] text-red-600/80 dark:text-red-400/80 break-words">
                            {xaiOAuthPhase.message}
                          </p>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={handleXaiOAuthLogin}
                              className="px-2.5 py-1 text-[11px] font-medium rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors"
                            >
                              {i18nService.t('xaiOAuthRelogin')}
                            </button>
                            <button
                              type="button"
                              onClick={() => setXaiOAuthPhase({ kind: 'idle' })}
                              className="px-2.5 py-1 text-[11px] font-medium rounded-lg border border-border text-foreground hover:bg-surface-raised transition-colors"
                            >
                              {i18nService.t('xaiOAuthCancel')}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Shared consent-screen note */}
                      <p className="text-[11px] text-secondary leading-relaxed">
                        {i18nService.t('xaiOAuthConsentNote')}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Custom provider display name */}
              {isCustomProvider(activeProvider) && (
                <div>
                  <label htmlFor={`${activeProvider}-displayName`} className="block text-xs font-medium dark:text-claude-darkText text-claude-text mb-1">
                    {i18nService.t('customDisplayName')}
                  </label>
                  <input
                    type="text"
                    id={`${activeProvider}-displayName`}
                    value={(providers[activeProvider] as ProviderConfig)?.displayName ?? ''}
                    onChange={(e) => handleProviderConfigChange(activeProvider, 'displayName', e.target.value)}
                    className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                    placeholder={i18nService.t('customDisplayNamePlaceholder')}
                  />
                </div>
              )}

              {/* Standard API key section for non-MiniMax providers */}
              {providerRequiresApiKey(activeProvider) && activeProvider !== 'minimax' && !(activeProvider === 'openai' && openaiIsOAuthMode) && !(activeProvider === 'xai' && xaiIsOAuthMode) && (
                <div>
                  {/* Standard API Key input for non-Qwen providers */}
                  {activeProvider !== 'qwen' && (
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label htmlFor={`${activeProvider}-apiKey`} className="block text-xs font-medium dark:text-claude-darkText text-claude-text">
                          {i18nService.t('apiKey')}<span className="text-red-500 dark:text-red-400 ml-0.5">*</span>
                        </label>
                        {ProviderRegistry.get(activeProvider)?.apiKeyUrl && (
                          <button
                            type="button"
                            onClick={() => void window.electron.shell.openExternal(ProviderRegistry.get(activeProvider)!.apiKeyUrl!)}
                            className="text-[11px] text-claude-accent hover:underline transition-colors"
                          >
                            {i18nService.t('getApiKey')} →
                          </button>
                        )}
                      </div>
                      <div className={`relative ${authAttentionRingClass}`}>
                        <input
                          type={showApiKey ? 'text' : 'password'}
                          id={`${activeProvider}-apiKey`}
                          value={providers[activeProvider].apiKey}
                          onChange={(e) => handleProviderConfigChange(activeProvider, 'apiKey', e.target.value)}
                          className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-xs"
                          placeholder={i18nService.t('apiKeyPlaceholder')}
                        />
                        <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                          {providers[activeProvider].apiKey && (
                            <button
                              type="button"
                              onClick={() => handleProviderConfigChange(activeProvider, 'apiKey', '')}
                              className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                              title={i18nService.t('clear') || 'Clear'}
                            >
                              <XCircleIconSolid className="h-4 w-4" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setShowApiKey(!showApiKey)}
                            className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                            title={showApiKey ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
                          >
                            {showApiKey ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                          </button>
                        </div>
                      </div>
                      {authAttentionHint}
                    </div>
                  )}

                  {/* Qwen API Key section */}
                  {activeProvider === 'qwen' && (
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label htmlFor="qwen-apiKey" className="block text-xs font-medium dark:text-claude-darkText text-claude-text">
                          API Key<span className="text-red-500 dark:text-red-400 ml-0.5">*</span>
                        </label>
                        {ProviderRegistry.get('qwen')?.apiKeyUrl && (
                          <button
                            type="button"
                            onClick={() => void window.electron.shell.openExternal(ProviderRegistry.get('qwen')!.apiKeyUrl!)}
                            className="text-[11px] text-claude-accent hover:underline transition-colors"
                          >
                            {i18nService.t('getApiKey')} →
                          </button>
                        )}
                      </div>
                      <div className={`relative ${authAttentionRingClass}`}>
                        <input
                          type={showApiKey ? 'text' : 'password'}
                          id="qwen-apiKey"
                          value={providers.qwen.apiKey}
                          onChange={(e) => handleProviderConfigChange('qwen', 'apiKey', e.target.value)}
                          className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-xs"
                          placeholder={i18nService.t('apiKeyPlaceholder')}
                        />
                        <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                          {providers.qwen.apiKey && (
                            <button
                              type="button"
                              onClick={() => handleProviderConfigChange('qwen', 'apiKey', '')}
                              className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                              title={i18nService.t('clear') || 'Clear'}
                            >
                              <XCircleIconSolid className="h-4 w-4" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setShowApiKey(!showApiKey)}
                            className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                            title={showApiKey ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
                          >
                            {showApiKey ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                          </button>
                        </div>
                      </div>
                      {authAttentionHint}
                    </div>
                  )}
                </div>
              )}

              {activeProvider === ProviderName.Copilot && (
                <div>
                  <label className="block text-xs font-medium dark:text-claude-darkText text-claude-text mb-2">
                    {i18nService.t('githubCopilotAuth')}
                  </label>

                  {(copilotAuthStatus === 'idle' || copilotAuthStatus === 'error') && !copilotSignedIn && (
                    <div className="space-y-2">
                      {authAttentionHint}
                      <button
                        type="button"
                        onClick={handleCopilotSignIn}
                        className="flex items-center gap-2 px-4 py-2 rounded-xl bg-claude-accent text-white text-xs font-medium hover:bg-claude-accent/90 transition-colors"
                      >
                        <GitHubCopilotIcon className="w-4 h-4" />
                        {i18nService.t('githubCopilotSignIn')}
                      </button>
                      {copilotError && (
                        <p className="text-xs text-red-500 dark:text-red-400">{copilotError}</p>
                      )}
                    </div>
                  )}

                  {copilotAuthStatus === 'requesting' && (
                    <div className="flex items-center gap-2 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      {i18nService.t('githubCopilotRequesting')}
                    </div>
                  )}

                  {(copilotAuthStatus === 'awaiting_user' || copilotAuthStatus === 'polling') && (
                    <div className="space-y-3">
                      <div className="p-3 rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset border border-claude-border dark:border-claude-darkBorder">
                        <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary mb-2">
                          {i18nService.t('githubCopilotEnterCode')}
                        </p>
                        <div className="flex items-center gap-2">
                          <code className="text-lg font-mono font-bold tracking-widest dark:text-claude-darkText text-claude-text">
                            {copilotUserCode}
                          </code>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(copilotUserCode);
                            }}
                            className="px-2 py-0.5 rounded text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent border border-claude-border dark:border-claude-darkBorder transition-colors"
                          >
                            {i18nService.t('copy') || 'Copy'}
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => window.electron.shell.openExternal(copilotVerificationUri)}
                          className="mt-2 text-xs text-claude-accent hover:underline"
                        >
                          {copilotVerificationUri}
                        </button>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                          <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                          {i18nService.t('githubCopilotWaiting')}
                        </div>
                        <button
                          type="button"
                          onClick={handleCopilotCancelAuth}
                          className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-red-500 transition-colors"
                        >
                          {i18nService.t('cancel')}
                        </button>
                      </div>
                    </div>
                  )}

                  {copilotSignedIn && !copilotAuthInProgress && (
                    <div className="flex items-center justify-between p-3 rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset border border-claude-border dark:border-claude-darkBorder">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-green-500" />
                        <span className="text-xs dark:text-claude-darkText text-claude-text">
                          {copilotGithubUser
                            ? `${i18nService.t('githubCopilotConnected')} @${copilotGithubUser}`
                            : i18nService.t('githubCopilotConnected')}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={handleCopilotSignOut}
                        className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-red-500 transition-colors"
                      >
                        {i18nService.t('githubCopilotSignOut')}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {!(activeProvider === 'minimax' && minimaxIsOAuthMode) && (
              <div>
                <label htmlFor={`${activeProvider}-baseUrl`} className="block text-xs font-medium text-foreground mb-1">
                  {i18nService.t('baseUrl')}
                </label>
                <div className="relative">
                  <input
                    type="text"
                    id={`${activeProvider}-baseUrl`}
                    value={
                      (() => {
                        // Coding plan override: delegate to ProviderRegistry (50e20b76)
                        const fmt = getEffectiveApiFormat(activeProvider, providers[activeProvider].apiFormat);
                        if (fmt !== 'gemini') {
                          const cpUrl = (providers[activeProvider] as { codingPlanEnabled?: boolean }).codingPlanEnabled
                            ? ProviderRegistry.getCodingPlanUrl(activeProvider, fmt)
                            : undefined;
                          if (cpUrl) return cpUrl;
                        }
                        return providers[activeProvider].baseUrl;
                      })()
                    }
                    onChange={(e) => handleProviderConfigChange(activeProvider, 'baseUrl', e.target.value)}
                    disabled={isBaseUrlLocked}
                    className={`block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-8 text-xs ${isBaseUrlLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
                    placeholder={
                      activeProvider === 'qwen'
                        ? 'https://dashscope.aliyuncs.com/apps/anthropic'
                        : getProviderDefaultBaseUrl(activeProvider, getEffectiveApiFormat(activeProvider, providers[activeProvider].apiFormat)) || defaultConfig.providers?.[activeProvider]?.baseUrl || i18nService.t('baseUrlPlaceholder')
                    }
                  />
                  {providers[activeProvider].baseUrl && !isBaseUrlLocked && (
                    <div className="absolute right-2 inset-y-0 flex items-center">
                      <button
                        type="button"
                        onClick={() => handleProviderConfigChange(activeProvider, 'baseUrl', '')}
                        className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                        title={i18nService.t('clear') || 'Clear'}
                      >
                        <XCircleIconSolid className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
                {isCustomProvider(activeProvider) && !isBaseUrlLocked && (
                <div className="mt-1.5 space-y-1">
                  <p className="text-[10px] text-muted">{i18nService.t('baseUrlExamplesTitle')}</p>
                  {([
                    { format: 'anthropic', label: i18nService.t('apiFormatNative'), url: i18nService.t('baseUrlHintExample1') },
                    { format: 'openai', label: i18nService.t('apiFormatOpenAI'), url: i18nService.t('baseUrlHintExample2') },
                  ] as const).map(example => (
                    <button
                      key={example.format}
                      type="button"
                      onClick={() => {
                        handleProviderConfigChange(activeProvider, 'apiFormat', example.format);
                        handleProviderConfigChange(activeProvider, 'baseUrl', example.url);
                      }}
                      title={i18nService.t('clickToFillBaseUrl')}
                      className="flex w-full items-center gap-2 rounded-lg border border-border-subtle bg-surface px-2 py-1 text-left transition-colors hover:border-primary hover:bg-primary-muted"
                    >
                      <code className="min-w-0 flex-1 truncate text-[11px] text-primary">{example.url}</code>
                      <span className="shrink-0 rounded-md bg-surface-raised px-1.5 py-0.5 text-[10px] text-secondary">{example.label}</span>
                    </button>
                  ))}
                </div>
                )}
                {/* GLM Coding Plan 提示 */}
                {activeProvider === 'zhipu' && providers.zhipu.codingPlanEnabled && (
                  <div className="mt-1.5 p-2 rounded-lg bg-primary-muted border border-primary-muted">
                    <p className="text-[11px] text-primary dark:text-primary">
                      <span className="font-medium">GLM Coding Plan:</span> {i18nService.t('zhipuCodingPlanEndpointHint')}
                    </p>
                  </div>
                )}
                {/* Qwen Coding Plan 提示 */}
                {activeProvider === 'qwen' && providers.qwen.codingPlanEnabled && (
                  <div className="mt-1.5 p-2 rounded-lg bg-primary-muted border border-primary-muted">
                    <p className="text-[11px] text-primary dark:text-primary">
                      <span className="font-medium">Coding Plan:</span> {i18nService.t('qwenCodingPlanEndpointHint')}
                    </p>
                  </div>
                )}
                {/* Volcengine Coding Plan 提示 */}
                {activeProvider === 'volcengine' && providers.volcengine.codingPlanEnabled && (
                  <div className="mt-1.5 p-2 rounded-lg bg-primary-muted border border-primary-muted">
                    <p className="text-[11px] text-primary dark:text-primary">
                      <span className="font-medium">Coding Plan:</span> {i18nService.t('volcengineCodingPlanEndpointHint')}
                    </p>
                  </div>
                )}
                {/* Moonshot Coding Plan 提示 */}
                {activeProvider === 'moonshot' && providers.moonshot.codingPlanEnabled && (
                  <div className="mt-1.5 p-2 rounded-lg bg-primary-muted border border-primary-muted">
                    <p className="text-[11px] text-primary dark:text-primary">
                      <span className="font-medium">Coding Plan:</span> {i18nService.t('moonshotCodingPlanEndpointHint')}
                    </p>
                  </div>
                )}
                {/* Qianfan Coding Plan 提示 */}
                {activeProvider === 'qianfan' && providers.qianfan.codingPlanEnabled && (
                  <div className="mt-1.5 p-2 rounded-lg bg-primary-muted border border-primary-muted">
                    <p className="text-[11px] text-primary dark:text-primary">
                      <span className="font-medium">Coding Plan:</span> {i18nService.t('qianfanCodingPlanEndpointHint')}
                    </p>
                  </div>
                )}
                {/* Xiaomi Coding Plan 提示 */}
                {activeProvider === 'xiaomi' && providers.xiaomi.codingPlanEnabled && (
                  <div className="mt-1.5 p-2 rounded-lg bg-primary-muted border border-primary-muted">
                    <p className="text-[11px] text-primary dark:text-primary">
                      <span className="font-medium">Coding Plan:</span> {i18nService.t('xiaomiCodingPlanEndpointHint')}
                    </p>
                  </div>
                )}
              </div>
              )}

              {/* API 格式选择器 */}
              {shouldShowApiFormatSelector(activeProvider) && !(activeProvider === 'minimax' && minimaxIsOAuthMode) && (
                <div>
                  <label htmlFor={`${activeProvider}-apiFormat`} className="block text-xs font-medium text-foreground mb-1">
                    {i18nService.t('apiFormat')}
                  </label>
                  <div className="flex items-center space-x-4">
                    <label className="flex items-center">
                      <input
                        type="radio"
                        name={`${activeProvider}-apiFormat`}
                        value="anthropic"
                        checked={getEffectiveApiFormat(activeProvider, providers[activeProvider].apiFormat) !== 'openai'}
                        onChange={() => handleProviderConfigChange(activeProvider, 'apiFormat', 'anthropic')}
                        className="h-3.5 w-3.5 text-claude-accent focus:ring-claude-accent dark:bg-claude-darkSurface bg-claude-surface disabled:opacity-50"
                      />
                      <span className="ml-2 text-xs text-foreground">
                        {i18nService.t('apiFormatNative')}
                      </span>
                    </label>
                    <label className="flex items-center">
                      <input
                        type="radio"
                        name={`${activeProvider}-apiFormat`}
                        value="openai"
                        checked={getEffectiveApiFormat(activeProvider, providers[activeProvider].apiFormat) === 'openai'}
                        onChange={() => handleProviderConfigChange(activeProvider, 'apiFormat', 'openai')}
                        className="h-3.5 w-3.5 text-claude-accent focus:ring-claude-accent dark:bg-claude-darkSurface bg-claude-surface disabled:opacity-50"
                      />
                      <span className="ml-2 text-xs text-foreground">
                        {i18nService.t('apiFormatOpenAI')}
                      </span>
                    </label>
                  </div>
                  <p className="mt-1 text-xs text-secondary">
                    {i18nService.t('apiFormatHint')}
                  </p>
                </div>
              )}

              {/* GLM Coding Plan 开关 (仅 Zhipu) */}
              {activeProvider === 'zhipu' && (
                <div className="flex items-center justify-between p-3 rounded-xl bg-surface border border-border">
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-medium text-foreground">
                        GLM Coding Plan
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-primary-muted text-primary">
                        Beta
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-secondary">
                      {i18nService.t('zhipuCodingPlanHint')}
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer ml-3">
                    <input
                      type="checkbox"
                      checked={providers.zhipu.codingPlanEnabled ?? false}
                      onChange={(e) => handleProviderConfigChange('zhipu', 'codingPlanEnabled', e.target.checked ? 'true' : 'false')}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary/50 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-primary"></div>
                  </label>
                </div>
              )}

              {/* Qwen Coding Plan 开关 (仅 Qwen) */}
              {activeProvider === 'qwen' && (
                <div className="flex items-center justify-between p-3 rounded-xl bg-surface border border-border">
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-medium text-foreground">
                        Coding Plan
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-primary-muted text-primary">
                        {i18nService.t('codingPlanSubscriptionBadge')}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-secondary">
                      {i18nService.t('qwenCodingPlanHint')}
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer ml-3">
                    <input
                      type="checkbox"
                      checked={providers.qwen.codingPlanEnabled ?? false}
                      onChange={(e) => handleProviderConfigChange('qwen', 'codingPlanEnabled', e.target.checked ? 'true' : 'false')}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary/50 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-primary"></div>
                  </label>
                </div>
              )}

              {/* Volcengine Coding Plan 开关 (仅 Volcengine) */}
              {activeProvider === 'volcengine' && (
                <div className="flex items-center justify-between p-3 rounded-xl bg-surface border border-border">
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-medium text-foreground">
                        Coding Plan
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-primary-muted text-primary">
                        Beta
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-secondary">
                      {i18nService.t('volcengineCodingPlanHint')}
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer ml-3">
                    <input
                      type="checkbox"
                      checked={providers.volcengine.codingPlanEnabled ?? false}
                      onChange={(e) => handleProviderConfigChange('volcengine', 'codingPlanEnabled', e.target.checked ? 'true' : 'false')}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary/50 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-primary"></div>
                  </label>
                </div>
              )}

              {/* Moonshot Coding Plan 开关 (仅 Moonshot) */}
              {activeProvider === 'moonshot' && (
                <div className="flex items-center justify-between p-3 rounded-xl bg-surface border border-border">
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-medium text-foreground">
                        Coding Plan
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-primary-muted text-primary">
                        Beta
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-secondary">
                      {i18nService.t('moonshotCodingPlanHint')}
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer ml-3">
                    <input
                      type="checkbox"
                      checked={providers.moonshot.codingPlanEnabled ?? false}
                      onChange={(e) => handleProviderConfigChange('moonshot', 'codingPlanEnabled', e.target.checked ? 'true' : 'false')}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary/50 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-primary"></div>
                  </label>
                </div>
              )}

              {/* Qianfan Coding Plan 开关 (仅 Qianfan) */}
              {activeProvider === 'qianfan' && (
                <div className="flex items-center justify-between p-3 rounded-xl bg-surface border border-border">
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-medium text-foreground">
                        Coding Plan
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-primary-muted text-primary">
                        Beta
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-secondary">
                      {i18nService.t('qianfanCodingPlanHint')}
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer ml-3">
                    <input
                      type="checkbox"
                      checked={providers.qianfan.codingPlanEnabled ?? false}
                      onChange={(e) => handleProviderConfigChange('qianfan', 'codingPlanEnabled', e.target.checked ? 'true' : 'false')}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary/50 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-primary"></div>
                  </label>
                </div>
              )}

              {/* Xiaomi Coding Plan 开关 (仅 Xiaomi) */}
              {activeProvider === 'xiaomi' && (
                <div className="flex items-center justify-between p-3 rounded-xl bg-surface border border-border">
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-medium text-foreground">
                        Coding Plan
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-primary-muted text-primary">
                        Beta
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-secondary">
                      {i18nService.t('xiaomiCodingPlanHint')}
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer ml-3">
                    <input
                      type="checkbox"
                      checked={providers.xiaomi.codingPlanEnabled ?? false}
                      onChange={(e) => handleProviderConfigChange('xiaomi', 'codingPlanEnabled', e.target.checked ? 'true' : 'false')}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary/50 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-primary"></div>
                  </label>
                </div>
              )}

              {/* 测试连接按钮 */}
              {!(activeProvider === 'minimax' && minimaxIsOAuthMode) && (
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={handleTestConnection}
                  disabled={isTesting || (providerRequiresApiKey(activeProvider) && !providers[activeProvider].apiKey)}
                  title={providerRequiresApiKey(activeProvider) && !providers[activeProvider].apiKey
                    ? i18nService.t('testConnectionRequiresApiKey')
                    : undefined}
                  className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                >
                  <SignalIcon className="h-3.5 w-3.5 mr-1.5" />
                  {isTesting ? i18nService.t('testing') : i18nService.t('testConnection')}
                </button>
                {!isTesting && testResult && testResult.provider === activeProvider && (
                  <button
                    type="button"
                    onClick={() => setIsTestResultModalOpen(true)}
                    title={i18nService.t('connectionTestResult')}
                    className={`inline-flex items-center gap-1 text-[11px] font-medium hover:underline ${
                      testResult.success
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-red-500 dark:text-red-400'
                    }`}
                  >
                    {testResult.success
                      ? <CheckCircleIcon className="h-3.5 w-3.5" />
                      : <XCircleIcon className="h-3.5 w-3.5" />}
                    {testResult.success ? i18nService.t('connectionSuccess') : i18nService.t('connectionFailed')}
                  </button>
                )}
              </div>
              )}

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <h3 className="text-xs font-medium text-foreground">
                    {i18nService.t('availableModels')}
                    {(providers[activeProvider].models?.length ?? 0) > 0 && (
                      <span className="ml-1 font-normal text-muted">
                        ({providers[activeProvider].models?.length})
                      </span>
                    )}
                  </h3>
                  <button
                    type="button"
                    onClick={handleAddModel}
                    className="inline-flex items-center text-xs text-primary hover:text-primary-hover"
                  >
                    <PlusCircleIcon className="h-3.5 w-3.5 mr-1" />
                    {i18nService.t('addModel')}
                  </button>
                </div>

                {/* Models List */}
                <div className="space-y-1.5">
                  {(providers[activeProvider].models ?? []).map(model => (
                    <div
                      key={model.id}
                      className="bg-surface p-2 rounded-xl border-border border transition-colors hover:border-primary group"
                    >
                      <div className="flex items-center justify-between gap-2 min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0 flex-1">
                          <div className="w-1.5 h-1.5 shrink-0 rounded-full bg-green-400"></div>
                          <div className="min-w-0">
                            <div className="text-foreground font-medium text-[11px] truncate">{model.name}</div>
                            <div className="text-[10px] text-secondary truncate">{model.id}</div>
                          </div>
                        </div>
                        <div className="flex items-center shrink-0 space-x-1">
                          {model.supportsImage && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-primary-muted text-primary">
                              {i18nService.t('imageInput')}
                            </span>
                          )}
                          {model.supportsThinking && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-primary-muted text-primary">
                              {i18nService.t('thinkingOutput')}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => handleEditModel(model.id, model.name, model.supportsImage, model.supportsThinking, model.contextWindow, model.customParams)}
                            className="p-0.5 text-secondary hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <EditIcon className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteModel(model.id)}
                            className="p-0.5 text-secondary hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <TrashIcon className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}

                  {(!providers[activeProvider].models || providers[activeProvider].models.length === 0) && (
                    <div className="bg-surface p-2.5 rounded-xl border border-border-subtle text-center">
                      <p className="text-[11px] text-secondary">{i18nService.t('noModelsAvailable')}</p>
                      <button
                        type="button"
                        onClick={handleAddModel}
                        className="mt-1.5 inline-flex items-center text-[11px] font-medium text-primary hover:text-primary-hover"
                      >
                        <PlusCircleIcon className="h-3 w-3 mr-1" />
                        {i18nService.t('addFirstModel')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        {isTestResultModalOpen && testResult && (
          <div
            className="absolute inset-0 z-30 flex items-center justify-center bg-black/35 px-4 rounded-2xl"
            onClick={() => setIsTestResultModalOpen(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label={i18nService.t('connectionTestResult')}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md rounded-2xl bg-background border-border border shadow-modal p-4"
            >
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-semibold text-foreground">
                  {i18nService.t('connectionTestResult')}
                </h4>
                <button
                  type="button"
                  onClick={() => setIsTestResultModalOpen(false)}
                  className="p-1 text-secondary hover:text-foreground rounded-md hover:bg-surface-raised"
                >
                  <XMarkIcon className="h-4 w-4" />
                </button>
              </div>

              <div className="flex items-center gap-2 text-xs text-secondary">
                <span>{ProviderRegistry.get(testResult.provider)?.label ?? testResult.provider}</span>
                <span className="text-[11px]">•</span>
                <span className={`inline-flex items-center gap-1 ${testResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                  {testResult.success ? (
                    <CheckCircleIcon className="h-4 w-4" />
                  ) : (
                    <XCircleIcon className="h-4 w-4" />
                  )}
                  {testResult.success ? i18nService.t('connectionSuccess') : i18nService.t('connectionFailed')}
                </span>
              </div>

              <p className="mt-3 text-xs leading-5 text-foreground whitespace-pre-wrap break-words max-h-56 overflow-y-auto">
                {testResult.message}
              </p>

              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => setIsTestResultModalOpen(false)}
                  className="px-3 py-1.5 text-xs font-medium rounded-xl border border-border text-foreground hover:bg-surface-raised transition-colors active:scale-[0.98]"
                >
                  {i18nService.t('close')}
                </button>
              </div>
            </div>
          </div>
        )}

    </>
  );
};

export default ModelSettingsSection;
