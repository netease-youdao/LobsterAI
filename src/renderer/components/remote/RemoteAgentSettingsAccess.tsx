import React, { useEffect, useRef, useState } from 'react';

import { emptyAgentSettingsPermissions, type RemoteAgentSettingsAccessState, type RemoteAgentSettingsPermissions,RemoteAgentSettingsSection, RemoteAgentSettingsStatus } from '../../../shared/remote/agentSettings';
import { i18nService } from '../../services/i18n';

const t = (key: string): string => i18nService.t(key);
const labels = {
  [RemoteAgentSettingsSection.Model]: 'remoteAgentSettingsModel', [RemoteAgentSettingsSection.Collaboration]: 'remoteAgentSettingsCollaboration',
  [RemoteAgentSettingsSection.Identity]: 'remoteAgentSettingsIdentity', [RemoteAgentSettingsSection.Memory]: 'remoteAgentSettingsMemory',
  [RemoteAgentSettingsSection.UserProfile]: 'remoteAgentSettingsUserProfile',
};
export function RemoteAgentSettingsAccess({ identity }: { identity: string }): React.ReactElement {
  const [state, setState] = useState<RemoteAgentSettingsAccessState | null>(null);
  const [phoneId, setPhoneId] = useState(''), [agentId, setAgentId] = useState('');
  const [permissions, setPermissions] = useState<RemoteAgentSettingsPermissions>(emptyAgentSettingsPermissions);
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const epoch = ++generation.current;
    setState(null); setPhoneId(''); setAgentId(''); setPermissions(emptyAgentSettingsPermissions()); setFailed(false); setBusy(true);
    void window.electron.remote.agentSettingsState().then(value => { if (generation.current === epoch) setState(value); })
      .catch(() => { if (generation.current === epoch) setFailed(true); })
      .finally(() => { if (generation.current === epoch) setBusy(false); });
    return () => { generation.current = epoch + 1; };
  }, [identity]);
  const run = async (action: () => Promise<RemoteAgentSettingsAccessState>): Promise<void> => {
    const epoch = generation.current; setBusy(true); setFailed(false);
    try { const value = await action(); if (generation.current === epoch) setState(value); }
    catch (error) { if (generation.current === epoch && !(error instanceof Error && error.message.includes('SETTINGS_AUTHORIZATION_CANCELLED'))) setFailed(true); }
    finally { if (generation.current === epoch) setBusy(false); }
  };
  const phone = state?.candidates.find(item => item.mobileDeviceId === phoneId);
  const canAuthorize = !!state?.supported && !!phone && !!agentId && Object.values(permissions).some(value => value.read) && !busy;
  const change = (section: RemoteAgentSettingsSection, field: 'read' | 'directUpdate' | 'conversationUpdate', enabled: boolean): void => {
    setPermissions(previous => ({ ...previous, [section]: { ...previous[section], [field]: enabled,
      ...(field === 'read' && !enabled ? { directUpdate: false, conversationUpdate: false } : {}) } }));
  };
  return <section className="space-y-3 rounded-xl border border-border bg-surface p-4" aria-label={t('remoteAgentSettingsTitle')}>
    <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">{t('remoteAgentSettingsTitle')}</h3>
      <button type="button" disabled={busy} onClick={() => void run(() => window.electron.remote.agentSettingsState())} className="text-xs text-primary disabled:opacity-50">{t('remoteAgentSettingsRefresh')}</button></div>
    <p className="text-xs leading-5 text-secondary">{t('remoteAgentSettingsDescription')}</p>
    {!state?.supported && <p className="text-xs text-secondary">{t('remoteAgentSettingsUnavailable')}</p>}
    {state?.supported && <>
      {!state.candidates.length && <p className="text-xs text-secondary">{t('remoteAgentSettingsNoPhones')}</p>}
      <div className="grid grid-cols-2 gap-3">
        <label className="min-w-0 space-y-1 text-xs">{t('remoteAgentSettingsPhone')}
          <select value={phoneId} disabled={busy} className="block w-full rounded border border-border bg-background p-2" onChange={event => { setPhoneId(event.target.value); setPermissions(emptyAgentSettingsPermissions()); }}>
            <option value="">{t('remoteAgentSettingsSelect')}</option>
            {state.candidates.map(item => <option key={item.mobileDeviceId} value={item.mobileDeviceId}>
              {item.shortLabel ? `${item.name} · ${item.shortLabel}` : item.name}
            </option>)}
          </select></label>
        <label className="space-y-1 text-xs">{t('remoteAgentSettingsAgent')}
          <select value={agentId} disabled={busy} className="block w-full rounded border border-border bg-background p-2" onChange={event => { setAgentId(event.target.value); setPermissions(emptyAgentSettingsPermissions()); }}>
            <option value="">{t('remoteAgentSettingsSelect')}</option>{state.agents.map(item => <option key={item.agentId} value={item.agentId}>{item.name}</option>)}
          </select></label>
      </div>
      {Object.values(RemoteAgentSettingsSection).map(section => {
        const direct = section === RemoteAgentSettingsSection.Model || section === RemoteAgentSettingsSection.Collaboration;
        const editable = direct ? 'directUpdate' : 'conversationUpdate';
        return <div key={section} className="flex flex-wrap items-center gap-3 text-xs">
          <span className="min-w-24">{t(labels[section])}</span>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={permissions[section].read} disabled={busy || !phone || !agentId}
            onChange={event => change(section, 'read', event.target.checked)} />{t('remoteAgentSettingsRead')}</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={permissions[section][editable]} disabled={busy || !permissions[section].read || !direct && !state.conversationReady}
            onChange={event => change(section, editable, event.target.checked)} />{t(direct ? 'remoteAgentSettingsDirect' : 'remoteAgentSettingsConversation')}</label>
        </div>;
      })}
      {agentId === 'main' && <p className="text-xs text-secondary">{t('remoteAgentSettingsShared')}</p>}
      {!state.conversationReady && <p className="text-xs text-secondary">{t('remoteAgentSettingsConversationUnavailable')}</p>}
      <button type="button" disabled={!canAuthorize} className="rounded bg-primary px-3 py-2 text-xs text-white disabled:opacity-50"
        onClick={() => { if (state && phone) void run(() => window.electron.remote.authorizeAgentSettings({ expectedAccountEpoch: state.accountEpoch,
          agentId, mobileDeviceId: phone.mobileDeviceId, grantId: phone.grantId, grantVersion: phone.grantVersion, sections: permissions })); }}>{t('remoteAgentSettingsAuthorize')}</button>
    </>}
    {!!state?.bindings.length && <ul className="space-y-2 border-t border-border pt-3 text-xs">{state.bindings.map(binding => <li key={binding.bindingId} className="flex items-center justify-between gap-3">
      <span className="min-w-0 break-words">
        {state.candidates.find(item => item.mobileDeviceId === binding.mobileDeviceId)?.name ?? binding.mobileDeviceId}
        {binding.shortLabel && <> · <span className="font-mono font-medium">{binding.shortLabel}</span></>}
        {' · '}{state.agents.find(item => item.agentId === binding.agentId)?.name ?? binding.agentId}
      </span>
      {binding.status === RemoteAgentSettingsStatus.Active ? <button type="button" disabled={busy} className="shrink-0 text-primary disabled:opacity-50"
        onClick={() => void run(() => window.electron.remote.revokeAgentSettings({ expectedAccountEpoch: state.accountEpoch, bindingId: binding.bindingId, bindingVersion: binding.bindingVersion }))}>{t('remoteAgentSettingsRevoke')}</button>
        : <span className="text-secondary">{t('remoteAgentSettingsPendingRevoke')}</span>}
    </li>)}</ul>}
    {failed && <p role="alert" className="text-xs text-red-500">{t('remoteAgentSettingsFailed')}</p>}
  </section>;
}
