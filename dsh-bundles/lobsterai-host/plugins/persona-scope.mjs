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
  AGENT_RULES_POLICY_PROMPT,
  assembleWorkspacePersona,
  buildWebSearchRoutingGuidance,
  DEFAULT_AGENT_ID,
  discoverLobsterSkills,
  isDefaultLobsterAgentPreset,
  MEMORY_WRITE_POLICY_PROMPT,
  parseSkillFrontmatter,
  readTextCached,
  resolveAssemblyAgentPresetId,
  SIDE_CHAT_RUNTIME_CONTEXT_PROMPT,
} from './persona-helpers.mjs';
import {
  getHostState,
  resolveSessionContext,
  resolveSessionId,
  resolveSessionWorkspaceDir,
} from './shared-state.mjs';

export const name = 'lobster-persona-scope';
export const inject = ['systemPrompt', 'skills'];

export function apply(ctx) {
  const state = getHostState(ctx);

  // A child's persona can replace deployment:persona-prefix. The host identity
  // must still precede that persona and the editable workspace documents.
  // Third-party agent presets (e.g. `pi` / `pi-plus`) own their own identity.
  ctx.systemPrompt.section({
    name: 'lobsterai:host-identity',
    order: -500,
    text: (assemblyCtx) => (
      isDefaultLobsterAgentPreset(resolveAssemblyAgentPresetId(ctx, assemblyCtx))
        ? 'You are LobsterAI, a desktop AI assistant running on the LobsterAI DSH host.'
        : ''
    ),
  });

  // 1. Register workspace persona & long-term memory system prompt section.
  ctx.systemPrompt.section({
    name: 'lobsterai:workspace-persona',
    order: 200,
    interpolate: false,
    text: (assemblyCtx) => {
      const sessionId = resolveSessionId(assemblyCtx?.scope)
        ?? resolveSessionId(assemblyCtx?.agent);
      const bound = resolveSessionContext(ctx, state, sessionId);
      const customSystemPrompt = bound && typeof bound.customSystemPrompt === 'string'
        ? bound.customSystemPrompt
        : '';
      if (!isDefaultLobsterAgentPreset(resolveAssemblyAgentPresetId(ctx, assemblyCtx))) {
        return customSystemPrompt.trim();
      }
      const agentId = bound && typeof bound.agentId === 'string'
        ? bound.agentId
        : DEFAULT_AGENT_ID;
      const workspaceDir = resolveSessionWorkspaceDir(
        ctx,
        state,
        sessionId,
        bound,
        assemblyCtx?.agent,
      );
      const memoryEnabled = typeof bound?.memoryEnabled === 'boolean'
        ? bound.memoryEnabled
        : state.memoryEnabled !== false;
      const persona = assembleWorkspacePersona(
        state.workspacesDir,
        agentId,
        customSystemPrompt,
        { workspaceDir, memoryEnabled },
      );
      const memoryPolicy = memoryEnabled ? MEMORY_WRITE_POLICY_PROMPT : '';
      const allowedSkillIds = bound && Array.isArray(bound.allowedSkillIds)
        ? new Set(bound.allowedSkillIds.filter((s) => typeof s === 'string'))
        : null;
      const roots = [
        ...(state.skillsDir ? [state.skillsDir] : []),
        ...state.skillsPolicy.extraDirs,
      ];
      const webSearchGuidance = buildWebSearchRoutingGuidance(roots, state.skillsPolicy, allowedSkillIds);
      const install = 'For requests to install a local or attached skill into My Skills, use lobster_skill_install. Its inspect action reports this instance’s actual skill root and install performs desktop security review and registration.';
      const officeGuidance = bound && typeof bound.officeAgentPrompt === 'string' && bound.officeAgentPrompt.trim().length > 0
        ? bound.officeAgentPrompt.trim()
        : 'When editing an existing `.docx`, `.xlsx`, or `.pptx` file, prefer LobsterAI\'s live in-place editor tools (`word_read`/`word_edit`, `excel_read`/`excel_edit`, `ppt_read`/`ppt_edit`; enable `word`/`excel`/`ppt` via `lobster_enable_tools` first if not yet visible) instead of rewriting the file with scripts.';
      return [persona, memoryPolicy, AGENT_RULES_POLICY_PROMPT, webSearchGuidance, install, officeGuidance].filter(Boolean).join('\n\n');
    },
  });

  // 1b. Inject per-turn media generation & skin workflow instructions as DSH
  // runtime context (`<system-reminder>`) rather than prepending raw prose into
  // the user's message, preventing models from confusing runtime policies with
  // user-stated memory preferences or polluting turn outlines.
  ctx.systemPrompt.context({
    name: 'lobsterai:media-turn',
    order: ctx.systemPrompt.getContextOrder('APPROVAL_POLICY') + 1,
    interpolate: false,
    required: true,
    text: (assemblyCtx) => {
      const sessionId = resolveSessionId(assemblyCtx?.scope)
        ?? resolveSessionId(assemblyCtx?.agent);
      const bound = resolveSessionContext(ctx, state, sessionId);
      const instruction = bound && typeof bound.mediaTurnInstruction === 'string'
        ? bound.mediaTurnInstruction.trim()
        : '';
      return instruction ? `## Media Generation Policy (Current Turn)\n${instruction}` : '';
    },
  });

  // 1c. Inject side-conversation soft-read-only guidance via KV-cache-safe
  // dynamic runtime context so the forked parent prefix stays byte-identical.
  ctx.systemPrompt.context({
    name: 'lobsterai:side-chat',
    order: ctx.systemPrompt.getContextOrder('APPROVAL_POLICY') + 2,
    interpolate: false,
    required: true,
    text: (assemblyCtx) => {
      const sessionId = resolveSessionId(assemblyCtx?.scope)
        ?? resolveSessionId(assemblyCtx?.agent);
      const bound = resolveSessionContext(ctx, state, sessionId);
      return bound?.sideChat === true ? SIDE_CHAT_RUNTIME_CONTEXT_PROMPT : '';
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
        const selectedSkillIds = bound && Array.isArray(bound.selectedSkillIds)
          ? new Set(bound.selectedSkillIds.filter((s) => typeof s === 'string'))
          : null;
        const roots = [
          ...(state.skillsDir ? [state.skillsDir] : []),
          ...state.skillsPolicy.extraDirs,
        ];
        return discoverLobsterSkills(roots, state.skillsPolicy, allowedSkillIds, {
          cwd: options?.cwd,
          isSkillName,
          selectedSkillIds,
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
            modelInvocable: candidate?.invocation?.modelInvocable !== false,
            userInvocable: candidate?.invocation?.userInvocable !== false,
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
