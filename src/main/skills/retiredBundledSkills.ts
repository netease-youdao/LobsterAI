import fs from 'fs';
import path from 'path';

// Keep retired IDs after removing their bundled files so upgrades also remove
// the copies installed by older app versions in userData/SKILLs.
export const RetiredBundledSkillId = {
  FilmsSearch: 'films-search',
  MusicSearch: 'music-search',
} as const;

export const RETIRED_BUNDLED_SKILL_IDS: ReadonlySet<string> = new Set(Object.values(RetiredBundledSkillId));

export function removeRetiredSkillEntries(entries: Record<string, unknown>): boolean {
  let changed = false;
  for (const id of RETIRED_BUNDLED_SKILL_IDS) {
    if (Object.prototype.hasOwnProperty.call(entries, id)) {
      delete entries[id];
      changed = true;
    }
  }
  return changed;
}

export function removeRetiredBundledSkills(skillsRoot: string, configPath: string): void {
  for (const id of RETIRED_BUNDLED_SKILL_IDS) {
    // Startup recovers .upgrading backups after bundled sync. Remove those too
    // so an interrupted upgrade cannot bring a retired skill back.
    for (const directory of [id, `${id}.upgrading`]) {
      const target = path.join(skillsRoot, directory);
      try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (error) {
        // Retry on the next startup without blocking unrelated skill updates.
        console.error(`[skills] Failed to remove retired bundled skill at ${target}:`, error);
      }
    }
  }

  if (!fs.existsSync(configPath)) return;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!config?.defaults || typeof config.defaults !== 'object' || Array.isArray(config.defaults)) return;
    if (!removeRetiredSkillEntries(config.defaults)) return;

    const temporaryPath = `${configPath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    fs.renameSync(temporaryPath, configPath);
  } catch (error) {
    console.error('[skills] Failed to remove retired bundled skill defaults:', error);
  }
}
