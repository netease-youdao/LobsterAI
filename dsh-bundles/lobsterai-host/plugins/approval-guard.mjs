/**
 * @lobsterai/dsh-bundle — Tool Pre-Execution Approval Guard Plugin
 *
 * Hooks `tools/pre-execute` where the full tool name AND raw parsed arguments
 * are visible (bridging `dsh-user-approval`'s intentionally narrow ask payload).
 * Delegates policy evaluation to Electron main (`commandSafety.ts` + SQLite
 * `allow-always` rules + per-session executionMode).
 *
 * Decisions supported from Electron main:
 * - `allow`: bypass interactive prompt (e.g. persisted allow-always rule or auto mode)
 * - `deny`: hard safety block with structured reason
 * - `ask`: escalate to DSH's `approval/request` interactive waterfall
 * - `passthrough` (or bridge absent): delegate to `next()`
 */

import { evaluateOfficeGuiGuard } from './office-gui-guard-helpers.mjs';
import { callLobsterBridge, getHostState, resolveSessionContext, resolveSessionId } from './shared-state.mjs';
import { evaluateWebAccessGuard } from './web-access-guard-helpers.mjs';

export const name = 'lobster-approval-guard';
export const inject = ['tools'];

export function apply(ctx) {
  const state = getHostState(ctx);

  // Monotonic synchronous guard that runs AFTER pre-execute/approval resolution
  // so desktop Office GUI launches (WPS / Keynote / Pages / MS Office / non-headless
  // soffice) are blocked reliably even under `danger-full-access` or subagents.
  const disposeOfficeGuiGuard = ctx.tools.guard((exec) => (
    evaluateOfficeGuiGuard(exec?.name, exec?.arguments)
  ));

  // Monotonic synchronous guard enforcing LobsterAI's browser/web access policy
  // (`webFetch.enabled`, `blockedHostnames`) and `DshSearchPolicy` on DSH's
  // `web_fetch` / `web_search` tools even under `danger-full-access` or subagents.
  const disposeWebAccessGuard = ctx.tools.guard((exec) => (
    evaluateWebAccessGuard(
      exec?.name,
      exec?.arguments,
      {
        webFetchEnabled: state.webAccessPolicy.webFetchEnabled,
        blockedHostnames: state.webAccessPolicy.blockedHostnames,
        searchPolicy: state.searchPolicy,
      },
      {
        llmProvider: exec?.agent?.session?.requestContext?.()?.provider,
      },
    )
  ));

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!state.bridgeUrl) {
      return next();
    }
    const sessionId = resolveSessionId(exec);
    const bound = resolveSessionContext(ctx, state, sessionId);

    const response = await callLobsterBridge(
      state,
      '/dsh-bridge/approval-evaluate',
      {
        toolName: exec.name,
        args: exec.arguments,
        callId: exec.callId,
        sessionId,
        agentId: bound?.agentId ?? 'main',
        coworkSessionId: bound?.coworkSessionId,
        executionMode: bound?.executionMode,
        permissionPreset: bound?.permissionPreset ?? state.defaultPermissionPreset,
      },
      exec.signal,
    );

    if (!response.available || !response.ok || !response.data || typeof response.data !== 'object') {
      return next();
    }

    const decision = /** @type {Record<string, unknown>} */ (response.data);
    switch (decision.kind) {
      case 'allow':
        if (exec.agent?.session?.header?.origin === 'subagent') return next();
        return { kind: 'allow' };
      case 'deny':
        return {
          kind: 'deny',
          reason: typeof decision.reason === 'string' && decision.reason.length > 0
            ? decision.reason
            : `Tool "${exec.name}" was blocked by LobsterAI safety policy.`,
        };
      case 'ask':
        return {
          kind: 'ask',
          reason: typeof decision.reason === 'string' && decision.reason.length > 0
            ? decision.reason
            : `LobsterAI approval required for tool "${exec.name}".`,
        };
      case 'cancel':
        return { kind: 'cancel' };
      default:
        return next();
    }
  });

  ctx.effect(() => () => {
    disposeOfficeGuiGuard();
    disposeWebAccessGuard();
    state.pluginsReady.approvalGuard = false;
  }, 'lobster-approval-guard cleanup');

  state.pluginsReady.approvalGuard = true;
}
