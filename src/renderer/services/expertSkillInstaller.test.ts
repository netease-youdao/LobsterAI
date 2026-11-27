import { describe, expect, test, vi } from 'vitest';

import type { MarketplaceSkill, Skill } from '../types/skill';
import {
  installMissingSkillsFromMarketplace,
  resolveMissingAgentSkillIds,
} from './expertSkillInstaller';

const makeInstalledSkill = (id: string): Skill => ({
  id,
  name: id,
  description: '',
  enabled: true,
  isOfficial: true,
  isBuiltIn: false,
  updatedAt: 0,
  prompt: '',
  skillPath: `/skills/${id}/SKILL.md`,
});

const makeMarketSkill = (id: string, url: string): MarketplaceSkill => ({
  id,
  name: id,
  description: `${id} description`,
  url,
  version: '1.0.0',
  source: { from: 'Official', url: 'https://example.com' },
});

describe('expertSkillInstaller', () => {
  test('resolveMissingAgentSkillIds deduplicates and filters out installed skills', () => {
    expect(
      resolveMissingAgentSkillIds(
        ['docx', 'article-writer', ' article-writer ', 'content-planner', ''],
        [makeInstalledSkill('docx')],
      ),
    ).toEqual(['article-writer', 'content-planner']);

    expect(resolveMissingAgentSkillIds([], [makeInstalledSkill('docx')])).toEqual([]);
    expect(resolveMissingAgentSkillIds(undefined, [])).toEqual([]);
  });

  test('installMissingSkillsFromMarketplace installs official packages, collects pending security reviews, and tracks unresolved/failed IDs', async () => {
    const onSkillsUpdated = vi.fn();
    const updatedSkills = [makeInstalledSkill('docx'), makeInstalledSkill('article-writer')];
    const downloadSkill = vi.fn(async (url: string) => {
      if (url.includes('article-writer')) {
        return { success: true, skills: updatedSkills };
      }
      if (url.includes('third-party')) {
        return {
          success: false,
          pendingInstallId: 'pending-1',
          auditReport: {
            skillName: 'third-party',
            riskLevel: 'medium',
            findings: [],
          } as never,
        };
      }
      return { success: false, error: 'Network error' };
    });

    const summary = await installMissingSkillsFromMarketplace(
      ['article-writer', 'third-party', 'broken-skill', 'unknown-skill'],
      {
        fetchMarketplace: async () => ({
          skills: [
            makeMarketSkill('article-writer', 'https://ydlunacommon-cdn.nosdn.127.net/article-writer.zip'),
            makeMarketSkill('third-party', 'https://github.com/org/third-party/archive/main.zip'),
            makeMarketSkill('broken-skill', 'https://ydlunacommon-cdn.nosdn.127.net/broken-skill.zip'),
          ],
        }),
        downloadSkill,
        onSkillsUpdated,
      },
    );

    expect(summary.installedIds).toEqual(['article-writer']);
    expect(summary.pendingReviews).toHaveLength(1);
    expect(summary.pendingReviews[0]).toMatchObject({
      skillId: 'third-party',
      pendingInstallId: 'pending-1',
    });
    expect(summary.failedIds).toEqual(['broken-skill']);
    expect(summary.unresolvedIds).toEqual(['unknown-skill']);
    expect(onSkillsUpdated).toHaveBeenCalledWith(updatedSkills);
  });
});
