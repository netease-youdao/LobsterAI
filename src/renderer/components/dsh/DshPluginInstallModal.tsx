import {
  ArrowPathIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
  FolderOpenIcon,
  ShieldExclamationIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useEffect, useRef, useState } from 'react';

import {
  DshPluginApplicationStatus,
  DshPluginInstallSource,
} from '../../../shared/dshEngine/hostConstants';
import {
  dshHostService,
  type DshPluginInspectResult,
  type DshPluginMutationResult,
  type DshPluginRegistriesResult,
} from '../../services/dshHost';
import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';
import {
  SETTINGS_DESCRIPTION_TEXT,
  SETTINGS_ITEM_TITLE_TEXT,
  SETTINGS_META_TEXT,
} from '../settings/settingsTypography';
import {
  formatRegistryDisplayName,
  isWebOnlyOrThemeInspection,
  RegistryPreset,
  resolveEffectiveRegistryUrl,
  resolveInspectProblemMessage,
  resolveMutationErrorMessage,
} from './pluginViewModel';

const InstallStep = {
  Input: 'input',
  Preview: 'preview',
  Installing: 'installing',
  BuildApproval: 'build-approval',
  Error: 'error',
} as const;
type InstallStep = typeof InstallStep[keyof typeof InstallStep];

interface DshPluginInstallModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInstalled: (result: DshPluginMutationResult) => void;
}

