import { PlusIcon, UsersIcon } from '@heroicons/react/24/outline';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { EXPERT_TEAM_DEFINITIONS, type ExpertTeamDefinition } from '../../../shared/agent/expertTeams';
import { agentService } from '../../services/agent';
import { i18nService } from '../../services/i18n';
import type { RootState } from '../../store';
import type { PresetAgent } from '../../types/agent';
import AgentAvatarIcon from '../agent/AgentAvatarIcon';
import AgentCreateModal from '../agent/AgentCreateModal';
import AgentSettingsPanel from '../agent/AgentSettingsPanel';
import Modal from '../common/Modal';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import { EmployeeTab, EmployeeTabLabels } from './constants';

interface Props {
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onOpenAgent: (id: string) => void;
  onShowSkills: () => void;
}

const t = (key: string) => i18nService.t(key);
const cardClass = 'flex flex-col rounded-2xl border border-border bg-surface p-5 gap-3';
const buttonClass = 'rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface-raised disabled:opacity-50';

export default function DigitalEmployeesView({ isSidebarCollapsed, onToggleSidebar, onOpenAgent, onShowSkills }: Props) {
  const agents = useSelector((state: RootState) => state.agent.agents);
  const skills = useSelector((state: RootState) => state.skill.skills);
  const [presets, setPresets] = useState<PresetAgent[]>([]);
  const [tab, setTab] = useState<EmployeeTab>(EmployeeTab.Catalog);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const operation = useRef(false);
  const [creating, setCreating] = useState(false);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [team, setTeam] = useState<ExpertTeamDefinition | null>(null);
  const [preset, setPreset] = useState<PresetAgent | null>(null);
  const isEn = i18nService.getLanguage() === 'en';
  const isWindows = window.electron.platform === 'win32';
  const isMac = window.electron.platform === 'darwin';
  useEffect(() => {
    let active = true;
    agentService.loadAgents();
    window.electron.agents.presetTemplates().then(items => {
      if (active) setPresets(items);
    }).catch(() => { if (active) setError(t('digitalEmployeeLoadFailed')); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const matches = (...values: string[]) => values.join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const catalog = presets.filter(item => matches(item.name, item.nameEn, item.description, item.descriptionEn, ...item.skillIds));
  const installed = agents.filter(item => !item.isDefault && matches(item.name, item.description));
  const teams = EXPERT_TEAM_DEFINITIONS.filter(item => matches(item.name, item.id, item.description, ...item.tags));
  const installedSkills = useMemo(() => new Set(skills.filter(skill => skill.enabled).map(skill => skill.id)), [skills]);
  const teamExists = team && agents.some(agent => agent.id === `expert-team-${team.id}`);
  const teamMissing = team && !teamExists ? [...new Set([team.lead, ...team.roles].flatMap(role => role.skillIds))].filter(id => !installedSkills.has(id)) : [];
  const presetMissing = preset ? preset.skillIds.filter(id => !installedSkills.has(id)) : [];
  const missingSkills = team ? teamMissing : presetMissing;
  const openInstalled = (id: string) => { agentService.switchAgent(id); onOpenAgent(id); };

  const addPreset = async (item: PresetAgent) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(item.id); setError(''); setNotice('');
    try {
      const result = await agentService.addPreset(item.id);
      if (!result) throw new Error('Preset creation failed');
      setPreset(null);
      setTab(EmployeeTab.Installed);
    } catch { setError(t('digitalEmployeeCreateFailed')); }
    finally { operation.current = false; setBusy(null); }
  };
  const addTeam = async (item: ExpertTeamDefinition) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(item.id); setError(''); setNotice('');
    try {
      const result = await window.electron.agents.installExpertTeam({ definitionId: item.id });
      if (!result.success || !result.leadAgentId) {
        setError(result.missingSkillIds?.length
          ? `${t('expertTeamMissingSkills')} ${result.missingSkillIds.join(', ')}`
          : t('expertTeamCreateFailed'));
        return;
      }
      await agentService.loadAgents();
      setTeam(null);
      if (!result.runtimeReady) {
        setNotice(t('expertTeamSavedPending'));
        setTab(EmployeeTab.Installed);
        return;
      }
      openInstalled(result.leadAgentId);
    } catch { setError(t('expertTeamCreateFailed')); }
    finally { operation.current = false; setBusy(null); }
  };

  return <div data-skin-management-page="true" className="relative z-10 flex h-full flex-col bg-background">
    <header className={`draggable flex h-12 shrink-0 items-center gap-3 border-b border-border px-4 ${isWindows ? 'pr-36' : ''}`}>
      {isSidebarCollapsed && !isWindows && <button type="button" onClick={onToggleSidebar} aria-label={t('expand')}
        className={`non-draggable rounded-lg p-2 hover:bg-surface-raised ${isMac ? 'ml-[68px]' : ''}`}>
        <SidebarToggleIcon className="h-4 w-4" isCollapsed />
      </button>}
      <h1 className="text-sm font-semibold">{t('digitalEmployees')}</h1>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
      <div className="mx-auto max-w-[1120px] space-y-6 px-8 py-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div><h2 className="text-2xl font-semibold">{t('digitalEmployeeTitle')}</h2><p className="mt-2 text-sm text-secondary">{t('digitalEmployeeSubtitle')}</p></div>
          <button type="button" onClick={() => setCreating(true)} className={`${buttonClass} inline-flex items-center gap-2`}><PlusIcon className="h-4 w-4" />{t('createAgent')}</button>
        </div>
        {error && <p role="alert" className="rounded-xl border border-red-500/30 p-3 text-sm text-red-500">{error}</p>}
        {notice && <p role="status" className="rounded-xl border border-border p-3 text-sm">{notice}</p>}
        <input aria-label={t('digitalEmployeeSearch')} placeholder={t('digitalEmployeeSearch')} value={query} onChange={event => setQuery(event.target.value)}
          className="w-full rounded-xl border border-border bg-surface px-4 py-2 text-sm" />
        <div role="tablist" aria-label={t('digitalEmployees')} className="flex flex-wrap gap-2 border-b border-border pb-3">
          {Object.values(EmployeeTab).map(value => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}
            className={`${buttonClass} ${tab === value ? 'bg-primary-muted text-primary' : ''}`}>
            {t(EmployeeTabLabels[value])} <span className="ml-1 text-secondary">{value === EmployeeTab.Catalog ? catalog.length : value === EmployeeTab.Teams ? teams.length : installed.length}</span>
          </button>)}
        </div>
        {loading && tab === EmployeeTab.Catalog ? <p role="status">{t('loading')}</p> : <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
          {tab === EmployeeTab.Catalog && catalog.map(item => <article key={item.id} className={cardClass}>
            <AgentAvatarIcon value={item.icon} className="h-12 w-12" />
            <h3 className="font-semibold">{isEn ? item.nameEn : item.name}</h3>
            <p className="line-clamp-3 flex-1 text-sm text-secondary">{isEn ? item.descriptionEn : item.description}</p>
            <button type="button" className={buttonClass} onClick={() => setPreset(item)}>{t('digitalEmployeeDetails')}</button>
          </article>)}
          {tab === EmployeeTab.Installed && installed.map(item => <article key={item.id} className={cardClass}>
            <AgentAvatarIcon value={item.icon} className="h-12 w-12" /><h3 className="font-semibold">{item.name}</h3>
            <p className="line-clamp-3 flex-1 text-sm text-secondary">{item.description}</p>
            <div className="flex gap-2"><button type="button" disabled={!item.enabled} className={buttonClass} onClick={() => openInstalled(item.id)}>{t('digitalEmployeeOpen')}</button>
              <button type="button" className={buttonClass} onClick={() => setSettingsId(item.id)}>{t('agentSettings')}</button></div>
          </article>)}
          {tab === EmployeeTab.Teams && teams.map(item => <article key={item.id} className={cardClass}>
            <UsersIcon className="h-12 w-12 text-primary" /><h3 className="font-semibold">{item.name}</h3>
            <p className="line-clamp-3 flex-1 text-sm text-secondary">{item.description}</p>
            <p className="text-xs text-secondary">{t('expertTeamMembers').replace('{count}', String(item.roles.length))}</p>
            <button type="button" className={buttonClass} onClick={() => setTeam(item)}>{t('digitalEmployeeDetails')}</button>
          </article>)}
        </div>}
        {!loading && (tab === EmployeeTab.Catalog ? catalog : tab === EmployeeTab.Teams ? teams : installed).length === 0 && <p className="py-12 text-center text-secondary">{t('digitalEmployeeEmpty')}</p>}
      </div>
    </div>
    {creating && <AgentCreateModal onClose={() => { setCreating(false); agentService.loadAgents(); }} source="agents_view" />}
    {settingsId && <AgentSettingsPanel agentId={settingsId} onClose={() => setSettingsId(null)} />}
    {(preset || team) && <Modal onClose={() => { if (!busy) { setPreset(null); setTeam(null); } }}>
      <div className="max-h-[80vh] w-[min(640px,90vw)] overflow-y-auto p-6">
        <h2 className="text-xl font-semibold">{team?.name ?? (isEn ? preset?.nameEn : preset?.name)}</h2>
        <p className="mt-3 text-sm text-secondary">{team?.description ?? (isEn ? preset?.descriptionEn : preset?.description)}</p>
        {team && <div className="my-5 space-y-3">{[team.lead, ...team.roles].map(role => <div key={role.key} className="rounded-xl border border-border p-3">
          <h3 className="text-sm font-semibold">{role.name}</h3><p className="mt-1 text-sm text-secondary">{role.description}</p>
          <p className="mt-2 text-xs text-secondary">{role.skillIds.join(' · ')}</p>
        </div>)}<p className="text-sm text-secondary">{t('expertTeamDelegationNotice')}</p></div>}
        {preset && <p className="my-4 text-sm">{t('digitalEmployeeSkills')} {preset.skillIds.join(' · ')}</p>}
        {missingSkills.length > 0 && <p className="my-4 text-sm text-amber-600">{t('expertTeamMissingSkills')} {missingSkills.join(', ')}</p>}
        {error && <p role="alert" className="my-3 text-sm text-red-500">{error}</p>}
        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" className={buttonClass} disabled={Boolean(busy)} onClick={() => { setPreset(null); setTeam(null); }}>{t('close')}</button>
          {missingSkills.length > 0 ? <button type="button" className={buttonClass} onClick={onShowSkills}>{t('expertTeamManageSkills')}</button>
            : <button type="button" className={`${buttonClass} bg-primary text-white`} disabled={Boolean(busy)} onClick={() => team ? void addTeam(team) : preset && void addPreset(preset)}>
              {busy ? t('loading') : team ? t('expertTeamCreate') : t('digitalEmployeeAdd')}
            </button>}
        </div>
      </div>
    </Modal>}
  </div>;
}
