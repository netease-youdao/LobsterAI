// Pure translators converting LobsterAI's SQLite provider & MCP server
// configuration into the live in-memory payloads consumed by
// `@lobsterai/dsh-bundle` (`syncProviders` and `syncMcpServers`).
//
// Zero Electron imports — directly testable under Vitest.

import { OpenClawApi } from '../../../shared/providers/constants';
import type { McpOAuthManager } from '../../mcp/mcpOAuthManager';
import type {
  DshHostMcpServerSpec,
  DshHostProviderModelSpec,
  DshHostProviderSpec,
} from './dshHostManager';

export interface LobsterProviderModelConfig {
  id: string;
  name?: string;
  supportsImage?: boolean;
  supportsThinking?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

export interface LobsterProviderConfig {
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  apiFormat?: 'anthropic' | 'openai' | 'openai-responses' | 'gemini' | 'google' | string;
  headers?: Record<string, string>;
  models?: LobsterProviderModelConfig[];
  authType?: 'api_key' | 'oauth' | 'lobster_plan' | string;
}

export interface BuildDshProvidersOptions {
  providers: Record<string, LobsterProviderConfig>;
  /** Local unified model auth proxy origin (serves LobsterAI Plan, Copilot, Codex OAuth, xAI OAuth). */
  modelAuthProxyUrl?: string | null;
  /** Optional bearer secret for local modelAuthProxy calls. */
  modelAuthProxySecret?: string | null;
  /** Virtual model alias mapping (e.g. `yd-fast` -> `{ provider, model }`). */
  virtualAliases?: Record<string, { provider: string; model: string }>;
}

const PROXY_BACKED_PROVIDERS = new Set([
  'lobster',
  'lobsterai',
  'youdao',
  'github-copilot',
  'openai-codex',
  'xai-oauth',
]);

function mapApiFormat(
  providerId: string,
  apiFormat: string | undefined,
): DshHostProviderSpec['api'] {
  const fmt = (apiFormat ?? '').trim().toLowerCase();
  if (fmt === 'anthropic' || fmt === 'anthropic-messages') return 'anthropic-messages';
  if (fmt === 'openai-responses' || fmt === 'responses') return 'openai-responses';
  if (fmt === 'gemini' || fmt === 'google' || fmt === 'google-generative-ai') {
    return 'google-generative-ai';
  }
  if (providerId === 'anthropic') return 'anthropic-messages';
  if (providerId === 'google' || providerId === 'gemini') return 'google-generative-ai';
  return 'openai-completions';
}

function isNativeOpenAIEndpoint(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
}

function defaultBaseUrlForProvider(providerId: string): string | undefined {
  switch (providerId) {
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'anthropic':
      return 'https://api.anthropic.com';
    case 'deepseek':
      return 'https://api.deepseek.com/v1';
    case 'google':
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1beta';
    case 'moonshot':
    case 'kimi':
      return 'https://api.moonshot.cn/v1';
    case 'qwen':
    case 'dashscope':
      return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    case 'openrouter':
      return 'https://openrouter.ai/api/v1';
    default:
      return undefined;
  }
}

/**
 * Convert LobsterAI `AppConfig.providers` into `DshHostProviderSpec[]` for
 * in-memory registration via `POST /api/lobsterai/ops` (`syncProviders`).
 *
 * Notice:
 * - Never writes API keys to disk.
 * - Routes OAuth & LobsterAI Plan providers through the local `modelAuthProxyUrl`
 *   so DSH `pi-ai` speaks standard OpenAI/Anthropic wire protocols while main
 *   handles token refresh, quota alerts, and enterprise headers.
 * - Avoids route ID collision with DSH's built-in `deepseek-official` adapter
 *   by mapping LobsterAI's provider IDs cleanly.
 */
export function buildDshProvidersPayload(options: BuildDshProvidersOptions): {
  providers: DshHostProviderSpec[];
  virtualAliases: Record<string, { provider: string; model: string }>;
} {
  const specs: DshHostProviderSpec[] = [];
  const proxyUrl = options.modelAuthProxyUrl?.replace(/\/+$/, '') || '';

  for (const [rawId, cfg] of Object.entries(options.providers ?? {})) {
    if (!cfg || cfg.enabled === false) continue;
    const providerId = rawId.trim();
    if (!providerId) continue;

    // Avoid clashing with DSH's reserved built-in deepseek-official route.
    const routeId = providerId === 'deepseek-official' ? 'lobster-deepseek' : providerId;

    const usesProxy = Boolean(
      proxyUrl
      && (PROXY_BACKED_PROVIDERS.has(providerId)
        || cfg.authType === 'oauth'
        || cfg.authType === 'lobster_plan'),
    );

    const baseURL = usesProxy
      ? `${proxyUrl}/v1/${encodeURIComponent(providerId)}`
      : (cfg.baseUrl?.trim().replace(/\/+$/, '') || defaultBaseUrlForProvider(providerId));

    if (!baseURL) continue;

    const apiKey = usesProxy
      ? (options.modelAuthProxySecret || 'lobsterai-local-proxy')
      : (cfg.apiKey?.trim() || undefined);

    // Skip non-local remote providers that have neither an API key nor a proxy.
    const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(baseURL);
    if (!apiKey && !isLoopback) continue;

    const api = mapApiFormat(providerId, cfg.apiFormat);
    const models: DshHostProviderModelSpec[] = (cfg.models ?? [])
      .filter((m) => m && typeof m.id === 'string' && m.id.trim().length > 0)
      .map((m) => ({
        id: m.id.trim(),
        name: m.name?.trim() || m.id.trim(),
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        input: m.supportsImage ? ['text', 'image'] : ['text'],
        reasoning: Boolean(m.reasoning ?? m.supportsThinking),
      }));

    if (models.length === 0) continue;

    const compat: Record<string, unknown> = {};
    if (api === OpenClawApi.OpenAICompletions) {
      if (!isNativeOpenAIEndpoint(baseURL)) {
        // pi-ai auto-enables supportsDeveloperRole and supportsStore for any
        // openai-completions URL outside its small built-in non-standard list.
        // Reasoning models then send system prompts with `role: "developer"`,
        // which OpenAI-compatible gateways (including lobsterai-server / Qwen /
        // custom proxies) reject.
        compat.supportsDeveloperRole = false;
        compat.supportsStore = false;
      }
      // Kimi / Moonshot thinking compatibility in OpenAI-compat mode.
      if (providerId === 'moonshot' || providerId === 'kimi' || providerId === 'kimi-coding') {
        compat.requiresReasoningContentOnAssistantMessages = true;
      }
    }

    specs.push({
      id: routeId,
      displayName: routeId,
      api,
      baseURL,
      ...(apiKey ? { apiKey } : {}),
      ...(cfg.headers && Object.keys(cfg.headers).length > 0 ? { headers: cfg.headers } : {}),
      ...(Object.keys(compat).length > 0 ? { compat } : {}),
      models,
    });
  }

  return {
    providers: specs,
    virtualAliases: { ...(options.virtualAliases ?? {}) },
  };
}

export interface LobsterMcpServerRecord {
  id: string;
  name: string;
  enabled: boolean;
  transportType: 'stdio' | 'sse' | 'http' | 'streamable-http' | string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  oauthEnabled?: boolean;
}

/**
 * Sanitize an arbitrary LobsterAI MCP server name into DSH's strict
 * `SERVER_NAME_PATTERN` (`^[a-z0-9][a-z0-9_-]*$`).
 */
export function normalizeDshMcpServerName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '');
  return cleaned || 'mcp-server';
}

