import { ArrowPathIcon, DocumentTextIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  type OpenClawUserConfigActionResult,
  OpenClawUserConfigState,
  type OpenClawUserConfigStatus,
  OpenClawUserConfigSuspendReason,
} from '../../../shared/openclawUserConfig/constants';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import CardToggle from '../common/CardToggle';
import { SETTINGS_DESCRIPTION_TEXT, SETTINGS_ITEM_TITLE_TEXT } from './settingsTypography';

const BUTTON_CLASS =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.98]';
const NOTE_CLASS = 'rounded-lg border px-3 py-2 text-xs leading-5';
const WARNING_NOTE_CLASS =
  `${NOTE_CLASS} border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200`;
const ERROR_NOTE_CLASS =
  `${NOTE_CLASS} border-red-300 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300`;

const Action = {
  Toggle: 'toggle',
  Open: 'open',
  Reveal: 'reveal',
  Apply: 'apply',
} as const;
type Action = typeof Action[keyof typeof Action];

const describeState = (status: OpenClawUserConfigStatus): string => {
  switch (status.state) {
    case OpenClawUserConfigState.Missing:
      return i18nService.t('openClawUserConfigStateMissing');
    case OpenClawUserConfigState.Disabled:
      return i18nService.t('openClawUserConfigStateDisabled');
    case OpenClawUserConfigState.ParseError:
      return i18nService.t('openClawUserConfigStateParseError');
    case OpenClawUserConfigState.Suspended:
      return status.suspension?.reason === OpenClawUserConfigSuspendReason.Repair
        ? i18nService.t('openClawUserConfigStateSuspendedRepair')
        : i18nService.t('openClawUserConfigStateSuspendedInvalid');
    default:
      return status.overriddenPaths.length > 0
        ? i18nService.t('openClawUserConfigStateActive').replace('{count}', String(status.overriddenPaths.length))
        : i18nService.t('openClawUserConfigStateActiveEmpty');
  }
};

const OpenClawUserConfigRow: React.FC = () => {
  const [status, setStatus] = useState<OpenClawUserConfigStatus | null>(null);
  const [pendingAction, setPendingAction] = useState<Action | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await window.electron.openclaw.userConfig.getStatus();
      if (mountedRef.current) setStatus(next);
    } catch (error) {
      console.error('[OpenClawUserConfig] Failed to load status:', error);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    // The engine can suspend overrides when it rejects them; re-read on phase changes.
    let lastPhase: string | null = null;
    const unsubscribe = coworkService.onOpenClawEngineStatus((engineStatus) => {
      if (engineStatus.phase === lastPhase) return;
      lastPhase = engineStatus.phase;
      void refresh();
    });
    // The file is edited in another app; show its state once the user is back.
    const handleFocus = () => { void refresh(); };
    const handleVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      mountedRef.current = false;
      unsubscribe();
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [refresh]);

  const run = async (action: Action, invoke: () => Promise<OpenClawUserConfigActionResult>) => {
    setPendingAction(action);
    setActionError(null);
    try {
      const result = await invoke();
      if (!mountedRef.current) return;
      setStatus(result.status);
      if (!result.success) setActionError(result.error || i18nService.t('openClawUserConfigActionFailed'));
    } catch (error) {
      if (mountedRef.current) {
        setActionError(error instanceof Error ? error.message : i18nService.t('openClawUserConfigActionFailed'));
      }
    } finally {
      if (mountedRef.current) setPendingAction(null);
    }
  };

  const api = window.electron.openclaw.userConfig;
  const busy = pendingAction !== null;
  const enabled = status?.enabled ?? true;
  const suspended = status?.state === OpenClawUserConfigState.Suspended;
  // Paths stay listed while paused so the user can find the offending one.
  const pathsApplied = status?.state !== OpenClawUserConfigState.Suspended
    && status?.state !== OpenClawUserConfigState.Disabled;
  // A rejection is already shown as the suspension detail.
  const visibleActionError = actionError && actionError !== status?.suspension?.detail ? actionError : null;

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-muted text-primary">
            <DocumentTextIcon className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0">
            <div className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
              {i18nService.t('openClawUserConfigTitle')}
            </div>
            <div className={`mt-0.5 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
              {i18nService.t('openClawUserConfigDesc')}
            </div>
          </div>
        </div>
        <CardToggle
          isOn={enabled}
          label={i18nService.t('openClawUserConfigToggle')}
          disabled={busy || !status}
          onToggle={() => { void run(Action.Toggle, () => api.setEnabled(!enabled)); }}
        />
      </div>

      {status && (
        <div className="space-y-2 pl-12">
          <div className="text-xs leading-5 text-secondary">{describeState(status)}</div>
          {status.overriddenPaths.length > 0 && (
            <div className="text-xs leading-5 text-secondary">
              <span>
                {i18nService.t(pathsApplied ? 'openClawUserConfigOverriddenLabel' : 'openClawUserConfigNotAppliedLabel')}
              </span>
              <span className="break-all font-mono text-foreground">{status.overriddenPaths.join(', ')}</span>
            </div>
          )}
          {status.ignoredPaths.length > 0 && (
            <div className={WARNING_NOTE_CLASS}>
              {i18nService.t('openClawUserConfigIgnoredLabel')}
              <span className="break-all font-mono">{status.ignoredPaths.join(', ')}</span>
            </div>
          )}
          {status.parseError && (
            <div className={`${ERROR_NOTE_CLASS} whitespace-pre-wrap break-words font-mono`}>{status.parseError}</div>
          )}
          {suspended && status.suspension?.detail && (
            <div className={`${ERROR_NOTE_CLASS} whitespace-pre-wrap break-words font-mono`}>{status.suspension.detail}</div>
          )}
          {visibleActionError && <div role="alert" className={ERROR_NOTE_CLASS}>{visibleActionError}</div>}
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              className={BUTTON_CLASS}
              disabled={busy}
              onClick={() => { void run(Action.Open, api.openFile); }}
            >
              {i18nService.t('openClawUserConfigOpenFile')}
            </button>
            <button
              type="button"
              className={BUTTON_CLASS}
              disabled={busy}
              onClick={() => { void run(Action.Reveal, api.revealFile); }}
            >
              {i18nService.t('showInFolder')}
            </button>
            <button
              type="button"
              className={BUTTON_CLASS}
              disabled={busy || !enabled}
              onClick={() => { void run(Action.Apply, api.apply); }}
            >
              {pendingAction === Action.Apply && <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />}
              {pendingAction === Action.Apply
                ? i18nService.t('openClawUserConfigApplying')
                : suspended
                  ? i18nService.t('openClawUserConfigRetry')
                  : i18nService.t('openClawUserConfigApply')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default OpenClawUserConfigRow;
