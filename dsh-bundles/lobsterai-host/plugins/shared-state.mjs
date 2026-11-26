/**
 * Shared in-process state & Electron main bridge client for @lobsterai/dsh-bundle.
 *
 * State is keyed by Cordis root context via a WeakMap so multiple independent
 * Cordis roots (e.g. parallel tests) stay completely isolated.
 */

const rootStates = new WeakMap();

export const ENV_KEYS = Object.freeze({
  bridgeUrl: 'LOBSTERAI_DSH_BRIDGE_URL',
  bridgeSecret: 'LOBSTERAI_DSH_BRIDGE_SECRET',
  proxyUrl: 'LOBSTERAI_DSH_PROXY_URL',
  workspacesDir: 'LOBSTERAI_WORKSPACES_DIR',
  skillsDir: 'LOBSTERAI_SKILLS_DIR',
  instanceId: 'LOBSTERAI_DSH_INSTANCE_ID',
  searchPolicy: 'LOBSTERAI_DSH_SEARCH_POLICY',
});

export function getHostState(ctx) {
  const root = ctx.root ?? ctx;
  let state = rootStates.get(root);
  if (!state) {
    state = {
      bootedAt: Date.now(),
      bridgeUrl: (process.env[ENV_KEYS.bridgeUrl] || '').replace(/\/+$/, ''),
      bridgeSecret: process.env[ENV_KEYS.bridgeSecret] || '',
      proxyUrl: (process.env[ENV_KEYS.proxyUrl] || '').replace(/\/+$/, ''),
      workspacesDir: process.env[ENV_KEYS.workspacesDir] || '',
      skillsDir: process.env[ENV_KEYS.skillsDir] || '',
      instanceId: process.env[ENV_KEYS.instanceId] || '',
      searchPolicy: process.env[ENV_KEYS.searchPolicy] || 'allow_all',
      defaultPermissionPreset: 'workspace-write',
      memoryEnabled: true,
      /** @type {Map<string, Record<string, unknown>>} */
      sessionContexts: new Map(),
      /** @type {Map<string, Record<string, unknown>>} */
      agents: new Map(),
      /** @type {string[]} */
      agentOrder: [],
      /**
       * Durable child DSH session -> delegated LobsterAI target agent mapping
       * (`{ targetAgentId, parentDshSessionId?, rootCoworkSessionId?, workspaceDir? }`).
       * Kept separate from `sessionContexts` so cold resumes and follow-ups
       * always pick up the parent's latest `traceId` while keeping target persona/skills.
       * @type {Map<string, { targetAgentId: string, parentDshSessionId?: string, rootCoworkSessionId?: string, workspaceDir?: string }>}
       */
      delegatedChildAgents: new Map(),
      /** @type {{ enabledIds: Set<string> | null, disabledIds: Set<string>, extraDirs: string[] }} */
      skillsPolicy: {
        enabledIds: null,
        disabledIds: new Set(),
        extraDirs: [],
      },
      /** @type {{ webFetchEnabled: boolean, browserSearchEnabled: boolean, blockedHostnames: string[], allowedHostnames: string[], deepseekSearchBaseUrl: string }} */
      webAccessPolicy: {
        webFetchEnabled: true,
        browserSearchEnabled: true,
        blockedHostnames: [],
        allowedHostnames: [],
        deepseekSearchBaseUrl: '',
      },
      /**
       * Active per-server user MCP tool filters keyed by normalized DSH server
       * name (`serverName -> { include?, exclude? }`).
       * @type {Map<string, Readonly<{ include?: readonly string[], exclude?: readonly string[] }>>}
       */
      mcpToolFilters: new Map(),
      /**
       * Normalized DSH server names currently registered via LobsterAI `syncMcpServers`.
       * @type {Set<string>}
       */
      mcpRegisteredServers: new Set(),
      /** @type {Record<string, boolean>} */
      pluginsReady: {
        modelBridge: false,
        webSearchBridge: false,
        personaScope: false,
        hostTools: false,
        approvalGuard: false,
        opsRpc: false,
        toolDisclosure: false,
        agentDelegation: false,
      },
      /** @type {((payload: unknown) => Promise<unknown>) | null} */
      syncProviders: null,
      /** @type {((providerId: unknown) => { apiKey: string, baseURL: string, api: string } | null) | null} */
      getProviderAuth: null,
      /** @type {(() => void) | null} */
      resetWebSearchCooldown: null,
      /** @type {((payload: unknown) => Promise<unknown>) | null} */
      syncMcpServers: null,
      /** @type {((payload: unknown) => Promise<unknown>) | null} */
      syncHostTools: null,
      /** @type {(() => void) | null} */
      invalidateSkills: null,
      /** @type {((sessionId?: string) => void) | null} */
      reconcileToolDisclosure: null,
    };
    rootStates.set(root, state);
  }
  return state;
}

