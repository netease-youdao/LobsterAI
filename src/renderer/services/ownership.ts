import { AgentId } from '@shared/agent';
import { OwnershipErrorCode, OwnershipResultStatus, OwnershipSyncState, OwnershipTargetKind } from '@shared/ownership/constants';
import type { OwnershipCommitResult, OwnershipDetail, OwnershipPreview, OwnershipResponse,OwnershipTarget } from '@shared/ownership/types';

import type { ToastEventDetail } from '../components/Toast';
import { store } from '../store';
import { i18nService } from './i18n';
import { clearOwnershipPending, type OwnershipPendingIntent,readOwnershipPending, saveOwnershipPending } from './ownershipPending';

export const OwnershipView = { Detail: 'detail', Preview: 'preview', Unknown: 'unknown' } as const;
export type OwnershipView = typeof OwnershipView[keyof typeof OwnershipView];
export interface OwnershipPanelState {
  target: OwnershipTarget;
  view: OwnershipView;
  loading?: boolean;
  detail?: OwnershipDetail;
  preview?: OwnershipPreview;
  error?: string;
  intent?: OwnershipPendingIntent;
  notice?: string;
}

let panel: OwnershipPanelState | null = null;
let revision = 0;
let sequence = 0;
let waitingLogin: OwnershipTarget | null = null;
const listeners = new Set<() => void>();
const changeListeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
const identity = () => store.getState().auth.accountGeneration;
const notifyChange = () => { revision += 1; changeListeners.forEach(listener => listener()); };
function unwrap<T>(response: OwnershipResponse<T>): T {
  if (!response.success) throw new Error(response.error.code);
  return response.data;
}
function errorCode(error: unknown): string {
  return error instanceof Error && Object.values(OwnershipErrorCode).some(value => value === error.message)
    ? error.message : OwnershipErrorCode.NotAvailable;
}
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('IPC_TIMEOUT')), 15_000);
    })]);
  } finally { clearTimeout(timer); }
}

function finishAssociation(target: OwnershipTarget, result: OwnershipCommitResult) {
  const generation = identity();
  ownershipService.close();
  notifyChange();
  const toast: ToastEventDetail = result.syncState === OwnershipSyncState.Failed ? {
    message: i18nService.t('ownershipAssociationSyncFailed'),
    actionLabel: i18nService.t('ownershipRetrySync'),
    onAction: () => {
      if (generation === identity()) void ownershipService.retrySync(target);
    },
  } : { message: i18nService.t('ownershipSuccess') };
  window.dispatchEvent(new CustomEvent<ToastEventDetail>('app:showToast', { detail: toast }));
}

