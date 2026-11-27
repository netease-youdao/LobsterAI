import { ArrowDownTrayIcon, CheckIcon, ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';

import type { SkillSecurityReport as SkillSecurityReportData } from '../../../main/libs/skillSecurity/skillSecurityTypes';
import { AgentUiEvent } from '../../../shared/agent/constants';
import {
  installMissingSkillsFromMarketplace,
  resolveMissingAgentSkillIds,
} from '../../services/expertSkillInstaller';
import { i18nService } from '../../services/i18n';
import { skillService } from '../../services/skill';
import { RootState } from '../../store';
import { setSkills } from '../../store/slices/skillSlice';
import SearchIcon from '../icons/SearchIcon';
import SkillIcon from '../icons/SkillIcon';
import SkillSecurityReport from '../skills/SkillSecurityReport';

interface AgentSkillSelectorProps {
  selectedSkillIds: string[];
  onChange: (skillIds: string[]) => void;
}

const AgentSkillSelector: React.FC<AgentSkillSelectorProps> = ({ selectedSkillIds, onChange }) => {
  const dispatch = useDispatch();
  const skills = useSelector((state: RootState) => state.skill.skills);
  const [search, setSearch] = useState('');
  const [i18nReady, setI18nReady] = useState(() => skillService.hasLocalizedSkillDescriptions());
  const [installingIds, setInstallingIds] = useState<string[]>([]);
  const [pendingSecurityReview, setPendingSecurityReview] = useState<{
    pendingInstallId: string;
    auditReport: SkillSecurityReportData;
  } | null>(null);
  const [isConfirmingReview, setIsConfirmingReview] = useState(false);
  const shouldUseFallbackDescription = i18nReady || i18nService.getLanguage() !== 'zh';

  // Load localized skill descriptions from marketplace API
  useEffect(() => {
    if (skillService.hasLocalizedSkillDescriptions()) {
      setI18nReady(true);
      return;
    }
    skillService.fetchMarketplaceSkills()
      .then(() => setI18nReady(true))
      .catch(() => setI18nReady(true));
  }, []);

  const enabledSkills = useMemo(
    () => skills.filter((s) => s.enabled),
    [skills],
  );

  const missingSkillIds = useMemo(
    () => resolveMissingAgentSkillIds(selectedSkillIds, skills),
    [selectedSkillIds, skills],
  );

  const filteredSkills = useMemo(() => {
    const q = search.trim().toLowerCase();
    return enabledSkills.filter((skill) => {
      if (!q) return true;
      const localizedDescription = shouldUseFallbackDescription
        ? skillService.getLocalizedSkillDescription(skill.id, skill.name, skill.description)
        : '';
      return skill.name.toLowerCase().includes(q) || localizedDescription.toLowerCase().includes(q);
    });
  }, [enabledSkills, search, shouldUseFallbackDescription]);

  const toggle = (skillId: string) => {
    if (selectedSkillIds.includes(skillId)) {
      onChange(selectedSkillIds.filter((id) => id !== skillId));
    } else {
      onChange([...selectedSkillIds, skillId]);
    }
  };

  const handleInstallMissingSkills = async (targetIds: string[]) => {
    if (targetIds.length === 0 || installingIds.length > 0) return;
    setInstallingIds(targetIds);
    try {
      const summary = await installMissingSkillsFromMarketplace(targetIds, {
        fetchMarketplace: () => skillService.fetchMarketplaceSkills(),
        downloadSkill: (url) => skillService.downloadSkill(url),
        onSkillsUpdated: (nextSkills) => {
          dispatch(setSkills(nextSkills));
        },
      });
      if (summary.pendingReviews.length > 0) {
        const [firstPending, ...restPending] = summary.pendingReviews;
        for (const extra of restPending) {
          await skillService.confirmInstall(extra.pendingInstallId, 'cancel').catch(() => {});
        }
        setPendingSecurityReview({
          pendingInstallId: firstPending.pendingInstallId,
          auditReport: firstPending.auditReport,
        });
      } else if (summary.installedIds.length > 0 && summary.failedIds.length === 0 && summary.unresolvedIds.length === 0) {
        window.dispatchEvent(new CustomEvent('app:showToast', {
          detail: i18nService.t('agentMissingSkillsInstalledToast').replace('{count}', String(summary.installedIds.length)),
        }));
      } else if (summary.failedIds.length > 0 || summary.unresolvedIds.length > 0) {
        window.dispatchEvent(new CustomEvent('app:showToast', {
          detail: i18nService.t('agentMissingSkillsPartialToast'),
        }));
      }
    } finally {
      setInstallingIds([]);
    }
  };

  const handleSecurityDecision = async (action: 'install' | 'installDisabled' | 'cancel') => {
    if (!pendingSecurityReview || isConfirmingReview) return;
    setIsConfirmingReview(true);
    try {
      const result = await skillService.confirmInstall(pendingSecurityReview.pendingInstallId, action);
      if (result.success && result.skills) {
        dispatch(setSkills(result.skills));
      }
    } finally {
      setIsConfirmingReview(false);
      setPendingSecurityReview(null);
    }
  };

  const handleOpenMarketplace = () => {
    window.dispatchEvent(new Event(AgentUiEvent.OpenSkillsMarketplace));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex items-center gap-2 text-xs leading-5 text-secondary/60">
        <div className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-secondary/30 text-secondary/60">
          <span className="text-[10px] font-medium leading-none">i</span>
        </div>
        <span>{i18nService.t('agentSkillsHint')}</span>
      </div>

      {missingSkillIds.length > 0 && (
        <div className="mb-3 shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
              <ExclamationTriangleIcon className="h-4 w-4 shrink-0" />
              <span>{i18nService.t('agentMissingSkillsTitle')}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={installingIds.length > 0}
                onClick={() => void handleInstallMissingSkills(missingSkillIds)}
                className="inline-flex items-center gap-1 rounded-md bg-amber-600 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ArrowDownTrayIcon className="h-3 w-3" />
                <span>
                  {installingIds.length > 0
                    ? i18nService.t('agentMissingSkillsInstalling')
                    : i18nService.t('agentMissingSkillsInstallAll')}
                </span>
              </button>
              <button
                type="button"
                onClick={handleOpenMarketplace}
                className="rounded-md border border-amber-500/35 px-2 py-1 text-[11px] font-medium text-amber-800 transition-colors hover:bg-amber-500/15 dark:text-amber-200"
              >
                {i18nService.t('agentMissingSkillsOpenMarket')}
              </button>
            </div>
          </div>
          <p className="mt-1 text-[11px] leading-4 text-amber-800/80 dark:text-amber-200/80">
            {i18nService.t('agentMissingSkillsHint')}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {missingSkillIds.map((skillId) => {
              const isInstalling = installingIds.includes(skillId);
              const label = skillService.getLocalizedSkillName(skillId, skillId);
              return (
                <div
                  key={skillId}
                  className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-surface px-2 py-1 text-xs text-foreground"
                >
                  <span className="max-w-[160px] truncate font-medium">{label}</span>
                  <button
                    type="button"
                    disabled={installingIds.length > 0}
                    onClick={() => void handleInstallMissingSkills([skillId])}
                    className="text-[11px] font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isInstalling
                      ? i18nService.t('agentMissingSkillsInstalling')
                      : i18nService.t('agentMissingSkillsInstall')}
                  </button>
                  <button
                    type="button"
                    aria-label={i18nService.t('agentMissingSkillsRemove')}
                    title={i18nService.t('agentMissingSkillsRemove')}
                    onClick={() => onChange(selectedSkillIds.filter((id) => id !== skillId))}
                    className="rounded p-0.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
                  >
                    <XMarkIcon className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="mb-3 shrink-0">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary/45" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={i18nService.t('agentSkillsSearch')}
            className="h-9 w-full rounded-md border border-border-subtle bg-surface-raised/30 pl-9 pr-3 text-xs text-foreground placeholder:text-secondary/45 focus:border-border focus:bg-surface focus:outline-none"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {filteredSkills.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-border text-sm text-secondary/60">
            {enabledSkills.length === 0
              ? i18nService.t('agentSkillsNoInstalled')
              : i18nService.t('agentSkillsNoMatches')}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {filteredSkills.map((skill) => {
              const isSelected = selectedSkillIds.includes(skill.id);
              const description = shouldUseFallbackDescription
                ? skillService.getLocalizedSkillDescription(skill.id, skill.name, skill.description)
                : '';

              return (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => toggle(skill.id)}
                  className={`group relative flex min-h-[96px] items-start gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors hover:border-foreground/25 hover:bg-surface-raised/50 ${
                    isSelected
                      ? 'border-foreground/35 bg-surface-raised/60'
                      : 'border-border bg-surface'
                  }`}
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-raised">
                    <SkillIcon className="h-[18px] w-[18px] text-secondary" />
                  </div>
                  <div className="min-w-0 flex-1 pr-8">
                    <div className="truncate text-sm font-medium leading-5 text-foreground">
                      {skill.name}
                    </div>
                    {description && (
                      <div className="mt-1 line-clamp-2 text-xs leading-[18px] text-secondary/80">
                        {description}
                      </div>
                    )}
                  </div>
                  <div
                    className={`absolute right-3.5 top-3.5 flex h-5 w-5 items-center justify-center rounded border transition-colors ${
                      isSelected
                        ? 'border-foreground bg-foreground'
                        : 'border-border bg-surface group-hover:border-foreground/35'
                    }`}
                  >
                    {isSelected && <CheckIcon className="h-3.5 w-3.5 text-background" />}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {pendingSecurityReview && createPortal(
        <SkillSecurityReport
          report={pendingSecurityReview.auditReport}
          isLoading={isConfirmingReview}
          onAction={(action) => void handleSecurityDecision(action)}
        />,
        document.body,
      )}
    </div>
  );
};

export default AgentSkillSelector;
