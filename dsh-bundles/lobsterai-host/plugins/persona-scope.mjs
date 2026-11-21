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

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isSkillName } from '@deepseek-ai/dsh-skill';
import {
  assembleWorkspacePersona,
  DEFAULT_AGENT_ID,
  parseSkillFrontmatter,
  readTextCached,
} from './persona-helpers.mjs';
import { getHostState, resolveSessionContext, resolveSessionId } from './shared-state.mjs';

export const name = 'lobster-persona-scope';
export const inject = ['systemPrompt', 'skills'];

const LOBSTERAI_SKILL_RANK = 260;

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
      const bound = resolveSessionContext(ctx, state, sessionId);
      const agentId = bound && typeof bound.agentId === 'string'
        ? bound.agentId
        : DEFAULT_AGENT_ID;
      const customSystemPrompt = bound && typeof bound.customSystemPrompt === 'string'
        ? bound.customSystemPrompt
        : '';
      const persona = assembleWorkspacePersona(state.workspacesDir, agentId, customSystemPrompt);
      const install = 'For requests to install a local or attached skill into My Skills, use lobster_skill_install. Its inspect action reports this instance’s actual skill root and install performs desktop security review and registration.';
      const officeGuidance = bound && typeof bound.officeAgentPrompt === 'string' && bound.officeAgentPrompt.trim().length > 0
        ? bound.officeAgentPrompt.trim()
        : 'When editing an existing `.docx`, `.xlsx`, or `.pptx` file, prefer LobsterAI\'s live in-place editor tools (`word_read`/`word_edit`, `excel_read`/`excel_edit`, `ppt_read`/`ppt_edit`; enable `word`/`excel`/`ppt` via `lobster_enable_tools` first if not yet visible) instead of rewriting the file with scripts.';
      return [persona, install, officeGuidance].filter(Boolean).join('\n\n');
    },
  });

  // 2. Register LobsterAI scoped skills provider into DSH's skill registry.
  ctx.skills.registerProvider((control) => {
    state.invalidateSkills = () => control.invalidate();
    return {
      name: 'lobsterai-skills',
      async list(options) {
        const sessionId = resolveSessionId(options?.scope);
        const bound = resolveSessionContext(ctx, state, sessionId);
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
          source: locator.filePath,
          path: locator.filePath,
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
