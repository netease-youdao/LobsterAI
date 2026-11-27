import type { SkillSecurityReport as SkillSecurityReportData } from '../../main/libs/skillSecurity/skillSecurityTypes';
import { AgentUiEvent } from '../../shared/agent/constants';
import { store } from '../store';
import { setSkills } from '../store/slices/skillSlice';
import type { Agent } from '../types/agent';
import type { MarketplaceSkill, Skill } from '../types/skill';
import { i18nService } from './i18n';
import { skillService } from './skill';

export interface PendingExpertSkillReview {
  skillId: string;
  skillName: string;
  pendingInstallId: string;
  auditReport: SkillSecurityReportData;
}

export interface ExpertSkillInstallSummary {
  installedIds: string[];
  pendingReviews: PendingExpertSkillReview[];
  unresolvedIds: string[];
  failedIds: string[];
}

export interface ExpertSkillInstallDeps {
  fetchMarketplace: () => Promise<{ skills: MarketplaceSkill[] }>;
  downloadSkill: (source: string) => Promise<{
    success: boolean;
    skills?: Skill[];
    error?: string;
    auditReport?: SkillSecurityReportData;
    pendingInstallId?: string;
  }>;
  onSkillsUpdated?: (skills: Skill[]) => void;
}

/**
 * Return unique non-empty skill IDs required by an agent that are not yet
 * present among locally installed skills.
 */
export function resolveMissingAgentSkillIds(
  agentSkillIds: readonly string[] | null | undefined,
  installedSkills: readonly Pick<Skill, 'id'>[],
): string[] {
  if (!Array.isArray(agentSkillIds) || agentSkillIds.length === 0) {
    return [];
  }
  const installedIds = new Set(installedSkills.map((skill) => skill.id));
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const rawId of agentSkillIds) {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id || seen.has(id) || installedIds.has(id)) continue;
    seen.add(id);
    missing.push(id);
  }
  return missing;
}

/**
 * Install missing skills sequentially from the Skill Marketplace catalog.
 *
 * Official CDN marketplace packages complete silently in the main process
 * without triggering a security modal; any third-party/unverified URL that
 * requires user security confirmation is collected in `pendingReviews` and
 * never auto-confirmed.
 */
export async function installMissingSkillsFromMarketplace(
  missingSkillIds: readonly string[],
  deps: ExpertSkillInstallDeps,
): Promise<ExpertSkillInstallSummary> {
  const uniqueIds = [...new Set(
    missingSkillIds
      .filter((id): id is string => typeof id === 'string')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  )];
  const summary: ExpertSkillInstallSummary = {
    installedIds: [],
    pendingReviews: [],
    unresolvedIds: [],
    failedIds: [],
  };
  if (uniqueIds.length === 0) {
    return summary;
  }

  let catalog: MarketplaceSkill[] = [];
  try {
    const result = await deps.fetchMarketplace();
    catalog = Array.isArray(result?.skills) ? result.skills : [];
  } catch (error) {
    console.warn('[ExpertSkillInstaller] Failed to fetch marketplace catalog:', error);
    summary.failedIds.push(...uniqueIds);
    return summary;
  }

  const catalogById = new Map(catalog.map((skill) => [skill.id, skill]));

  for (const skillId of uniqueIds) {
    const marketplaceSkill = catalogById.get(skillId);
    if (!marketplaceSkill?.url) {
      summary.unresolvedIds.push(skillId);
      continue;
    }

    try {
      const result = await deps.downloadSkill(marketplaceSkill.url);
      if (result.pendingInstallId && result.auditReport) {
        summary.pendingReviews.push({
          skillId,
          skillName: marketplaceSkill.name || skillId,
          pendingInstallId: result.pendingInstallId,
          auditReport: result.auditReport,
        });
        continue;
      }
      if (result.success) {
        summary.installedIds.push(skillId);
        if (result.skills) {
          deps.onSkillsUpdated?.(result.skills);
        }
      } else {
        summary.failedIds.push(skillId);
      }
    } catch (error) {
      console.warn(`[ExpertSkillInstaller] Failed to install missing skill "${skillId}":`, error);
      summary.failedIds.push(skillId);
    }
  }

  return summary;
}

/**
 * Best-effort non-blocking background installation of missing skills after a
 * preset expert is summoned/added. Never blocks the summon flow.
 */
export async function autoInstallMissingSkillsForAgent(
  agent: Pick<Agent, 'id' | 'name' | 'skillIds'>,
): Promise<ExpertSkillInstallSummary> {
  const emptySummary: ExpertSkillInstallSummary = {
    installedIds: [],
    pendingReviews: [],
    unresolvedIds: [],
    failedIds: [],
  };
  if (
    !Array.isArray(agent.skillIds)
    || agent.skillIds.length === 0
    || typeof window === 'undefined'
    || typeof window.electron?.skills?.list !== 'function'
    || typeof window.electron?.skills?.fetchMarketplace !== 'function'
    || typeof window.electron?.skills?.download !== 'function'
  ) {
    return emptySummary;
  }

  let installedSkills = store.getState().skill.skills;
  if (installedSkills.length === 0) {
    installedSkills = await skillService.loadSkills();
    if (installedSkills.length === 0) {
      return emptySummary;
    }
    store.dispatch(setSkills(installedSkills));
  }

  const missingSkillIds = resolveMissingAgentSkillIds(agent.skillIds, installedSkills);
  if (missingSkillIds.length === 0) {
    return emptySummary;
  }

  const summary = await installMissingSkillsFromMarketplace(missingSkillIds, {
    fetchMarketplace: () => skillService.fetchMarketplaceSkills(),
    downloadSkill: (url) => skillService.downloadSkill(url),
    onSkillsUpdated: (nextSkills) => {
      if (Array.isArray(nextSkills) && nextSkills.length > 0) {
        store.dispatch(setSkills(nextSkills));
      }
    },
  });

  // Cancel any unconfirmed pending background installs so temp dirs are cleaned up;
  // users can complete interactive confirmation in the Marketplace or Agent Settings.
  for (const pending of summary.pendingReviews) {
    await skillService.confirmInstall(pending.pendingInstallId, 'cancel').catch(() => {});
  }

  const incompleteCount =
    summary.pendingReviews.length + summary.unresolvedIds.length + summary.failedIds.length;
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    if (summary.installedIds.length > 0 && incompleteCount === 0) {
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t('agentMissingSkillsInstalledToast').replace('{count}', String(summary.installedIds.length)),
      }));
    } else if (incompleteCount > 0) {
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: {
          message: i18nService.t('agentMissingSkillsPartialToast'),
          actionLabel: i18nService.t('agentMissingSkillsOpenMarket'),
          onAction: () => {
            window.dispatchEvent(new Event(AgentUiEvent.OpenSkillsMarketplace));
          },
        },
      }));
    }
  }

  return summary;
}