export const ownershipService = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: () => panel,
  getRevision: () => revision,
  subscribeChange(listener: () => void) { changeListeners.add(listener); return () => { changeListeners.delete(listener); }; },
  async getDetail(target: OwnershipTarget): Promise<OwnershipDetail> {
    const generation = identity();
    const detail = unwrap(await window.electron.ownership.getDetail(target));
    if (generation !== identity()) throw new Error(OwnershipErrorCode.AccountChanged);
    return detail;
  },
  close() { sequence += 1; panel = null; waitingLogin = null; notify(); },
  async open(target: OwnershipTarget, view: OwnershipView = OwnershipView.Detail) {
    const requestSequence = ++sequence;
    const generation = identity();
    panel = { target, view, loading: true };
    waitingLogin = null;
    notify();
    try {
      const detail = await this.getDetail(target);
      // Never offer a second commit while an earlier result remains unknown.
      const pending = readOwnershipPending(localStorage).find(intent => (
        intent.partition === detail.accountPartition && intent.target.kind === target.kind && intent.target.id === target.id
      ));
      if (requestSequence !== sequence || generation !== identity()) return;
      if (pending) {
        panel = { target, view: OwnershipView.Unknown, detail, intent: pending };
        notify();
        await this.reconcile(pending);
        return;
      }
      const preview = view === OwnershipView.Preview
        ? unwrap(await window.electron.ownership.preview(target)) : undefined;
      if (requestSequence !== sequence || generation !== identity()) return;
      panel = { target, view, detail, preview };
    } catch (error) {
      if (requestSequence !== sequence || generation !== identity()) return;
      panel = { target, view, error: errorCode(error) };
    }
    notify();
  },
  waitForLogin() { waitingLogin = panel?.target ?? null; },
  loginFailed() {
    waitingLogin = null;
    if (panel) { panel = { ...panel, error: OwnershipErrorCode.AuthRequired }; notify(); }
  },
  async refreshDetail() {
    if (panel?.view !== OwnershipView.Detail) return;
    const current = panel;
    const requestSequence = sequence;
    try {
      const detail = await this.getDetail(current.target);
      if (requestSequence !== sequence || panel?.view !== OwnershipView.Detail) return;
      panel = { ...panel, detail };
      notify();
    } catch { /* Keep the last authorized detail until an identity invalidation clears it. */ }
  },
  async retrySync(target?: OwnershipTarget) {
    const generation = identity();
    if (target) {
      const opening = this.open(target);
      const openSequence = sequence;
      await opening;
      if (generation !== identity() || openSequence !== sequence
        || panel?.detail?.ownership.kind !== 'owned' || panel.detail.syncState !== OwnershipSyncState.Failed) return;
    }
    if (!panel?.detail || panel.loading) return;
    const requestSequence = sequence;
    try {
      const remote = await window.electron.remote.state();
      if (requestSequence !== sequence || generation !== identity() || !panel) return;
      if (!remote.owner || !remote.enabled) {
        panel = { ...panel, notice: !remote.owner ? 'remoteLoginRequired' : 'remoteDisabled' };
        notify();
        return;
      }
      await window.electron.remote.configure({ retry: true });
      if (requestSequence !== sequence || generation !== identity() || !panel) return;
      panel = { ...panel, notice: 'ownershipRetryScheduled' };
      notify();
      await this.refreshDetail();
    } catch {
      if (requestSequence !== sequence || generation !== identity() || !panel) return;
      panel = { ...panel, notice: 'remoteUnavailable' };
      notify();
    }
  },
  async commit() {
    const current = panel;
    if (!current?.preview?.eligible || !current.preview.account || current.loading) return;
    const generation = identity();
    const requestSequence = sequence;
    const intent: OwnershipPendingIntent = {
      partition: current.preview.account.partition,
      target: current.target,
      request: {
        planId: current.preview.planId,
        planVersion: current.preview.planVersion,
        accountGeneration: current.preview.accountGeneration,
        requestId: crypto.randomUUID(),
      },
    };
    try {
      saveOwnershipPending(localStorage, intent);
    } catch {
      panel = { ...current, error: OwnershipErrorCode.LocalCommitFailed };
      notify();
      return; // Do not submit a mutation whose recovery intent could not be saved.
    }
    panel = { ...current, loading: true, intent };
    notify();
    try {
      const result = unwrap(await deadline(window.electron.ownership.commit(intent.request)));
      // A stale response cannot remove another account's intent or display its result.
      if (generation !== identity() || requestSequence !== sequence) return;
      if (result.accountPartition !== intent.partition) throw new Error(OwnershipErrorCode.AccountChanged);
      clearOwnershipPending(localStorage, intent);
      finishAssociation(current.target, result);
    } catch (error) {
      if (generation !== identity() || requestSequence !== sequence) return;
      panel = { target: current.target, view: OwnershipView.Unknown, intent };
      notify();
      await this.reconcile(intent);
      if (generation === identity() && requestSequence === sequence && panel?.view === OwnershipView.Detail) {
        const code = errorCode(error);
        if (code !== OwnershipErrorCode.NotAvailable) { panel = { ...panel, error: code }; notify(); }
      }
      return;
    }
  },
  async reconcile(intent: OwnershipPendingIntent) {
    const generation = identity();
    const requestSequence = sequence;
    try {
      // Trusted main-process detail, not cached renderer user IDs, selects the partition.
      const account = await this.getDetail({ kind: OwnershipTargetKind.Agent, id: AgentId.Main });
      if (account.accountPartition !== intent.partition) return;
      const result = unwrap(await deadline(window.electron.ownership.getResult({ requestId: intent.request.requestId })));
      if (generation !== identity() || requestSequence !== sequence) return;
      if (result.status !== OwnershipResultStatus.NotCommitted && result.accountPartition !== intent.partition) return;
      clearOwnershipPending(localStorage, intent);
      if (result.status === OwnershipResultStatus.NotCommitted) {
        // getResult is authoritative only because commits never queue asynchronous writes.
        let detail: OwnershipDetail | undefined;
        try { detail = await this.getDetail(intent.target); } catch { /* The target may have been deleted after the original confirmation. */ }
        if (generation !== identity() || requestSequence !== sequence) return;
        panel = { target: intent.target, view: OwnershipView.Detail, detail, error: detail ? OwnershipErrorCode.PlanChanged : OwnershipErrorCode.NotAvailable };
      } else {
        finishAssociation(intent.target, result);
        return;
      }
    } catch {
      if (generation !== identity() || requestSequence !== sequence) return;
      panel = { target: intent.target, view: OwnershipView.Unknown, intent };
    }
    notify();
  },
  start() {
    let generation = identity();
    const recover = async () => {
      for (const intent of readOwnershipPending(localStorage)) {
        if (panel || generation !== identity()) return;
        try {
          const account = await this.getDetail({ kind: OwnershipTargetKind.Agent, id: AgentId.Main });
          if (account.accountPartition !== intent.partition || generation !== identity()) continue;
          panel = { target: intent.target, view: OwnershipView.Unknown, intent };
          notify();
          await this.reconcile(intent);
          return;
        } catch { /* Other-account and deleted targets must not reveal the stored intent. */ }
      }
    };
    const unsubscribeStore = store.subscribe(() => {
      if (identity() === generation) return;
      generation = identity();
      const resume = waitingLogin;
      sequence += 1;
      panel = null;
      waitingLogin = null;
      notifyChange();
      notify();
      if (resume && store.getState().auth.isLoggedIn) void this.open(resume, OwnershipView.Preview);
      else void recover();
    });
    const unsubscribeChanged = window.electron.ownership?.onChanged(() => {
      notifyChange();
      if (panel?.view === OwnershipView.Detail && !panel.loading) void this.open(panel.target);
    });
    void recover();
    return () => { unsubscribeStore(); unsubscribeChanged?.(); };
  },
};
