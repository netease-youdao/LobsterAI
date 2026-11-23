/**
 * Pure helpers for `@lobsterai/dsh-bundle` persona assembly and SKILL.md
 * frontmatter parsing. Zero DSH peer imports so Vitest can test them directly.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  extractProjectKeys,
  filterMarkdownForProject,
  parseProjectTagFromLine,
  resolveProjectMemoryKeys,
  stripProjectTags,
} from './project-memory-scope.mjs';

export {
  extractProjectKeys,
  filterMarkdownForProject,
  parseProjectTagFromLine,
  resolveProjectMemoryKeys,
  stripProjectTags,
};

export const DEFAULT_AGENT_ID = 'main';
export const LOBSTERAI_SKILL_RANK = 260;
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const WEB_SEARCH_SKILL_ID = 'web-search';
export const MAX_PERSONA_FILE_BYTES = 128 * 1024;
export const MAX_INLINE_MEMORY_CHARS = 3_000;

export const MEMORY_WRITE_POLICY_PROMPT = [
  '## Memory Policy',
  '- Write before you confirm: when the user asks you to remember something ("记住", "以后", "remember this", "from now on") or shares a durable preference or convention, call `lobster_memory_save` BEFORE confirming that you have remembered it.',
  '- Choose the right scope: pass `scope: "project"` for repository/project-specific conventions, commands, architecture, or file paths; pass `scope: "global"` for cross-project user preferences and general facts.',
  '- Use `lobster_memory_search` and `lobster_memory_get` to recall older memories or daily notes not shown inline.',
].join('\n');

export const WEB_SEARCH_ROUTING_GUIDANCE = [
  'When you need live web search:',
  '- If a dedicated search MCP tool (such as Tavily) is available and requested or suitable, prefer that MCP search tool.',
  '- Otherwise call the built-in `web_search` tool directly.',
  '- Use `web_fetch` only to read a specific known URL, not as a substitute for search engines.',
  '- Never claim you searched the web unless you actually ran a search tool.',
].join('\n');

const MEMORY_TRUNCATED_HINT = '\n\n（长期记忆较长，以上仅展示前段内容；如需检索完整历史记忆或每日笔记，请调用 `lobster_memory_search` / `lobster_memory_get`。）';

const MANAGED_BLOCK_RE = /<!--\s*LOBSTERAI_MANAGED_START\s*-->[\s\S]*?<!--\s*LOBSTERAI_MANAGED_END\s*-->\s*/g;
const MANAGED_AGENTS_MARKER = '<!-- LobsterAI managed:';
const OPENCLAW_MEMORY_PROMOTION_COMMENT_RE = /^[ \t]*<!--\s*openclaw-memory-promotion:[^>]*-->[ \t]*\r?\n?/gm;

// Matches OpenClaw's stock `# AGENTS.md - Your Workspace` template through its
// standard `## Make It Yours` closing block (plus optional OpenClaw doc links),
// while preserving any user-authored text outside that stock template.
const OPENCLAW_STOCK_AGENTS_RE = /^#\s+AGENTS\.md\s*-\s*Your Workspace\s*\n+This folder is home\.\s*Treat it that way\.[\s\S]*?^##\s+Make It Yours\s*\n+This is a starting point\.\s*Add your own conventions, style, and rules as you figure out what works\.(?:\s*\n+##\s+Related\s*\n+(?:-\s+\[[^\]]+\]\(\/(?:reference|concepts|automation|gateway)\/[^)]+\)\s*\n?)+)?\s*/m;

// Matches standalone OpenClaw stock `# TOOLS.md - Local Notes` placeholder file.
const OPENCLAW_STOCK_TOOLS_RE = /^#\s+TOOLS\.md\s*-\s*Local Notes\s*\n+Skills define _how_ tools work\.[\s\S]*?Add whatever helps you do your job\.\s*This is your cheat sheet\.\s*/m;

export const PERSONA_FILES = Object.freeze([
  { file: 'SOUL.md', heading: '角色设定' },
  { file: 'IDENTITY.md', heading: '身份信息' },
  { file: 'USER.md', heading: '用户信息' },
  { file: 'AGENTS.md', heading: '工作区指令', sanitize: 'agents' },
  { file: 'MEMORY.md', heading: '长期记忆', sanitize: 'memory' },
]);