/**
 * Convert LobsterAI SQLite `mcp_servers` records into `DshHostMcpServerSpec[]`
 * with OAuth bearer headers dynamically resolved through `McpOAuthManager`.
 */
export async function buildDshMcpServerSpecs(
  records: LobsterMcpServerRecord[],
  oauthManager?: Pick<McpOAuthManager, 'resolveAuthorizationHeaders'>,
): Promise<{
  servers: DshHostMcpServerSpec[];
  needsReauthIds: string[];
}> {
  const servers: DshHostMcpServerSpec[] = [];
  const needsReauthIds: string[] = [];
  const usedNames = new Set<string>();

  for (const rec of records) {
    if (!rec.enabled) continue;
    let name = normalizeDshMcpServerName(rec.name || rec.id);
    if (usedNames.has(name)) {
      name = `${name}-${rec.id.slice(0, 6).toLowerCase().replace(/[^a-z0-9]/g, '') || '2'}`;
    }
    usedNames.add(name);

    if (rec.transportType === 'stdio') {
      if (!rec.command) continue;
      servers.push({
        name,
        enabled: true,
        transport: 'stdio',
        command: rec.command,
        args: rec.args ?? [],
        env: rec.env ?? {},
        ...(rec.cwd ? { cwd: rec.cwd } : {}),
      });
      continue;
    }

    if (!rec.url) continue;
    const headers: Record<string, string> = { ...(rec.headers ?? {}) };
    if (rec.oauthEnabled && oauthManager) {
      try {
        const authHeaders = await oauthManager.resolveAuthorizationHeaders(rec.id);
        if (authHeaders) {
          Object.assign(headers, authHeaders);
        } else {
          needsReauthIds.push(rec.id);
          continue;
        }
      } catch {
        needsReauthIds.push(rec.id);
        continue;
      }
    }

    servers.push({
      name,
      enabled: true,
      transport: 'streamable-http',
      url: rec.url,
      headers,
    });
  }

  return { servers, needsReauthIds };
}
