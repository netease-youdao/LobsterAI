/**
 * @lobsterai/dsh-bundle — Owner-Only Operations RPC Plugin
 *
 * Registers `POST /api/lobsterai/ops` via `ctx.connection.fetch.register(...)`,
 * automatically inheriting DSH's loopback/Origin fence, signed cookie auth,
 * and `peer.principal.kind === 'owner'` enforcement.
 *
 * Supported actions:
 * - `health`: runtime readiness & loaded LobsterAI plugin inventory
 * - `syncProviders`: hot-sync LobsterAI providers & API keys into memory
 * - `syncMcpServers`: reconcile LobsterAI MCP servers via `ctx.mcpManager.register`
 * - `syncSkillsPolicy`: update global enabled/disabled skill lists & refresh catalog
 * - `bindSessionContext`: bind `{ agentId, coworkSessionId, allowedSkillIds, customSystemPrompt, executionMode }`
 * - `syncHostTools`: hot-sync native host tool definitions
 * - `deleteSessionFiles`: cancel/stop live agent and delete persisted JSONL session dir
 */

import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { getHostState } from './shared-state.mjs';

export const name = 'lobster-ops-rpc';
export const inject = ['connection'];

const OPS_ROUTE_PATH = '/api/lobsterai/ops';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * Find and delete all directories matching an encoded DSH sessionId under
 * `<dshHome>/sessions/<project>/<encodedId>` so deleting a LobsterAI session
 * leaves zero orphaned JSONL history files behind.
 */
async function removeSessionDirectories(sessionId) {
  const sessionsRoot = dshHomePath('sessions');
  if (!existsSync(sessionsRoot)) return [];
  const encoded = encodeURIComponent(sessionId);
  const removed = [];
  let projectDirs;
  try {
    projectDirs = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const dirent of projectDirs) {
    if (!dirent.isDirectory()) continue;
    for (const candidateName of new Set([sessionId, encoded])) {
      const target = join(sessionsRoot, dirent.name, candidateName);
      if (existsSync(target)) {
        await rm(target, { recursive: true, force: true });
        removed.push(target);
      }
    }
  }
  return removed;
}

