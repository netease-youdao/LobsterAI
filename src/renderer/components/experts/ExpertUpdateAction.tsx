import { ArrowPathIcon, ClockIcon } from '@heroicons/react/24/outline';
import { ExpertUpgradeStatus } from '@shared/agent/presets';
import { useEffect, useRef, useState } from 'react';

import { agentService } from '../../services/agent';
import { i18nService } from '../../services/i18n';
import { showToast } from '../../utils/localFileActions';
import { useExpertLoginGate } from './useExpertLoginGate';

const UpdateAction = { Update: 'update', Dismiss: 'dismiss' } as const;
type UpdateAction = typeof UpdateAction[keyof typeof UpdateAction];

interface ExpertUpdateActionProps {
  agentId: string;
  revision: number;
  active?: boolean;
  onDismiss?: () => void;
  onCatalogChanged?: () => void;
}

export default function ExpertUpdateAction({ agentId, revision, active = true, onDismiss, onCatalogChanged }: ExpertUpdateActionProps) {
  const [busy, setBusy] = useState<boolean | null>(null);
  const [pending, setPending] = useState<UpdateAction | null>(null);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const { requestLogin, loginPrompt } = useExpertLoginGate();
  const t = (key: string) => i18nService.t(key);

  useEffect(() => {
    if (!active) return;
    let closed = false;
    let timer: number;
    const refresh = async () => {
      try {
        const running = await agentService.isExpertBusy(agentId);
        if (!closed) setBusy(running);
      } catch {
        // The update IPC still performs the authoritative check before writing.
        if (!closed) setBusy(false);
      }
      if (!closed) timer = window.setTimeout(() => { void refresh(); }, 2000);
    };
    setBusy(null);
    setError('');
    void refresh();
    return () => { closed = true; window.clearTimeout(timer); };
  }, [agentId, revision, active]);

  const update = async () => {
    if (inFlight.current || busy !== false) return;
    if (requestLogin(() => { void update(); })) return;
    inFlight.current = true;
    setPending(UpdateAction.Update);
    setError('');
    try {
      const status = await agentService.upgradePreset(agentId, revision);
      if (status === ExpertUpgradeStatus.Updated) {
        showToast(t('expertUpdated'));
        onDismiss?.();
      } else if (status === ExpertUpgradeStatus.Busy) {
        setBusy(true);
      } else {
        setError('expertUpgradeUnavailable');
        if (onCatalogChanged) onCatalogChanged();
        else await agentService.loadExpertCatalog();
      }
    } catch (cause) {
      console.warn('[ExpertUpdate] Update failed:', cause);
      setError('expertUpdateFailed');
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  };

  const dismiss = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(UpdateAction.Dismiss);
    try {
      const saved = await agentService.dismissPresetUpdate(agentId, revision);
      if (saved) {
        showToast(t('expertUpdateDismissed'));
        onDismiss?.();
      } else {
        setError('expertUpgradeUnavailable');
        await agentService.loadExpertCatalog();
      }
    } catch (cause) {
      console.warn('[ExpertUpdate] Could not dismiss reminder:', cause);
      setError('expertUpdateFailed');
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  };

  const button = <button type="button" disabled={pending !== null || busy !== false} onClick={() => { void update(); }}
    className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg bg-action px-4 text-sm font-semibold text-action-foreground transition-colors hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-40">
    {t(pending === UpdateAction.Update ? 'expertUpdating' : 'expertUpdate')}
  </button>;
  const Icon = busy ? ClockIcon : ArrowPathIcon;
  return <>
    {onDismiss ? <div className="space-y-3">
      <p className="text-sm font-semibold text-foreground">{t('expertUpdateQuestion')}</p>
      {(busy || error) && <p role="status" className="text-xs text-secondary">{t(busy ? 'expertUpgradeBusy' : error)}</p>}
      <div className="flex items-center justify-between gap-3">
        <button type="button" disabled={pending !== null} onClick={() => { void dismiss(); }} className="rounded px-1 py-1.5 text-xs text-secondary hover:text-foreground">{t('expertDismissUpdate')}</button>
        {button}
      </div>
    </div> : <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-raised px-3 py-2">
      <p role="status" className="flex min-w-0 items-center gap-2 text-xs leading-5 text-secondary">
        <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />{t(busy ? 'expertUpgradeBusy' : error || 'expertUpdateHint')}
      </p>
      {button}
    </div>}
    {loginPrompt}
  </>;
}
