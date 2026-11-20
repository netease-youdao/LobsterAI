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
      searchPolicy: process.env[ENV_KEYS.searchPolicy] || 'deepseek_native_only',
      /** @type {Map<string, Record<string, unknown>>} */
      sessionContexts: new Map(),
      /** @type {{ enabledIds: Set<string> | null, disabledIds: Set<string>, extraDirs: string[] }} */
      skillsPolicy: {
        enabledIds: null,
        disabledIds: new Set(),
        extraDirs: [],
      },
      /** @type {Record<string, boolean>} */
      pluginsReady: {
        modelBridge: false,
        personaScope: false,
        hostTools: false,
        approvalGuard: false,
        opsRpc: false,
      },
      /** @type {((payload: unknown) => Promise<unknown>) | null} */
      syncProviders: null,
      /** @type {((payload: unknown) => Promise<unknown>) | null} */
      syncMcpServers: null,
      /** @type {((payload: unknown) => Promise<unknown>) | null} */
      syncHostTools: null,
      /** @type {(() => void) | null} */
      invalidateSkills: null,
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
    body = undefined;
  }
  if (!response.ok) {
    const message = (body && typeof body === 'object' && typeof body.error === 'string')
      ? body.error
      : `LobsterAI host bridge returned HTTP ${response.status}`;
    return { available: true, ok: false, status: response.status, error: message, data: body };
  }
  return { available: true, ok: true, status: response.status, data: body };
}
