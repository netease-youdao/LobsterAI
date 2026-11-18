import { createHmac, randomUUID } from 'crypto';
import path from 'path';

import { catalogAnalyticsId, UsageAnalytics, type UsageParams } from '../../shared/analytics/usage';

export const CapabilityKind = {
  Tool: 'tool',
  Mcp: 'mcp',
  SkillLoad: 'skill_load',
  Skill: 'skill',
  Kit: 'kit',
  Media: 'media',
} as const;

export interface AnalyticsSkill {
  id: string;
  skillPath: string;
  isOfficial?: boolean;
  isBuiltIn?: boolean;
}

const BUILTIN_TOOLS = new Set([
  'read',
  'write',
  'edit',
  'exec',
  'process',
  'browser',
  'web_search',
  'web_fetch',
  'sessions_spawn',
  'sessions_send',
  'sessions_resume',
  'sessions_read',
  'image',
  'memory_search',
  'memory_get',
]);

export function getResourceAnalyticsSalt(store: {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}): string {
  const existing = store.get<string>(UsageAnalytics.ResourceSaltStoreKey);
  if (existing) return existing;
  const salt = randomUUID();
  store.set(UsageAnalytics.ResourceSaltStoreKey, salt);
  return salt;
}

/** Only pseudonyms leave the client; the random salt is an installation-local HMAC key. */
export function resourceAnalyticsId(salt: string, kind: string, value: string): string {
  return createHmac('sha256', salt).update(`${kind}\0${value}`).digest('hex').slice(0, 32);
}

export function classifyCapability(
  name: string,
  input: unknown,
  skills: AnalyticsSkill[],
  salt: string,
): UsageParams & { capabilityKind: string } {
  const normalized = name.toLowerCase();
  if (/^lobsterai_(image|video)_generate$/.test(normalized))
    return { capabilityKind: CapabilityKind.Media, toolName: normalized };
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const file = record.path ?? record.file_path;
  if (normalized === 'read' && typeof file === 'string' && path.isAbsolute(file)) {
    const normalizePath = (value: string) =>
      process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    const skill = skills.find(item => normalizePath(item.skillPath) === normalizePath(file));
    if (skill)
      return {
        capabilityKind: CapabilityKind.SkillLoad,
        skillId: skill.isOfficial || skill.isBuiltIn ? catalogAnalyticsId(skill.id) : undefined,
        capabilityId: resourceAnalyticsId(salt, CapabilityKind.Skill, skill.id),
        capabilitySource: skill.isBuiltIn ? 'builtin' : skill.isOfficial ? 'official' : 'custom',
      };
  }
  // Pinned OpenClaw namespaces native MCP tools as <server>__<tool>.
  if (/^[\w-]+__[\w-]+$/.test(name) || /^mcp[_.]/i.test(name))
    return {
      capabilityKind: CapabilityKind.Mcp,
      capabilityId: resourceAnalyticsId(salt, CapabilityKind.Mcp, name),
      serverId: resourceAnalyticsId(salt, 'mcp_server', name.split('__')[0]),
    };
  return {
    capabilityKind: CapabilityKind.Tool,
    toolName: BUILTIN_TOOLS.has(normalized) ? normalized : undefined,
    capabilityId: resourceAnalyticsId(salt, CapabilityKind.Tool, name),
  };
}