export const DshPluginInstallModal: React.FC<DshPluginInstallModalProps> = ({
  isOpen,
  onClose,
  onInstalled,
}) => {
  const t = (key: string) => i18nService.t(key);
  const [source, setSource] = useState<DshPluginInstallSource>(DshPluginInstallSource.Registry);
  const [spec, setSpec] = useState('');
  const [registryPreset, setRegistryPreset] = useState<RegistryPreset>(RegistryPreset.Auto);
  const [customRegistry, setCustomRegistry] = useState('');
  const [showRegistryOptions, setShowRegistryOptions] = useState(false);
  const [registries, setRegistries] = useState<DshPluginRegistriesResult | null>(null);

  const [step, setStep] = useState<InstallStep>(InstallStep.Input);
  const [checking, setChecking] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [inspection, setInspection] = useState<DshPluginInspectResult | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [failureResult, setFailureResult] = useState<DshPluginMutationResult | null>(null);
  const [pendingBuilds, setPendingBuilds] = useState<string[]>([]);
  const [showLogDetails, setShowLogDetails] = useState(false);

  const activeRequestIdRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setStep(InstallStep.Input);
    setSpec('');
    setInlineError(null);
    setInspection(null);
    setFailureResult(null);
    setPendingBuilds([]);
    setShowLogDetails(false);
    setChecking(false);
    setCancelling(false);
    activeRequestIdRef.current = null;

    let alive = true;
    void dshHostService.getPluginRegistries().then((res) => {
      if (alive && res.ok) setRegistries(res);
    }).catch(() => undefined);

    const focusTimer = setTimeout(() => {
      inputRef.current?.focus();
    }, 30);

    return () => {
      alive = false;
      clearTimeout(focusTimer);
    };
  }, [isOpen]);

  const effectiveRegistry =
    source === DshPluginInstallSource.Registry
      ? resolveEffectiveRegistryUrl(registryPreset, customRegistry, registries)
      : undefined;

  const isBusy = checking || step === InstallStep.Installing;

  const handleGuardedClose = () => {
    if (step === InstallStep.Installing) return;
    onClose();
  };

  const handlePickLocalDir = async () => {
    const res = await dshHostService.pickLocalPluginDir();
    if (res.ok && !res.canceled && res.path) {
      setSpec(res.path);
      setInlineError(null);
    }
  };

  const handleStartInstall = async () => {
    const trimmed = spec.trim();
    if (!trimmed || isBusy) return;

    if (source === DshPluginInstallSource.Registry && registryPreset === RegistryPreset.Custom) {
      const reg = customRegistry.trim();
      if (!reg || !/^https?:\/\//i.test(reg)) {
        setShowRegistryOptions(true);
        setInlineError(t('dshPluginsRegistryInvalidUrl'));
        return;
      }
    }

    setChecking(true);
    setInlineError(null);
    let inspected: DshPluginInspectResult;
    try {
      inspected = await dshHostService.inspectPlugin({
        spec: trimmed,
        ...(effectiveRegistry !== undefined ? { registry: effectiveRegistry } : {}),
      });
    } catch (error) {
      setChecking(false);
      setInlineError(error instanceof Error ? error.message : t('dshPluginsInspectFailed'));
      return;
    }
    setChecking(false);

    if (!inspected.ok || inspected.status === 'refused') {
      setInlineError(resolveInspectProblemMessage(inspected, t));
      return;
    }
    if (inspected.bundle === false) {
      setInlineError(t('dshPluginsProblemNotBundle'));
      return;
    }

    setInspection(inspected);

    // Pause for explicit confirmation only when a Web-only / theme compatibility warning applies.
    if (isWebOnlyOrThemeInspection(inspected)) {
      setStep(InstallStep.Preview);
      return;
    }

    // Normal compatible plugins install immediately in one click.
    await runInstall(undefined, inspected);
  };

  const runInstall = async (
    approvedBuilds?: string[],
    inspectedOverride?: DshPluginInspectResult | null,
  ) => {
    const trimmed = spec.trim();
    if (!trimmed) return;
    const activeInspection = inspectedOverride !== undefined ? inspectedOverride : inspection;
    const requestId = `install-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeRequestIdRef.current = requestId;
    setCancelling(false);
    setFailureResult(null);
    setShowLogDetails(false);
    setStep(InstallStep.Installing);

    try {
      const registryForInstall =
        activeInspection?.registry !== undefined && source === DshPluginInstallSource.Registry
          ? activeInspection.registry
          : effectiveRegistry;
      const res = await dshHostService.installPlugin({
        spec: trimmed,
        enabled: true,
        requestId,
        ...(registryForInstall !== undefined ? { registry: registryForInstall } : {}),
        ...(approvedBuilds && approvedBuilds.length > 0 ? { approvedBuilds } : {}),
      });
      activeRequestIdRef.current = null;

      if (res.application === DshPluginApplicationStatus.Cancelled) {
        setStep(InstallStep.Input);
        return;
      }

      if (res.ok) {
        onInstalled(res);
        onClose();
        return;
      }

      if (res.pendingBuilds && res.pendingBuilds.length > 0) {
        setPendingBuilds(res.pendingBuilds);
        setFailureResult(res);
        setStep(InstallStep.BuildApproval);
        return;
      }

      setFailureResult(res);
      setStep(InstallStep.Error);
    } catch (error) {
      activeRequestIdRef.current = null;
      setFailureResult({
        ok: false,
        error: error instanceof Error ? error.message : t('dshEcosystemInstallFailed'),
      });
      setStep(InstallStep.Error);
    }
  };

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    void handleStartInstall();
  };

  const handleCancelInstall = async () => {
    const requestId = activeRequestIdRef.current;
    if (!requestId || cancelling) return;
    setCancelling(true);
    try {
      await dshHostService.cancelPluginInstall(requestId);
    } catch {
      // Wait for install promise to settle.
    }
  };

  const placeholderBySource: Record<DshPluginInstallSource, string> = {
    [DshPluginInstallSource.Registry]: t('dshPluginsSpecPlaceholderRegistry'),
    [DshPluginInstallSource.Git]: t('dshPluginsSpecPlaceholderGit'),
    [DshPluginInstallSource.Local]: t('dshPluginsSpecPlaceholderLocal'),
  };

  const isWebOnlyWarning = isWebOnlyOrThemeInspection(inspection);
  const autoRegistryLabel = formatRegistryDisplayName(registries?.fastest ?? registries?.resolved, t);
  const logText = failureResult?.output || failureResult?.stderr || failureResult?.stdout || '';

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleGuardedClose}
      onEscape={handleGuardedClose}
      overlayClassName="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      className="w-full max-w-lg rounded-2xl border border-border bg-surface shadow-modal"
    >
      {/* Modal Header */}
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h3 className="text-base font-semibold text-foreground">{t('dshPluginsInstallModalTitle')}</h3>
        <button
          type="button"
          onClick={handleGuardedClose}
          disabled={step === InstallStep.Installing}
          aria-label={t('close')}
          className="rounded-lg p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <XMarkIcon className="h-5 w-5" />
        </button>
      </div>

      {/* Step 1: Input (uses div instead of form so React synthetic submit never bubbles to Settings' outer form) */}
      {step === InstallStep.Input && (
        <div className="space-y-4 px-5 py-4">
          {/* Source Switcher */}
          <div
            className="grid grid-cols-3 gap-1 rounded-xl bg-surface-raised p-1"
            role="tablist"
            aria-label={t('dshPluginsSourceLabel')}
          >
            {(
              [
                { id: DshPluginInstallSource.Registry, labelKey: 'dshPluginsSourceRegistry' },
                { id: DshPluginInstallSource.Git, labelKey: 'dshPluginsSourceGit' },
                { id: DshPluginInstallSource.Local, labelKey: 'dshPluginsSourceLocal' },
              ] as const
            ).map((tab) => {
              const active = source === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    setSource(tab.id);
                    setInlineError(null);
                  }}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? 'bg-surface text-foreground shadow-sm'
                      : 'text-secondary hover:text-foreground'
                  }`}
                >
                  {t(tab.labelKey)}
                </button>
              );
            })}
          </div>

          {/* Spec input */}
          <div className="space-y-1.5">
            <label className={`block font-medium text-foreground ${SETTINGS_DESCRIPTION_TEXT}`}>
              {source === DshPluginInstallSource.Registry
                ? t('dshPluginsSpecLabelRegistry')
                : source === DshPluginInstallSource.Git
                  ? t('dshPluginsSpecLabelGit')
                  : t('dshPluginsSpecLabelLocal')}
            </label>
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                value={spec}
                onChange={(e) => {
                  setSpec(e.target.value);
                  setInlineError(null);
                }}
                onKeyDown={handleInputKeyDown}
                placeholder={placeholderBySource[source]}
                className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-secondary/60 focus:border-primary"
              />
              {source === DshPluginInstallSource.Local && (
                <button
                  type="button"
                  onClick={() => void handlePickLocalDir()}
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
                >
                  <FolderOpenIcon className="h-4 w-4 text-secondary" />
                  {t('dshPluginsBrowseDir')}
                </button>
              )}
            </div>
            <p className={`${SETTINGS_META_TEXT} text-secondary`}>
              {t('dshPluginsInstallHint')}
            </p>
          </div>

          {/* Registry options for npm source */}
          {source === DshPluginInstallSource.Registry && (
            <div className="rounded-xl border border-border bg-background/60 px-3 py-2">
              <button
                type="button"
                onClick={() => setShowRegistryOptions((prev) => !prev)}
                className="flex w-full items-center justify-between gap-2 text-left text-xs text-secondary hover:text-foreground"
              >
                <span className="flex items-center gap-1.5">
                  {showRegistryOptions
                    ? <ChevronDownIcon className="h-3.5 w-3.5" />
                    : <ChevronRightIcon className="h-3.5 w-3.5" />}
                  <span>{t('dshPluginsRegistryLabel')}</span>
                </span>
                <span className="truncate font-medium text-foreground">
                  {registryPreset === RegistryPreset.Auto
                    ? `${t('dshPluginsRegistryAuto')} (${autoRegistryLabel})`
                    : registryPreset === RegistryPreset.NpmMirror
                      ? t('dshPluginsRegistryNpmMirror')
                      : registryPreset === RegistryPreset.Official
                        ? t('dshPluginsRegistryOfficial')
                        : customRegistry.trim() || t('dshPluginsRegistryCustom')}
                </span>
              </button>

              {showRegistryOptions && (
                <div className="mt-2.5 space-y-2 border-t border-border pt-2.5">
                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [
                        { id: RegistryPreset.Auto, label: t('dshPluginsRegistryAuto') },
                        { id: RegistryPreset.NpmMirror, label: t('dshPluginsRegistryNpmMirror') },
                        { id: RegistryPreset.Official, label: t('dshPluginsRegistryOfficial') },
                        { id: RegistryPreset.Custom, label: t('dshPluginsRegistryCustom') },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => {
                          setRegistryPreset(opt.id);
                          setInlineError(null);
                        }}
                        className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                          registryPreset === opt.id
                            ? 'border-primary bg-primary-muted font-medium text-primary'
                            : 'border-border bg-surface text-secondary hover:text-foreground'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  {registryPreset === RegistryPreset.Custom && (
                    <input
                      type="url"
                      value={customRegistry}
                      onChange={(e) => {
                        setCustomRegistry(e.target.value);
                        setInlineError(null);
                      }}
                      onKeyDown={handleInputKeyDown}
                      placeholder="https://registry.example.com/"
                      className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-primary"
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {inlineError && (
            <div className="rounded-xl border border-red-300/70 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800/70 dark:bg-red-950/35 dark:text-red-300">
              {inlineError}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={handleGuardedClose}
              className="rounded-xl border border-border px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
            >
              {t('cancel')}
            </button>
            <button
              type="button"
              disabled={!spec.trim() || checking}
              onClick={() => void handleStartInstall()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {checking && <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />}
              {checking ? t('dshPluginsChecking') : t('dshEcosystemInstallBtn')}
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Preview & Compatibility Check */}
      {step === InstallStep.Preview && inspection && (
        <div className="space-y-4 px-5 py-4">
          <div className="rounded-xl border border-border bg-background/60 p-3.5">
            <div className="flex items-center gap-2">
              <span className={`truncate font-mono font-semibold text-foreground ${SETTINGS_ITEM_TITLE_TEXT}`}>
                {inspection.name || spec.trim()}
              </span>
              {inspection.version && (
                <span className="shrink-0 rounded-md bg-surface-raised px-1.5 py-0.5 text-[11px] text-secondary">
                  v{inspection.version}
                </span>
              )}
            </div>
            {inspection.description && (
              <p className={`mt-1.5 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
                {inspection.description}
              </p>
            )}
            <div className={`mt-2 flex flex-wrap gap-x-4 gap-y-1 ${SETTINGS_META_TEXT} text-secondary`}>
              {inspection.registry && (
                <span>
                  {t('dshPluginsRegistryLabel')}: {formatRegistryDisplayName(inspection.registry, t)}
                </span>
              )}
              {inspection.host && (
                <span>
                  {t('dshPluginsSourceHost')}: {inspection.host}
                </span>
              )}
            </div>
          </div>

          {isWebOnlyWarning && (
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-400/50 bg-amber-50/80 px-3.5 py-3 text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200">
              <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="space-y-1">
                <div className="text-xs font-semibold">
                  {inspection.isThemePlugin
                    ? t('dshPluginsThemeWarningTitle')
                    : t('dshPluginsWebOnlyWarningTitle')}
                </div>
                <p className="text-xs leading-relaxed opacity-90">
                  {inspection.isThemePlugin
                    ? t('dshPluginsThemeWarningDesc')
                    : t('dshPluginsWebOnlyWarningDesc')}
                </p>
              </div>
            </div>
          )}

          <div className="flex justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={() => setStep(InstallStep.Input)}
              className="rounded-xl border border-border px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
            >
              {t('dshPluginsBackToEdit')}
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleGuardedClose}
                className="rounded-xl border border-border px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => void runInstall()}
                className="rounded-xl bg-primary px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-hover"
              >
                {isWebOnlyWarning ? t('dshPluginsInstallAnyway') : t('dshPluginsInstallNow')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Step 3: Installing */}
      {step === InstallStep.Installing && (
        <div className="space-y-4 px-5 py-6">
          <div className="flex items-start gap-3">
            <ArrowPathIcon className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-primary" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={`truncate font-medium text-foreground ${SETTINGS_ITEM_TITLE_TEXT}`}>
                  {cancelling ? t('dshPluginsCancelling') : t('dshEcosystemInstalling')}
                </span>
                {inspection?.version && (
                  <span className="shrink-0 rounded-md bg-surface-raised px-1.5 py-0.5 font-mono text-[11px] text-secondary">
                    v{inspection.version}
                  </span>
                )}
              </div>
              <div className={`mt-0.5 truncate font-mono ${SETTINGS_META_TEXT} text-secondary`}>
                {inspection?.name || spec.trim()}
              </div>
              {inspection?.description && (
                <p className={`mt-1 line-clamp-2 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
                  {inspection.description}
                </p>
              )}
            </div>
          </div>
          <p className={`${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
            {t('dshPluginsInstallingHotReloadNote')}
          </p>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleCancelInstall()}
              disabled={cancelling}
              className="rounded-xl border border-border px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:opacity-50"
            >
              {cancelling ? t('dshPluginsCancelling') : t('dshPluginsCancelInstall')}
            </button>
          </div>
        </div>
      )}

      {/* Step 4: pnpm Build Script Approval */}
      {step === InstallStep.BuildApproval && (
        <div className="space-y-4 px-5 py-4">
          <div className="flex items-start gap-2.5 rounded-xl border border-amber-400/50 bg-amber-50/80 px-3.5 py-3 text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200">
            <ShieldExclamationIcon className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="space-y-1.5">
              <div className="text-xs font-semibold">{t('dshPluginsBuildBlockedTitle')}</div>
              <p className="text-xs leading-relaxed opacity-90">
                {t('dshPluginsBuildBlockedDesc')}
              </p>
              <ul className="list-disc pl-4 font-mono text-[11px]">
                {pendingBuilds.map((pkg) => (
                  <li key={pkg}>{pkg}</li>
                ))}
              </ul>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setStep(InstallStep.Input)}
              className="rounded-xl border border-border px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
            >
              {t('cancel')}
            </button>
            <button
              type="button"
              onClick={() => void runInstall(pendingBuilds)}
              className="rounded-xl bg-primary px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-hover"
            >
              {t('dshPluginsApproveBuildsAndRetry')}
            </button>
          </div>
        </div>
      )}

      {/* Step 5: Error */}
      {step === InstallStep.Error && failureResult && (
        <div className="space-y-4 px-5 py-4">
          <div className="rounded-xl border border-red-300/70 bg-red-50 px-3.5 py-3 text-xs text-red-700 dark:border-red-800/70 dark:bg-red-950/35 dark:text-red-300">
            {resolveMutationErrorMessage(failureResult, 'dshEcosystemInstallFailed', t)}
          </div>

          {logText && (
            <div className="rounded-xl border border-border bg-background/60">
              <button
                type="button"
                onClick={() => setShowLogDetails((prev) => !prev)}
                className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium text-secondary hover:text-foreground"
              >
                {showLogDetails
                  ? <ChevronDownIcon className="h-3.5 w-3.5" />
                  : <ChevronRightIcon className="h-3.5 w-3.5" />}
                {t('dshPluginsViewInstallLog')}
              </button>
              {showLogDetails && (
                <pre className="max-h-48 overflow-auto border-t border-border p-3 font-mono text-[11px] leading-relaxed text-secondary whitespace-pre-wrap break-all">
                  {logText}
                </pre>
              )}
            </div>
          )}

          <div className="flex justify-between gap-2">
            <button
              type="button"
              onClick={() => setStep(InstallStep.Input)}
              className="rounded-xl border border-border px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
            >
              {t('dshPluginsBackToEdit')}
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleGuardedClose}
                className="rounded-xl border border-border px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
              >
                {t('close')}
              </button>
              <button
                type="button"
                onClick={() => void runInstall()}
                className="rounded-xl bg-primary px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-hover"
              >
                {t('retry')}
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
};
