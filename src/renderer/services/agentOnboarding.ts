const STORAGE_KEY = 'lobsterai.agentOnboardingMeta.v1';
const MAX_STORED_AGENTS = 100;
const MAX_STARTER_PROMPTS = 3;

export interface AgentOnboardingMeta {
  starterPrompts: string[];
  recommendedSkillIds?: string[];
  updatedAt: number;
}

type OnboardingMetaMap = Record<string, AgentOnboardingMeta>;

function getStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readAll(): OnboardingMetaMap {
  const storage = getStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as OnboardingMetaMap;
  } catch {
    return {};
  }
}

function writeAll(map: OnboardingMetaMap): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    const entries = Object.entries(map)
      .sort((a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0))
      .slice(0, MAX_STORED_AGENTS);
    storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Quota or private browsing restrictions must never break agent creation.
  }
}

export function getAgentOnboardingMeta(agentId: string): AgentOnboardingMeta | null {
  const key = agentId.trim();
  if (!key) return null;
  const entry = readAll()[key];
  if (!entry || !Array.isArray(entry.starterPrompts)) return null;
  return entry;
}

export function saveAgentOnboardingMeta(
  agentId: string,
  meta: { starterPrompts?: string[]; recommendedSkillIds?: string[] },
): void {
  const key = agentId.trim();
  if (!key) return;
  const starterPrompts = (meta.starterPrompts ?? [])
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, MAX_STARTER_PROMPTS);
  const recommendedSkillIds = (meta.recommendedSkillIds ?? [])
    .map(item => item.trim())
    .filter(Boolean);

  if (starterPrompts.length === 0 && recommendedSkillIds.length === 0) {
    removeAgentOnboardingMeta(key);
    return;
  }

  const map = readAll();
  map[key] = {
    starterPrompts,
    ...(recommendedSkillIds.length > 0 ? { recommendedSkillIds } : {}),
    updatedAt: Date.now(),
  };
  writeAll(map);
}

export function removeAgentOnboardingMeta(agentId: string): void {
  const key = agentId.trim();
  if (!key) return;
  const map = readAll();
  if (!(key in map)) return;
  delete map[key];
  writeAll(map);
}
