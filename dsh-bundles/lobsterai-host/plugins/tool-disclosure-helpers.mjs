/**
 * Pure helpers for progressive on-demand disclosure of LobsterAI's built-in
 * heavy MCP tool groups (`computer-use`, `browser`, `word`, `excel`, `ppt`)
 * combined with user-configured per-server MCP `toolFilter` denials.
 * Zero DSH peer imports so Vitest can test them directly.
 */

import { computeDeniedUserMcpTools } from './mcp-tool-filter-helpers.mjs';

export const PROGRESSIVE_TOOL_GROUPS = Object.freeze([
  {
    id: 'computer-use',
    prefix: 'mcp__computer-use__',
    skills: ['computer-use'],
    label: '桌面键鼠与窗口自动化（仅限用户明确要求操控桌面软件时启用，严禁用于预览或校验文档）',
  },
  {
    id: 'browser',
    prefix: 'mcp__lobster-browser__',
    skills: ['web-search'],
    label: '内置浏览器与网页交互',
  },
  {
    id: 'word',
    prefix: 'mcp__lobster-word__',
    skills: ['docx'],
    label: 'Word 文档读写编辑',
  },
  {
    id: 'excel',
    prefix: 'mcp__lobster-excel__',
    skills: ['xlsx'],
    label: 'Excel 表格读写编辑',
  },
  {
    id: 'ppt',
    prefix: 'mcp__lobster-ppt__',
    skills: ['pptx'],
    label: 'PPT 演示文稿读写编辑',
  },
]);

export const PROGRESSIVE_CAPABILITY_IDS = Object.freeze(
  PROGRESSIVE_TOOL_GROUPS.map((group) => group.id),
);

const GROUP_BY_ID = new Map(PROGRESSIVE_TOOL_GROUPS.map((group) => [group.id, group]));
const SKILL_TO_CAPABILITY = new Map();
for (const group of PROGRESSIVE_TOOL_GROUPS) {
  for (const skillName of group.skills) {
    SKILL_TO_CAPABILITY.set(skillName, group.id);
  }
}

/**
 * Resolve which progressive capability group owns a registered tool name,
 * or `null` if the tool is not managed by progressive disclosure (e.g. DSH
 * built-in tools, host tools, or user-added custom MCP servers).
 * @param {string} toolName
 * @returns {string | null}
 */
export function resolveCapabilityForToolName(toolName) {
  if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return null;
  for (const group of PROGRESSIVE_TOOL_GROUPS) {
    if (toolName.startsWith(group.prefix)) return group.id;
  }
  return null;
}

/**
 * Resolve which progressive capability group should auto-unlock when a skill
 * is invoked or pre-selected for a turn.
 * @param {string} skillName
 * @returns {string | null}
 */
export function resolveCapabilityForSkillName(skillName) {
  if (typeof skillName !== 'string') return null;
  const normalized = skillName.trim().toLowerCase();
  return SKILL_TO_CAPABILITY.get(normalized) ?? null;
}

/**
 * Check whether at least one built-in progressive MCP tool is currently
 * registered in the global tool set.
 * @param {Iterable<string>} toolNames
 * @returns {boolean}
 */
export function hasAnyProgressiveToolMounted(toolNames) {
  for (const name of toolNames) {
    if (resolveCapabilityForToolName(name) !== null) return true;
  }
  return false;
}

/**
 * Normalize an incoming array of capability IDs to the allowlisted set.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeCapabilityIds(raw) {
  if (!Array.isArray(raw)) return [];
  const result = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const id = item.trim().toLowerCase();
    if (!GROUP_BY_ID.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * Infer already-admitted capability groups from a resumed session's logged
 * request header tools so resumed sessions keep KV-cache & tool stability.
 * @param {Array<{ name?: unknown }> | undefined} headerTools
 * @returns {string[]}
 */
export function collectAdmittedCapabilitiesFromTools(headerTools) {
  if (!Array.isArray(headerTools) || headerTools.length === 0) return [];
  const found = new Set();
  for (const tool of headerTools) {
    if (!tool || typeof tool.name !== 'string') continue;
    const cap = resolveCapabilityForToolName(tool.name);
    if (cap) found.add(cap);
  }
  return [...found];
}

/**
 * Compute the sorted list of global tool names that should currently be denied
 * for an agent given its set of unlocked capability IDs.
 * @param {Iterable<string>} restrictableNames
 * @param {ReadonlySet<string>} unlockedCapabilities
 * @returns {string[]}
 */
export function computeDeniedProgressiveTools(restrictableNames, unlockedCapabilities) {
  const denied = [];
  for (const name of restrictableNames) {
    const cap = resolveCapabilityForToolName(name);
    if (cap !== null && !unlockedCapabilities.has(cap)) {
      denied.push(name);
    }
  }
  denied.sort();
  return denied;
}

/**
 * Compute the sorted union of global tool names that must be denied for an
 * agent: locked built-in progressive MCP tool groups PLUS user-configured
 * per-server MCP `toolFilter` denials.
 *
 * User `toolFilter` denials are strictly monotonic and are NEVER overridden by
 * `unlockedCapabilities`.
 *
 * @param {Iterable<string>} restrictableNames
 * @param {ReadonlySet<string>} unlockedCapabilities
 * @param {ReadonlyMap<string, { include?: readonly string[], exclude?: readonly string[] }> | undefined} mcpToolFilters
 * @param {Iterable<string> | undefined} [registeredServerNames]
 * @returns {string[]}
 */
export function computeCombinedDeniedTools(
  restrictableNames,
  unlockedCapabilities,
  mcpToolFilters,
  registeredServerNames,
) {
  const denied = new Set(computeDeniedProgressiveTools(restrictableNames, unlockedCapabilities));
  for (const name of computeDeniedUserMcpTools(restrictableNames, mcpToolFilters, registeredServerNames)) {
    denied.add(name);
  }
  return [...denied].sort();
}

/**
 * Collect currently mounted tool names for a specific capability group.
 * @param {Iterable<string>} restrictableNames
 * @param {string} capabilityId
 * @returns {string[]}
 */
export function listMountedToolsForCapability(restrictableNames, capabilityId) {
  const group = GROUP_BY_ID.get(capabilityId);
  if (!group) return [];
  const tools = [];
  for (const name of restrictableNames) {
    if (name.startsWith(group.prefix)) tools.push(name);
  }
  tools.sort();
  return tools;
}

/**
 * Group all mounted progressive tools by capability ID.
 * @param {Iterable<string>} restrictableNames
 * @returns {Record<string, string[]>}
 */
export function groupMountedProgressiveTools(restrictableNames) {
  /** @type {Record<string, string[]>} */
  const grouped = {};
  for (const name of restrictableNames) {
    const cap = resolveCapabilityForToolName(name);
    if (!cap) continue;
    if (!grouped[cap]) grouped[cap] = [];
    grouped[cap].push(name);
  }
  for (const tools of Object.values(grouped)) {
    tools.sort();
  }
  return grouped;
}

/**
 * Render `lobster_enable_tools` output into DSH's required `ContentBlock[]`
 * format so downstream hooks (`dsh-spill-policy`, session persistence) always
 * receive an array of content blocks rather than a raw string.
 * @param {unknown} _args
 * @param {unknown} value
 * @returns {Array<{ type: 'text', text: string }>}
 */
export function renderEnableToolsOutput(_args, value) {
  const text = value && typeof value === 'object' && typeof /** @type {Record<string, unknown>} */ (value).text === 'string'
    ? /** @type {Record<string, string>} */ (value).text
    : JSON.stringify(value ?? null);
  return [{ type: 'text', text }];
}
