import './subscriptionTrialCampaign.css';

import React, { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { AuthSubscriptionStatus } from '../../shared/auth/constants';
import type { SubscriptionTrialState } from '../../shared/subscriptionTrial/constants';
import { selectIsEnterpriseAccount } from '../features/enterpriseAccount/selectors';
import { getPortalSubscriptionTrialUrl, isTestModeEnabled } from '../services/endpoints';
import { i18nService } from '../services/i18n';
import type { RootState } from '../store';
import Modal from './common/Modal';
import { reportSubscriptionTrialUnlockClick } from './subscriptionTrialAnalytics';
import {
  beijingDayStart,
  getSubscriptionTrialPopupKey,
  nextBeijingWeek,
  readSubscriptionTrialPopupState,
  saveSubscriptionTrialPopupState,
  type SubscriptionTrialPopupState,
} from './subscriptionTrialPopupState';

const FIRST_LOGIN_KEY = 'subscription_trial.waiting_for_first_login';
const DIALOG_SELECTOR = '[data-app-modal], [role="dialog"], [aria-modal="true"]';
const read = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const write = (key: string, value: string): void => {
  try { localStorage.setItem(key, value); } catch { /* The current session still preserves the onboarding gate. */ }
};
const otherDialogOpen = (): boolean => Array.from(document.querySelectorAll(DIALOG_SELECTOR)).some(node => (
  !node.querySelector('[data-subscription-trial]') && !node.hasAttribute('data-subscription-trial')
  && node.getClientRects().length > 0
));

interface Props { enabled: boolean; privacyAgreed: boolean | null; taskCreatedSignal: number }
interface PendingPopup {
  owner: string;
  state: SubscriptionTrialState;
  key: string;
  local: SubscriptionTrialPopupState;
  receivedAt: number;
  receivedWallTime: number;
}
const popupTime = (popup: PendingPopup): number => popup.state.serverTimeEpochMs + Math.max(
  0, performance.now() - popup.receivedAt, Date.now() - popup.receivedWallTime,
);
const isAvailable = (state: SubscriptionTrialState | null): boolean => Boolean(
  state?.active && state.visible && state.campaignCode && state.endAtEpochMs
  && state.serverTimeEpochMs < state.endAtEpochMs,
);

const SubscriptionTrialCampaign: React.FC<Props> = ({ enabled, privacyAgreed, taskCreatedSignal }) => {
  const { isLoggedIn, isLoading, user, quota, accountGeneration } = useSelector((state: RootState) => state.auth);
  const enterprise = useSelector(selectIsEnterpriseAccount);
  const subscribed = isLoggedIn && quota?.subscriptionStatus === AuthSubscriptionStatus.Active;
  const identity = user?.yid ?? user?.userId ?? user?.id;
  const owner = `${accountGeneration}:${isLoggedIn ? identity : 'anonymous'}:${enterprise}`;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const [pending, setPending] = useState<PendingPopup | null>(null);
  const [otherOpen, setOtherOpen] = useState(true);
  const [requiresLogin, setRequiresLogin] = useState(() => read(FIRST_LOGIN_KEY) === '1');
  const [opening, setOpening] = useState(false);
  const [, languageChanged] = useState(0);
  const shownInSession = useRef(new Map<string, number>());
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const runRef = useRef<() => void>(() => undefined);
  const diagnosticRef = useRef('');
  const openingRef = useRef(false);
  const storageWrites = useRef<Promise<void>>(Promise.resolve());
  const persist = (key: string, state: SubscriptionTrialPopupState): void => {
    storageWrites.current = storageWrites.current.catch(() => undefined)
      .then(() => saveSubscriptionTrialPopupState(key, state));
    void storageWrites.current.catch(error => console.warn('[SubscriptionTrial] Could not persist popup state', error));
  };
  const diagnose = (reason: string): void => {
    if (diagnosticRef.current === reason) return;
    diagnosticRef.current = reason;
    const message = `Popup state: ${reason}`;
    console.debug(`[SubscriptionTrial] ${message}`);
    window.electron.log?.fromRenderer?.('debug', 'SubscriptionTrial', message);
  };
  const setPopup = (value: PendingPopup | null): void => {
    pendingRef.current = value;
    setPending(value);
  };

  useEffect(() => i18nService.subscribe(() => languageChanged(value => value + 1)), []);
  useEffect(() => {
    if (isLoggedIn) {
      write(FIRST_LOGIN_KEY, '0');
      setRequiresLogin(false);
    } else if (privacyAgreed === false) {
      write(FIRST_LOGIN_KEY, '1');
      setRequiresLogin(true);
    }
  }, [isLoggedIn, privacyAgreed]);

  useEffect(() => {
    let previouslyOpen = true;
    const update = () => {
      const open = otherDialogOpen();
      setOtherOpen(open);
      if (previouslyOpen && !open) runRef.current();
      previouslyOpen = open;
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    update();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    let fetching = false;
    const current = () => !disposed && ownerRef.current === owner;
    const load = async () => {
      if (fetching) return;
      if (isLoading || privacyAgreed !== true || enterprise || subscribed
        || requiresLogin || (isLoggedIn && identity == null)) {
        diagnose(isLoading ? 'auth_loading' : privacyAgreed !== true ? 'onboarding'
          : enterprise ? 'enterprise' : subscribed ? 'subscribed' : requiresLogin ? 'waiting_for_first_login' : 'missing_identity');
        setPopup(null);
        return;
      }
      fetching = true;
      try {
        const state = await window.electron.subscriptionTrial.status();
        if (!current()) return;
        if (!state || !isAvailable(state)) {
          diagnose(state?.reason ?? (state ? 'inactive' : 'status_unavailable'));
          setPopup(null);
          return;
        }
        const receivedAt = performance.now();
        const receivedWallTime = Date.now();
        const expiresAt = state.endAtEpochMs!;
        const queued = pendingRef.current;
        if (queued?.owner === owner) {
          if (queued.state.campaignCode === state.campaignCode && state.serverTimeEpochMs < queued.local.nextShowAt) {
            // Refresh the activity deadline, including early shutdowns, without recounting an open popup.
            setPopup({ ...queued, state, local: { ...queued.local, expiresAt }, receivedAt, receivedWallTime });
            return;
          }
          setPopup(null);
        }
        const key = getSubscriptionTrialPopupKey(state.campaignCode, isTestModeEnabled());
        const saved = await readSubscriptionTrialPopupState(key);
        if (!current()) return;
        const nextShowAt = Math.max(saved?.nextShowAt ?? 0, shownInSession.current.get(key) ?? 0);
        if ((saved?.dismissCount ?? 0) >= 3) { diagnose('dismissed_three_times'); return; }
        if (state.serverTimeEpochMs < nextShowAt) { diagnose('client_shown_this_week'); return; }
        if (!enabledRef.current || otherDialogOpen()) { diagnose('waiting_for_other_dialog'); return; }
        const firstShownDay = saved?.firstShownDay ?? beijingDayStart(state.serverTimeEpochMs);
        setPopup({
          owner, state, key, receivedAt, receivedWallTime,
          local: {
            nextShowAt: nextBeijingWeek(firstShownDay, state.serverTimeEpochMs), expiresAt,
            firstShownDay, dismissCount: saved?.dismissCount ?? 0, cadenceVersion: 2,
          },
        });
      } finally { fetching = false; }
    };
    const run = () => { void load().catch(() => { if (current()) diagnose('request_failed'); }); };
    runRef.current = run;
    run();
    // Keep an open popup in sync; an idle client waits for a new task or focus before the next weekly display.
    const timer = window.setInterval(() => { if (pendingRef.current) run(); }, 30000);
    window.addEventListener('focus', run);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener('focus', run);
      if (runRef.current === run) runRef.current = () => undefined;
    };
  }, [owner, identity, enterprise, subscribed, isLoggedIn, isLoading, privacyAgreed, requiresLogin]);

  // Overlay changes wake the existing request loop without resetting local frequency.
  useEffect(() => { if (enabled) runRef.current(); }, [enabled]);
  useEffect(() => { if (taskCreatedSignal > 0) runRef.current(); }, [taskCreatedSignal]);
  const pendingServerTime = pending ? popupTime(pending) : 0;
  const visible = enabled && !isLoading && privacyAgreed === true && !requiresLogin && !otherOpen
    && !!pending && pending.owner === owner && !enterprise && !subscribed
    && pendingServerTime < Math.min(pending.local.expiresAt, pending.local.nextShowAt);
  useEffect(() => {
    if (!visible || !pending) return;
    // Count only an actually rendered popup. Login, logout and account changes share this device key.
    shownInSession.current.set(pending.key, pending.local.nextShowAt);
    persist(pending.key, pending.local);
    diagnose('shown');
  }, [visible, pending]);

  useEffect(() => {
    if (!pending) return undefined;
    let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      clearTimeout(timer);
      if (pendingRef.current !== pending) return;
      const remaining = Math.min(pending.local.expiresAt, pending.local.nextShowAt) - popupTime(pending);
      if (remaining <= 0) {
        setPopup(null);
        diagnose('expired_locally');
        return;
      }
      timer = setTimeout(expire, remaining);
    };
    expire();
    // Resume from sleep without waiting for the next successful activity request.
    window.addEventListener('focus', expire);
    document.addEventListener('visibilitychange', expire);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', expire);
      document.removeEventListener('visibilitychange', expire);
    };
  }, [pending]);

  const close = () => setPopup(null);
  const dismiss = () => {
    const current = pendingRef.current;
    if (!current || !visible) return;
    const local = { ...current.local, dismissCount: Math.min(3, current.local.dismissCount + 1) };
    shownInSession.current.set(current.key, local.nextShowAt);
    setPopup(null);
    persist(current.key, local);
  };
  const buy = async () => {
    if (!pending || openingRef.current || !visible) return;
    const code = pending.state.campaignCode;
    openingRef.current = true;
    reportSubscriptionTrialUnlockClick(code, isLoggedIn);
    setOpening(true);
    try {
      const state = await window.electron.subscriptionTrial.status();
      if (ownerRef.current !== owner) return;
      if (!state || !isAvailable(state) || state.campaignCode !== code) { close(); return; }
      const result = await window.electron.shell.openExternal(getPortalSubscriptionTrialUrl(code, { checkout: true }));
      if (result?.success) close();
    } finally { openingRef.current = false; setOpening(false); }
  };
  if (!visible) return null;
  return (
    <Modal
      onClose={dismiss}
      onEscape={dismiss}
      overlayClassName="subscription-trial-overlay non-draggable fixed inset-0 z-[210] flex items-center justify-center modal-backdrop"
      className="subscription-trial-dialog"
    >
      <section
        data-subscription-trial
        role="dialog"
        aria-modal="true"
        aria-labelledby="subscription-trial-title subscription-trial-credits"
        aria-describedby="subscription-trial-subtitle"
        className="subscription-trial-card"
      >
        <button type="button" onClick={dismiss} aria-label={i18nService.t('close')} className="subscription-trial-close">×</button>
        <h2 id="subscription-trial-title" className="subscription-trial-title">
          {i18nService.t('subscriptionTrialTitlePrefix')}{' '}
          <span className="subscription-trial-price"><span className="subscription-trial-currency">¥</span>0.01</span>{' '}
          {i18nService.t('subscriptionTrialTitleSuffix')}
        </h2>
        <div id="subscription-trial-credits" className="subscription-trial-credits">
          <strong>1000</strong><span>{i18nService.t('subscriptionTrialCreditUnit')}</span>
        </div>
        <p id="subscription-trial-subtitle" className="subscription-trial-subtitle">{i18nService.t('subscriptionTrialSubtitle')}</p>
        <button type="button" disabled={opening} onClick={() => { void buy().catch(() => undefined); }} className="subscription-trial-cta">
          {i18nService.t('subscriptionTrialAction')}
        </button>
        <details className="subscription-trial-details">
          <summary>
            {i18nService.t('subscriptionTrialRenewal')}
            <span className="subscription-trial-info" aria-hidden="true">!</span>
          </summary>
          <div className="subscription-trial-rules">
            <p>{i18nService.t('subscriptionTrialEligibilityRule')}</p>
            <p>{i18nService.t('subscriptionTrialBenefitsRule')}</p>
            <p>{i18nService.t('subscriptionTrialExpiryRule')}</p>
            <p>{i18nService.t('subscriptionTrialUpgradeRule')}</p>
            <p>{i18nService.t('subscriptionTrialRenewalRule')}</p>
          </div>
        </details>
      </section>
    </Modal>
  );
};
export default SubscriptionTrialCampaign;
