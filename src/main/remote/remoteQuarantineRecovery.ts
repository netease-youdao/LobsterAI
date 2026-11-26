import { dialog } from 'electron';

import type { RemoteOwner } from '../../shared/remote/constants';
import { t } from '../i18n';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import { sameOwner } from './canonical';
import type { RemoteStore } from './remoteStore';

interface RecoveryDependencies {
  store: RemoteStore;
  runtime: Pick<CoworkRuntime, 'isSessionActive' | 'stopSession'>;
  getOwner(): RemoteOwner | null;
  getGeneration(): string;
  showLogs(): void;
}

/** Normal authorization is unchanged; quarantine permits only this process's own witnessed run to stop. */
export function stopOwnedSessionWithRecovery(store: RemoteStore, runtime: RecoveryDependencies['runtime'], actor: RemoteOwner | null, sessionId: string): void {
  try { store.assertActor(sessionId, actor); }
  catch {
    const candidate = store.quarantinedStopCandidates(actor).find(item => item.sessionId === sessionId);
    if (!candidate || !runtime.isSessionActive(sessionId)) throw new Error('REMOTE_QUARANTINE_STOP_UNVERIFIED');
    store.assertQuarantinedStop(sessionId, candidate.runId, actor);
  }
  runtime.stopSession(sessionId);
}

/** A local native dialog exposes counts only, with no quarantined titles, messages or identifiers. */
export async function showQuarantineRecovery(deps: RecoveryDependencies): Promise<void> {
  const owner = deps.getOwner(), generation = deps.getGeneration();
  const candidates = deps.store.quarantinedStopCandidates(owner).filter(item => deps.runtime.isSessionActive(item.sessionId));
  const { response } = await dialog.showMessageBox({ type: 'info', title: t('quarantineRecoveryTitle'),
    message: t('quarantineRecoveryDescription'), detail: t('quarantineRecoveryCount', { count: candidates.length }),
    buttons: [t('quarantineRecoveryClose'), t('startupRecoveryLogs'), ...(candidates.length ? [t('quarantineRecoveryStop')] : [])],
    defaultId: 0, cancelId: 0, noLink: true });
  if (response === 1) { deps.showLogs(); return; }
  if (response !== 2 || !candidates.length) return;
  if (generation !== deps.getGeneration() || !sameOwner(owner, deps.getOwner())) {
    await dialog.showMessageBox({ type: 'info', message: t('agentAccountChanged') }); return;
  }
  let submitted = 0;
  for (const item of candidates) {
    try {
      // Revalidate synchronously immediately before each effect; never turn a stop request into a terminal receipt.
      deps.store.assertQuarantinedStop(item.sessionId, item.runId, deps.getOwner());
      if (!deps.runtime.isSessionActive(item.sessionId)) continue;
      deps.runtime.stopSession(item.sessionId); submitted++;
    } catch { /* A changed/unverifiable task remains quarantined, independent of siblings. */ }
  }
  await dialog.showMessageBox({ type: 'info', message: t('quarantineRecoverySubmitted', { count: submitted }),
    detail: t('quarantineRecoverySafety') });
}
