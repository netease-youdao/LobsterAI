import {
  ArrowPathIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  FolderOpenIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  DshPluginApplicationStatus,
  DshPluginInstallPhase,
} from '../../../shared/dshEngine/hostConstants';
import {
  dispatchOpenEmbeddedPlugin,
  dshHostService,
  type DshPluginEntry,
  type DshPluginInspectResult,
  type DshPluginMutationResult,
  type DshPluginRegistriesResult,
  loadDshPluginInstallRegistry,
  saveDshPluginInstallRegistry,
} from '../../services/dshHost';
import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';
import {
  SETTINGS_DESCRIPTION_TEXT,
  SETTINGS_META_TEXT,
} from '../settings/settingsTypography';
import { DshInstallTerminalBlock } from './DshInstallTerminalBlock';
import {
  appendInstallLogChunk,
  buildOfferedRegistries,
  getRegistryDisplayInfo,
  INSTALL_EXAMPLE_PACKAGE,
  INSTALL_GIT_TEMPLATE,
  INSTALL_PATH_TEMPLATE,
  InstallModalPhase,
  type InstallRegistryChoice,
  isInstallPendingPhase,
  isValidCustomRegistryUrl,
  type PluginInstallRun,
  resolveGithubMirrorRecovery,
  resolveInitialRegistryChoice,
  resolveInstallFailureText,
  resolveInstallInputProblem,
  resolveInstallRestartReasonText,
  resolveRegistryValueForRpc,
  resolveSubjectKindLabelKey,
  settleInstallRuns,
  shouldShowMinimumReleaseAgeNotice,
} from './pluginInstallViewModel';
import {
  isWebOnlyOrThemeInspection,
  resolvePluginDisplayTitle,
} from './pluginViewModel';

