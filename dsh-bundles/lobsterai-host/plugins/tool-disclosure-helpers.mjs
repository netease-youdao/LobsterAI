/**
 * Pure helpers for progressive on-demand disclosure of LobsterAI's built-in
 * heavy MCP tool groups (`computer-use`, `browser`, `word`, `excel`, `ppt`)
 * and scoped host tools (`html-render`, `skin-manage`), combined with
 * user-configured per-server MCP `toolFilter` denials and Goal-mode gating.
 * Zero DSH peer imports so Vitest can test them directly.
 */

import { computeDeniedUserMcpTools } from './mcp-tool-filter-helpers.mjs';

export const GOAL_TOOL_NAMES = Object.freeze([
  'create_goal',
  'update_goal',
  'get_goal',
]);

const GOAL_TOOL_NAME_SET = new Set(GOAL_TOOL_NAMES);

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
    skills: [],
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
  {
    id: 'html-render',
    toolNames: ['lobsterai_render_html_to_image'],
    skills: [],
    label: '离屏 HTML 渲染为 PNG/JPEG 图片（封面、海报、社媒图文卡片）',
  },
  {
    id: 'skin-manage',
    toolNames: ['lobsterai_skin_manage'],
    skills: ['skin-creator'],
    label: 'LobsterAI 皮肤草稿创建、资源注册与应用',
  },
]);

export const PROGRESSIVE_CAPABILITY_IDS = Object.freeze(
  PROGRESSIVE_TOOL_GROUPS.map((group) => group.id),
);

const GROUP_BY_ID = new Map(PROGRESSIVE_TOOL_GROUPS.map((group) => [group.id, group]));
const EXACT_TOOL_TO_CAPABILITY = new Map();
const SKILL_TO_CAPABILITY = new Map();
for (const group of PROGRESSIVE_TOOL_GROUPS) {
  if (Array.isArray(group.toolNames)) {
    for (const toolName of group.toolNames) {
      EXACT_TOOL_TO_CAPABILITY.set(toolName, group.id);
    }
  }
  for (const skillName of group.skills) {
    SKILL_TO_CAPABILITY.set(skillName, group.id);
  }
}

/**
 * Resolve which progressive capability group owns a registered tool name,
 * or `null` if the tool is not managed by progressive disclosure (e.g. DSH
 * built-in tools, general host tools, or user-added custom MCP servers).
 * @param {string} toolName
 * @returns {string | null}
 */
export function resolveCapabilityForToolName(toolName) {
  if (typeof toolName !== 'string' || !toolName) return null;
  const exact = EXACT_TOOL_TO_CAPABILITY.get(toolName);
  if (exact) return exact;
  if (!toolName.startsWith('mcp__')) return null;
  for (const group of PROGRESSIVE_TOOL_GROUPS) {
    if (group.prefix && toolName.startsWith(group.prefix)) return group.id;
  }
  return null;
}

/**
 * Check whether a resumed session's logged request header already admitted any
 * Goal-mode tool (`create_goal`, `update_goal`, `get_goal`) so Goal tools stay
 * admitted for cache & behavior stability on resume.
 * @param {Array<{ name?: unknown }> | undefined} headerTools
 * @returns {boolean}
 */
export function hasAdmittedGoalTools(headerTools) {
  if (!Array.isArray(headerTools) || headerTools.length === 0) return false;
  for (const tool of headerTools) {
    if (tool && typeof tool.name === 'string' && GOAL_TOOL_NAME_SET.has(tool.name)) {
      return true;
    }
  }
  return false;
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
  const exactSet = Array.isArray(group.toolNames) ? new Set(group.toolNames) : null;
  const tools = [];
  for (const name of restrictableNames) {
    if ((group.prefix && name.startsWith(group.prefix)) || (exactSet && exactSet.has(name))) {
      tools.push(name);
    }
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
export const SIDE_CHAT_BLOCKED_TOOL_NAMES = Object.freeze(new Set([
  'subagent',
  'delegate_agent',
  'lobster_schedule',
  'send_message',
  'interrupt_agent',
  'wait_agent',
  'list_agents',
  'list_subagent_models',
]));

/**
 * Evaluate whether a tool call must be blocked inside a side-chat session.
 * Blocking via `ctx.tools.guard` preserves the inherited parent tool-schema
 * list so KV-cache prefix reuse remains intact while preventing side chats
 * from spawning subagents, delegating across agents, or scheduling tasks.
 * @param {unknown} toolName
 * @param {boolean} isSideChat
 * @returns {{ reason: string, info: { name: string, code: string } } | undefined}
 */
export function evaluateSideChatToolGuard(toolName, isSideChat) {
  if (!isSideChat || typeof toolName !== 'string' || !SIDE_CHAT_BLOCKED_TOOL_NAMES.has(toolName)) {
    return undefined;
  }
  return {
    reason: `Tool "${toolName}" is disabled in side conversations. Answer directly or ask the user to run this in the main conversation.`,
    info: {
      name: 'SideChatToolBlockedError',
      code: 'SIDE_CHAT_TOOL_BLOCKED',
    },
  };
}

export function renderEnableToolsOutput(_args, value) {
  const text = value && typeof value === 'object' && typeof /** @type {Record<string, unknown>} */ (value).text === 'string'
    ? /** @type {Record<string, string>} */ (value).text
    : JSON.stringify(value ?? null);
  return [{ type: 'text', text }];
}