/**
 * Resolve the DSH sessionId from a Cordis scope/agent/execution context.
 * @param {unknown} candidate
 * @returns {string | undefined}
 */
export function resolveSessionId(candidate) {
  if (!candidate || typeof candidate !== 'object') return undefined;
  const obj = /** @type {Record<string, unknown>} */ (candidate);
  if (typeof obj.sessionId === 'string' && obj.sessionId.length > 0) return obj.sessionId;
  if (obj.session && typeof obj.session === 'object') {
    const sess = /** @type {Record<string, unknown>} */ (obj.session);
    if (typeof sess.id === 'string' && sess.id.length > 0) return sess.id;
  }
  if (obj.agent && typeof obj.agent === 'object') {
    return resolveSessionId(obj.agent);
  }
  if (typeof obj.id === 'string' && obj.id.length > 0) return obj.id;
  return undefined;
}

function resolveParentSessionId(ctx, state, sessionId) {
  const header = ctx?.get?.('agents')?.get?.(sessionId)?.session?.header;
  if (header?.origin === 'subagent' && typeof header.parentSession === 'string' && header.parentSession.length > 0) {
    return header.parentSession;
  }
  const binding = state.delegatedChildAgents?.get?.(sessionId);
  if (binding && typeof binding.parentDshSessionId === 'string' && binding.parentDshSessionId.length > 0) {
    return binding.parentDshSessionId;
  }
  return undefined;
}

function findAncestorBoundContext(ctx, state, sessionId) {
  const visited = new Set([sessionId]);
  let nextId = resolveParentSessionId(ctx, state, sessionId);
  while (nextId && !visited.has(nextId)) {
    visited.add(nextId);
    const bound = state.sessionContexts.get(nextId);
    if (bound) return bound;
    nextId = resolveParentSessionId(ctx, state, nextId);
  }
  return undefined;
}

/**
 * Resolve LobsterAI session context for a root session, a cross-agent delegated
 * subagent (live or cold-resumed), or an ordinary same-agent native subagent.
 * An ordinary fork has its own Cowork context (`origin !== 'subagent'`).
 */