/** Simple mtime-keyed file cache so synchronous prompt assembly stays fast. */
const fileCache = new Map();

export function readTextCached(filePath) {
  try {
    if (!existsSync(filePath)) return '';
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return '';
    const cached = fileCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.content;
    }
    const raw = readFileSync(filePath, 'utf8');
    const content = raw.length > MAX_PERSONA_FILE_BYTES
      ? `${raw.slice(0, MAX_PERSONA_FILE_BYTES)}\n...(已截断)`
      : raw;
    fileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, content });
    return content;
  } catch {
    return '';
  }
}

export function sanitizeAgentId(agentId) {
  const raw = typeof agentId === 'string' ? agentId.trim() : '';
  if (!raw || !/^[a-zA-Z0-9_-]{1,64}$/.test(raw)) return DEFAULT_AGENT_ID;
  return raw;
}

/**
 * Strip legacy OpenClaw managed blocks and default workspace/tools boilerplate
 * from `AGENTS.md` while keeping any user-authored instructions intact.
 */
export function stripLegacyOpenClawAgentsBoilerplate(content) {
  if (typeof content !== 'string' || !content) return '';
  let text = content.replace(/\r\n/g, '\n').replace(MANAGED_BLOCK_RE, '');
  const markerIndex = text.indexOf(MANAGED_AGENTS_MARKER);
  if (markerIndex >= 0) {
    text = text.slice(0, markerIndex);
  }
  text = text.replace(OPENCLAW_STOCK_AGENTS_RE, '');
  text = text.replace(OPENCLAW_STOCK_TOOLS_RE, '');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Remove legacy OpenClaw memory-promotion HTML comments from `MEMORY.md`
 * and enforce a bounded inline character budget so long-term memory cannot
 * bloat every turn's system prompt (full history remains searchable via
 * `lobster_memory_search` / `lobster_memory_get`).
 */
export function sanitizeMemoryMarkdownForPrompt(content, maxChars = MAX_INLINE_MEMORY_CHARS) {
  if (typeof content !== 'string' || !content) return '';
  const cleaned = content
    .replace(/\r\n/g, '\n')
    .replace(OPENCLAW_MEMORY_PROMOTION_COMMENT_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!cleaned || cleaned.length <= maxChars) return cleaned;
  const slice = cleaned.slice(0, maxChars);
  const lastNewline = slice.lastIndexOf('\n');
  const bounded = (lastNewline > Math.floor(maxChars * 0.6) ? slice.slice(0, lastNewline) : slice).trimEnd();
  return `${bounded}${MEMORY_TRUNCATED_HINT}`;
}

export function assembleWorkspacePersona(workspacesDir, agentId, customSystemPrompt, options = {}) {
  const sections = [];
  const memoryEnabled = options?.memoryEnabled !== false;
  const activeProjectKeys = resolveProjectMemoryKeys(options?.workspaceDir);

  if (workspacesDir) {
    const safeId = sanitizeAgentId(agentId);
    const dir = resolve(workspacesDir, safeId);
    const isNonMainExpert = safeId !== DEFAULT_AGENT_ID;
    const mainDir = isNonMainExpert ? resolve(workspacesDir, DEFAULT_AGENT_ID) : null;

    const pushSection = (heading, text) => {
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (trimmed.length > 0) {
        sections.push(`## ${heading}\n\n${trimmed}`);
      }
    };

    pushSection('角色设定', readTextCached(join(dir, 'SOUL.md')));
    pushSection('身份信息', readTextCached(join(dir, 'IDENTITY.md')));

    if (memoryEnabled) {
      if (mainDir) {
        const globalUser = filterMarkdownForProject(
          readTextCached(join(mainDir, 'USER.md')),
          [],
          { stripTags: true, globalOnly: true },
        );
        pushSection('Global User Preferences', globalUser);

        const globalMemoryFiltered = filterMarkdownForProject(
          readTextCached(join(mainDir, 'MEMORY.md')),
          [],
          { stripTags: true, globalOnly: true },
        );
        pushSection('Global Memory', sanitizeMemoryMarkdownForPrompt(globalMemoryFiltered));
      }

      const ownUser = filterMarkdownForProject(
        readTextCached(join(dir, 'USER.md')),
        activeProjectKeys,
        { stripTags: true },
      );
      pushSection('用户信息', ownUser);
    }

    const agentsText = readTextCached(join(dir, 'AGENTS.md'));
    if (agentsText) {
      pushSection('工作区指令', stripLegacyOpenClawAgentsBoilerplate(agentsText));
    }

    if (memoryEnabled) {
      const ownMemoryFiltered = filterMarkdownForProject(
        readTextCached(join(dir, 'MEMORY.md')),
        activeProjectKeys,
        { stripTags: true },
      );
      pushSection('长期记忆', sanitizeMemoryMarkdownForPrompt(ownMemoryFiltered));
    }
  }
  if (typeof customSystemPrompt === 'string' && customSystemPrompt.trim().length > 0) {
    sections.push(customSystemPrompt.trim());
  }
  return sections.join('\n\n');
}

