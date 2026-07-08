import path from 'path';

import type { SkillManager } from './skillManager';

/** Narrow type for the OpenClaw skills.status report used by IPC handlers */
export interface OpenClawSkillReport {
  skills: Array<{
    source?: string;
    skillKey?: string;
    baseDir?: string;
  }>;
}

/**
 * Extract plugin-provided skill IDs from an OpenClaw status report
 * and update the SkillManager's cached set.
 *
 * Skills whose baseDir resides inside the LobsterAI user SKILLs directory
 * are excluded — those are user-installed (e.g. from the skill marketplace)
 * and should remain deletable.
 */
export function updatePluginSkillIdsFromReport(
  sm: SkillManager,
  report: OpenClawSkillReport,
): void {
  const pluginIds = new Set<string>();
  const skillsRoot = path.resolve(sm.getSkillsRoot());
  for (const entry of report.skills ?? []) {
    if (entry.source === 'openclaw-extra') {
      // Skip skills inside the LobsterAI user SKILLs directory —
      // these are user-installed marketplace skills, not plugin-provided.
      if (entry.baseDir) {
        const resolved = path.resolve(entry.baseDir);
        if (resolved.startsWith(skillsRoot + path.sep) || resolved === skillsRoot) {
          continue;
        }
      }
      const id = entry.skillKey || (entry.baseDir ? path.basename(entry.baseDir) : '');
      if (id) pluginIds.add(id);
    }
  }
  sm.setPluginSkillIds(pluginIds);
}