export function apply(ctx) {
  const state = getHostState(ctx);
  /** @type {Map<string, () => void>} */
  const managedMcpDisposers = new Map();

  async function syncMcpServers(payload) {
    const mcpManager = ctx.get('mcpManager');
    if (!mcpManager) {
      return { available: false, registered: [], errors: ['mcpManager service is not mounted'] };
    }
    const body = payload && typeof payload === 'object' ? payload : {};
    const servers = Array.isArray(body.servers) ? body.servers : [];

    // Dispose all previously LobsterAI-managed MCP registrations cleanly.
    for (const dispose of managedMcpDisposers.values()) {
      try {
        await dispose();
      } catch {
        // best-effort unmount
      }
    }
    managedMcpDisposers.clear();

    const registered = [];
    const errors = [];
    for (const entry of servers) {
      if (!entry || typeof entry !== 'object') continue;
      const serverName = String(entry.name || '').trim();
      if (!serverName || entry.enabled === false) continue;

      const transport = entry.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
      const config = transport === 'stdio'
        ? {
            transport: 'stdio',
            command: String(entry.command || ''),
            args: Array.isArray(entry.args) ? entry.args.map(String) : [],
            env: entry.env && typeof entry.env === 'object'
              ? Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, String(v)]))
              : {},
            cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
            ...(typeof entry.startupTimeoutMs === 'number' ? { startupTimeoutMs: entry.startupTimeoutMs } : {}),
            ...(typeof entry.toolCallTimeoutMs === 'number' ? { toolCallTimeoutMs: entry.toolCallTimeoutMs } : {}),
          }
        : {
            transport: 'streamable-http',
            url: String(entry.url || ''),
            headers: entry.headers && typeof entry.headers === 'object'
              ? Object.fromEntries(Object.entries(entry.headers).map(([k, v]) => [k, String(v)]))
              : {},
            ...(typeof entry.startupTimeoutMs === 'number' ? { startupTimeoutMs: entry.startupTimeoutMs } : {}),
            ...(typeof entry.toolCallTimeoutMs === 'number' ? { toolCallTimeoutMs: entry.toolCallTimeoutMs } : {}),
          };

      try {
        const disposer = mcpManager.register(serverName, config);
        managedMcpDisposers.set(serverName, disposer);
        registered.push(serverName);
      } catch (error) {
        errors.push(`${serverName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      available: true,
      registered,
      errors,
      statuses: mcpManager.list(),
    };
  }

  state.syncMcpServers = syncMcpServers;

  const VALID_PERMISSION_PRESETS = new Set([
    'read-only',
    'workspace-write',
    'danger-full-access',
  ]);

  function applyPermissionPresetToAgent(agent, preset) {
    if (!agent || !agent.session || !VALID_PERMISSION_PRESETS.has(preset)) return false;
    // dsh applies the delegation's sandbox on top of its parent's permissions.
    if (agent.session.header?.origin === 'subagent') return false;
    const permissionPresets = ctx.get('permissionPresets');
    if (!permissionPresets || typeof permissionPresets.set !== 'function') return false;
    try {
      const current = typeof permissionPresets.current === 'function'
        ? permissionPresets.current(agent.session)
        : undefined;
      if (current === preset) return true;
      permissionPresets.set(agent.session, preset);
      const approval = ctx.get('approval');
      if (approval && typeof approval.setPolicy === 'function' && typeof permissionPresets.resolve === 'function') {
        const spec = permissionPresets.resolve(preset);
        if (spec?.approval) {
          approval.setPolicy(agent, spec.approval);
        }
      }
      return true;
    } catch (error) {
      ctx.logger.warn(
        `[LobsterAI:OpsRpc] failed to apply permission preset "${preset}" to session "${agent.id}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  // Ensure every newly attached/created session inherits LobsterAI's active permission preset.
  ctx.on('agent/created', ({ agent }) => {
    if (!agent?.session) return;
    const sid = agent.id || agent.session.id;
    const bound = sid ? state.sessionContexts.get(sid) : undefined;
    const targetPreset = typeof bound?.permissionPreset === 'string' && VALID_PERMISSION_PRESETS.has(bound.permissionPreset)
      ? bound.permissionPreset
      : state.defaultPermissionPreset;
    if (targetPreset && VALID_PERMISSION_PRESETS.has(targetPreset)) {
      applyPermissionPresetToAgent(agent, targetPreset);
    }
  });

  ctx.connection.fetch.register({
    path: OPS_ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ ok: false, error: 'Request body must be valid JSON' }, 400);
      }
      const action = body && typeof body === 'object' ? body.action : undefined;
      const payload = body && typeof body === 'object' ? body.payload : undefined;

      try {
        switch (action) {
          case 'health': {
            const llm = ctx.get('llm');
            const mcpManager = ctx.get('mcpManager');
            return jsonResponse({
              ok: true,
              bootedAt: state.bootedAt,
              pluginsReady: { ...state.pluginsReady },
              providers: llm ? llm.listProviders() : [],
              mcpServers: mcpManager ? mcpManager.list() : [],
              boundSessionsCount: state.sessionContexts.size,
              workspacesDirConfigured: state.workspacesDir.length > 0,
              skillsDirConfigured: state.skillsDir.length > 0,
              bridgeConfigured: state.bridgeUrl.length > 0,
            });
          }

          case 'syncProviders': {
            if (!state.syncProviders) {
              return jsonResponse({ ok: false, error: 'lobster-model-bridge is not active' }, 503);
            }
            const result = await state.syncProviders(payload);
            return jsonResponse({ ok: true, result });
          }

          case 'syncMcpServers': {
            const result = await syncMcpServers(payload);
            return jsonResponse({ ok: true, result });
          }

          case 'syncSkillsPolicy': {
            const p = payload && typeof payload === 'object' ? payload : {};
            state.skillsPolicy.enabledIds = Array.isArray(p.enabledIds)
              ? new Set(p.enabledIds.filter((s) => typeof s === 'string'))
              : null;
            state.skillsPolicy.disabledIds = Array.isArray(p.disabledIds)
              ? new Set(p.disabledIds.filter((s) => typeof s === 'string'))
              : new Set();
            state.skillsPolicy.extraDirs = Array.isArray(p.extraDirs)
              ? p.extraDirs.filter((s) => typeof s === 'string' && s.length > 0)
              : [];
            if (typeof p.skillsDir === 'string' && p.skillsDir.length > 0) {
              state.skillsDir = p.skillsDir;
            }
            state.invalidateSkills?.();
            return jsonResponse({
              ok: true,
              result: {
                skillsDir: state.skillsDir,
                enabledCount: state.skillsPolicy.enabledIds ? state.skillsPolicy.enabledIds.size : null,
                disabledCount: state.skillsPolicy.disabledIds.size,
              },
            });
          }

          case 'bindSessionContext': {
            const p = payload && typeof payload === 'object' ? payload : {};
            const sessionId = typeof p.sessionId === 'string' ? p.sessionId.trim() : '';
            if (!sessionId) {
              return jsonResponse({ ok: false, error: 'sessionId is required' }, 400);
            }
            if (p.unbind === true) {
              state.sessionContexts.delete(sessionId);
              return jsonResponse({ ok: true, result: { unbound: sessionId } });
            }
            const prev = state.sessionContexts.get(sessionId) ?? {};
            const nextPreset = typeof p.permissionPreset === 'string' && VALID_PERMISSION_PRESETS.has(p.permissionPreset)
              ? p.permissionPreset
              : undefined;
            const mergedUnlocked = new Set([
              ...(Array.isArray(prev.unlockedCapabilities) ? prev.unlockedCapabilities : []),
              ...(Array.isArray(p.unlockedCapabilities)
                ? p.unlockedCapabilities.filter((c) => typeof c === 'string' && c.trim().length > 0)
                : []),
            ]);
            state.sessionContexts.set(sessionId, {
              ...prev,
              ...(typeof p.agentId === 'string' ? { agentId: p.agentId } : {}),
              ...(typeof p.coworkSessionId === 'string' ? { coworkSessionId: p.coworkSessionId } : {}),
              ...(typeof p.traceId === 'string' && p.traceId.length > 0 ? { traceId: p.traceId } : {}),
              ...(typeof p.workspaceDir === 'string' ? { workspaceDir: p.workspaceDir } : {}),
              ...(Array.isArray(p.allowedSkillIds) || p.allowedSkillIds === null
                ? { allowedSkillIds: p.allowedSkillIds }
                : {}),
              ...(typeof p.customSystemPrompt === 'string'
                ? { customSystemPrompt: p.customSystemPrompt }
                : {}),
              ...(typeof p.executionMode === 'string' ? { executionMode: p.executionMode } : {}),
              ...(nextPreset ? { permissionPreset: nextPreset } : {}),
              ...(mergedUnlocked.size > 0 ? { unlockedCapabilities: [...mergedUnlocked] } : {}),
            });
            state.reconcileToolDisclosure?.(sessionId);
            const effectivePreset = nextPreset ?? prev.permissionPreset ?? state.defaultPermissionPreset;
            const liveAgent = ctx.get('agents')?.get(sessionId);
            if (liveAgent && effectivePreset) {
              applyPermissionPresetToAgent(liveAgent, effectivePreset);
            }
            return jsonResponse({ ok: true, result: { bound: sessionId, permissionPreset: effectivePreset } });
          }

          case 'setPermissionPreset': {
            const p = payload && typeof payload === 'object' ? payload : {};
            const preset = typeof p.preset === 'string' ? p.preset.trim() : '';
            if (!VALID_PERMISSION_PRESETS.has(preset)) {
              return jsonResponse({ ok: false, error: `Unsupported permission preset: "${preset}"` }, 400);
            }
            const sessionId = typeof p.sessionId === 'string' ? p.sessionId.trim() : '';
            const appliedSessions = [];
            if (sessionId) {
              const prev = state.sessionContexts.get(sessionId) ?? {};
              state.sessionContexts.set(sessionId, { ...prev, permissionPreset: preset });
              const liveAgent = ctx.get('agents')?.get(sessionId);
              if (liveAgent && applyPermissionPresetToAgent(liveAgent, preset)) {
                appliedSessions.push(sessionId);
              }
            } else {
              state.defaultPermissionPreset = preset;
              for (const [sid, ctxEntry] of state.sessionContexts.entries()) {
                state.sessionContexts.set(sid, { ...ctxEntry, permissionPreset: preset });
              }
              const agents = ctx.get('agents');
              if (agents && typeof agents.list === 'function') {
                for (const agent of agents.list()) {
                  if (applyPermissionPresetToAgent(agent, preset)) {
                    appliedSessions.push(agent.id);
                  }
                }
              }
            }
            return jsonResponse({
              ok: true,
              result: {
                preset,
                defaultPermissionPreset: state.defaultPermissionPreset,
                appliedSessions,
              },
            });
          }

          case 'syncHostTools': {
            if (!state.syncHostTools) {
              return jsonResponse({ ok: false, error: 'lobster-host-tools is not active' }, 503);
            }
            const result = await state.syncHostTools(payload);
            return jsonResponse({ ok: true, result });
          }

          case 'deleteSessionFiles': {
            const p = payload && typeof payload === 'object' ? payload : {};
            const sessionId = typeof p.sessionId === 'string' ? p.sessionId.trim() : '';
            if (!sessionId) {
              return jsonResponse({ ok: false, error: 'sessionId is required' }, 400);
            }
            state.sessionContexts.delete(sessionId);
            // Stop live agent if running before deleting files.
            const liveAgent = ctx.get('agents')?.get(sessionId);
            if (liveAgent && typeof liveAgent.cancel === 'function') {
              try {
                liveAgent.cancel({ kind: 'user' });
              } catch {
                // ignore if already idle
              }
            }
            const removedPaths = await removeSessionDirectories(sessionId);
            return jsonResponse({ ok: true, result: { sessionId, removedPaths } });
          }

          default:
            return jsonResponse({ ok: false, error: `Unknown ops action: ${String(action)}` }, 400);
        }
      } catch (error) {
        ctx.logger.warn(
          `[LobsterAI:OpsRpc] action "${String(action)}" failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return jsonResponse(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          500,
        );
      }
    },
  });

  ctx.effect(() => async () => {
    for (const dispose of managedMcpDisposers.values()) {
      try {
        await dispose();
      } catch {}
    }
    managedMcpDisposers.clear();
    state.syncMcpServers = null;
    state.pluginsReady.opsRpc = false;
  }, 'lobster-ops-rpc cleanup');

  state.pluginsReady.opsRpc = true;
}