/**
 * Parse YAML frontmatter header from a SKILL.md file (lightweight, zero-dep),
 * including YAML multiline block scalars (`|`, `>`, `|-`, `>-`, `|+`, `>+`)
 * and indented continuation lines.
 */
export function parseSkillFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: markdown };
  const [, yamlBlock, body] = match;
  const lines = yamlBlock.split(/\r?\n/);
  const meta = {};

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const kv = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let rawValue = kv[2].trim();

    if (/^[|>][+-]?$/.test(rawValue)) {
      const folded = rawValue.startsWith('>');
      const blockLines = [];
      let baseIndent = null;
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.trim().length === 0) {
          blockLines.push('');
          i += 1;
          continue;
        }
        const indentMatch = next.match(/^([ \t]+)/);
        if (!indentMatch) break;
        const indentLen = indentMatch[1].length;
        if (baseIndent === null) baseIndent = indentLen;
        if (indentLen < baseIndent) break;
        blockLines.push(next.slice(baseIndent));
        i += 1;
      }
      const joined = folded
        ? blockLines.join(' ').replace(/\s+/g, ' ').trim()
        : blockLines.join('\n').trim();
      meta[key] = joined;
      continue;
    }

    if (
      (rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2)
      || (rawValue.startsWith("'") && rawValue.endsWith("'") && rawValue.length >= 2)
    ) {
      rawValue = rawValue.slice(1, -1);
    } else if (rawValue.length > 0) {
      // Collect plain indented continuation lines for multi-line scalars.
      const parts = [rawValue];
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1])) {
        parts.push(lines[i + 1].trim());
        i += 1;
      }
      rawValue = parts.join(' ');
    }
    meta[key] = rawValue;
  }
  return { meta, body };
}

