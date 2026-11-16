import type { Skill } from '../types/skill';

/**
 * Ordering for the skill picker in the prompt input ("使用技能").
 *
 * - Recently used: the skills the user last picked from this menu, newest
 *   first, across both "mine" and "built-in". Hidden while searching so the
 *   results stay in their usual groups.
 * - Mine: user-installed skills, by display name. A file's mtime is not used
 *   because syncs and upgrades rewrite SKILL.md and reshuffle the list.
 * - Built-in: the order `listSkills()` already returns (skills.config.json
 *   `order`, then name).
 *
 * Recent use is picker-only state kept in localStorage; it does not affect
 * which skills run.
 */
const STORAGE_KEY = 'lobsterai.skill-picker-recent';
const MAX_STORED_RECENT_SKILLS = 20;
export const MAX_RECENT_SKILLS_SHOWN = 5;

let cachedRecentSkillIds: string[] | null = null;

function getStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Skill IDs the user picked from the skill menu, most recent first. */
export function readRecentSkillIds(): string[] {
  if (cachedRecentSkillIds) return cachedRecentSkillIds;

  const ids: string[] = [];
  try {
    const raw = getStorage()?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      for (const id of parsed) {
        if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
      }
    }
  } catch {
    // Best-effort ordering: unreadable storage just means no recent group.
  }
  cachedRecentSkillIds = ids.slice(0, MAX_STORED_RECENT_SKILLS);
  return cachedRecentSkillIds;
}

/** Moves a skill to the front of the recent list. */
export function recordSkillPickerUse(skillId: string): void {
  if (!skillId) return;

  const ids = [skillId, ...readRecentSkillIds().filter(id => id !== skillId)]
    .slice(0, MAX_STORED_RECENT_SKILLS);
  cachedRecentSkillIds = ids;
  try {
    getStorage()?.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Keeping the order in memory for this run is still useful.
  }
}

export interface SkillPickerGroups {
  recent: Skill[];
  mine: Skill[];
  builtIn: Skill[];
}

interface GroupSkillsOptions {
  /** Current search query; a non-empty query hides the recent group. */
  query: string;
  matchesQuery: (skill: Skill) => boolean;
  recentSkillIds: readonly string[];
  getDisplayName: (skill: Skill) => string;
}

/**
 * Splits enabled skills into the picker's groups. `skills` is expected in
 * `listSkills()` order, which the built-in group keeps as is.
 */
export function groupSkillsForPicker(
  skills: readonly Skill[],
  { query, matchesQuery, recentSkillIds, getDisplayName }: GroupSkillsOptions,
): SkillPickerGroups {
  const visible = skills.filter(skill => skill.enabled && matchesQuery(skill));

  const recent: Skill[] = [];
  if (!query.trim()) {
    const byId = new Map(visible.map(skill => [skill.id, skill]));
    for (const id of recentSkillIds) {
      const skill = byId.get(id);
      if (skill) recent.push(skill);
      if (recent.length >= MAX_RECENT_SKILLS_SHOWN) break;
    }
  }
  const recentIds = new Set(recent.map(skill => skill.id));
  const rest = visible.filter(skill => !recentIds.has(skill.id));

  const mine = rest
    .filter(skill => !skill.isBuiltIn)
    .map(skill => ({ skill, name: getDisplayName(skill) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.skill.id.localeCompare(b.skill.id))
    .map(entry => entry.skill);
  const builtIn = rest.filter(skill => skill.isBuiltIn);

  return { recent, mine, builtIn };
}

/** Test-only: drop the cached list so the next read re-parses storage. */
export function resetSkillPickerRecentCache(): void {
  cachedRecentSkillIds = null;
}
