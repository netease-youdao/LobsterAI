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

import { isSkillName } from '@deepseek-ai/dsh-skill';
import {
  assembleWorkspacePersona,
  buildWebSearchRoutingGuidance,
  DEFAULT_AGENT_ID,
  discoverLobsterSkills,
  parseSkillFrontmatter,
  readTextCached,
} from './persona-helpers.mjs';
import { getHostState, resolveSessionContext, resolveSessionId } from './shared-state.mjs';

export const name = 'lobster-persona-scope';
export const inject = ['systemPrompt', 'skills'];

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
      const allowedSkillIds = bound && Array.isArray(bound.allowedSkillIds)
        ? new Set(bound.allowedSkillIds.filter((s) => typeof s === 'string'))
        : null;
      const roots = [
        ...(state.skillsDir ? [state.skillsDir] : []),
        ...state.skillsPolicy.extraDirs,
      ];
      const webSearchGuidance = buildWebSearchRoutingGuidance(roots, state.skillsPolicy, allowedSkillIds);
      const install = 'For requests to install a local or attached skill into My Skills, use lobster_skill_install. Its inspect action reports this instance’s actual skill root and install performs desktop security review and registration.';
      return [persona, webSearchGuidance, install].filter(Boolean).join('\n\n');
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
        return discoverLobsterSkills(roots, state.skillsPolicy, allowedSkillIds, {
          cwd: options?.cwd,
          isSkillName,
        });
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