export function toKebabSkillName(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Resolve a DSH-compliant kebab-case skill name from a directory ID (`rawId`)
 * and optional frontmatter `name` (`metaName`).
 *
 * - For LobsterAI-managed roots (`preferRawId: true`), `rawId` is preferred so
 *   the registered DSH name always matches `SkillManager`'s `skill.id`,
 *   `agents.skill_ids`, and `selectedSkillRoutingPrompt`'s `<id>` even when
 *   frontmatter `name` is non-ASCII (e.g. `周报助手`) or differs from the
 *   directory name (e.g. `remotion` vs `remotion-best-practices`).
 * - For project-local `.dsh/skills` / `.agents/skills` (`preferRawId: false`),
 *   `metaName` is checked first and falls back to `rawId` when `metaName`
 *   contains no ASCII characters.
 * - If both yield empty kebab names, generates a deterministic `skill-<hash>`
 *   fallback so custom non-ASCII skills are never silently dropped.
 */
export function resolveDshSkillName(rawId, metaName, options = {}) {
  const preferRawId = options.preferRawId !== false;
  const rawCandidate = toKebabSkillName(rawId);
  const metaCandidate = toKebabSkillName(metaName);
  const primary = preferRawId ? rawCandidate : metaCandidate;
  const secondary = preferRawId ? metaCandidate : rawCandidate;
  if (primary) return primary;
  if (secondary) return secondary;
  const seed = String(rawId || metaName || '').trim();
  if (!seed) return '';
  return `skill-${createHash('sha1').update(seed).digest('hex').slice(0, 8)}`;
}

function collectSkillIdentifiers(rawId, skillName, metaName) {
  const result = [];
  const seen = new Set();
  for (const candidate of [rawId, skillName, metaName, toKebabSkillName(metaName)]) {
    const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function matchesAnyIdentifier(set, identifiers) {
  if (!set) return false;
  for (const id of identifiers) {
    if (set.has(id)) return true;
  }
  return false;
}

/**
 * Determine whether a LobsterAI skill is installed and enabled for the current
 * session (respecting global skill toggles and per-agent allowlists).
 *
 * @param {string} skillId
 * @param {readonly string[]} rootDirs
 * @param {{ enabledIds?: Set<string> | null, disabledIds?: Set<string> }} policy
 * @param {Set<string> | null | undefined} allowedSkillIds
 * @returns {boolean}
 */
export function isSkillEnabledForSession(skillId, rootDirs, policy, allowedSkillIds) {
  if (!skillId) return false;
  if (policy?.disabledIds?.has(skillId)) return false;
  if (policy?.enabledIds instanceof Set && !policy.enabledIds.has(skillId)) return false;
  if (allowedSkillIds instanceof Set && !allowedSkillIds.has(skillId)) return false;
  if (!Array.isArray(rootDirs) || rootDirs.length === 0) return false;
  for (const rootDir of rootDirs) {
    if (typeof rootDir !== 'string' || rootDir.length === 0) continue;
    if (existsSync(join(rootDir, skillId, 'SKILL.md'))) {
      return true;
    }
  }
  return false;
}

/**
 * Return concise web-search routing guidance when the `web-search` skill is
 * enabled for the current session, or empty string when disabled.
 */
export function buildWebSearchRoutingGuidance(rootDirs, policy, allowedSkillIds) {
  return isSkillEnabledForSession(WEB_SEARCH_SKILL_ID, rootDirs, policy, allowedSkillIds)
    ? WEB_SEARCH_ROUTING_GUIDANCE
    : '';
}

function findProjectRootForSkills(cwd) {
  let current = resolve(cwd);
  while (true) {
    if (
      existsSync(join(current, '.git'))
      || existsSync(join(current, '.dsh', 'skills'))
      || existsSync(join(current, '.agents', 'skills'))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

export function resolveProjectSkillRoots(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return [];
  const resolvedCwd = resolve(cwd);
  if (!existsSync(resolvedCwd)) return [];
  const projectRoot = findProjectRootForSkills(resolvedCwd);
  const candidates = [
    join(resolvedCwd, '.dsh', 'skills'),
    join(resolvedCwd, '.agents', 'skills'),
    ...(projectRoot !== resolvedCwd
      ? [join(projectRoot, '.dsh', 'skills'), join(projectRoot, '.agents', 'skills')]
      : []),
  ];
  const seen = new Set();
  const roots = [];
  for (const dir of candidates) {
    const norm = resolve(dir);
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (existsSync(norm)) {
      roots.push(norm);
    }
  }
  return roots;
}

function scanSkillEntries(rootDir) {
  if (!rootDir || !existsSync(rootDir)) return [];
  try {
    return readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Discover skills across LobsterAI's managed roots (`skillsDir` + `extraDirs`)
 * and optional project-local roots (`<projectRoot>/.dsh/skills`, `.agents/skills`),
 * strictly enforcing `policy.disabledIds`, `policy.enabledIds`, and per-session
 * `allowedSkillIds`.
 */
export function discoverLobsterSkills(rootDirs, policy, allowedSkillIds, options = {}) {
  const validateName = typeof options.isSkillName === 'function'
    ? options.isSkillName
    : (candidate) => SKILL_NAME_RE.test(candidate);
  const disabledIds = policy?.disabledIds instanceof Set ? policy.disabledIds : new Set();
  const enabledIds = policy?.enabledIds instanceof Set ? policy.enabledIds : null;
  const candidates = [];
  const seen = new Set();
  const blockedByManagedPolicy = new Set();
  const scannedRoots = new Set();

  const pushCandidate = (skillName, meta, skillDir, skillFile) => {
    const description = (meta.description || meta.name || '').trim() || `LobsterAI skill: ${skillName}`;
    seen.add(skillName);
    candidates.push({
      name: skillName,
      description,
      provider: 'lobsterai-skills',
      source: skillFile,
      rank: LOBSTERAI_SKILL_RANK,
      invocation: {
        modelInvocable: true,
        userInvocable: true,
      },
      resourceBase: {
        kind: 'directory',
        path: skillDir,
      },
      locator: {
        filePath: skillFile,
        dirPath: skillDir,
        skillName,
        description,
      },
    });
  };

  // 1. LobsterAI-managed skill roots (`skillsDir` + `extraDirs`).
  for (const rootDir of rootDirs ?? []) {
    if (!rootDir) continue;
    const normRoot = resolve(rootDir);
    if (scannedRoots.has(normRoot)) continue;
    scannedRoots.add(normRoot);

    for (const entry of scanSkillEntries(normRoot)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillDir = join(normRoot, entry.name);
      const skillFile = join(skillDir, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      const rawId = entry.name;
      const content = readTextCached(skillFile);
      if (!content) continue;
      const { meta } = parseSkillFrontmatter(content);
      const skillName = resolveDshSkillName(rawId, meta.name, { preferRawId: true });
      if (!validateName(skillName)) continue;

      const identifiers = collectSkillIdentifiers(rawId, skillName, meta.name);

      // `web-search` is exposed natively through DSH's `web_search` tool via
      // `lobster-web-search-bridge`; omit it from the model-facing skill
      // catalog so it consumes zero prompt tokens while its toggle/allowlist
      // still gates `web_search` admission.
      if (identifiers.includes(WEB_SEARCH_SKILL_ID)) {
        continue;
      }

      // Apply global LobsterAI skill toggle policy.
      if (matchesAnyIdentifier(disabledIds, identifiers)) {
        for (const id of identifiers) blockedByManagedPolicy.add(id);
        continue;
      }
      if (enabledIds !== null && !matchesAnyIdentifier(enabledIds, identifiers)) {
        for (const id of identifiers) blockedByManagedPolicy.add(id);
        continue;
      }

      // Apply per-agent / per-turn skill allowlist when the session restricts skills.
      if (allowedSkillIds !== null && !matchesAnyIdentifier(allowedSkillIds, identifiers)) {
        continue;
      }

      if (seen.has(skillName)) continue;
      pushCandidate(skillName, meta, skillDir, skillFile);
    }
  }

  // 2. Project-local `.dsh/skills` and `.agents/skills` filtered by LobsterAI policy.
  for (const projectSkillRoot of resolveProjectSkillRoots(options.cwd)) {
    const normRoot = resolve(projectSkillRoot);
    if (scannedRoots.has(normRoot)) continue;
    scannedRoots.add(normRoot);

    for (const entry of scanSkillEntries(normRoot)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillDir = join(normRoot, entry.name);
      const skillFile = join(skillDir, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      const rawId = entry.name;
      const content = readTextCached(skillFile);
      if (!content) continue;
      const { meta } = parseSkillFrontmatter(content);
      const skillName = resolveDshSkillName(rawId, meta.name, { preferRawId: false });
      if (!validateName(skillName)) continue;

      const identifiers = collectSkillIdentifiers(rawId, skillName, meta.name);

      // Never allow project-local skills to resurrect a LobsterAI-disabled skill.
      if (
        matchesAnyIdentifier(disabledIds, identifiers)
        || matchesAnyIdentifier(blockedByManagedPolicy, identifiers)
      ) {
        continue;
      }
      if (allowedSkillIds !== null && !matchesAnyIdentifier(allowedSkillIds, identifiers)) {
        continue;
      }

      if (seen.has(skillName)) continue;
      pushCandidate(skillName, meta, skillDir, skillFile);
    }
  }

  return candidates;
}