export function resolveSessionContext(ctx, state, sessionId) {
  const visited = new Set();
  let currentId = sessionId;
  while (currentId && !visited.has(currentId)) {
    const bound = state.sessionContexts.get(currentId);
    if (bound) return bound;
    visited.add(currentId);

    const binding = state.delegatedChildAgents?.get?.(currentId);
    if (binding && typeof binding.targetAgentId === 'string' && binding.targetAgentId.length > 0) {
      const ancestor = findAncestorBoundContext(ctx, state, currentId);
      const spec = state.agents?.get?.(binding.targetAgentId);
      const coworkSessionId = ancestor?.coworkSessionId ?? binding.rootCoworkSessionId;
      const workspaceDir = binding.workspaceDir
        || (typeof spec?.workingDirectory === 'string' && spec.workingDirectory.length > 0 ? spec.workingDirectory : undefined)
        || ancestor?.workspaceDir;
      return {
        agentId: binding.targetAgentId,
        ...(binding.remoteRequestId ? {
          remoteRequestId: binding.remoteRequestId,
          remoteAllowedAgentIds: ancestor?.remoteRequestId === binding.remoteRequestId
            && Array.isArray(ancestor?.remoteAllowedAgentIds) ? ancestor.remoteAllowedAgentIds : [],
        } : Array.isArray(ancestor?.remoteAllowedAgentIds)
          ? { remoteRequestId: ancestor.remoteRequestId, remoteAllowedAgentIds: ancestor.remoteAllowedAgentIds } : {}),
        ...(coworkSessionId ? { coworkSessionId } : {}),
        ...(ancestor?.traceId ? { traceId: ancestor.traceId } : {}),
        ...(workspaceDir ? { workspaceDir } : {}),
        allowedSkillIds: spec && Array.isArray(spec.allowedSkillIds) ? spec.allowedSkillIds : null,
        ...(typeof spec?.systemPrompt === 'string' && spec.systemPrompt.length > 0
          ? { customSystemPrompt: spec.systemPrompt }
          : {}),
        ...(typeof ancestor?.officeAgentPrompt === 'string' && ancestor.officeAgentPrompt.length > 0
          ? { officeAgentPrompt: ancestor.officeAgentPrompt }
          : {}),
        ...(ancestor?.executionMode ? { executionMode: ancestor.executionMode } : {}),
        ...(ancestor?.userQuestionsDisabled ? { userQuestionsDisabled: true } : {}),
        ...(ancestor?.permissionPreset ? { permissionPreset: ancestor.permissionPreset } : {}),
        ...(typeof ancestor?.memoryEnabled === 'boolean' ? { memoryEnabled: ancestor.memoryEnabled } : {}),
      };
    }

    const header = ctx?.get?.('agents')?.get?.(currentId)?.session?.header;
    if (header?.origin !== 'subagent') return undefined;
    currentId = header.parentSession;
  }
  return undefined;
}

/**
 * Resolve the active project working directory (`workspaceDir`) for a session,
 * preferring the bound LobsterAI session context and falling back to DSH's own
 * session header `cwd`.
 */
export function resolveSessionWorkspaceDir(ctx, state, sessionId, bound, agent) {
  const resolvedBound = bound ?? resolveSessionContext(ctx, state, sessionId);
  if (typeof resolvedBound?.workspaceDir === 'string' && resolvedBound.workspaceDir.trim().length > 0) {
    return resolvedBound.workspaceDir.trim();
  }
  const agentCwd = agent?.session?.header?.cwd;
  if (typeof agentCwd === 'string' && agentCwd.trim().length > 0) {
    return agentCwd.trim();
  }
  const liveCwd = sessionId ? ctx?.get?.('agents')?.get?.(sessionId)?.session?.header?.cwd : undefined;
  if (typeof liveCwd === 'string' && liveCwd.trim().length > 0) {
    return liveCwd.trim();
  }
  return undefined;
}

/**
 * Call Electron main's authenticated local callback bridge.
 * Returns `{ available: false }` when running standalone (e.g. upgrade-check or CLI).
 *
 * @param {ReturnType<typeof getHostState>} state
 * @param {string} pathname
 * @param {unknown} payload
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{ available: boolean, ok: boolean, status?: number, data?: unknown, error?: string }>}
 */
export async function callLobsterBridge(state, pathname, payload, signal) {
  if (!state.bridgeUrl) {
    return { available: false, ok: false, error: 'LobsterAI host bridge URL is not configured' };
  }
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const url = `${state.bridgeUrl}${normalizedPath}`;
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json',
  };
  if (state.bridgeSecret) {
    headers['authorization'] = `Bearer ${state.bridgeSecret}`;
  }
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload ?? {}),
    signal,
  });
  let body;
  try {
    body = await response.json();
  } catch {
    return { available: true, ok: false, status: response.status, error: 'Incomplete LobsterAI bridge response' };
  }
  if (typeof body?.bridgeError === 'string') {
    return { available: true, ok: false, status: response.status, error: body.bridgeError };
  }
  if (!response.ok) {
    const message = (body && typeof body === 'object' && typeof body.error === 'string')
      ? body.error
      : `LobsterAI host bridge returned HTTP ${response.status}`;
    return { available: true, ok: false, status: response.status, error: message, data: body };
  }
  return { available: true, ok: true, status: response.status, data: body };
}
