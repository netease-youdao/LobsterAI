/**
 * @lobsterai/dsh-bundle — Persona & Scoped Skills Plugin
 *
 * 1. Injects LobsterAI's engine-independent workspace persona & memory files
 *    (`<workspacesDir>/<agentId>/{SOUL,IDENTITY,USER,MEMORY,AGENTS}.md`) via
 *    `ctx.systemPrompt.section(..., { interpolate: false })`, preventing any
 *    literal `{{...}}` in user Markdown from failing prompt interpolation.
 * 2. Registers a `ctx.skills` provider exposing LobsterAI's `<skillsDir>`
 *    filtered by global `skills_state` policy and per-agent `allowedSkillIds`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isSkillName } from '@deepseek-ai/dsh-skill';
import { getHostState, resolveSessionId } from './shared-state.mjs';

export const name = 'lobster-persona-scope';
export const inject = ['systemPrompt', 'skills'];

const DEFAULT_AGENT_ID = 'main';
const LOBSTERAI_SKILL_RANK = 260;
const MAX_PERSONA_FILE_BYTES = 128 * 1024;
const MANAGED_BLOCK_RE = /<!--\s*LOBSTERAI_MANAGED_START\s*-->[\s\S]*?<!--\s*LOBSTERAI_MANAGED_END\s*-->\s*/g;

const PERSONA_FILES = Object.freeze([
  { file: 'SOUL.md', heading: 'Persona (SOUL.md)' },
  { file: 'IDENTITY.md', heading: 'Identity (IDENTITY.md)' },
  { file: 'USER.md', heading: 'User Profile (USER.md)' },
  { file: 'AGENTS.md', heading: 'Agent Instructions (AGENTS.md)', stripManaged: true },
  { file: 'MEMORY.md', heading: 'Long-Term Memory (MEMORY.md)' },
]);

/** Simple mtime-keyed file cache so synchronous prompt assembly stays fast. */
const fileCache = new Map();

function readTextCached(filePath) {
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
      ? `${raw.slice(0, MAX_PERSONA_FILE_BYTES)}\n...(truncated)`
      : raw;
    fileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, content });
    return content;
  } catch {
    return '';
  }
}

function sanitizeAgentId(agentId) {
  const raw = typeof agentId === 'string' ? agentId.trim() : '';
  if (!raw || !/^[a-zA-Z0-9_-]{1,64}$/.test(raw)) return DEFAULT_AGENT_ID;
  return raw;
}

function assembleWorkspacePersona(workspacesDir, agentId, customSystemPrompt) {
  const sections = [];
  if (workspacesDir) {
    const dir = resolve(workspacesDir, sanitizeAgentId(agentId));
    for (const item of PERSONA_FILES) {
      let text = readTextCached(join(dir, item.file));
      if (item.stripManaged && text) {
        text = text.replace(MANAGED_BLOCK_RE, '');
      }
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        sections.push(`## ${item.heading}\n\n${trimmed}`);
      }
    }
  }
  if (typeof customSystemPrompt === 'string' && customSystemPrompt.trim().length > 0) {
    sections.push(customSystemPrompt.trim());
  }
  return sections.join('\n\n');
}

/**
 * Parse YAML frontmatter header from a SKILL.md file (lightweight, zero-dep).
 */
function parseSkillFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: markdown };
  const [, yamlBlock, body] = match;
  const meta = {};
  for (const line of yamlBlock.split(/\r?\n/)) {
    const kv = line.match(/^\s*([a-zA-Z0-9_-]+)\s*:\s*(.*)\s*$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[kv[1]] = value;
  }
  return { meta, body };
}

function toKebabSkillName(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function discoverLobsterSkills(rootDirs, policy, allowedSkillIds) {
  const candidates = [];
  const seen = new Set();

  for (const rootDir of rootDirs) {
    if (!rootDir || !existsSync(rootDir)) continue;
    let entries;
    try {
      entries = readdirSync(rootDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillDir = join(rootDir, entry.name);
      const skillFile = join(skillDir, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      const rawId = entry.name;
      const content = readTextCached(skillFile);
      if (!content) continue;
      const { meta } = parseSkillFrontmatter(content);
      const skillName = toKebabSkillName(meta.name || rawId);
      if (!isSkillName(skillName) || seen.has(skillName)) continue;

      // Apply global LobsterAI skill toggle policy.
      if (policy.disabledIds.has(rawId) || policy.disabledIds.has(skillName)) continue;
      if (
        policy.enabledIds !== null
        && !policy.enabledIds.has(rawId)
        && !policy.enabledIds.has(skillName)
      ) {
        continue;
      }

      // Apply per-agent skill allowlist when the session restricts skills.
      if (
        allowedSkillIds !== null
        && !allowedSkillIds.has(rawId)
        && !allowedSkillIds.has(skillName)
      ) {
        continue;
      }

      seen.add(skillName);
      candidates.push({
        name: skillName,
        description: meta.description || `LobsterAI skill: ${skillName}`,
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
          description: meta.description || `LobsterAI skill: ${skillName}`,
        },
      });
    }
  }
  return candidates;
}

export function apply(ctx) {
  const state = getHostState(ctx);

  // 1. Register workspace persona & long-term memory system prompt section.
  ctx.systemPrompt.section({
    name: 'lobsterai:workspace-persona',
    order: 200,
    interpolate: false,
    text: (assemblyCtx) => {
      const sessionId = resolveSessionId(assemblyCtx?.scope)
        ?? resolveSessionId(assemblyCtx?.agent);
      const bound = sessionId ? state.sessionContexts.get(sessionId) : undefined;
      const agentId = bound && typeof bound.agentId === 'string'
        ? bound.agentId
        : DEFAULT_AGENT_ID;
      const customSystemPrompt = bound && typeof bound.customSystemPrompt === 'string'
        ? bound.customSystemPrompt
        : '';
      return assembleWorkspacePersona(state.workspacesDir, agentId, customSystemPrompt);
    },
  });

  // 2. Register LobsterAI scoped skills provider into DSH's skill registry.
  ctx.skills.registerProvider((control) => {
    state.invalidateSkills = () => control.invalidate();
    return {
      name: 'lobsterai-skills',
      async list(options) {
        const sessionId = resolveSessionId(options?.scope);
        const bound = sessionId ? state.sessionContexts.get(sessionId) : undefined;
        const allowedSkillIds = bound && Array.isArray(bound.allowedSkillIds)
          ? new Set(bound.allowedSkillIds.filter((s) => typeof s === 'string'))
          : null;
        const roots = [
          ...(state.skillsDir ? [state.skillsDir] : []),
          ...state.skillsPolicy.extraDirs,
        ];
        return discoverLobsterSkills(roots, state.skillsPolicy, allowedSkillIds);
      },
      async get(candidate) {
        const locator = candidate?.locator;
        if (!locator || typeof locator.filePath !== 'string') return undefined;
        const raw = readTextCached(locator.filePath);
        if (!raw) return undefined;
        const { body } = parseSkillFrontmatter(raw);
        return {
          name: locator.skillName,
          description: locator.description,
          provider: 'lobsterai-skills',
          content: body.trim(),
          invocation: {
            modelInvocable: true,
            userInvocable: true,
          },
          resourceBase: {
            kind: 'directory',
            path: locator.dirPath,
          },
        };
      },
    };
  });

  ctx.effect(() => () => {
    state.invalidateSkills = null;
    state.pluginsReady.personaScope = false;
  }, 'lobster-persona-scope cleanup');

  state.pluginsReady.personaScope = true;
}