export const BackgroundInstallOutcome = {
  Done: 'done',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;
export type BackgroundInstallOutcome =
  typeof BackgroundInstallOutcome[keyof typeof BackgroundInstallOutcome];

interface RegistryPopoverPosition {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

interface InstallAttemptsState {
  registries: Array<string | null>;
  total: number;
}

interface DshPluginInstallModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInstalled: (result: DshPluginMutationResult) => void;
  onRestartHost?: () => Promise<void> | void;
  onActiveInstallChange?: (active: boolean) => void;
  onBackgroundOutcome?: (outcome: BackgroundInstallOutcome, result?: DshPluginMutationResult) => void;
}

/**
 * Tracks IME composition including WebKit/Safari's brief post-composition Enter
 * window so committing Chinese/Japanese characters never triggers submit.
 */
function useImeCompositionGuard(active: boolean) {
  const stateRef = useRef({ active: false, until: 0 });
  useEffect(() => {
    stateRef.current = { active: false, until: 0 };
  }, [active]);

  return {
    onCompositionStart: () => {
      stateRef.current.active = true;
    },
    onCompositionEnd: () => {
      stateRef.current = { active: false, until: Date.now() + 15 };
    },
    onBlur: () => {
      stateRef.current = { active: false, until: 0 };
    },
    isComposing: (event: KeyboardEvent) =>
      event.isComposing
      || event.keyCode === 229
      || stateRef.current.active
      || Date.now() < stateRef.current.until,
  };
}

export const DshPluginInstallModal: React.FC<DshPluginInstallModalProps> = ({
  isOpen,
  onClose,
  onInstalled,
  onRestartHost,
  onActiveInstallChange,
  onBackgroundOutcome,
}) => {
  const t = (key: string) => i18nService.t(key);
  const language = i18nService.getLanguage() === 'en' ? 'en' : 'zh';

  const errorId = useId();
  const guideId = useId();
  const registryPopoverId = useId();
  const registryRadioName = useId();
  const registryErrorId = useId();

  const [spec, setSpec] = useState('');
  const [mirrorRecovery, setMirrorRecovery] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

  const [registries, setRegistries] = useState<DshPluginRegistriesResult | null>(null);
  const [registryChoice, setRegistryChoice] = useState<InstallRegistryChoice>({
    kind: 'offered',
    registry: null,
  });
  const [customRegistryDraft, setCustomRegistryDraft] = useState('');
  const [registryOpen, setRegistryOpen] = useState(false);
  const [registryError, setRegistryError] = useState(false);
  const [popoverPos, setPopoverPos] = useState<RegistryPopoverPosition | null>(null);

  const [phase, setPhase] = useState<InstallModalPhase>(InstallModalPhase.Idle);
  const [inputError, setInputError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<DshPluginInspectResult | null>(null);
  const [installResult, setInstallResult] = useState<DshPluginMutationResult | null>(null);
  const [runs, setRuns] = useState<PluginInstallRun[]>([]);
  const [attempts, setAttempts] = useState<InstallAttemptsState | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const registryToggleRef = useRef<HTMLButtonElement>(null);
  const registryPanelRef = useRef<HTMLFieldSetElement>(null);
  const registryCustomRef = useRef<HTMLInputElement>(null);

  const mountedRef = useRef(true);
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const registryChoiceRef = useRef(registryChoice);
  registryChoiceRef.current = registryChoice;
  const registriesRef = useRef(registries);
  registriesRef.current = registries;

  const activeRequestIdRef = useRef<string | null>(null);
  const inspectGenerationRef = useRef(0);
  const userTouchedRegistryRef = useRef(false);
  const registryReadPromiseRef = useRef<Promise<void> | null>(null);
  const unseenSettledRef = useRef(false);

  const pending = isInstallPendingPhase(phase);
  const registryShown = isOpen && registryOpen && phase === InstallModalPhase.Idle;

  const specComposition = useImeCompositionGuard(isOpen && phase === InstallModalPhase.Idle);
  const registryComposition = useImeCompositionGuard(registryShown);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    onActiveInstallChange?.(pending || unseenSettledRef.current);
  }, [pending, onActiveInstallChange]);

  const computePopoverPosition = useCallback(() => {
    const anchor = registryToggleRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const margin = 12;
    const width = Math.min(400, viewportW - margin * 2);
    const left = Math.max(margin, Math.min(rect.right - width, viewportW - width - margin));
    const spaceBelow = viewportH - rect.bottom - margin - 6;
    const spaceAbove = rect.top - margin - 6;
    if (spaceBelow >= 230 || spaceBelow >= spaceAbove) {
      setPopoverPos({
        left,
        width,
        top: Math.max(margin, rect.bottom + 6),
        maxHeight: Math.max(160, spaceBelow),
      });
    } else {
      setPopoverPos({
        left,
        width,
        bottom: Math.max(margin, viewportH - rect.top + 6),
        maxHeight: Math.max(160, spaceAbove),
      });
    }
  }, []);

  useEffect(() => {
    if (!registryShown) return undefined;
    computePopoverPosition();
    const onLayoutChange = () => computePopoverPosition();
    window.addEventListener('resize', onLayoutChange);
    window.addEventListener('scroll', onLayoutChange, true);
    return () => {
      window.removeEventListener('resize', onLayoutChange);
      window.removeEventListener('scroll', onLayoutChange, true);
    };
  }, [registryShown, computePopoverPosition]);

  useEffect(() => {
    if (registryShown && registryError) {
      registryCustomRef.current?.focus();
    }
  }, [registryShown, registryError]);

  useEffect(() => {
    if (!registryShown) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (registryToggleRef.current?.contains(target)) return;
      if (registryPanelRef.current?.contains(target)) return;
      setRegistryOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setRegistryOpen(false);
      registryToggleRef.current?.focus();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [registryShown]);

  // Initialize fresh dialog state on open unless an install is pending or has an
  // unseen settled result waiting for the user to inspect.
  useEffect(() => {
    if (!isOpen) return;

    if (isInstallPendingPhase(phaseRef.current)) {
      return;
    }
    if (unseenSettledRef.current) {
      unseenSettledRef.current = false;
      onActiveInstallChange?.(false);
      return;
    }

    inspectGenerationRef.current += 1;
    activeRequestIdRef.current = null;
    userTouchedRegistryRef.current = false;

    setSpec('');
    setMirrorRecovery(false);
    setGuideOpen(false);
    setRegistryOpen(false);
    setRegistryError(false);
    setPhase(InstallModalPhase.Idle);
    setInputError(null);
    setInspection(null);
    setInstallResult(null);
    setRuns([]);
    setAttempts(null);
    setDetailsOpen(false);
    setRestarting(false);

    let alive = true;
    const readPromise = Promise.all([
      loadDshPluginInstallRegistry().catch(() => null),
      dshHostService.getPluginRegistries().catch(() => null),
    ]).then(([remembered, fetchedRegistries]) => {
      if (!alive || !mountedRef.current) return;
      const validRegistries = fetchedRegistries?.ok ? fetchedRegistries : null;
      if (validRegistries) {
        setRegistries(validRegistries);
        registriesRef.current = validRegistries;
      }
      if (!userTouchedRegistryRef.current) {
        const nextChoice = resolveInitialRegistryChoice(remembered, validRegistries);
        setRegistryChoice(nextChoice);
        registryChoiceRef.current = nextChoice;
        if (nextChoice.kind === 'custom') {
          setCustomRegistryDraft(nextChoice.url);
        }
      }
    });
    registryReadPromiseRef.current = readPromise;
    void readPromise.finally(() => {
      if (registryReadPromiseRef.current === readPromise) {
        registryReadPromiseRef.current = null;
      }
    });

    const focusTimer = setTimeout(() => {
      inputRef.current?.focus();
    }, 30);

    return () => {
      alive = false;
      clearTimeout(focusTimer);
    };
  }, [isOpen, onActiveInstallChange]);

  // Subscribe to live install phase transitions and streamed pnpm output chunks.
  useEffect(() => {
    if (!pending) return undefined;

    const unsubState = dshHostService.onPluginInstallState((progress) => {
      if (!activeRequestIdRef.current || progress.requestId !== activeRequestIdRef.current) return;
      if (!mountedRef.current) return;

      setPhase((prev) => {
        if (prev === InstallModalPhase.Applying) return prev;
        if (progress.phase === DshPluginInstallPhase.Applying) return InstallModalPhase.Applying;
        if (progress.phase === DshPluginInstallPhase.Cancelling) return InstallModalPhase.Cancelling;
        if (prev === InstallModalPhase.Cancelling) return prev;
        return InstallModalPhase.Running;
      });

      if (progress.attempt) {
        const { registry, total } = progress.attempt;
        setAttempts((prev) => ({
          registries: [...(prev?.registries ?? []), registry],
          total: Math.max(prev?.total ?? 0, total),
        }));
      }
    });

    const unsubLog = dshHostService.onPluginInstallLog((chunk) => {
      if (!activeRequestIdRef.current || chunk.requestId !== activeRequestIdRef.current) return;
      if (!mountedRef.current) return;

      setPhase((prev) => (prev === InstallModalPhase.Starting ? InstallModalPhase.Running : prev));
      setRuns((prev) => appendInstallLogChunk(prev, chunk, false));
    });

    return () => {
      unsubState();
      unsubLog();
    };
  }, [pending]);

  const handleChooseRegistry = (choice: InstallRegistryChoice, closePopover: boolean) => {
    userTouchedRegistryRef.current = true;
    setRegistryChoice(choice);
    registryChoiceRef.current = choice;
    setRegistryError(false);
    setInputError(null);
    if (closePopover) {
      setRegistryOpen(false);
    }
  };

  const handlePickLocalDir = async () => {
    const res = await dshHostService.pickLocalPluginDir();
    if (res.ok && !res.canceled && res.path) {
      setSpec(res.path);
      setInputError(null);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  };

  const runInstall = async (
    approvedBuilds?: string[],
    inspectedOverride?: DshPluginInspectResult | null,
    choiceOverride?: InstallRegistryChoice,
  ) => {
    const trimmed = spec.trim();
    if (!trimmed) return;

    const activeInspection = inspectedOverride !== undefined ? inspectedOverride : inspection;
    const activeChoice = choiceOverride ?? registryChoiceRef.current;
    const requestId = `install-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    activeRequestIdRef.current = requestId;
    unseenSettledRef.current = false;
    setInstallResult(null);
    setRuns([]);
    setAttempts(null);
    setDetailsOpen(false);
    setPhase(InstallModalPhase.Starting);

    const registryForInstall =
      activeInspection?.registry !== undefined
        ? activeInspection.registry
        : resolveRegistryValueForRpc(activeChoice);

    let res: DshPluginMutationResult;
    try {
      res = await dshHostService.installPlugin({
        spec: trimmed,
        enabled: true,
        requestId,
        registry: registryForInstall,
        ...(approvedBuilds && approvedBuilds.length > 0 ? { approvedBuilds } : {}),
      });
    } catch (error) {
      res = {
        ok: false,
        error: error instanceof Error ? error.message : t('dshEcosystemInstallFailed'),
      };
    }

    if (!mountedRef.current || activeRequestIdRef.current !== requestId) return;
    activeRequestIdRef.current = null;

    if (res.registries && res.registries.length > 0) {
      setAttempts((prev) => ({
        registries: res.registries!,
        total: Math.max(prev?.total ?? 0, res.registries!.length),
      }));
    }

    if (res.application === DshPluginApplicationStatus.Cancelled) {
      setPhase(InstallModalPhase.Idle);
      setInstallResult(null);
      setRuns([]);
      setAttempts(null);
      onActiveInstallChange?.(false);
      if (!isOpenRef.current) {
        onBackgroundOutcome?.(BackgroundInstallOutcome.Cancelled, res);
      }
      return;
    }

    if (res.ok) {
      setRuns((prev) => settleInstallRuns(prev, 0));
      setInstallResult(res);
      setPhase(InstallModalPhase.Done);
      onInstalled(res);
      if (!isOpenRef.current) {
        unseenSettledRef.current = true;
        onActiveInstallChange?.(true);
        onBackgroundOutcome?.(BackgroundInstallOutcome.Done, res);
      }
      return;
    }

    const fallbackOutput = res.output || res.stderr || res.stdout || '';
    setRuns((prev) => {
      if (prev.length > 0) {
        return settleInstallRuns(prev, res.exitCode ?? null);
      }
      if (!fallbackOutput.trim()) return prev;
      return [
        {
          jobId: `fallback-${requestId}`,
          command: `pnpm add ${trimmed}`,
          cwd: '',
          output: fallbackOutput,
          exitCode: res.exitCode ?? 1,
        },
      ];
    });
    setInstallResult(res);
    setPhase(InstallModalPhase.Failed);
    if (!isOpenRef.current) {
      unseenSettledRef.current = true;
      onActiveInstallChange?.(true);
      onBackgroundOutcome?.(BackgroundInstallOutcome.Failed, res);
    }
  };

  const handleStartInstall = async () => {
    const trimmed = spec.trim();
    if (!trimmed || phase === InstallModalPhase.Checking || pending) return;

    const currentChoice = registryChoiceRef.current;
    if (currentChoice.kind === 'custom' && !isValidCustomRegistryUrl(currentChoice.url)) {
      setRegistryError(true);
      setRegistryOpen(true);
      return;
    }

    const generation = ++inspectGenerationRef.current;
    setPhase(InstallModalPhase.Checking);
    setInputError(null);
    setRegistryOpen(false);
    setRegistryError(false);

    if (!userTouchedRegistryRef.current && registryReadPromiseRef.current) {
      await registryReadPromiseRef.current.catch(() => undefined);
      if (!mountedRef.current || inspectGenerationRef.current !== generation) return;
    }

    const effectiveChoice = registryChoiceRef.current;
    if (effectiveChoice.kind === 'custom' && !isValidCustomRegistryUrl(effectiveChoice.url)) {
      setPhase(InstallModalPhase.Idle);
      setRegistryError(true);
      setRegistryOpen(true);
      return;
    }

    const normalizedChoice: InstallRegistryChoice =
      effectiveChoice.kind === 'custom'
        ? { kind: 'custom', url: effectiveChoice.url.trim() }
        : effectiveChoice;
    void saveDshPluginInstallRegistry(normalizedChoice);

    let inspected: DshPluginInspectResult;
    try {
      inspected = await dshHostService.inspectPlugin({
        spec: trimmed,
        registry: resolveRegistryValueForRpc(normalizedChoice),
      });
    } catch (error) {
      if (!mountedRef.current || inspectGenerationRef.current !== generation) return;
      setPhase(InstallModalPhase.Idle);
      setInputError(error instanceof Error ? error.message : t('dshPluginsInspectFailed'));
      return;
    }

    if (!mountedRef.current || inspectGenerationRef.current !== generation) return;

    if (!inspected.ok || inspected.status === 'refused') {
      setPhase(InstallModalPhase.Idle);
      setInputError(resolveInstallInputProblem(inspected, registriesRef.current?.resolved, t));
      return;
    }

    if (inspected.bundle === false) {
      setPhase(InstallModalPhase.Idle);
      setInputError(t('dshPluginsProblemNotBundle'));
      return;
    }

    setInspection(inspected);

    if (isWebOnlyOrThemeInspection(inspected)) {
      setPhase(InstallModalPhase.Preview);
      return;
    }

    await runInstall(undefined, inspected, normalizedChoice);
  };

  const handleCancelOrBack = async () => {
    if (phase === InstallModalPhase.Checking) {
      inspectGenerationRef.current += 1;
      setPhase(InstallModalPhase.Idle);
      return;
    }
    if (phase === InstallModalPhase.Preview || phase === InstallModalPhase.Failed) {
      setPhase(InstallModalPhase.Idle);
      setInstallResult(null);
      setTimeout(() => inputRef.current?.focus(), 20);
      return;
    }
    const requestId = activeRequestIdRef.current;
    if (!requestId) return;
    if (phase !== InstallModalPhase.Starting && phase !== InstallModalPhase.Running) return;

    setPhase(InstallModalPhase.Cancelling);
    try {
      const res = await dshHostService.cancelPluginInstall(requestId);
      if (!mountedRef.current || activeRequestIdRef.current !== requestId) return;
      if (res.status === 'too-late') {
        setPhase(InstallModalPhase.Applying);
      }
    } catch {
      // Wait for the in-flight installPlugin promise to settle.
    }
  };

  const handleCloseButton = () => {
    if (registryOpen) {
      setRegistryOpen(false);
      return;
    }
    if (phase === InstallModalPhase.Checking) {
      inspectGenerationRef.current += 1;
      setPhase(InstallModalPhase.Idle);
      onClose();
      return;
    }
    if (pending) {
      // Hide modal and request cancellation if still in a cancellable phase.
      onClose();
      if (phase === InstallModalPhase.Starting || phase === InstallModalPhase.Running) {
        void handleCancelOrBack();
      }
      return;
    }
    unseenSettledRef.current = false;
    onActiveInstallChange?.(false);
    onClose();
  };

  const handleBackdropOrEscape = () => {
    if (registryOpen) {
      setRegistryOpen(false);
      return;
    }
    if (pending || restarting) return;
    handleCloseButton();
  };

  const handleChangeRegistryFromFailure = () => {
    setPhase(InstallModalPhase.Idle);
    setInstallResult(null);
    setRegistryOpen(true);
  };

  const handleUseGithubMirror = (mirrorRegistry: string | null, alreadyUsingMirror: boolean) => {
    if (!alreadyUsingMirror) {
      const nextChoice: InstallRegistryChoice = { kind: 'offered', registry: mirrorRegistry };
      userTouchedRegistryRef.current = true;
      setRegistryChoice(nextChoice);
      registryChoiceRef.current = nextChoice;
      void saveDshPluginInstallRegistry(nextChoice);
    } else {
      setGuideOpen(true);
    }
    setSpec('');
    setMirrorRecovery(true);
    setInputError(null);
    setInspection(null);
    setInstallResult(null);
    setRuns([]);
    setAttempts(null);
    setPhase(InstallModalPhase.Idle);
    setTimeout(() => inputRef.current?.focus(), 30);
  };

  const handleRestartNow = async () => {
    if (!onRestartHost || restarting) return;
    setRestarting(true);
    try {
      await onRestartHost();
      if (mountedRef.current) {
        onClose();
      }
    } finally {
      if (mountedRef.current) {
        setRestarting(false);
      }
    }
  };

  const offeredRegistries = useMemo(() => buildOfferedRegistries(registries), [registries]);
  const resolvedRegistry = registries?.resolved ?? null;
  const chosenRegistryLabel =
    registryChoice.kind === 'custom'
      ? t('dshPluginsRegistryCustom')
      : getRegistryDisplayInfo(registryChoice.registry, resolvedRegistry, t).name;

  const githubRecovery = useMemo(
    () =>
      phase === InstallModalPhase.Failed
        ? resolveGithubMirrorRecovery({
            failure: installResult,
            subjectHost: inspection?.host,
            registries,
            currentChoice: registryChoice,
          })
        : { applicable: false, mirrorRegistry: null, alreadyUsingMirror: false, isTimeout: false },
    [phase, installResult, inspection?.host, registries, registryChoice],
  );

  const installedPluginEntry: DshPluginEntry | undefined = useMemo(() => {
    if (phase !== InstallModalPhase.Done || !installResult?.ok) return undefined;
    const targetName = installResult.bundle || inspection?.name;
    if (!targetName) return undefined;
    return installResult.plugins?.find((item) => item.name === targetName);
  }, [phase, installResult, inspection?.name]);

  const minReleaseAgeNotice = useMemo(
    () =>
      phase === InstallModalPhase.Done
        ? shouldShowMinimumReleaseAgeNotice({
            inspection,
            result: installResult,
            attemptedCount: attempts?.registries.length ?? 1,
          })
        : null,
    [phase, inspection, installResult, attempts?.registries.length],
  );

  const templateHint =
    spec === INSTALL_GIT_TEMPLATE
      ? t('dshPluginsInstallGitTemplateHint')
      : spec === INSTALL_PATH_TEMPLATE
        ? t('dshPluginsInstallPathTemplateHint')
        : null;

  const renderSubjectCard = () => {
    const title = inspection?.name || installResult?.bundle || spec.trim();
    if (!title) return null;
    const kindKey = resolveSubjectKindLabelKey(inspection?.kind);
    const description = inspection?.description || (kindKey ? t(kindKey) : undefined);
    const version =
      phase === InstallModalPhase.Done && installResult?.version
        ? installResult.version
        : inspection?.version;

    return (
      <div className="flex flex-col items-center gap-1 rounded-xl border border-border bg-background/60 px-4 py-3.5 text-center">
        <p className="max-w-full break-all font-mono text-sm font-semibold text-foreground">
          {title}
        </p>
        {description && (
          <p className="max-w-full text-xs leading-relaxed text-secondary">
            {description}
          </p>
        )}
        {version && (
          <p className="text-xs text-secondary">
            {t('dshPluginsInstallVersionMeta').replace('{version}', version)}
          </p>
        )}
      </div>
    );
  };

  // Screen A: Dedicated GitHub Unreachable / Timeout Recovery Dialog
  if (githubRecovery.applicable) {
    return (
      <Modal
        isOpen={isOpen}
        onClose={handleBackdropOrEscape}
        onEscape={handleBackdropOrEscape}
        overlayClassName="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
        className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-modal"
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-base font-semibold text-foreground">
            {githubRecovery.isTimeout
              ? t('dshPluginsInstallGithubTimeoutTitle')
              : t('dshPluginsInstallGithubFailedTitle')}
          </h3>
          <button
            type="button"
            onClick={handleCloseButton}
            aria-label={t('close')}
            className="rounded-lg p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <p className={`mt-2 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
          {t('dshPluginsInstallGithubFailedDesc')}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={handleCloseButton}
            className="rounded-xl border border-border px-4 py-2 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            autoFocus
            onClick={() =>
              handleUseGithubMirror(
                githubRecovery.mirrorRegistry,
                githubRecovery.alreadyUsingMirror,
              )
            }
            className="rounded-xl bg-action px-4 py-2 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover"
          >
            {githubRecovery.alreadyUsingMirror
              ? t('dshPluginsInstallTryAnotherWay')
              : t('dshPluginsInstallUseGithubMirror')}
          </button>
        </div>
      </Modal>
    );
  }

  // Screen B: Unified Input Screen (Idle / Checking)
  if (phase === InstallModalPhase.Idle || phase === InstallModalPhase.Checking) {
    const checking = phase === InstallModalPhase.Checking;
    const empty = spec.trim() === '';

    return (
      <>
        <Modal
          isOpen={isOpen}
          onClose={handleBackdropOrEscape}
          onEscape={handleBackdropOrEscape}
          overlayClassName="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          className="flex max-h-[min(780px,90vh)] w-full max-w-[540px] flex-col rounded-2xl border border-border bg-surface shadow-modal"
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-3 px-6 pt-6 pb-2">
            <div className="min-w-0 space-y-1.5">
              <h3 className="text-lg font-semibold text-foreground">
                {t('dshPluginsInstallModalTitle')}
              </h3>
              {!mirrorRecovery && (
                <p className="text-sm text-secondary">
                  {t('dshPluginsInstallModalSubtitle')}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={handleCloseButton}
              aria-label={t('close')}
              className="rounded-lg p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>

          {/* Scrollable Body */}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-3">
            {/* Unified spec input with trailing local-dir picker */}
            <div className="relative">
              <input
                ref={inputRef}
                type="text"
                value={spec}
                disabled={checking}
                placeholder={t('dshPluginsInstallSpecPlaceholder')}
                aria-label={t('dshPluginsInstallSpecLabel')}
                aria-invalid={inputError !== null}
                aria-describedby={inputError ? errorId : undefined}
                onChange={(e) => {
                  setSpec(e.target.value);
                  setInputError(null);
                }}
                onCompositionStart={specComposition.onCompositionStart}
                onCompositionEnd={specComposition.onCompositionEnd}
                onBlur={specComposition.onBlur}
                onKeyDown={(e) => {
                  if (specComposition.isComposing(e.nativeEvent)) return;
                  if (e.key === 'Enter' && !empty && !checking) {
                    e.preventDefault();
                    e.stopPropagation();
                    void handleStartInstall();
                  }
                }}
                className={`h-11 w-full rounded-xl border bg-background pl-3.5 pr-10 text-sm text-foreground outline-none transition-colors placeholder:text-secondary/60 disabled:opacity-60 ${
                  inputError
                    ? 'border-red-500 focus:border-red-500 focus:ring-2 focus:ring-red-500/20'
                    : 'border-border focus:border-primary focus:ring-2 focus:ring-primary/20'
                }`}
              />
              <button
                type="button"
                disabled={checking}
                onClick={() => void handlePickLocalDir()}
                title={t('dshPluginsBrowseDirTooltip')}
                aria-label={t('dshPluginsBrowseDirTooltip')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                <FolderOpenIcon className="h-4 w-4" />
              </button>
            </div>

            {/* Inline refusal error or template hint */}
            {inputError && (
              <p id={errorId} role="alert" className="text-xs leading-relaxed text-red-600 dark:text-red-400">
                {inputError}
              </p>
            )}
            {!inputError && templateHint && (
              <p role="status" className="text-xs leading-relaxed text-secondary">
                {templateHint}
              </p>
            )}

            {/* Options Row: Guide toggle on left, Registry pill on right */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
              <button
                type="button"
                aria-expanded={guideOpen}
                aria-controls={guideId}
                onClick={() => setGuideOpen((prev) => !prev)}
                className="inline-flex items-center gap-1.5 text-xs text-secondary transition-colors hover:text-foreground"
              >
                <ChevronDownIcon
                  className={`h-3.5 w-3.5 transition-transform duration-150 ${guideOpen ? 'rotate-180' : ''}`}
                />
                <span>
                  {guideOpen ? t('dshPluginsInstallGuideHide') : t('dshPluginsInstallGuideToggle')}
                </span>
              </button>

              <button
                ref={registryToggleRef}
                type="button"
                disabled={checking}
                aria-expanded={registryOpen}
                aria-controls={registryPopoverId}
                aria-haspopup="dialog"
                onClick={() => setRegistryOpen((prev) => !prev)}
                className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  registryOpen
                    ? 'border-foreground/25 bg-surface-raised text-foreground'
                    : 'border-border bg-surface text-secondary hover:bg-surface-raised/60 hover:text-foreground'
                }`}
              >
                <span>{t('dshPluginsRegistryToggleLabel')}</span>
                <span className="max-w-[160px] truncate font-medium text-foreground">
                  {chosenRegistryLabel}
                </span>
                <ChevronDownIcon
                  className={`h-3.5 w-3.5 transition-transform duration-150 ${registryOpen ? 'rotate-180' : ''}`}
                />
              </button>
            </div>

            {/* Expandable Install Guide */}
            {guideOpen && (
              <div
                id={guideId}
                className="space-y-3 rounded-xl border border-border bg-background/60 px-3.5 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="text-xs font-medium text-foreground">
                      {t('dshPluginsInstallGuideNpmTitle')}
                    </div>
                    <p className="text-xs leading-relaxed text-secondary">
                      {t('dshPluginsInstallGuideNpmHint')}
                    </p>
                    <div className="text-xs text-secondary">
                      <span>{t('dshPluginsInstallGuideExampleLabel')}</span>
                      <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                        {INSTALL_EXAMPLE_PACKAGE}
                      </code>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={checking}
                    onClick={() => {
                      setSpec(INSTALL_EXAMPLE_PACKAGE);
                      setInputError(null);
                      inputRef.current?.focus();
                    }}
                    className="shrink-0 self-center rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:opacity-50"
                  >
                    {t('dshPluginsInstallGuideFill')}
                  </button>
                </div>

                <div className="flex items-start justify-between gap-3 border-t border-border/70 pt-2.5">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="text-xs font-medium text-foreground">
                      {t('dshPluginsInstallGuideOtherTitle')}
                    </div>
                    <p className="text-xs leading-relaxed text-secondary">
                      {t('dshPluginsInstallGuideOtherHint')}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={checking}
                    onClick={() => void handlePickLocalDir()}
                    className="inline-flex shrink-0 items-center gap-1 self-center rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:opacity-50"
                  >
                    <FolderOpenIcon className="h-3.5 w-3.5 text-secondary" />
                    {t('dshPluginsBrowseDir')}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Footer: Safety Notice + Full-Width Install CTA */}
          <div className="space-y-4 px-6 pt-2 pb-6">
            <div
              role="note"
              className="flex items-start gap-2.5 rounded-xl bg-amber-50/90 px-3.5 py-3 text-xs leading-relaxed text-amber-900/90 dark:bg-amber-950/35 dark:text-amber-200/90"
            >
              <ExclamationCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-500 dark:text-amber-400" />
              <div className="min-w-0 space-y-1">
                <p>{t('dshPluginsInstallSafetyNotice')}</p>
                <p className="opacity-90">{t('dshPluginsInstallUpgradeNotice')}</p>
              </div>
            </div>

            <button
              type="button"
              disabled={checking || empty}
              aria-busy={checking}
              onClick={() => void handleStartInstall()}
              className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-action text-sm font-medium text-action-foreground transition-colors hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-45"
            >
              {checking && <ArrowPathIcon className="h-4 w-4 animate-spin" />}
              <span>{checking ? t('dshPluginsChecking') : t('dshPluginsInstallSubmitBtn')}</span>
            </button>
          </div>
        </Modal>

        {/* Floating Portaled Registry Popover (never expands dialog height) */}
        {registryShown && popoverPos && typeof document !== 'undefined' && createPortal(
          <fieldset
            ref={registryPanelRef}
            id={registryPopoverId}
            aria-label={t('dshPluginsRegistryLegend')}
            style={{
              position: 'fixed',
              zIndex: 80,
              left: popoverPos.left,
              width: popoverPos.width,
              maxHeight: popoverPos.maxHeight,
              ...(popoverPos.top !== undefined ? { top: popoverPos.top } : {}),
              ...(popoverPos.bottom !== undefined ? { bottom: popoverPos.bottom } : {}),
            }}
            className="flex flex-col gap-1 overflow-y-auto rounded-2xl border border-border bg-surface p-2 shadow-popover"
          >
            {offeredRegistries.map((registry) => {
              const checked = registryChoice.kind === 'offered' && registryChoice.registry === registry;
              const { name, host } = getRegistryDisplayInfo(registry, resolvedRegistry, t);
              return (
                <label
                  key={registry ?? '__default__'}
                  className={`flex cursor-pointer items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors ${
                    checked ? 'bg-surface-raised/80' : 'hover:bg-surface-raised/60'
                  }`}
                >
                  <input
                    type="radio"
                    name={registryRadioName}
                    checked={checked}
                    onChange={() => {
                      if (registryChoice.kind === 'custom') {
                        setCustomRegistryDraft(registryChoice.url);
                      }
                      handleChooseRegistry({ kind: 'offered', registry }, true);
                    }}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                  />
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs leading-5">
                    <span className="font-medium text-foreground">{name}</span>
                    {name !== host && (
                      <span className="break-all font-mono text-[11px] text-secondary">{host}</span>
                    )}
                  </span>
                </label>
              );
            })}

            {/* Custom registry URL option */}
            <div
              className={`flex flex-col gap-1.5 rounded-xl px-2.5 py-2 transition-colors ${
                registryChoice.kind === 'custom' ? 'bg-surface-raised/80' : 'hover:bg-surface-raised/60'
              }`}
              onClick={(e) => {
                if (!(e.target instanceof HTMLInputElement)) {
                  e.preventDefault();
                }
                if (registryChoice.kind !== 'custom') {
                  handleChooseRegistry({ kind: 'custom', url: customRegistryDraft }, false);
                }
                registryCustomRef.current?.focus();
              }}
            >
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="radio"
                  name={registryRadioName}
                  checked={registryChoice.kind === 'custom'}
                  onChange={() => {
                    handleChooseRegistry({ kind: 'custom', url: customRegistryDraft }, false);
                    registryCustomRef.current?.focus();
                  }}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                />
                <span className="text-xs font-medium leading-5 text-foreground">
                  {t('dshPluginsRegistryCustom')}
                </span>
              </label>

              <div className="pl-6 space-y-1.5">
                <input
                  ref={registryCustomRef}
                  type="text"
                  value={registryChoice.kind === 'custom' ? registryChoice.url : customRegistryDraft}
                  placeholder="https://npm.example.com/"
                  aria-label={t('dshPluginsRegistryCustom')}
                  aria-invalid={registryError}
                  aria-describedby={registryError ? registryErrorId : undefined}
                  onFocus={() => {
                    if (registryChoice.kind !== 'custom') {
                      handleChooseRegistry({ kind: 'custom', url: customRegistryDraft }, false);
                    }
                  }}
                  onChange={(e) => {
                    const nextUrl = e.target.value;
                    setCustomRegistryDraft(nextUrl);
                    handleChooseRegistry({ kind: 'custom', url: nextUrl }, false);
                  }}
                  onCompositionStart={registryComposition.onCompositionStart}
                  onCompositionEnd={registryComposition.onCompositionEnd}
                  onBlur={registryComposition.onBlur}
                  onKeyDown={(e) => {
                    if (registryComposition.isComposing(e.nativeEvent)) return;
                    if (e.key === 'Enter' && !empty) {
                      e.preventDefault();
                      e.stopPropagation();
                      void handleStartInstall();
                    }
                  }}
                  className={`h-8 w-full rounded-lg border bg-background px-2.5 text-xs text-foreground outline-none transition-colors placeholder:text-secondary/60 ${
                    registryError
                      ? 'border-red-500 focus:border-red-500'
                      : 'border-border focus:border-primary'
                  }`}
                />
                {registryError && (
                  <p id={registryErrorId} role="alert" className="text-[11px] text-red-600 dark:text-red-400">
                    {t('dshPluginsRegistryInvalidUrl')}
                  </p>
                )}
                <p className="text-[11px] leading-relaxed text-secondary">
                  {t('dshPluginsRegistryCustomHint')}
                </p>
              </div>
            </div>
          </fieldset>,
          document.body,
        )}
      </>
    );
  }

  // Screen C: Web-only / Theme Compatibility Preview Confirmation (LobsterAI guard)
  if (phase === InstallModalPhase.Preview && inspection) {
    const isWebOnlyWarning = isWebOnlyOrThemeInspection(inspection);
    return (
      <Modal
        isOpen={isOpen}
        onClose={handleBackdropOrEscape}
        onEscape={handleBackdropOrEscape}
        overlayClassName="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
        className="w-full max-w-[540px] rounded-2xl border border-border bg-surface p-6 shadow-modal"
      >
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => void handleCancelOrBack()}
            className="inline-flex items-center gap-1 text-sm font-semibold text-foreground transition-opacity hover:opacity-75"
          >
            <ChevronLeftIcon className="h-4 w-4 stroke-[2.2]" />
            <span>{t('dshPluginsBackToEdit')}</span>
          </button>
          <button
            type="button"
            onClick={handleCloseButton}
            aria-label={t('close')}
            className="rounded-lg p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 space-y-4">
          {renderSubjectCard()}

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

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={handleCloseButton}
              className="rounded-xl border border-border px-4 py-2 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
            >
              {t('cancel')}
            </button>
            <button
              type="button"
              onClick={() => void runInstall()}
              className="rounded-xl bg-action px-4 py-2 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover"
            >
              {isWebOnlyWarning ? t('dshPluginsInstallAnyway') : t('dshPluginsInstallNow')}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  // Screen D: Unified Live Install / Done / Failed Wizard
  const cancellable =
    phase === InstallModalPhase.Starting || phase === InstallModalPhase.Running;
  const stoppable = cancellable || phase === InstallModalPhase.Failed;
  const isDone = phase === InstallModalPhase.Done;
  const isFailed = phase === InstallModalPhase.Failed;
  const pendingBuilds = isFailed ? (installResult?.pendingBuilds ?? []) : [];
  const approvable = pendingBuilds.length > 0;
  const changeableRegistry =
    isFailed && !approvable && installResult?.failedAt === 'registry';

  const heading = (() => {
    switch (phase) {
      case InstallModalPhase.Starting:
        return t('dshPluginsInstallStarting');
      case InstallModalPhase.Running:
        return t('dshPluginsInstallingTitle');
      case InstallModalPhase.Cancelling:
        return t('dshPluginsCancelling');
      case InstallModalPhase.Applying:
        return t('dshPluginsInstallApplying');
      case InstallModalPhase.Done:
        return t('dshPluginsInstalledTitle');
      case InstallModalPhase.Failed:
        return t('dshPluginsInstallFailedTitle');
      default:
        return t('dshPluginsInstallModalTitle');
    }
  })();

  const askedMulti =
    attempts && attempts.registries.length > 1 ? attempts : null;
  const currentAttemptReg = askedMulti ? askedMulti.registries[askedMulti.registries.length - 1] : undefined;
  const previousAttemptReg = askedMulti ? askedMulti.registries[askedMulti.registries.length - 2] : undefined;
  const attemptFallbackLine =
    pending && askedMulti && currentAttemptReg !== undefined && previousAttemptReg !== undefined
      ? t('dshPluginsInstallAttemptFallback')
          .replace('{previous}', getRegistryDisplayInfo(previousAttemptReg, resolvedRegistry, t).name)
          .replace('{registry}', getRegistryDisplayInfo(currentAttemptReg, resolvedRegistry, t).name)
          .replace('{index}', String(askedMulti.registries.length))
          .replace('{total}', String(askedMulti.total))
      : null;

  const failureHeadline = isFailed
    ? resolveInstallFailureText(
        installResult,
        {
          subjectHost: inspection?.host,
          attemptedRegistries: attempts?.registries ?? installResult?.registries,
          resolvedRegistry,
        },
        t,
      )
    : null;

  const firstRun = runs[0];
  const approvedBuilds = isDone ? (installResult?.approvedBuilds ?? []) : [];
  const canOpenPanel =
    isDone
    && !installResult?.restartRequired
    && Boolean(installedPluginEntry?.enabled && installedPluginEntry?.panelId && !installedPluginEntry?.isThemePlugin);

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleBackdropOrEscape}
      onEscape={handleBackdropOrEscape}
      overlayClassName="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      className="flex max-h-[min(780px,90vh)] w-full max-w-[540px] flex-col rounded-2xl border border-border bg-surface shadow-modal"
    >
      {/* Wizard Top Bar */}
      <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-2">
        {isDone ? (
          <span />
        ) : (
          <button
            type="button"
            disabled={!stoppable}
            onClick={() => void handleCancelOrBack()}
            className="inline-flex items-center gap-1 text-sm font-semibold text-foreground transition-opacity hover:opacity-75 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeftIcon className="h-4 w-4 stroke-[2.2]" />
            <span>
              {pending
                ? t('dshPluginsInstallCancelAndEdit')
                : t('dshPluginsBackToEdit')}
            </span>
          </button>
        )}
        <button
          type="button"
          onClick={handleCloseButton}
          disabled={restarting}
          aria-label={cancellable ? t('dshPluginsInstallCloseCancels') : t('close')}
          title={cancellable ? t('dshPluginsInstallCloseCancels') : t('close')}
          className="rounded-lg p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <XMarkIcon className="h-5 w-5" />
        </button>
      </div>

      {/* Scrollable Wizard Content */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pt-2 pb-6">
        {/* Centered Hero */}
        <div className="flex flex-col items-center gap-2 py-2 text-center">
          <div className="flex h-11 w-11 items-center justify-center">
            {pending ? (
              <ArrowPathIcon className="h-7 w-7 animate-spin text-primary" />
            ) : isDone ? (
              <CheckCircleIcon className="h-8 w-8 text-emerald-500" />
            ) : (
              <ExclamationTriangleIcon className="h-8 w-8 text-amber-500" />
            )}
          </div>
          <h3
            role={isFailed ? 'alert' : 'status'}
            className="text-lg font-semibold text-foreground"
          >
            {heading}
          </h3>
          {isDone && !installResult?.restartRequired && (
            <p className="text-xs leading-relaxed text-secondary">
              {t('dshPluginsInstalledHot')}
            </p>
          )}
          {attemptFallbackLine && (
            <p className="max-w-md text-xs leading-relaxed text-secondary">
              {attemptFallbackLine}
            </p>
          )}
          {failureHeadline && (
            <p className="max-w-md break-words text-xs leading-relaxed text-secondary">
              {failureHeadline}
            </p>
          )}
          {isFailed
            && installResult?.stage === 'enable'
            && installResult?.enabled === true
            && failureHeadline !== t('dshPluginsInstallFailedEnabling') && (
              <p className="max-w-md text-xs leading-relaxed text-secondary">
                {t('dshPluginsInstallFailedEnabling')}
              </p>
          )}
        </div>

        {/* Consistent Subject Card */}
        {renderSubjectCard()}

        {/* Build Script Approval Card (inside wizard) */}
        {approvable && (
          <section className="space-y-2.5 rounded-xl border border-amber-400/50 bg-amber-50/85 px-4 py-3.5 dark:border-amber-500/35 dark:bg-amber-950/30">
            <h4 className="text-xs font-semibold text-foreground">
              {t('dshPluginsBuildBlockedTitle')}
            </h4>
            <p className="text-xs leading-relaxed text-secondary">
              {t('dshPluginsBuildBlockedDesc')}
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {pendingBuilds.map((pkg) => (
                <li key={pkg}>
                  <code className="inline-block rounded-md bg-surface px-2 py-0.5 font-mono text-[11px] text-foreground border border-border/70">
                    {pkg}
                  </code>
                </li>
              ))}
            </ul>
            <p className="text-xs leading-relaxed text-secondary">
              {t('dshPluginsInstallApprovalConsequence')}
            </p>
            <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
              {t('dshPluginsInstallApprovalCaution')}
            </p>
            <button
              type="button"
              onClick={() => void runInstall(pendingBuilds)}
              className="mt-1 inline-flex h-9 w-full items-center justify-center rounded-xl bg-action text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover"
            >
              {t('dshPluginsApproveBuildsAndRetry')}
            </button>
          </section>
        )}

        {/* Done Notices: Restart required / minimumReleaseAge / approvedBuilds */}
        {isDone && installResult?.restartRequired && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-xl bg-amber-50/90 px-3.5 py-2.5 text-xs leading-relaxed text-amber-900 dark:bg-amber-950/35 dark:text-amber-200"
          >
            <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <span>{resolveInstallRestartReasonText(installResult.restartReason, t)}</span>
          </div>
        )}

        {minReleaseAgeNotice && (
          <div
            role="status"
            className="rounded-xl bg-amber-50/90 px-3.5 py-2.5 text-xs leading-relaxed text-amber-900 dark:bg-amber-950/35 dark:text-amber-200"
          >
            {t('dshPluginsInstallDoneOtherVersion')
              .replace(/\{installed\}/g, minReleaseAgeNotice.installed)
              .replace(/\{version\}/g, minReleaseAgeNotice.latest)
              .replace(/\{exact\}/g, minReleaseAgeNotice.exactSpec)}
          </div>
        )}

        {approvedBuilds.length > 0 && (
          <div
            role="status"
            className="rounded-xl bg-emerald-500/10 px-3.5 py-2 text-xs text-emerald-800 dark:text-emerald-200"
          >
            {t('dshPluginsInstallDoneApproved').replace('{names}', approvedBuilds.join(', '))}
          </div>
        )}

        {/* Details Toggle + Inline Contextual Action Row */}
        <div className="flex items-center justify-between gap-3 pt-1">
          <button
            type="button"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((prev) => !prev)}
            className="inline-flex items-center gap-1.5 text-xs text-secondary transition-colors hover:text-foreground"
          >
            <span>
              {detailsOpen ? t('dshPluginsInstallDetailsHide') : t('dshPluginsInstallDetailsShow')}
            </span>
            <ChevronDownIcon
              className={`h-3.5 w-3.5 transition-transform duration-150 ${detailsOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {pending && (
            <button
              type="button"
              disabled={!cancellable}
              onClick={() => void handleCancelOrBack()}
              className="rounded-xl border border-border px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
            >
              {phase === InstallModalPhase.Cancelling
                ? t('dshPluginsCancelling')
                : t('dshPluginsCancelInstall')}
            </button>
          )}

          {isFailed && !approvable && (
            <div className="flex items-center gap-2">
              {changeableRegistry && (
                <button
                  type="button"
                  onClick={handleChangeRegistryFromFailure}
                  className="rounded-xl border border-border px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
                >
                  {t('dshPluginsInstallChangeRegistry')}
                </button>
              )}
              <button
                type="button"
                onClick={() => void runInstall()}
                className="rounded-xl bg-action px-4 py-1.5 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover"
              >
                {t('retry')}
              </button>
            </div>
          )}
        </div>

        {/* Live Collapsible Terminal Details */}
        {detailsOpen && (
          <div className="space-y-2.5">
            {firstRun?.cwd ? (
              <p className={`break-all ${SETTINGS_META_TEXT} text-secondary`}>
                {t('dshPluginsInstallLocation').replace('{dir}', firstRun.cwd)}
              </p>
            ) : !pending && runs.length === 0 ? (
              <p className={`${SETTINGS_META_TEXT} text-secondary`}>
                {t('dshPluginsInstallDetailsNoOutput')}
              </p>
            ) : null}

            {runs.map((run, index) => {
              const attemptReg = askedMulti ? askedMulti.registries[index] : undefined;
              const badge =
                attemptReg !== undefined
                  ? t('dshPluginsInstallAttemptBadge')
                      .replace('{index}', String(index + 1))
                      .replace('{registry}', getRegistryDisplayInfo(attemptReg, resolvedRegistry, t).name)
                  : null;
              return (
                <DshInstallTerminalBlock
                  key={run.jobId}
                  run={run}
                  cancelled={phase === InstallModalPhase.Cancelling}
                  attemptBadge={badge}
                />
              );
            })}

            {installResult?.logPath && (
              <p className={`break-all ${SETTINGS_META_TEXT} text-secondary`}>
                {t('dshPluginsInstallLogPath').replace('{path}', installResult.logPath)}
              </p>
            )}
          </div>
        )}

        {/* Done Primary CTA Footer */}
        {isDone && (
          <div className="flex items-center gap-2 pt-1">
            {installResult?.restartRequired && onRestartHost && (
              <button
                type="button"
                disabled={restarting}
                onClick={() => void handleRestartNow()}
                className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/15 text-sm font-medium text-amber-800 transition-colors hover:bg-amber-500/25 disabled:opacity-50 dark:text-amber-200"
              >
                {restarting ? t('dshPluginsRestarting') : t('dshPluginsRestartNow')}
              </button>
            )}
            {canOpenPanel && installedPluginEntry && (
              <button
                type="button"
                onClick={() => {
                  dispatchOpenEmbeddedPlugin({
                    name: installedPluginEntry.name,
                    panelId: installedPluginEntry.panelId!,
                    ...(installedPluginEntry.panelKind ? { panelKind: installedPluginEntry.panelKind } : {}),
                    title: resolvePluginDisplayTitle(installedPluginEntry, language, t),
                    ...(installedPluginEntry.icon ? { icon: installedPluginEntry.icon } : {}),
                  });
                  handleCloseButton();
                }}
                className="inline-flex h-10 flex-1 items-center justify-center rounded-xl border border-border bg-surface text-sm font-medium text-foreground transition-colors hover:bg-surface-raised"
              >
                {t('dshPluginsOpenPluginPanel')}
              </button>
            )}
            <button
              type="button"
              onClick={handleCloseButton}
              className="inline-flex h-10 flex-1 items-center justify-center rounded-xl bg-action text-sm font-medium text-action-foreground transition-colors hover:bg-action-hover"
            >
              {t('dshPluginsUpdateFinishBtn')}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
};
