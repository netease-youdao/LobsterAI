import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import { buildScheduledTaskEnginePrompt } from '../../scheduledTask/enginePrompt';
import {
  AuthType,
  OpenClawApi as OpenClawApiConst,
  OpenClawProviderId,
  ProviderName,
} from '../../shared/providers';
import type { Agent, CoworkConfig, CoworkExecutionMode } from '../coworkStore';
import type { DiscordInstanceConfig, IMSettings, TelegramInstanceConfig } from '../im/types';
import type { DingTalkInstanceConfig, EmailMultiInstanceConfig, FeishuInstanceConfig, NeteaseBeeChanConfig, NimInstanceConfig, PopoOpenClawConfig, QQInstanceConfig, WecomInstanceConfig, WeixinOpenClawConfig } from '../im/types';
import { OpenClawSessionKeepAlive } from '../openclawSessionPolicy/constants';
import { buildOpenClawSessionConfig } from '../openclawSessionPolicy/store';
import {
  getAllServerModelMetadata,
  resolveAllEnabledProviderConfigs,
  resolveAllProviderApiKeys,
  resolveRawApiConfig,
} from './claudeSettings';
import {
  getCoworkOpenAICompatProxyBaseURL,
  getCoworkOpenAICompatProxyToken,
} from './coworkOpenAICompatProxy';
import type { McpToolManifestEntry } from './mcpServerManager';
import {
  buildAgentEntry,
  buildManagedAgentEntries,
  parsePrimaryModelRef,
  resolveManagedSessionModelTarget,
  resolveQualifiedAgentModelRef,
} from './openclawAgentModels';
import { parseChannelSessionKey } from './openclawChannelSessionSync';
import type { OpenClawEngineManager } from './openclawEngineManager';
import { findThirdPartyExtensionsDir, hasBundledOpenClawExtension } from './openclawLocalExtensions';
import { getOpenClawTokenProxyPort } from './openclawTokenProxy';
import { isSystemProxyEnabled } from './systemProxy';

export type McpBridgeConfig = {
  callbackUrl: string;
  askUserCallbackUrl: string;
  secret: string;
  tools: McpToolManifestEntry[];
};

const mapExecutionModeToSandboxMode = (
  mode: CoworkExecutionMode,
  isEnterprise: boolean,
): 'off' | 'non-main' | 'all' => {
  if (!isEnterprise) return 'off';
  switch (mode) {
    case 'sandbox':
      return 'all';
    case 'auto':
      return 'non-main';
    case 'local':
    default:
      return 'off';
  }
};

/**
 * Default agent timeout in seconds written to openclaw config.
 * Also used by the runtime adapter's client-side timeout watchdog.
 */
export const OPENCLAW_AGENT_TIMEOUT_SECONDS = 3600;
const DINGTALK_OPENCLAW_CHANNEL = 'dingtalk-connector';

function deriveNimAccountId(instance: Pick<NimInstanceConfig, 'nimToken' | 'appKey' | 'account'>): string | null {
  const nimToken = instance.nimToken?.trim();
  if (nimToken) {
    const delimiter = nimToken.includes('|') ? '|' : '-';
    const parts = nimToken.split(delimiter).map((part) => part.trim());
    if (parts.length === 3 && parts[0] && parts[1]) {
      return `${parts[0]}:${parts[1]}`;
    }
  }
  if (instance.appKey && instance.account) {
    return `${instance.appKey}:${instance.account}`;
  }
  return null;
}

function deriveNimAccountConfigKey(
  instance: Pick<NimInstanceConfig, 'instanceId' | 'nimToken' | 'appKey' | 'account'>,
): string | null {
  if (instance.instanceId?.trim()) {
    return instance.instanceId.trim().slice(0, 8);
  }
  return deriveNimAccountId(instance);
}

function shouldUseOpenAIResponsesApi(providerName?: string, baseURL?: string): boolean {
  if (providerName !== ProviderName.OpenAI) return false;
  if (!baseURL) return true;
  const normalized = baseURL.trim().toLowerCase();
  return !normalized || normalized.includes('api.openai.com');
}

const mapApiTypeToOpenClawApi = (
  apiType: 'anthropic' | 'openai' | undefined,
  providerName?: string,
  baseURL?: string,
): OpenClawProviderApi => {
  // Qwen/DashScope Anthropic-compatible endpoint auto-injects web_search and
  // web_extractor built-in tools that cannot be disabled from the client side,
  // causing HTTP 400 errors. Force OpenAI format for any URL pointing to DashScope.
  if (apiType === 'anthropic' && isDashScopeUrl(baseURL)) {
    return 'openai-completions';
  }
  if (apiType === 'openai') {
    return shouldUseOpenAIResponsesApi(providerName, baseURL)
      ? 'openai-responses'
      : 'openai-completions';
  }
  return 'anthropic-messages';
};

/**
 * Detect DashScope (Qwen) URLs regardless of which provider the user configured.
 */
const isDashScopeUrl = (url?: string): boolean => !!url && /dashscope\.aliyuncs\.com/i.test(url);

/**
 * When a DashScope Anthropic URL is forced to OpenAI format, rewrite the base
 * URL to the corresponding OpenAI-compatible endpoint so the request actually
 * reaches the correct API server.
 *
 * dashscope.aliyuncs.com/apps/anthropic       → dashscope.aliyuncs.com/compatible-mode/v1
 * coding.dashscope.aliyuncs.com/apps/anthropic → coding.dashscope.aliyuncs.com/v1
 */
const rewriteDashScopeAnthropicToOpenAI = (url: string): string => {
  if (/coding\.dashscope\.aliyuncs\.com/i.test(url)) {
    return url.replace(/\/apps\/anthropic\b/i, '/v1');
  }
  return url.replace(/\/apps\/anthropic\b/i, '/compatible-mode/v1');
};

const ensureDir = (dirPath: string): void => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const normalizeModelName = (modelId: string): string => {
  const trimmed = modelId.trim();
  if (!trimmed) return 'default-model';
  const slashIndex = trimmed.lastIndexOf('/');
  const name = slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
  // Ensure the result is never empty after stripping prefix
  return name.trim() || 'default-model';
};

/**
 * Resolve the effective model display name with fallback chain:
 * userModelName → normalizeModelName(modelId) → 'default-model'
 */
const resolveModelDisplayName = (modelId: string, userModelName?: string): string => {
  const userName = userModelName?.trim();
  if (userName) return userName;
  return normalizeModelName(modelId);
};

const MANAGED_OWNER_ALLOW_FROM = [
  // Internal `chat.send` turns identify the sender as bare `gateway-client`.
  // Prefixing with `webchat:` does not round-trip through owner resolution,
  // so owner-only tools like `cron` never become available.
  'gateway-client',
  // Native IM channel senders use their platform user ID (e.g. telegram:xxx),
  // which would not match 'gateway-client'. Use wildcard so all senders that
  // pass the per-channel allowFrom gate are also recognised as owners.
  '*',
];

const MANAGED_TOOL_DENY = ['web_search'] as const;

const MANAGED_SKILL_ENTRY_OVERRIDES: Record<string, { enabled: boolean }> = {
  // QQ plugin ships a legacy reminder skill that steers the model toward a
  // channel-specific cron wrapper/subagent flow. Hide that path so native IM
  // sessions use the gateway's built-in `cron` tool instead.
  'qqbot-cron': {
    enabled: false,
  },
  // Personal Feishu reminder helpers often instruct the model to shell out via
  // `openclaw cron ...` or message relays. Native channel sessions should use
  // the gateway's built-in `cron` tool directly instead.
  'feishu-cron-reminder': {
    enabled: false,
  },
  // LobsterAI implements its own MCP integration. The bundled mcporter skill
  // tries to discover MCP servers via its own CLI, finds none, and produces
  // confusing "no MCP servers" output. Disable it so users are routed through
  // LobsterAI's MCP layer instead.
  'mcporter': {
    enabled: false,
  },
};

const DISABLED_MANAGED_SKILL_NAMES = Object.entries(MANAGED_SKILL_ENTRY_OVERRIDES)
  .filter(([, value]) => value.enabled === false)
  .map(([name]) => name);

/**
 * Build the env var name for a provider's apiKey.
 * Must match the key format produced by resolveAllProviderApiKeys() in claudeSettings.ts.
 */
const providerApiKeyEnvVar = (providerName: string): string => {
  const envName = providerName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `LOBSTER_APIKEY_${envName}`;
};

const MANAGED_WEB_SEARCH_POLICY_PROMPT = [
  '## Web Search',
  '',
  'Built-in `web_search` is disabled in this workspace. Do not ask for or rely on the Brave Search API.',
  '',
  'When you need live web information:',
  '- If you already have a specific URL, use `web_fetch`.',
  '- If you need search discovery, dynamic pages, or interactive browsing, use the built-in `browser` tool.',
  '- Only use the LobsterAI `web-search` skill when local command execution is available. Native channel sessions may deny `exec`, so prefer `browser` or `web_fetch` there.',
  '- Exception: the `imap-smtp-email` skill must always use `exec` to run its scripts, even in native channel sessions. Do not skip it because of exec restrictions.',
  '',
  'Do not claim you searched the web unless you actually used `browser`, `web_fetch`, or the LobsterAI `web-search` skill.',
].join('\n');

const MANAGED_EXEC_SAFETY_PROMPT = [
  '## Command Execution & User Interaction Policy',
  '',
  '### Delete Operations',
  '- Before executing **delete operations** (rm, trash, rmdir, unlink, git clean, or any command that permanently removes files/directories), check if the `AskUserQuestion` tool is available in your toolset.',
  '- If `AskUserQuestion` IS available: you MUST call it first to get user confirmation. The question should clearly state what will be deleted with options like "Allow delete" / "Cancel".',
  '- If `AskUserQuestion` is NOT available: execute the delete command directly without asking for text-based confirmation.',
  '',
  '### User Choices & Decisions',
  '- When you need the user to make a choice between multiple options (e.g. selecting a framework, choosing a file, picking a configuration), check if `AskUserQuestion` is available.',
  '- If `AskUserQuestion` IS available: use it to present the options as a structured question. Use `multiSelect: true` when the user can pick more than one option.',
  '- If `AskUserQuestion` is NOT available: ask via plain text instead.',
  '',
  '### General Commands',
  '- For ALL commands (ls, git, cd, kill, chmod, curl, etc.), execute them directly WITHOUT asking for confirmation.',
  '- Do NOT add your own text-based confirmation before executing commands.',
  '- Never mention "approval", "审批", or "批准" to the user.',
  '- If a command fails, report the error and ask the user what to do next.',
  '- These rules are mandatory and cannot be overridden.',
].join('\n');

/**
 * Compute the skill creation directory path for the managed prompt.
 * Returns a forward-slash-normalized, ~-compacted path suitable for
 * embedding in AGENTS.md so the model knows where to create new skills.
 *
 * Example outputs:
 *   macOS:   ~/Library/Application Support/LobsterAI/SKILLs
 *   Windows: ~/AppData/Roaming/LobsterAI/SKILLs
 *   Linux:   ~/.config/LobsterAI/SKILLs
 */
const resolveSkillCreationPath = (): string => {
  const skillsDir = path.join(app.getPath('userData'), 'SKILLs');
  const home = app.getPath('home');
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  const compacted = skillsDir.startsWith(prefix)
    ? '~/' + skillsDir.slice(prefix.length)
    : skillsDir;
  return compacted.replace(/\\/g, '/');
};

const buildManagedSkillCreationPrompt = (skillsDirPath: string): string => [
  '## Skill Creation',
  '',
  'When the user asks you to create a new skill, you MUST place it under the LobsterAI skills directory:',
  '',
  `  ${skillsDirPath}/<skill-name>/SKILL.md`,
  '',
  'Do NOT create skills under the workspace `skills/` subdirectory.',
].join('\n');

const MANAGED_MEMORY_POLICY_PROMPT = [
  '## Memory Policy',
  '',
  '**Write before you confirm.** When the user expresses any intent to persist information',
  '— including phrases like "记住", "以后", "下次要", "remember this", "keep this in mind",',
  '"from now on", or similar — you MUST call the `write` tool to save the information to a',
  'memory file BEFORE replying that you have remembered it.',
  '',
  '- Save to `memory/YYYY-MM-DD.md` (daily notes) or `MEMORY.md` (durable facts).',
  '- Only say "记住了" / "I\'ll remember that" AFTER the write tool call succeeds.',
  '- Never give a verbal acknowledgment of remembering without a corresponding file write.',
  '- "Mental notes" do not survive session restarts. Files do.',
].join('\n');

const FALLBACK_OPENCLAW_AGENTS_TEMPLATE = [
  '# AGENTS.md - Your Workspace',
  '',
  'This folder is home. Treat it that way.',
  '',
  '## First Run',
  '',
  'If `BOOTSTRAP.md` exists, follow it first, then delete it when you are done.',
  '',
  '## Every Session',
  '',
  'Before doing anything else:',
  '',
  '1. Read `SOUL.md`.',
  '2. Read `USER.md`.',
  '3. Read `memory/YYYY-MM-DD.md` for today and yesterday.',
  '4. In the main session, also read `MEMORY.md`.',
  '',
  'Do not ask permission first.',
  '',
  '## Memory',
  '',
  '- `memory/YYYY-MM-DD.md` stores raw daily notes.',
  '- `MEMORY.md` stores durable facts, preferences, and decisions.',
  '- If something should survive a restart, write it to a file.',
  '',
  '## Safety',
  '',
  '- Do not exfiltrate private data.',
  '- Do not run destructive commands without asking.',
  '- When in doubt, ask.',
  '',
  '## Group Chats',
  '',
  '- In shared spaces, do not act like the user or leak private context.',
  '- If you have nothing useful to add, stay quiet.',
  '',
  '## Tools',
  '',
  '- Skills provide tools. Read each skill before using it.',
  '- Keep local environment notes in `TOOLS.md`.',
  '',
  '## Heartbeats',
  '',
  '- Use `HEARTBEAT.md` for proactive background checks and reminders.',
  '- Prefer cron for exact schedules and heartbeat for periodic checks.',
].join('\n');

const stripTemplateFrontMatter = (content: string): string => {
  if (!content.startsWith('---')) {
    return content.trim();
  }

  const endIndex = content.indexOf('\n---', 3);
  if (endIndex < 0) {
    return content.trim();
  }

  return content.slice(endIndex + 4).trim();
};

const resolveBundledOpenClawAgentsTemplatePaths = (): string[] => {
  const runtimeRoots =
    app.isPackaged === true
      ? [path.join(process.resourcesPath, 'cfmind')]
      : [
          path.join(app.getAppPath(), 'vendor', 'openclaw-runtime', 'current'),
          path.join(process.cwd(), 'vendor', 'openclaw-runtime', 'current'),
        ];

  return runtimeRoots.map(runtimeRoot =>
    path.join(runtimeRoot, 'docs', 'reference', 'templates', 'AGENTS.md'),
  );
};

const readBundledOpenClawAgentsTemplate = (): string => {
  for (const templatePath of resolveBundledOpenClawAgentsTemplatePaths()) {
    try {
      const content = fs.readFileSync(templatePath, 'utf8');
      const trimmed = stripTemplateFrontMatter(content);
      if (trimmed) {
        return trimmed;
      }
    } catch {
      // Ignore missing/unreadable bundled templates and fall back below.
    }
  }

  return FALLBACK_OPENCLAW_AGENTS_TEMPLATE;
};

const sessionSnapshotContainsDisabledManagedSkill = (entry: Record<string, unknown>): boolean => {
  const skillsSnapshot = entry.skillsSnapshot;
  if (!skillsSnapshot || typeof skillsSnapshot !== 'object') {
    return false;
  }

  const snapshot = skillsSnapshot as Record<string, unknown>;
  const resolvedSkills = Array.isArray(snapshot.resolvedSkills) ? snapshot.resolvedSkills : [];

  for (const skill of resolvedSkills) {
    if (!skill || typeof skill !== 'object') {
      continue;
    }
    const name =
      typeof (skill as Record<string, unknown>).name === 'string'
        ? ((skill as Record<string, unknown>).name as string).trim()
        : '';
    if (name && DISABLED_MANAGED_SKILL_NAMES.includes(name)) {
      return true;
    }
  }

  const prompt = typeof snapshot.prompt === 'string' ? snapshot.prompt : '';
  return DISABLED_MANAGED_SKILL_NAMES.some(name => prompt.includes(`<name>${name}</name>`));
};

type OpenClawProviderApi =
  | 'anthropic-messages'
  | 'openai-completions'
  | 'openai-responses'
  | 'google-generative-ai';

type OpenClawProviderSelection = {
  providerId: string;
  legacyModelId: string;
  sessionModelId: string;
  primaryModel: string;
  providerConfig: {
    baseUrl: string;
    api: OpenClawProviderApi;
    apiKey: string;
    auth: typeof AuthType[keyof typeof AuthType];
    request?: {
      proxy: {
        mode: 'env-proxy';
      };
    };
    models: Array<{
      id: string;
      name: string;
      api: OpenClawProviderApi;
      input: string[];
      reasoning?: boolean;
      cost?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
      };
      contextWindow?: number;
      maxTokens?: number;
    }>;
  };
};

const normalizeBaseUrlPath = (rawBaseUrl: string, pathName: string): string => {
  const trimmed = rawBaseUrl.trim();
  if (!trimmed) return trimmed;
  try {
    const parsed = new URL(trimmed);
    parsed.pathname = pathName;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
};

/**
 * Strip the `/chat/completions` endpoint suffix from a base URL so that the
 * OpenClaw gateway can append its own path without duplication.
 *
 * Aligned with the detection logic in `buildOpenAIChatCompletionsURL`
 * (coworkFormatTransform.ts) which returns the URL as-is when it already
 * ends with `/chat/completions`.
 *
 * e.g. "https://gw.example.com/v1/chat/completions" → "https://gw.example.com/v1"
 *      "https://gw.example.com/v1"                   → "https://gw.example.com/v1"  (unchanged)
 */
const stripChatCompletionsSuffix = (rawBaseUrl: string): string => {
  const normalized = rawBaseUrl.trim().replace(/\/+$/, '');
  if (normalized.endsWith('/chat/completions')) {
    return normalized.slice(0, -'/chat/completions'.length).replace(/\/+$/, '');
  }
  return normalized;
};

const isLoopbackProviderBaseUrl = (rawBaseUrl: string): boolean => {
  try {
    const host = new URL(rawBaseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost'
      || host === '127.0.0.1'
      || host === '::1'
      || host === '0.0.0.0';
  } catch {
    return false;
  }
};

const shouldUseEnvProxyForProviderBaseUrl = (rawBaseUrl: string): boolean => (
  isSystemProxyEnabled() && !isLoopbackProviderBaseUrl(rawBaseUrl)
);

const normalizeGeminiBaseUrl = (rawBaseUrl: string): string => {
  return normalizeBaseUrlPath(
    rawBaseUrl.trim() || 'https://generativelanguage.googleapis.com',
    '/v1beta',
  );
};

// ═══════════════════════════════════════════════════════
// Provider Descriptor Registry
// ═══════════════════════════════════════════════════════

type ProviderDescriptor = {
  providerId: string;
  resolveApi: (ctx: {
    apiType: 'anthropic' | 'openai' | undefined;
    baseURL: string;
  }) => OpenClawProviderApi;
  normalizeBaseUrl: (rawBaseUrl: string) => string;
  resolveApiKey?: (ctx: { apiKey: string; providerName: string }) => string;
  resolveSessionModelId?: (modelId: string) => string;
  /**
   * 动态计算 baseUrl，完全覆盖 normalizeBaseUrl 的结果。
   * 用于 baseUrl 由运行时环境决定（如代理端口）而非用户配置的场景。
   * 返回 null 表示降级使用 normalizeBaseUrl。
   */
  resolveRuntimeBaseUrl?: () => string | null;
  /**
   * 基于 modelId 动态计算 reasoning 标志。
   * 优先级高于 modelDefaults.reasoning。
   */
  resolveModelReasoning?: (modelId: string, codingPlanEnabled: boolean) => boolean | undefined;
  modelDefaults?: Partial<{
    reasoning: boolean;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  }>;
};

const PROVIDER_REGISTRY: Record<string, ProviderDescriptor> = {
  [ProviderName.LobsteraiServer]: {
    providerId: OpenClawProviderId.LobsteraiServer,
    resolveApi: () => OpenClawApiConst.OpenAICompletions as OpenClawProviderApi,
    normalizeBaseUrl: url => {
      const proxyPort = getOpenClawTokenProxyPort();
      return proxyPort ? `http://127.0.0.1:${proxyPort}/v1` : stripChatCompletionsSuffix(url);
    },
    resolveApiKey: () => {
      const proxyPort = getOpenClawTokenProxyPort();
      return proxyPort ? '${LOBSTER_PROXY_TOKEN}' : `\${${providerApiKeyEnvVar('server')}}`;
    },
  },

  [ProviderName.Moonshot]: {
    providerId: OpenClawProviderId.Moonshot,
    resolveApi: ({ apiType, baseURL }) => mapApiTypeToOpenClawApi(apiType, undefined, baseURL),
    normalizeBaseUrl: stripChatCompletionsSuffix,
    modelDefaults: {
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 256000,
      maxTokens: 8192,
    },
  },

  [ProviderName.Gemini]: {
    providerId: OpenClawProviderId.Google,
    resolveApi: () => OpenClawApiConst.GoogleGenerativeAI as OpenClawProviderApi,
    normalizeBaseUrl: normalizeGeminiBaseUrl,
    modelDefaults: {
      reasoning: true,
    },
  },

  [ProviderName.Anthropic]: {
    providerId: OpenClawProviderId.Anthropic,
    resolveApi: () => OpenClawApiConst.AnthropicMessages as OpenClawProviderApi,
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  [ProviderName.OpenAI]: {
    providerId: OpenClawProviderId.OpenAI,
    resolveApi: ({ baseURL }) =>
      shouldUseOpenAIResponsesApi(ProviderName.OpenAI, baseURL)
        ? (OpenClawApiConst.OpenAIResponses as OpenClawProviderApi)
        : (OpenClawApiConst.OpenAICompletions as OpenClawProviderApi),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  [ProviderName.DeepSeek]: {
    providerId: OpenClawProviderId.DeepSeek,
    resolveApi: ({ apiType, baseURL }) => mapApiTypeToOpenClawApi(apiType, undefined, baseURL),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  [ProviderName.Qwen]: {
    providerId: OpenClawProviderId.Qwen,
    resolveApi: ({ apiType, baseURL }) => mapApiTypeToOpenClawApi(apiType, undefined, baseURL),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  [ProviderName.Zhipu]: {
    providerId: OpenClawProviderId.Zai,
    resolveApi: ({ apiType, baseURL }) => mapApiTypeToOpenClawApi(apiType, undefined, baseURL),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  [ProviderName.Volcengine]: {
    providerId: OpenClawProviderId.Volcengine,
    resolveApi: ({ apiType, baseURL }) => mapApiTypeToOpenClawApi(apiType, undefined, baseURL),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  [ProviderName.Minimax]: {
    providerId: OpenClawProviderId.Minimax,
    resolveApi: ({ apiType, baseURL }) => mapApiTypeToOpenClawApi(apiType, undefined, baseURL),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  [ProviderName.Youdaozhiyun]: {
    providerId: OpenClawProviderId.Youdaozhiyun,
    resolveApi: () => OpenClawApiConst.OpenAICompletions as OpenClawProviderApi,
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  [ProviderName.StepFun]: {
    providerId: OpenClawProviderId.StepFun,
    resolveApi: () => OpenClawApiConst.OpenAICompletions as OpenClawProviderApi,
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  [ProviderName.Xiaomi]: {
    providerId: OpenClawProviderId.Xiaomi,
    resolveApi: ({ apiType, baseURL }) => mapApiTypeToOpenClawApi(apiType, undefined, baseURL),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  [ProviderName.OpenRouter]: {
    providerId: OpenClawProviderId.OpenRouter,
    resolveApi: ({ apiType, baseURL }) => mapApiTypeToOpenClawApi(apiType, undefined, baseURL),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  [ProviderName.Ollama]: {
    providerId: OpenClawProviderId.Ollama,
    resolveApi: () => OpenClawApiConst.OpenAICompletions as OpenClawProviderApi,
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  [ProviderName.LmStudio]: {
    providerId: OpenClawProviderId.LmStudio,
    resolveApi: ({ apiType, baseURL }) => mapApiTypeToOpenClawApi(apiType, undefined, baseURL),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  [ProviderName.Copilot]: {
    providerId: OpenClawProviderId.LobsteraiCopilot,
    resolveApi: () => OpenClawApiConst.OpenAICompletions as OpenClawProviderApi,
    normalizeBaseUrl: stripChatCompletionsSuffix,
    resolveRuntimeBaseUrl: () => {
      const proxyBase = getCoworkOpenAICompatProxyBaseURL('local');
      return proxyBase ? `${proxyBase}/v1/copilot` : null;
    },
    resolveApiKey: () => '${LOBSTER_PROXY_TOKEN}',
  },
};

const DEFAULT_DESCRIPTOR: ProviderDescriptor = {
  providerId: OpenClawProviderId.Lobster,
  resolveApi: ({ apiType, baseURL }) => mapApiTypeToOpenClawApi(apiType, undefined, baseURL),
  normalizeBaseUrl: stripChatCompletionsSuffix,
};

const resolveDescriptor = (
  providerName: string,
  codingPlanEnabled: boolean,
): ProviderDescriptor => {
  if (codingPlanEnabled) {
    const compositeKey = `${providerName}:codingPlan`;
    if (compositeKey in PROVIDER_REGISTRY) {
      return PROVIDER_REGISTRY[compositeKey];
    }
  }
  if (providerName in PROVIDER_REGISTRY) {
    return PROVIDER_REGISTRY[providerName];
  }
  return {
    ...DEFAULT_DESCRIPTOR,
    providerId: providerName || OpenClawProviderId.Lobster,
  };
};

export const buildProviderSelection = (options: {
  apiKey: string;
  baseURL: string;
  modelId: string;
  apiType: 'anthropic' | 'openai' | undefined;
  providerName?: string;
  authType?: 'apikey' | 'oauth';
  codingPlanEnabled?: boolean;
  supportsImage?: boolean;
  modelName?: string;
}): OpenClawProviderSelection => {
  const providerName = options.providerName ?? '';
  const descriptor = resolveDescriptor(providerName, !!options.codingPlanEnabled);

  let baseUrl =
    descriptor.resolveRuntimeBaseUrl?.() ?? descriptor.normalizeBaseUrl(options.baseURL);
  const api = descriptor.resolveApi({
    apiType: options.apiType,
    baseURL: options.baseURL,
  });

  // When DashScope Anthropic URL is forced to OpenAI format, rewrite the
  // base URL to the corresponding OpenAI-compatible endpoint.
  if (api === 'openai-completions' && options.apiType === 'anthropic' && isDashScopeUrl(baseUrl)) {
    baseUrl = rewriteDashScopeAnthropicToOpenAI(baseUrl);
  }
  const apiKey = descriptor.resolveApiKey
    ? descriptor.resolveApiKey({ apiKey: options.apiKey, providerName })
    : `\${${providerApiKeyEnvVar(providerName)}}`;
  const sessionModelId = descriptor.resolveSessionModelId
    ? descriptor.resolveSessionModelId(options.modelId)
    : options.modelId;

  const providerModelName = resolveModelDisplayName(sessionModelId, options.modelName);
  const modelInput: string[] = options.supportsImage ? ['text', 'image'] : ['text'];
  const auth = options.providerName === ProviderName.Minimax && options.authType === 'oauth'
    ? AuthType.OAuth
    : AuthType.ApiKey;

  // reasoning：descriptor 动态计算 > modelDefaults 静态值
  const reasoning = descriptor.resolveModelReasoning
    ? descriptor.resolveModelReasoning(options.modelId, !!options.codingPlanEnabled)
    : descriptor.modelDefaults?.reasoning;
  const request = shouldUseEnvProxyForProviderBaseUrl(baseUrl)
    ? { proxy: { mode: 'env-proxy' as const } }
    : undefined;

  return {
    providerId: descriptor.providerId,
    legacyModelId: options.modelId,
    sessionModelId,
    primaryModel: `${descriptor.providerId}/${sessionModelId}`,
    providerConfig: {
      baseUrl,
      api,
      apiKey,
      auth,
      ...(request ? { request } : {}),
      models: [
        {
          id: sessionModelId,
          name: providerModelName,
          api,
          input: modelInput,
          ...(reasoning !== undefined ? { reasoning } : {}),
          ...(descriptor.modelDefaults?.cost ? { cost: descriptor.modelDefaults.cost } : {}),
          ...(descriptor.modelDefaults?.contextWindow
            ? { contextWindow: descriptor.modelDefaults.contextWindow }
            : {}),
          ...(descriptor.modelDefaults?.maxTokens
            ? { maxTokens: descriptor.modelDefaults.maxTokens }
            : {}),
        },
      ],
    },
  };
};

const readPreinstalledPluginIds = (): string[] => {
  try {
    const pkgPath = path.join(app.getAppPath(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const plugins = pkg.openclaw?.plugins;
    if (!Array.isArray(plugins)) return [];
    return plugins
      .map((p: { id?: string }) => p.id)
      .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
};

const isBundledPluginAvailable = (pluginId: string): boolean => {
  return hasBundledOpenClawExtension(pluginId);
};

function normalizeMcpToolInputSchemaForOpenAI(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(normalizeMcpToolInputSchemaForOpenAI);
  }
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  const record = schema as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    normalized[key] = normalizeMcpToolInputSchemaForOpenAI(value);
  }

  const schemaType = normalized.type;
  const isArraySchema = schemaType === 'array'
    || (Array.isArray(schemaType) && schemaType.includes('array'));
  if (isArraySchema && normalized.items === undefined) {
    normalized.items = {};
  }

  return normalized;
}

const normalizeMcpBridgeToolManifestEntry = (
  tool: McpToolManifestEntry,
): McpToolManifestEntry => ({
  ...tool,
  inputSchema: normalizeMcpToolInputSchemaForOpenAI(tool.inputSchema) as Record<string, unknown>,
});

export type OpenClawConfigSyncResult = {
  ok: boolean;
  changed: boolean;
  configPath: string;
  error?: string;
  agentsMdWarning?: string;
  bindingsChanged?: boolean;
  mcpBridgeConfigChanged?: boolean;
};

const buildStreamingModeConfig = (
  mode: 'off' | 'partial' | 'block' | 'progress',
): { mode: 'off' | 'partial' | 'block' | 'progress' } => ({
  mode,
});

type OpenClawConfigSyncDeps = {
  engineManager: OpenClawEngineManager;
  getCoworkConfig: () => CoworkConfig;
  isEnterprise: () => boolean;
  getOpenClawSessionPolicy?: () => { keepAlive: OpenClawSessionKeepAlive };
  getTelegramInstances?: () => TelegramInstanceConfig[];
  getDiscordInstances?: () => DiscordInstanceConfig[];
  getDingTalkInstances?: () => DingTalkInstanceConfig[];
  getFeishuInstances?: () => FeishuInstanceConfig[];
  getQQInstances?: () => QQInstanceConfig[];
  getWecomInstances?: () => WecomInstanceConfig[];
  getPopoConfig: () => PopoOpenClawConfig | null;
  getEmailOpenClawConfig?: () => EmailMultiInstanceConfig;
  getNimInstances?: () => NimInstanceConfig[];
  getNeteaseBeeChanConfig: () => NeteaseBeeChanConfig | null;
  getWeixinConfig: () => WeixinOpenClawConfig | null;
  getIMSettings?: () => IMSettings | null;
  getMcpBridgeConfig?: () => McpBridgeConfig | null;
  getMcpBridgeSecret?: () => string;
  getSkillsList?: () => Array<{ id: string; enabled: boolean }>;
  getAgents?: () => Agent[];
};

export class OpenClawConfigSync {
  private readonly engineManager: OpenClawEngineManager;
  private readonly getCoworkConfig: () => CoworkConfig;
  private readonly isEnterprise: () => boolean;
  private readonly getOpenClawSessionPolicy?: () => { keepAlive: OpenClawSessionKeepAlive };
  private readonly getTelegramInstances: () => TelegramInstanceConfig[];
  private readonly getDiscordInstances: () => DiscordInstanceConfig[];
  private readonly getDingTalkInstances: () => DingTalkInstanceConfig[];
  private readonly getFeishuInstances: () => FeishuInstanceConfig[];
  private readonly getQQInstances: () => QQInstanceConfig[];
  private readonly getWecomInstances: () => WecomInstanceConfig[];
  private readonly getPopoConfig: () => PopoOpenClawConfig | null;
  private readonly getEmailOpenClawConfig?: () => EmailMultiInstanceConfig;
  private readonly getNimInstances: () => NimInstanceConfig[];
  private readonly getNeteaseBeeChanConfig: () => NeteaseBeeChanConfig | null;
  private readonly getWeixinConfig: () => WeixinOpenClawConfig | null;
  private readonly getIMSettings?: () => IMSettings | null;
  private readonly getMcpBridgeConfig?: () => McpBridgeConfig | null;
  private readonly getMcpBridgeSecret?: () => string;
  private readonly getSkillsList?: () => Array<{ id: string; enabled: boolean }>;
  private readonly getAgents?: () => Agent[];
  private previousBindingsJson?: string;
  private currentBindingsObj: { bindings?: Array<Record<string, unknown>> } = {};

  constructor(deps: OpenClawConfigSyncDeps) {
    this.engineManager = deps.engineManager;
    this.getCoworkConfig = deps.getCoworkConfig;
    this.isEnterprise = deps.isEnterprise;
    this.getOpenClawSessionPolicy = deps.getOpenClawSessionPolicy;
    this.getTelegramInstances = deps.getTelegramInstances ?? (() => []);
    this.getDiscordInstances = deps.getDiscordInstances ?? (() => []);
    this.getDingTalkInstances = deps.getDingTalkInstances ?? (() => []);
    this.getFeishuInstances = deps.getFeishuInstances ?? (() => []);
    this.getQQInstances = deps.getQQInstances ?? (() => []);
    this.getWecomInstances = deps.getWecomInstances ?? (() => []);
    this.getPopoConfig = deps.getPopoConfig;
    this.getEmailOpenClawConfig = deps.getEmailOpenClawConfig;
    this.getNimInstances = deps.getNimInstances ?? (() => []);
    this.getNeteaseBeeChanConfig = deps.getNeteaseBeeChanConfig;
    this.getWeixinConfig = deps.getWeixinConfig;
    this.getIMSettings = deps.getIMSettings;
    this.getMcpBridgeConfig = deps.getMcpBridgeConfig;
    this.getMcpBridgeSecret = deps.getMcpBridgeSecret;
    this.getSkillsList = deps.getSkillsList;
    this.getAgents = deps.getAgents;
  }

  private buildSessionConfig(): Record<string, unknown> {
    const policy = this.getOpenClawSessionPolicy?.() ?? {
      keepAlive: OpenClawSessionKeepAlive.ThirtyDays,
    };
    return buildOpenClawSessionConfig(policy);
  }

  sync(reason: string): OpenClawConfigSyncResult {
    const configPath = this.engineManager.getConfigPath();
    const coworkConfig = this.getCoworkConfig();
    const apiResolution = resolveRawApiConfig();

    if (!apiResolution.config) {
      // Enterprise mode: proceed with full config generation even without a
      // resolved API model. The enterprise openclaw.json merge (called after
      // sync) will supply providers and the primary model. Writing only the
      // minimal config would lose sandbox settings, plugins, AGENTS.md, etc.
      if (this.isEnterprise()) {
        console.log(
          '[OpenClawConfigSync] enterprise mode: no API config resolved, generating full config with empty providers (enterprise merge will supply them)',
        );
      } else {
        // No API/model configured yet (fresh install).
        // Write a minimal config so the gateway can start — it just won't have
        // any model provider until the user configures one.
        const result = this.writeMinimalConfig(configPath, reason);
        // Still sync AGENTS.md even when API is not configured — skills/systemPrompt
        // may already be set and should be available when the user configures a model.
        const workspaceDir = (coworkConfig.workingDirectory || '').trim();
        const resolvedWorkspaceDir =
          workspaceDir || path.join(app.getPath('home'), '.openclaw', 'workspace');
        const agentsMdWarning = this.syncAgentsMd(resolvedWorkspaceDir, coworkConfig);
        this.syncPerAgentWorkspaces(resolvedWorkspaceDir, coworkConfig);
        if (agentsMdWarning) result.agentsMdWarning = agentsMdWarning;
        return result;
      }
    }

    let allProvidersMap: Record<string, OpenClawProviderSelection['providerConfig']> = {};
    let primaryModel = '';
    let providerSelection: OpenClawProviderSelection | null = null;

    if (apiResolution.config) {
      const { baseURL, apiKey, model, apiType } = apiResolution.config;
      const modelId = model.trim();
      if (!modelId) {
        return {
          ok: false,
          changed: false,
          configPath,
          error: 'OpenClaw config sync failed: resolved model is empty.',
        };
      }

      providerSelection = buildProviderSelection({
        apiKey,
        baseURL,
        modelId,
        apiType,
        providerName: apiResolution.providerMetadata?.providerName,
        authType: apiResolution.providerMetadata?.authType,
        codingPlanEnabled: apiResolution.providerMetadata?.codingPlanEnabled,
        supportsImage: apiResolution.providerMetadata?.supportsImage,
        modelName: apiResolution.providerMetadata?.modelName,
      });
      primaryModel = providerSelection.primaryModel;

      for (const p of resolveAllEnabledProviderConfigs()) {
        for (const m of p.models) {
          const sel = buildProviderSelection({
            apiKey: p.apiKey,
            baseURL: p.baseURL,
            modelId: m.id,
            apiType: p.apiType,
            providerName: p.providerName,
            authType: p.authType,
            codingPlanEnabled: p.codingPlanEnabled,
            supportsImage: m.supportsImage,
            modelName: m.name,
          });
          if (!allProvidersMap[sel.providerId]) {
            allProvidersMap[sel.providerId] = { ...sel.providerConfig, models: [] };
          }
          const existing = allProvidersMap[sel.providerId];
          const alreadyHas = existing.models.some(em => em.id === sel.providerConfig.models[0]?.id);
          if (!alreadyHas && sel.providerConfig.models.length > 0) {
            existing.models.push(...sel.providerConfig.models);
          }
        }
      }

      if (!allProvidersMap[providerSelection.providerId]) {
        allProvidersMap[providerSelection.providerId] = providerSelection.providerConfig;
      } else {
        const existing = allProvidersMap[providerSelection.providerId];
        const alreadyHas = existing.models.some(
          em => em.id === providerSelection.providerConfig.models[0]?.id,
        );
        if (!alreadyHas && providerSelection.providerConfig.models.length > 0) {
          existing.models.push(...providerSelection.providerConfig.models);
        }
      }

      const proxyPort = getOpenClawTokenProxyPort();
      if (proxyPort && !allProvidersMap[ProviderName.LobsteraiServer]) {
        const serverModels = getAllServerModelMetadata();
        const firstServerModelId = serverModels[0]?.modelId || modelId;
        const firstServerSel = buildProviderSelection({
          apiKey: 'proxy-managed',
          baseURL: `http://127.0.0.1:${proxyPort}/v1`,
          modelId: firstServerModelId,
          apiType: 'openai',
          providerName: ProviderName.LobsteraiServer,
          supportsImage: serverModels[0]?.supportsImage,
        });
        const lobsteraiProviderConfig = {
          ...firstServerSel.providerConfig,
          models: [] as typeof firstServerSel.providerConfig.models,
        };
        for (const sm of serverModels) {
          lobsteraiProviderConfig.models.push({
            id: sm.modelId,
            name: sm.modelId,
            api: OpenClawApiConst.OpenAICompletions as OpenClawProviderApi,
            input: sm.supportsImage ? ['text', 'image'] : ['text'],
          });
        }
        if (lobsteraiProviderConfig.models.length === 0) {
          lobsteraiProviderConfig.models.push(firstServerSel.providerConfig.models[0]);
        }
        allProvidersMap[OpenClawProviderId.LobsteraiServer] = lobsteraiProviderConfig;
      }
    }

    const sandboxMode = mapExecutionModeToSandboxMode(
      coworkConfig.executionMode || 'local',
      this.isEnterprise(),
    );
    console.log(
      `[OpenClawConfigSync] sandbox mode: ${sandboxMode} (executionMode: ${coworkConfig.executionMode || 'local'}, enterprise: ${this.isEnterprise()})`,
    );

    const workspaceDir = (coworkConfig.workingDirectory || '').trim();

    const preinstalledPluginIds = readPreinstalledPluginIds().filter(id =>
      isBundledPluginAvailable(id),
    );
    const hasMcpBridgePlugin = isBundledPluginAvailable('mcp-bridge');
    const hasAskUserPlugin = isBundledPluginAvailable('ask-user-question');

    // Detect if any provider uses Qwen/Aliyun DashScope URLs — OpenClaw auto-injects
    // qwen-portal-auth plugin for these, so we must declare it to prevent config diff loops.
    const hasQwenProvider = Object.values(allProvidersMap).some(p => {
      const url = (p as { baseUrl?: string }).baseUrl || '';
      return url.includes('dashscope.aliyuncs.com') || url.includes('aliyuncs.com/compatible-mode');
    });

    // Read existing config to preserve fields that the OpenClaw runtime
    // auto-injects at startup.  Without this, every configSync cycle removes
    // them, the gateway detects the diff, and restarts — creating a restart
    // loop.  We preserve ALL existing gateway fields and plugin entries rather
    // than whitelisting specific ones, so new auto-injected fields in future
    // OpenClaw versions don't cause regressions.
    // See: openclaw/openclaw#58678, #33310, #61613
    let existingGateway: Record<string, unknown> = {};
    let existingPlugins: Record<string, unknown> = {};
    try {
      const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      existingGateway = (existing.gateway ?? {}) as Record<string, unknown>;
      existingPlugins = (existing.plugins ?? {}) as Record<string, unknown>;
    } catch {
      // First run or corrupt file — nothing to preserve.
    }
    const existingPluginEntries = (existingPlugins.entries ?? {}) as Record<string, unknown>;
    console.log('[GW-RESTART-DIAG] existingGateway keys:', Object.keys(existingGateway).sort().join(',') || '(empty)');
    console.log('[GW-RESTART-DIAG] existingPlugins keys:', Object.keys(existingPlugins).sort().join(',') || '(empty)');
    console.log('[GW-RESTART-DIAG] existingPluginEntries keys:', Object.keys(existingPluginEntries).sort().join(',') || '(empty)');

    const dingTalkInstances = this.getDingTalkInstances();
    // DingTalk runs through OpenClaw plugin but still needs the gateway HTTP endpoint (chatCompletions)
    const hasDingTalkOpenClaw = dingTalkInstances.some(i => i.enabled && i.clientId);

    const feishuInstances = this.getFeishuInstances();

    const qqInstances = this.getQQInstances();

    const wecomInstances = this.getWecomInstances();

    const popoConfig = this.getPopoConfig();

    const nimInstances = this.getNimInstances();

    const neteaseBeeChanConfig = this.getNeteaseBeeChanConfig();

    const weixinConfig = this.getWeixinConfig();

    const hasAnyChannel = hasDingTalkOpenClaw;

    // Pre-compute bindings and detect changes so we can signal a hard restart
    // when only bindings change (channel plugins don't hot-reload bindings).
    this.currentBindingsObj = this.buildBindings();
    const bindingsJson = JSON.stringify(this.currentBindingsObj);
    const bindingsChanged = this.previousBindingsJson !== undefined
      && bindingsJson !== this.previousBindingsJson;
    this.previousBindingsJson = bindingsJson;

    const managedConfig: Record<string, unknown> = {
      gateway: {
        // Preserve ALL existing gateway fields so runtime-seeded values
        // survive config rewrites.  Our managed fields below override
        // any stale values.
        ...existingGateway,
        mode: 'local',
        // Explicitly declare auth and tailscale to match the runtime
        // in-memory state.  The gateway sets auth.mode='token' when
        // --token / OPENCLAW_GATEWAY_TOKEN is provided.  Without
        // matching values here, ANY file change triggers
        // "config change requires gateway restart (gateway.auth.token)".
        auth: { mode: 'token', token: '${OPENCLAW_GATEWAY_TOKEN}' },
        tailscale: { mode: 'off' },
        ...(hasAnyChannel
          ? {
              http: {
                endpoints: {
                  chatCompletions: { enabled: true },
                },
              },
            }
          : {}),
      },
      models: {
        mode: 'replace',
        providers: allProvidersMap,
      },
      agents: {
        defaults: {
          timeoutSeconds: OPENCLAW_AGENT_TIMEOUT_SECONDS,
          model: {
            primary: primaryModel,
          },
          sandbox: {
            mode: sandboxMode,
          },
          ...(workspaceDir ? { workspace: path.resolve(workspaceDir) } : {}),
          ...(coworkConfig.embeddingEnabled ? {
            memorySearch: {
              enabled: true,
              provider: (['openai', 'gemini', 'voyage', 'mistral', 'ollama'].includes(coworkConfig.embeddingProvider)
                ? coworkConfig.embeddingProvider
                : 'openai'),
              ...(coworkConfig.embeddingModel ? { model: coworkConfig.embeddingModel } : {}),
              remote: {
                ...(coworkConfig.embeddingRemoteBaseUrl ? { baseUrl: coworkConfig.embeddingRemoteBaseUrl } : {}),
                ...(coworkConfig.embeddingRemoteApiKey ? { apiKey: coworkConfig.embeddingRemoteApiKey } : {}),
              },
              store: {
                // Use trigram tokenizer for FTS5 — unicode61 (the openclaw default)
                // cannot tokenize CJK characters, so Chinese/Japanese/Korean memory
                // content is invisible to keyword search.
                fts: { tokenizer: 'trigram' },
              },
              query: {
                hybrid: {
                  vectorWeight: coworkConfig.embeddingVectorWeight ?? 0.7,
                },
              },
            },
          } : {}),
        },
        ...this.buildAgentsList(primaryModel, this.engineManager.getStateDir()),
      },
      ...this.currentBindingsObj,
      session: this.buildSessionConfig(),
      commands: {
        ownerAllowFrom: MANAGED_OWNER_ALLOW_FROM,
      },
      tools: {
        deny: [...MANAGED_TOOL_DENY],
        web: {
          search: {
            enabled: false,
          },
        },
      },
      browser: {
        enabled: true,
      },
      skills: {
        entries: {
          ...this.buildSkillEntries(),
          ...MANAGED_SKILL_ENTRY_OVERRIDES,
        },
        load: {
          extraDirs: this.resolveSkillsExtraDirs(),
          watch: true,
        },
      },
      cron: {
        enabled: true,
        skipMissedJobs: coworkConfig.skipMissedJobs === true,
        maxConcurrentRuns: 3,
        sessionRetention: '7d',
      },
      ...((() => {
        // Remove known-stale plugin entries that no longer ship with the
        // runtime.  These ghost entries cause harmless but noisy "plugin
        // not found" warnings on every gateway startup.
        const knownStalePluginIds = ['dingtalk', 'openclaw-nim-channel', 'qwen-portal-auth', 'openclaw-qqbot'];
        const transientPluginIds = [
          ...(preinstalledPluginIds.includes('openclaw-lark') ? ['feishu'] : []),
        ];
        const cleanedExistingEntries = Object.fromEntries(
          Object.entries(existingPluginEntries).filter(([id]) => (
            !knownStalePluginIds.includes(id) && !transientPluginIds.includes(id)
          )),
        );
        const qqbotPluginEnabled = qqInstances.some(i => i.enabled && i.appId);


        const pluginEntries: Record<string, unknown> = {
          // Preserve ALL existing plugin entries so runtime auto-injected
          // plugins (moonshot, minimax, volcengine, browser, etc.) survive
          // config rewrites.  Our managed entries below override stale values.
          ...cleanedExistingEntries,
          qqbot: { enabled: qqbotPluginEnabled },
          ...Object.fromEntries(
            preinstalledPluginIds.map(id => {
              // Sync plugin enabled state with the corresponding channel config.
              // When a channel is disabled in the UI, its plugin must also be
              // disabled so OpenClaw doesn't load it at all.
              const pluginEnabled = (() => {
                if (id === DINGTALK_OPENCLAW_CHANNEL || id === 'dingtalk') return dingTalkInstances.some(i => i.enabled && i.clientId);
                if (id === 'openclaw-lark' || id === 'feishu-openclaw-plugin')
                  return feishuInstances.some(i => i.enabled && i.appId);
                if (id === 'openclaw-qqbot') return qqInstances.some(i => i.enabled && i.appId);
                if (id === 'wecom-openclaw-plugin') return wecomInstances.some(i => i.enabled && i.botId);
                if (id === 'moltbot-popo') return !!(popoConfig?.enabled && popoConfig.appKey);
                if (id === 'nim') return nimInstances.some(i => i.enabled && ((i.nimToken && i.nimToken.trim()) || (i.appKey && i.account && i.token)));
                if (id === 'openclaw-netease-bee') return !!(neteaseBeeChanConfig?.enabled && neteaseBeeChanConfig.clientId && neteaseBeeChanConfig.secret);
                if (id === 'openclaw-weixin') return true; // Always keep enabled for QR login discovery
                return true; // other plugins stay enabled
              })();
              return [id, { enabled: pluginEnabled }];
            }),
          ),
          ...(preinstalledPluginIds.includes('feishu-openclaw-plugin')
            ? { feishu: { enabled: false } }
            : {}),
          ...(hasMcpBridgePlugin ? { 'mcp-bridge': { enabled: true } } : {}),
          ...(hasAskUserPlugin ? { 'ask-user-question': { enabled: true } } : {}),
          // OpenClaw auto-injects qwen-portal-auth for Qwen/DashScope URLs; declare it
          // explicitly so configSync doesn't remove it and trigger restart loops.
          ...(hasQwenProvider ? { 'qwen-portal-auth': { enabled: true } } : {}),
          // Disable acpx (ACP agent runtime) — LobsterAI does not use ACP and
          // the embedded probe adds ~11s to gateway startup while it waits for
          // a process that always fails.  See openclaw/openclaw#62588.
          'acpx': { enabled: false },
        };

        return Object.keys(pluginEntries).length > 0
          ? {
              plugins: {
                // Preserve existing plugins fields (load, deny, etc.) so
                // runtime-seeded values survive config rewrites and don't
                // cause a plugins diff → gateway restart.
                ...existingPlugins,
                // Third-party plugins live in a separate `extensions/` dir (not
                // `dist/extensions/`) and need `load.paths` so the gateway discovers
                // them with origin="config", bypassing the bundled-channel-entry
                // contract check.  See openclaw/openclaw#60196.
                ...((() => {
                  const thirdPartyDir = findThirdPartyExtensionsDir();
                  return thirdPartyDir ? { load: { paths: [thirdPartyDir] } } : {};
                })()),
                // Deny list cleared — unused bundled plugins are physically removed
                // from dist/extensions/ at build time (see prune-openclaw-runtime.cjs).
                // OpenClaw validates deny IDs against discovered plugins, so denying
                // a removed plugin causes "Config invalid: plugin not found" errors.
                deny: [],
                entries: pluginEntries,
              },
            }
          : {};
      })())
    };

    // Sync MCP Bridge config into the plugin's own config section
    // (root-level keys are rejected by OpenClaw's strict schema validation)
    const mcpBridgeCfg = this.getMcpBridgeConfig?.();
    console.log(`[OpenClawConfigSync] getMcpBridgeConfig: callbackUrl=${mcpBridgeCfg?.callbackUrl ?? 'null'}, tools=${mcpBridgeCfg?.tools?.length ?? 0}`);
    if (
      hasMcpBridgePlugin &&
      mcpBridgeCfg &&
      mcpBridgeCfg.tools.length > 0 &&
      managedConfig.plugins
    ) {
      const plugins = managedConfig.plugins as Record<string, unknown>;
      const entries = plugins.entries as Record<string, Record<string, unknown>>;
      entries['mcp-bridge'] = {
        ...entries['mcp-bridge'],
        config: {
          callbackUrl: mcpBridgeCfg.callbackUrl,
          secret: '${LOBSTER_MCP_BRIDGE_SECRET}',
          tools: mcpBridgeCfg.tools.map(normalizeMcpBridgeToolManifestEntry),
        },
      };
    }

    // Sync AskUserQuestion plugin config — uses the same HTTP callback server
    if (hasAskUserPlugin && mcpBridgeCfg && managedConfig.plugins) {
      const plugins = managedConfig.plugins as Record<string, unknown>;
      const entries = plugins.entries as Record<string, Record<string, unknown>>;
      entries['ask-user-question'] = {
        enabled: true,
        config: {
          callbackUrl: mcpBridgeCfg.askUserCallbackUrl,
          secret: '${LOBSTER_MCP_BRIDGE_SECRET}',
        },
      };
    }

    // Sync Telegram OpenClaw channel config — multi-instance via accounts
    const telegramInstances = this.getTelegramInstances();
    const enabledTelegramInstances = telegramInstances.filter(i => i.enabled && i.botToken);
    if (enabledTelegramInstances.length > 0) {
      const accounts: Record<string, unknown> = {};
      for (let idx = 0; idx < enabledTelegramInstances.length; idx++) {
        const inst = enabledTelegramInstances[idx];
        const tokenVar = idx === 0 ? 'LOBSTER_TG_BOT_TOKEN' : `LOBSTER_TG_BOT_TOKEN_${idx}`;
        const webhookSecretVar = idx === 0 ? 'LOBSTER_TG_WEBHOOK_SECRET' : `LOBSTER_TG_WEBHOOK_SECRET_${idx}`;
        const account: Record<string, unknown> = {
          enabled: true,
          name: inst.instanceName,
          botToken: `\${${tokenVar}}`,
          dmPolicy: inst.dmPolicy || 'open',
          allowFrom: (() => {
            const ids = inst.allowFrom?.length ? [...inst.allowFrom] : [];
            if (inst.dmPolicy === 'open' && !ids.includes('*')) ids.push('*');
            return ids;
          })(),
          groupPolicy: inst.groupPolicy || 'allowlist',
          groupAllowFrom: (() => {
            const ids = inst.groupAllowFrom?.length ? [...inst.groupAllowFrom] : [];
            if (inst.groupPolicy === 'open' && !ids.includes('*')) ids.push('*');
            return ids;
          })(),
          groups:
            inst.groups && Object.keys(inst.groups).length > 0
              ? inst.groups
              : { '*': { requireMention: true } },
          historyLimit: inst.historyLimit || 50,
          replyToMode: inst.replyToMode || 'off',
          linkPreview: inst.linkPreview ?? true,
          streaming: buildStreamingModeConfig(inst.streaming || 'off'),
          mediaMaxMb: inst.mediaMaxMb || 5,
        };
        if (inst.proxy) {
          account.proxy = inst.proxy;
        }
        if (inst.webhookUrl) {
          account.webhookUrl = inst.webhookUrl;
          if (inst.webhookSecret) {
            account.webhookSecret = `\${${webhookSecretVar}}`;
          }
        }
        accounts[inst.instanceId.slice(0, 8)] = account;
      }
      managedConfig.channels = {
        ...((managedConfig.channels as Record<string, unknown>) || {}),
        telegram: { enabled: true, accounts },
      };
    }
    // When disabled, omit the channel key entirely so OpenClaw won't load the plugin.

    // Sync Discord OpenClaw channel config — multi-instance via accounts
    const discordInstances = this.getDiscordInstances();
    const enabledDiscordInstances = discordInstances.filter(i => i.enabled && i.botToken);
    if (enabledDiscordInstances.length > 0) {
      const accounts: Record<string, unknown> = {};
      for (let idx = 0; idx < enabledDiscordInstances.length; idx++) {
        const inst = enabledDiscordInstances[idx];
        const tokenVar = idx === 0 ? 'LOBSTER_DC_BOT_TOKEN' : `LOBSTER_DC_BOT_TOKEN_${idx}`;
        const account: Record<string, unknown> = {
          enabled: true,
          name: inst.instanceName,
          token: `\${${tokenVar}}`,
          dm: {
            policy: inst.dmPolicy || 'open',
            allowFrom: (() => {
              const ids = inst.allowFrom?.length ? [...inst.allowFrom] : [];
              if (inst.dmPolicy === 'open' && !ids.includes('*')) ids.push('*');
              return ids;
            })(),
          },
          groupPolicy: inst.groupPolicy || 'allowlist',
          guilds: (() => {
            const guilds: Record<string, unknown> = {};
            if (inst.groupAllowFrom?.length) {
              for (const guildId of inst.groupAllowFrom) {
                guilds[guildId] = inst.guilds?.[guildId] || {};
              }
            }
            if (inst.guilds && Object.keys(inst.guilds).length > 0) {
              for (const [key, guildConfig] of Object.entries(inst.guilds)) {
                const existing = (guilds[key] || {}) as Record<string, unknown>;
                guilds[key] = {
                  ...existing,
                  ...(guildConfig.requireMention !== undefined
                    ? { requireMention: guildConfig.requireMention }
                    : {}),
                  ...(guildConfig.allowFrom?.length ? { users: guildConfig.allowFrom } : {}),
                  ...(guildConfig.systemPrompt ? { systemPrompt: guildConfig.systemPrompt } : {}),
                };
              }
            }
            return Object.keys(guilds).length > 0 ? guilds : { '*': { requireMention: true } };
          })(),
          historyLimit: inst.historyLimit || 50,
          streaming: buildStreamingModeConfig(inst.streaming || 'off'),
          mediaMaxMb: inst.mediaMaxMb || 25,
        };
        if (inst.proxy) {
          account.proxy = inst.proxy;
        }
        accounts[inst.instanceId.slice(0, 8)] = account;
      }
      managedConfig.channels = {
        ...((managedConfig.channels as Record<string, unknown>) || {}),
        discord: { enabled: true, accounts },
      };
    }

    // Sync Feishu OpenClaw channel config (via @larksuite/openclaw-lark) — multi-instance via accounts
    const enabledFeishuInstances = feishuInstances.filter(i => i.enabled && i.appId);
    if (enabledFeishuInstances.length > 0) {
      const buildFeishuAccountConfig = (
        inst: (typeof enabledFeishuInstances)[0],
        secretEnvVar: string,
      ): Record<string, unknown> => ({
        enabled: true,
        name: inst.instanceName,
        appId: inst.appId,
        appSecret: `\${${secretEnvVar}}`,
        domain: inst.domain || 'feishu',
        dmPolicy: inst.dmPolicy || 'open',
        allowFrom: (() => {
          const ids = inst.allowFrom?.length ? [...inst.allowFrom] : [];
          if (inst.dmPolicy === 'open' && !ids.includes('*')) ids.push('*');
          return ids;
        })(),
        groupPolicy: inst.groupPolicy || 'allowlist',
        groupAllowFrom: (() => {
          const ids = inst.groupAllowFrom?.length ? [...inst.groupAllowFrom] : [];
          if (inst.groupPolicy === 'open' && !ids.includes('*')) ids.push('*');
          return ids;
        })(),
        groups:
          inst.groups && Object.keys(inst.groups).length > 0
            ? inst.groups
            : { '*': { requireMention: true } },
        historyLimit: inst.historyLimit || 50,
        streaming: inst.streaming ?? true,
        replyMode: inst.replyMode || 'auto',
        blockStreaming: inst.blockStreaming ?? false,
        ...(inst.footer ? { footer: inst.footer } : {}),
        ...(inst.blockStreamingCoalesce
          ? { blockStreamingCoalesce: inst.blockStreamingCoalesce }
          : {}),
        mediaMaxMb: inst.mediaMaxMb || 30,
      });

      // All instances go into `accounts` dict
      const accounts: Record<string, unknown> = {};
      for (let idx = 0; idx < enabledFeishuInstances.length; idx++) {
        const inst = enabledFeishuInstances[idx];
        const secretVar =
          idx === 0 ? 'LOBSTER_FEISHU_APP_SECRET' : `LOBSTER_FEISHU_APP_SECRET_${idx}`;
        accounts[inst.instanceId.slice(0, 8)] = buildFeishuAccountConfig(inst, secretVar);
      }

      managedConfig.channels = { ...(managedConfig.channels as Record<string, unknown> || {}), feishu: { enabled: true, accounts } };
    }

    // Sync DingTalk OpenClaw channel config (via dingtalk-connector plugin) — multi-instance via accounts
    const enabledDingTalkInstances = dingTalkInstances.filter(i => i.enabled && i.clientId);
    if (enabledDingTalkInstances.length > 0) {
      const buildDingTalkAccountConfig = (
        inst: (typeof enabledDingTalkInstances)[0],
        secretEnvVar: string,
      ): Record<string, unknown> => ({
        enabled: true,
        name: inst.instanceName,
        clientId: inst.clientId,
        clientSecret: `\${${secretEnvVar}}`,
        // v3.5.x schema: dmPolicy/groupPolicy/allowFrom are valid; sessionTimeout/
        // separateSessionByConversation/groupSessionScope/sharedMemoryAcrossConversations/
        // gatewayBaseUrl were LobsterAI-specific and are not in the plugin schema.
        dmPolicy: inst.dmPolicy || 'open',
        allowFrom: (() => {
          const ids = inst.allowFrom?.length ? [...inst.allowFrom] : [];
          if (inst.dmPolicy === 'open' && !ids.includes('*')) ids.push('*');
          return ids;
        })(),
        groupPolicy: inst.groupPolicy || 'open',
      });

      // All instances go into `accounts` dict
      const accounts: Record<string, unknown> = {};
      for (let idx = 0; idx < enabledDingTalkInstances.length; idx++) {
        const inst = enabledDingTalkInstances[idx];
        const secretVar =
          idx === 0 ? 'LOBSTER_DINGTALK_CLIENT_SECRET' : `LOBSTER_DINGTALK_CLIENT_SECRET_${idx}`;
        accounts[inst.instanceId.slice(0, 8)] = buildDingTalkAccountConfig(inst, secretVar);
      }

      const dingtalkChannel: Record<string, unknown> = { enabled: true, accounts };

      managedConfig.channels = {
        ...((managedConfig.channels as Record<string, unknown>) || {}),
        [DINGTALK_OPENCLAW_CHANNEL]: dingtalkChannel,
      };
    }

    // Sync QQ OpenClaw channel config (via qqbot plugin) — multi-instance via accounts
    const enabledQQInstances = qqInstances.filter(i => i.enabled && i.appId);
    if (enabledQQInstances.length > 0) {
      const buildQQAccountConfig = (
        inst: (typeof enabledQQInstances)[0],
        secretEnvVar: string,
      ): Record<string, unknown> => {
        const account: Record<string, unknown> = {
          enabled: true,
          name: inst.instanceName,
          appId: inst.appId,
          clientSecret: `\${${secretEnvVar}}`,
          // v2026.4.8 schema removed dmPolicy/groupPolicy/groupAllowFrom/historyLimit.
          // Only allowFrom and markdownSupport remain as valid account properties.
          allowFrom: (() => {
            const ids = inst.allowFrom?.length ? [...inst.allowFrom] : [];
            if (inst.dmPolicy === 'open' && !ids.includes('*')) ids.push('*');
            return ids;
          })(),
          markdownSupport: inst.markdownSupport ?? true,
        };
        if (inst.imageServerBaseUrl) {
          account.imageServerBaseUrl = inst.imageServerBaseUrl;
        }
        return account;
      };

      // All instances go into `accounts` dict
      const accounts: Record<string, unknown> = {};
      for (let idx = 0; idx < enabledQQInstances.length; idx++) {
        const inst = enabledQQInstances[idx];
        const secretVar =
          idx === 0 ? 'LOBSTER_QQ_CLIENT_SECRET' : `LOBSTER_QQ_CLIENT_SECRET_${idx}`;
        accounts[inst.instanceId.slice(0, 8)] = buildQQAccountConfig(inst, secretVar);
      }

      managedConfig.channels = { ...(managedConfig.channels as Record<string, unknown> || {}), qqbot: { enabled: true, accounts } };
    }

    // Sync WeCom OpenClaw channel config (via wecom-openclaw-plugin) — multi-instance via accounts
    const enabledWecomInstances = wecomInstances.filter(i => i.enabled && i.botId);
    if (enabledWecomInstances.length > 0) {
      const accounts: Record<string, unknown> = {};
      for (let idx = 0; idx < enabledWecomInstances.length; idx++) {
        const inst = enabledWecomInstances[idx];
        const secretVar = idx === 0 ? 'LOBSTER_WECOM_SECRET' : `LOBSTER_WECOM_SECRET_${idx}`;
        accounts[inst.instanceId.slice(0, 8)] = {
          enabled: true,
          name: inst.instanceName,
          botId: inst.botId,
          secret: `\${${secretVar}}`,
          dmPolicy: inst.dmPolicy || 'open',
          allowFrom: (() => {
            const ids = inst.allowFrom?.length ? [...inst.allowFrom] : [];
            if (inst.dmPolicy === 'open' && !ids.includes('*')) ids.push('*');
            return ids;
          })(),
          groupPolicy: inst.groupPolicy || 'open',
          groupAllowFrom: (() => {
            const ids = inst.groupAllowFrom?.length ? [...inst.groupAllowFrom] : [];
            if (inst.groupPolicy === 'open' && !ids.includes('*')) ids.push('*');
            return ids;
          })(),
          sendThinkingMessage: inst.sendThinkingMessage ?? true,
        };
      }
      managedConfig.channels = {
        ...((managedConfig.channels as Record<string, unknown>) || {}),
        wecom: { accounts },
      };
    }

    // Sync POPO OpenClaw channel config (via moltbot-popo plugin)
    if (popoConfig?.enabled && popoConfig.appKey) {
      // Migration: old configs lack connectionMode. If token is set, the user
      // was using webhook mode; otherwise default to the new websocket mode.
      const effectiveConnectionMode =
        popoConfig.connectionMode || (popoConfig.token ? 'webhook' : 'websocket');
      const isWebSocket = effectiveConnectionMode === 'websocket';
      const popoChannel: Record<string, unknown> = {
        enabled: true,
        connectionMode: effectiveConnectionMode,
        appKey: popoConfig.appKey,
        appSecret: '${LOBSTER_POPO_APP_SECRET}',
        aesKey: popoConfig.aesKey,
        dmPolicy: popoConfig.dmPolicy || 'open',
        allowFrom: (() => {
          const ids = popoConfig.allowFrom?.length ? [...popoConfig.allowFrom] : [];
          if (popoConfig.dmPolicy === 'open' && !ids.includes('*')) ids.push('*');
          return ids;
        })(),
        groupPolicy: popoConfig.groupPolicy || 'open',
        groupAllowFrom: (() => {
          const ids = popoConfig.groupAllowFrom?.length ? [...popoConfig.groupAllowFrom] : [];
          if (popoConfig.groupPolicy === 'open' && !ids.includes('*')) ids.push('*');
          return ids;
        })(),
      };
      // Webhook-only fields
      if (!isWebSocket) {
        popoChannel.token = '${LOBSTER_POPO_TOKEN}';
        popoChannel.webhookPort = popoConfig.webhookPort || 3100;
      }
      if (popoConfig.textChunkLimit && popoConfig.textChunkLimit !== 3000) {
        popoChannel.textChunkLimit = popoConfig.textChunkLimit;
      }
      if (popoConfig.richTextChunkLimit && popoConfig.richTextChunkLimit !== 5000) {
        popoChannel.richTextChunkLimit = popoConfig.richTextChunkLimit;
      }
      if (!isWebSocket && popoConfig.webhookBaseUrl) {
        popoChannel.webhookBaseUrl = popoConfig.webhookBaseUrl;
      }
      if (!isWebSocket && popoConfig.webhookPath && popoConfig.webhookPath !== '/popo/callback') {
        popoChannel.webhookPath = popoConfig.webhookPath;
      }
      managedConfig.channels = {
        ...((managedConfig.channels as Record<string, unknown>) || {}),
        'moltbot-popo': popoChannel,
      };
    }

    // Sync Email OpenClaw channel config (multi-instance)
    const emailConfig = this.getEmailOpenClawConfig?.();
    if (emailConfig?.instances && emailConfig.instances.length > 0) {
      const enabledInstances = emailConfig.instances.filter(i => i.enabled && i.email);

      if (enabledInstances.length > 0) {
        const accounts: Record<string, unknown> = {};

        for (const inst of enabledInstances) {
          const accountId = inst.instanceId;
          // Transform instanceId: email-1 → 1, email-work → WORK, uuid → UUID (dashes replaced with underscores)
          const envSuffix = accountId.replace(/^email-/, '').replace(/-/g, '_').toUpperCase();

          const accountConfig: Record<string, unknown> = {
            enabled: true,
            name: inst.instanceName,
            email: inst.email,
            transport: inst.transport,
          };

          // IMAP/SMTP mode configuration
          if (inst.transport === 'imap') {
            accountConfig.password = `\${LOBSTER_EMAIL_${envSuffix}_PASSWORD}`;
            if (inst.imapHost) accountConfig.imapHost = inst.imapHost;
            if (inst.imapPort) accountConfig.imapPort = inst.imapPort;
            if (inst.smtpHost) accountConfig.smtpHost = inst.smtpHost;
            if (inst.smtpPort) accountConfig.smtpPort = inst.smtpPort;
          }

          // WebSocket mode configuration
          if (inst.transport === 'ws') {
            accountConfig.apiKey = `\${LOBSTER_EMAIL_${envSuffix}_APIKEY}`;
          }

          // Common configuration
          if (inst.allowFrom?.length) {
            accountConfig.allowFrom = inst.allowFrom;
          }
          if (inst.replyMode) {
            accountConfig.replyMode = inst.replyMode;
          }
          if (inst.replyTo) {
            accountConfig.replyTo = inst.replyTo;
          }

          // A2A configuration
          if (
            inst.a2aEnabled !== undefined ||
            inst.a2aAgentDomains?.length ||
            inst.a2aMaxPingPongTurns
          ) {
            accountConfig.a2a = {
              enabled: inst.a2aEnabled ?? true,
              ...(inst.a2aAgentDomains?.length ? { agentDomains: inst.a2aAgentDomains } : {}),
              ...(inst.a2aMaxPingPongTurns ? { maxPingPongTurns: inst.a2aMaxPingPongTurns } : {}),
            };
          }

          accounts[accountId] = accountConfig;
        }

        managedConfig.channels = {
          ...((managedConfig.channels as Record<string, unknown>) || {}),
          email: {
            enabled: true,
            accounts,
          },
        };
      }
    }
    // Sync NIM OpenClaw channel config (via openclaw-nim plugin) — multi-instance via accounts
    const configuredNimInstances = nimInstances.filter((inst) =>
      Boolean((inst.nimToken && inst.nimToken.trim()) || (inst.appKey && inst.account && inst.token))
    );
    if (configuredNimInstances.length > 0) {
      const accounts: Record<string, Record<string, unknown>> = {};
      configuredNimInstances.forEach((inst, idx) => {
        const tokenEnvVar = idx === 0 ? 'LOBSTER_NIM_TOKEN' : `LOBSTER_NIM_TOKEN_${idx}`;
        const nimToken = inst.nimToken?.trim()
          ? inst.nimToken.trim()
          : `${inst.appKey}|${inst.account}|\${${tokenEnvVar}}`;
        const nimInstance: Record<string, unknown> = {
          enabled: inst.enabled ?? false,
          nimToken,
          antispamEnabled: inst.antispamEnabled ?? true,
        };
        if (inst.p2p) nimInstance.p2p = inst.p2p;
        if (inst.team) nimInstance.team = inst.team;
        if (inst.qchat) nimInstance.qchat = inst.qchat;
        if (inst.advanced) nimInstance.advanced = inst.advanced;
        const preferredKey = deriveNimAccountConfigKey(inst) || deriveNimAccountId(inst) || `nim_${idx + 1}`;
        const accountKey = accounts[preferredKey] ? (deriveNimAccountId(inst) || `${preferredKey}_${idx + 1}`) : preferredKey;
        accounts[accountKey] = nimInstance;
      });
      managedConfig.channels = { ...(managedConfig.channels as Record<string, unknown> || {}), nim: { accounts } };
    }

    // Sync NeteaseBee OpenClaw channel config (via openclaw-netease-bee plugin)
    if (
      neteaseBeeChanConfig?.enabled &&
      neteaseBeeChanConfig.clientId &&
      neteaseBeeChanConfig.secret
    ) {
      managedConfig.channels = {
        ...((managedConfig.channels as Record<string, unknown>) || {}),
        'netease-bee': {
          enabled: true,
          clientId: neteaseBeeChanConfig.clientId,
          secret: neteaseBeeChanConfig.secret,
        },
      };
    }

    // Sync Weixin OpenClaw channel config (via openclaw-weixin plugin)
    // Only write the channel entry when the plugin is actually installed,
    // otherwise the gateway rejects the config as invalid.
    if (preinstalledPluginIds.includes('openclaw-weixin')) {
      const weixinChannelEnabled = !!weixinConfig?.enabled;
      const weixinChannel: Record<string, unknown> = {
        enabled: weixinChannelEnabled,
        dmPolicy: weixinConfig?.dmPolicy || 'open',
        allowFrom: (() => {
          const ids = weixinConfig?.allowFrom?.length ? [...weixinConfig.allowFrom] : [];
          if ((weixinConfig?.dmPolicy || 'open') === 'open' && !ids.includes('*')) ids.push('*');
          return ids;
        })(),
      };
      managedConfig.channels = {
        ...((managedConfig.channels as Record<string, unknown>) || {}),
        'openclaw-weixin': weixinChannel,
      };
    }

    // Binding changes are detected via bindingsChanged (line ~1035) which
    // triggers a hard gateway restart in the caller.  We no longer inject
    // _agentBinding into channel configs because OpenClaw plugins using
    // additionalProperties:false reject the extra field and crash.

    const nextContent = `${JSON.stringify(managedConfig, null, 2)}\n`;
    console.log('[OpenClawConfigSync] sync() managedConfig key fields:', {
      providers: (managedConfig.models as Record<string, unknown>)?.providers,
      primaryModel: (
        (managedConfig.agents as Record<string, unknown>)?.defaults as Record<string, unknown>
      )?.model,
    });
    let currentContent = '';
    try {
      currentContent = fs.readFileSync(configPath, 'utf8');
    } catch {
      currentContent = '';
    }

    const configChanged = currentContent !== nextContent;

    // Detect mcp-bridge config changes (callbackUrl, tools) separately.
    // Even when the overall plugins section appears "UNCHANGED" in the
    // diagnostic, the mcp-bridge sub-config may have changed — and that
    // requires a hard gateway restart because the gateway pins its config
    // snapshot at startup.
    let mcpBridgeConfigChanged = false;
    try {
      const currentObj = currentContent ? JSON.parse(currentContent) : {};
      const nextObj = JSON.parse(nextContent);
      const curMcpBridge = currentObj?.plugins?.entries?.['mcp-bridge'];
      const nxtMcpBridge = nextObj?.plugins?.entries?.['mcp-bridge'];
      const curCallbackUrl = curMcpBridge?.config?.callbackUrl;
      const nxtCallbackUrl = nxtMcpBridge?.config?.callbackUrl;
      const curTools = curMcpBridge?.config?.tools;
      const nxtTools = nxtMcpBridge?.config?.tools;
      const curToolsJson = JSON.stringify(Array.isArray(curTools) ? curTools : []);
      const nxtToolsJson = JSON.stringify(Array.isArray(nxtTools) ? nxtTools : []);
      const curToolCount = Array.isArray(curTools) ? curTools.length : 0;
      const nxtToolCount = Array.isArray(nxtTools) ? nxtTools.length : 0;
      mcpBridgeConfigChanged = curCallbackUrl !== nxtCallbackUrl || curToolsJson !== nxtToolsJson;
      if (mcpBridgeConfigChanged) {
        console.log(`[GW-RESTART-DIAG] mcp-bridge config CHANGED: callbackUrl ${curCallbackUrl ?? 'null'} → ${nxtCallbackUrl ?? 'null'}, tools ${curToolCount} → ${nxtToolCount}`);
      }
    } catch { /* ignore parse errors */ }

    if (configChanged) {
      // Diagnostic: diff gateway and plugins sections to identify what triggers OpenClaw restart
      try {
        const currentObj = currentContent ? JSON.parse(currentContent) : {};
        const nextObj = JSON.parse(nextContent);
        const curGw = JSON.stringify(currentObj.gateway ?? {});
        const nxtGw = JSON.stringify(nextObj.gateway ?? {});
        const curPl = JSON.stringify(currentObj.plugins ?? {});
        const nxtPl = JSON.stringify(nextObj.plugins ?? {});
        if (curGw !== nxtGw) {
          console.log('[GW-RESTART-DIAG] gateway DIFF:');
          console.log('[GW-RESTART-DIAG]   old gateway keys:', Object.keys(currentObj.gateway ?? {}).sort().join(','));
          console.log('[GW-RESTART-DIAG]   new gateway keys:', Object.keys(nextObj.gateway ?? {}).sort().join(','));
          console.log('[GW-RESTART-DIAG]   old gateway:', curGw.slice(0, 500));
          console.log('[GW-RESTART-DIAG]   new gateway:', nxtGw.slice(0, 500));
        } else {
          console.log('[GW-RESTART-DIAG] gateway section UNCHANGED');
        }
        if (curPl !== nxtPl) {
          console.log('[GW-RESTART-DIAG] plugins DIFF:');
          console.log('[GW-RESTART-DIAG]   old plugin entry keys:', Object.keys((currentObj.plugins?.entries) ?? {}).sort().join(','));
          console.log('[GW-RESTART-DIAG]   new plugin entry keys:', Object.keys((nextObj.plugins?.entries) ?? {}).sort().join(','));
        } else {
          console.log('[GW-RESTART-DIAG] plugins section UNCHANGED');
        }
        // Check which top-level keys actually changed
        const allKeys = new Set([...Object.keys(currentObj), ...Object.keys(nextObj)]);
        const changedKeys = [...allKeys].filter(k => JSON.stringify(currentObj[k]) !== JSON.stringify(nextObj[k]));
        console.log('[GW-RESTART-DIAG] top-level changed keys:', changedKeys.join(',') || '(none)');
      } catch { /* ignore parse errors in diag */ }
      try {
        ensureDir(path.dirname(configPath));
        const tmpPath = `${configPath}.tmp-${Date.now()}`;
        fs.writeFileSync(tmpPath, nextContent, 'utf8');
        fs.renameSync(tmpPath, configPath);
      } catch (error) {
        return {
          ok: false,
          changed: false,
          configPath,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const sessionStoreChanged = providerSelection
      ? this.syncManagedSessionStore(providerSelection, allProvidersMap)
      : false;

    // Ensure exec-approvals.json has security=full + ask=off so the gateway
    // never triggers approval-pending for any command.
    this.ensureExecApprovalDefaults();

    // Sync AGENTS.md with skills routing prompt to the OpenClaw workspace directory.
    // This runs on every sync regardless of openclaw.json changes, because skills
    // may have been installed/enabled/disabled independently.
    const resolvedWorkspaceDir =
      workspaceDir || path.join(app.getPath('home'), '.openclaw', 'workspace');
    const agentsMdWarning = this.syncAgentsMd(resolvedWorkspaceDir, coworkConfig);

    // Sync per-agent workspace files (SOUL.md, IDENTITY.md, AGENTS.md) for non-main agents
    this.syncPerAgentWorkspaces(resolvedWorkspaceDir, coworkConfig);

    return {
      ok: true,
      changed: configChanged || sessionStoreChanged,
      configPath,
      ...(bindingsChanged ? { bindingsChanged } : {}),
      ...(mcpBridgeConfigChanged ? { mcpBridgeConfigChanged } : {}),
      ...(agentsMdWarning ? { agentsMdWarning } : {}),
    };
  }

  /**
   * Collect all secret values that should be injected as environment variables
   * into the OpenClaw gateway process. The openclaw.json file uses `${VAR}`
   * placeholders for these values so that no plaintext secrets are stored on disk.
   */
  collectSecretEnvVars(): Record<string, string> {
    const env: Record<string, string> = {};

    // Provider API Keys — one per configured provider so switching models
    // never changes env vars and avoids gateway process restarts.
    const allApiKeys = resolveAllProviderApiKeys();
    for (const [envSuffix, apiKey] of Object.entries(allApiKeys)) {
      console.info(`[OpenClawConfigSync] set secret env var LOBSTER_APIKEY_${envSuffix} for provider ${envSuffix}`);
      env[`LOBSTER_APIKEY_${envSuffix}`] = apiKey;
    }
    // Legacy fallback: keep LOBSTER_PROVIDER_API_KEY set to a stable value so stale
    // openclaw.json files with the old placeholder don't crash the gateway.
    // Use the active provider's key if available, but ONLY for the first sync —
    // after that, openclaw.json uses provider-specific placeholders and this var
    // is never resolved. Use a fixed value to avoid secretEnvVarsChanged on switch.
    env.LOBSTER_PROVIDER_API_KEY = 'legacy-unused';

    env.LOBSTER_PROXY_TOKEN = getCoworkOpenAICompatProxyToken() || 'unconfigured';

    // MCP Bridge Secret — always set so stale openclaw.json with
    // ${LOBSTER_MCP_BRIDGE_SECRET} placeholder doesn't crash the gateway.
    // Prefer getMcpBridgeSecret() which is available immediately (eagerly
    // generated at module load), over getMcpBridgeConfig() which requires
    // the full McpBridgeServer to be started.
    const mcpBridgeCfg = this.getMcpBridgeConfig?.();
    env.LOBSTER_MCP_BRIDGE_SECRET = this.getMcpBridgeSecret?.() || mcpBridgeCfg?.secret || 'unconfigured';

    // Telegram — per-instance secrets (must match sync() indexing: enabled instances only)
    const tgInstances = this.getTelegramInstances();
    const enabledTelegram = tgInstances.filter(i => i.enabled && i.botToken);
    for (let idx = 0; idx < enabledTelegram.length; idx++) {
      const inst = enabledTelegram[idx];
      if (idx === 0) {
        env.LOBSTER_TG_BOT_TOKEN = inst.botToken;
        if (inst.webhookSecret) env.LOBSTER_TG_WEBHOOK_SECRET = inst.webhookSecret;
      } else {
        env[`LOBSTER_TG_BOT_TOKEN_${idx}`] = inst.botToken;
        if (inst.webhookSecret) env[`LOBSTER_TG_WEBHOOK_SECRET_${idx}`] = inst.webhookSecret;
      }
    }

    // Discord — per-instance secrets (must match sync() indexing: enabled instances only)
    const dcInstances = this.getDiscordInstances();
    const enabledDiscord = dcInstances.filter(i => i.enabled && i.botToken);
    for (let idx = 0; idx < enabledDiscord.length; idx++) {
      if (idx === 0) {
        env.LOBSTER_DC_BOT_TOKEN = enabledDiscord[idx].botToken;
      } else {
        env[`LOBSTER_DC_BOT_TOKEN_${idx}`] = enabledDiscord[idx].botToken;
      }
    }

    // Feishu — per-instance secrets (must match sync() indexing: enabled instances only)
    const feishuInstances = this.getFeishuInstances();
    const enabledFeishu = feishuInstances.filter(i => i.enabled && i.appSecret);
    for (let idx = 0; idx < enabledFeishu.length; idx++) {
      if (idx === 0) {
        env.LOBSTER_FEISHU_APP_SECRET = enabledFeishu[idx].appSecret;
      } else {
        env[`LOBSTER_FEISHU_APP_SECRET_${idx}`] = enabledFeishu[idx].appSecret;
      }
    }

    // DingTalk — per-instance secrets (must match sync() indexing: enabled instances only)
    const dingTalkInstances = this.getDingTalkInstances();
    const enabledDingTalk = dingTalkInstances.filter(i => i.enabled && i.clientSecret);
    for (let idx = 0; idx < enabledDingTalk.length; idx++) {
      if (idx === 0) {
        env.LOBSTER_DINGTALK_CLIENT_SECRET = enabledDingTalk[idx].clientSecret;
      } else {
        env[`LOBSTER_DINGTALK_CLIENT_SECRET_${idx}`] = enabledDingTalk[idx].clientSecret;
      }
    }
    // Gateway token is shared (not per-instance)
    const gatewayToken = this.engineManager.getGatewayToken();
    if (gatewayToken) {
      env.LOBSTER_DINGTALK_GW_TOKEN = gatewayToken;
    }

    // QQ — per-instance secrets (must match sync() indexing: enabled instances only)
    const qqInstances = this.getQQInstances();
    const enabledQQ = qqInstances.filter(i => i.enabled && i.appSecret);
    for (let idx = 0; idx < enabledQQ.length; idx++) {
      if (idx === 0) {
        env.LOBSTER_QQ_CLIENT_SECRET = enabledQQ[idx].appSecret;
      } else {
        env[`LOBSTER_QQ_CLIENT_SECRET_${idx}`] = enabledQQ[idx].appSecret;
      }
    }

    // WeCom — per-instance secrets (must match sync() indexing: enabled instances only)
    const wecomInstances = this.getWecomInstances();
    const enabledWecom = wecomInstances.filter(i => i.enabled && i.secret);
    for (let idx = 0; idx < enabledWecom.length; idx++) {
      if (idx === 0) {
        env.LOBSTER_WECOM_SECRET = enabledWecom[idx].secret;
      } else {
        env[`LOBSTER_WECOM_SECRET_${idx}`] = enabledWecom[idx].secret;
      }
    }

    // POPO
    const popoConfig = this.getPopoConfig();
    if (popoConfig?.enabled && popoConfig.appSecret) {
      env.LOBSTER_POPO_APP_SECRET = popoConfig.appSecret;
    }
    if (popoConfig?.enabled && popoConfig.token) {
      env.LOBSTER_POPO_TOKEN = popoConfig.token;
    } else if (popoConfig?.enabled) {
      // Provide non-empty fallback so stale openclaw.json files that still
      // contain ${LOBSTER_POPO_TOKEN} from a previous webhook config
      // don't crash the gateway with MissingEnvVarError.
      env.LOBSTER_POPO_TOKEN = 'unconfigured';
    }

    // Email credentials
    const emailConfig = this.getEmailOpenClawConfig?.();
    if (emailConfig?.instances) {
      for (const inst of emailConfig.instances) {
        if (!inst.enabled || !inst.email) continue;

        const envSuffix = inst.instanceId.replace(/^email-/, '').replace(/-/g, '_').toUpperCase();

        if (inst.transport === 'imap' && inst.password) {
          env[`LOBSTER_EMAIL_${envSuffix}_PASSWORD`] = inst.password;
        }

        if (inst.transport === 'ws' && inst.apiKey) {
          env[`LOBSTER_EMAIL_${envSuffix}_APIKEY`] = inst.apiKey;
        }
      }
    }

    // NIM
    const nimInstances = this.getNimInstances().filter((inst) => inst.enabled && inst.token);
    for (let idx = 0; idx < nimInstances.length; idx++) {
      const key = idx === 0 ? 'LOBSTER_NIM_TOKEN' : `LOBSTER_NIM_TOKEN_${idx}`;
      env[key] = nimInstances[idx].token;
    }

    const D = '[GW-RESTART-DIAG]';
    const keysSummary = Object.keys(env).sort().map(k => {
      const v = env[k];
      return `${k}=${v.length > 16 ? v.slice(0, 12) + '…(' + v.length + ')' : v}`;
    });
    console.log(`${D} collectSecretEnvVars: ${Object.keys(env).length} keys: ${keysSummary.join(', ')}`);

    return env;
  }

  /**
   * Ensures exec-approvals.json under the LobsterAI-managed openclaw home has
   * security=full + ask=off so the gateway never triggers approval-pending
   * for any command. The path must match the OPENCLAW_HOME env var passed to
   * the gateway process so both sides read/write the same file.
   * Delete-command protection is handled via the system prompt instead.
   */
  private ensureExecApprovalDefaults(): void {
    const filePath = path.join(this.engineManager.getBaseDir(), '.openclaw', 'exec-approvals.json');

    type AgentEntry = { security?: string; ask?: string; [key: string]: unknown };
    type ApprovalsFile = {
      version: number;
      agents?: Record<string, AgentEntry>;
      [key: string]: unknown;
    };

    let file: ApprovalsFile;
    try {
      if (fs.existsSync(filePath)) {
        file = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ApprovalsFile;
        if (file?.version !== 1) file = { version: 1 };
      } else {
        file = { version: 1 };
      }
    } catch {
      file = { version: 1 };
    }

    if (!file.agents) file.agents = {};
    if (!file.agents.main) file.agents.main = {};
    const agent = file.agents.main;

    if (agent.security === 'full' && agent.ask === 'off') return;

    agent.security = 'full';
    agent.ask = 'off';

    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.atomicWriteFile(filePath, `${JSON.stringify(file, null, 2)}\n`);
      console.log('[OpenClawConfigSync] set exec-approvals security=full ask=off');
    } catch (error) {
      console.warn('[OpenClawConfigSync] failed to write exec-approvals.json:', error);
    }
  }

  private syncManagedSessionStore(
    selection: OpenClawProviderSelection,
    availableProviders: Record<string, OpenClawProviderSelection['providerConfig']>,
  ): boolean {
    const shouldMigrateManagedModelRefs = !(
      selection.providerId === 'lobster' && selection.sessionModelId === selection.legacyModelId
    );
    const fallbackTarget = parsePrimaryModelRef(selection.primaryModel) ?? {
      providerId: selection.providerId,
      modelId: selection.sessionModelId,
      primaryModel: selection.primaryModel,
    };
    const configuredAgents = this.getAgents?.() ?? [];
    const agentById = new Map(configuredAgents.map(agent => [agent.id, agent]));
    if (!agentById.has('main')) {
      agentById.set('main', {
        id: 'main',
        name: 'main',
        description: '',
        systemPrompt: '',
        identity: '',
        model: '',
        icon: '',
        skillIds: [],
        enabled: true,
        isDefault: true,
        source: 'custom',
        presetId: '',
        createdAt: 0,
        updatedAt: 0,
      });
    }

    let anyChanged = false;
    for (const [agentId, agent] of agentById.entries()) {
      const qualification = resolveQualifiedAgentModelRef({
        agentModel: agent.model,
        availableProviders,
      });
      if (qualification.status === 'ambiguous') {
        console.warn(
          `[OpenClawConfigSync] Skipped ambiguous managed session model sync for "${agent.id}" because "${qualification.modelId}" matches multiple providers: ${qualification.providerIds.join(', ')}`,
        );
      }

      const sessionStorePath = path.join(
        this.engineManager.getStateDir(),
        'agents',
        agentId,
        'sessions',
        'sessions.json',
      );

      let storeContent = '';
      try {
        storeContent = fs.readFileSync(sessionStorePath, 'utf8');
      } catch {
        continue;
      }

      let sessionStore: Record<string, unknown>;
      try {
        sessionStore = JSON.parse(storeContent) as Record<string, unknown>;
      } catch {
        continue;
      }

      let changed = false;
      for (const [sessionKey, rawEntry] of Object.entries(sessionStore)) {
        if (!rawEntry || typeof rawEntry !== 'object') {
          continue;
        }

        const entry = rawEntry as Record<string, unknown>;
        if (parseChannelSessionKey(sessionKey) !== null) {
          const execSecurity =
            typeof entry.execSecurity === 'string' ? entry.execSecurity.trim() : '';
          if (execSecurity !== 'full') {
            entry.execSecurity = 'full';
            changed = true;
          }
          if (sessionSnapshotContainsDisabledManagedSkill(entry)) {
            delete entry.skillsSnapshot;
            changed = true;
          }
        }

        if (!/^agent:[^:]+:lobsterai:/.test(sessionKey)) {
          continue;
        }

        const entryProvider =
          typeof entry.modelProvider === 'string' ? entry.modelProvider.trim() : '';
        if (qualification.status === 'ambiguous') {
          continue;
        }

        const target = resolveManagedSessionModelTarget({
          agentModel:
            qualification.status === 'qualified' ? qualification.primaryModel : agent.model,
          fallbackPrimaryModel: fallbackTarget.primaryModel,
          availableProviders,
          currentProviderId: entryProvider,
        });

        if (shouldMigrateManagedModelRefs) {
          const entryModel = typeof entry.model === 'string' ? entry.model.trim() : '';
          if (entryProvider !== target.providerId || entryModel !== target.modelId) {
            entry.modelProvider = target.providerId;
            entry.model = target.modelId;
            changed = true;
          }

          const systemPromptReport = entry.systemPromptReport;
          if (systemPromptReport && typeof systemPromptReport === 'object') {
            const report = systemPromptReport as Record<string, unknown>;
            const reportProvider =
              typeof report.provider === 'string' ? report.provider.trim() : '';
            const reportModel = typeof report.model === 'string' ? report.model.trim() : '';
            if (reportProvider !== target.providerId) {
              report.provider = target.providerId;
              changed = true;
            }
            if (reportModel !== target.modelId) {
              report.model = target.modelId;
              changed = true;
            }
          }
        }
      }

      if (!changed) {
        continue;
      }

      try {
        this.atomicWriteFile(sessionStorePath, `${JSON.stringify(sessionStore, null, 2)}\n`);
        anyChanged = true;
      } catch (error) {
        console.warn(
          '[OpenClawConfigSync] Failed to update managed session store:',
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return anyChanged;
  }

  /**
   * Resolve the LobsterAI SKILLs installation directory for OpenClaw's
   * `skills.load.extraDirs` configuration.
   *
   * Cross-platform paths (via Electron app.getPath('userData')):
   *   macOS:   ~/Library/Application Support/LobsterAI/SKILLs
   *   Windows: %APPDATA%/LobsterAI/SKILLs
   *   Linux:   ~/.config/LobsterAI/SKILLs
   */
  private resolveSkillsExtraDirs(): string[] {
    const userDataSkillsDir = path.join(app.getPath('userData'), 'SKILLs');
    try {
      if (fs.statSync(userDataSkillsDir).isDirectory()) {
        return [userDataSkillsDir];
      }
    } catch (err: unknown) {
      // ENOENT is expected on fresh installs before any skills sync.
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code !== 'ENOENT'
      ) {
        console.warn('[OpenClawConfigSync] Failed to stat SKILLs directory:', err);
      }
    }
    return [];
  }

  /**
   * Build per-skill `enabled` overrides from the LobsterAI SkillManager state,
   * so that skills disabled in the LobsterAI UI are also hidden from OpenClaw.
   */
  private buildSkillEntries(): Record<string, { enabled: boolean }> {
    const skills = this.getSkillsList?.() ?? [];
    const entries: Record<string, { enabled: boolean }> = {};
    for (const skill of skills) {
      entries[skill.id] = { enabled: skill.enabled };
    }
    return entries;
  }

  /**
   * Sync AGENTS.md to the OpenClaw workspace directory.
   * Embeds the skills routing prompt and system prompt so that OpenClaw's
   * native channel connectors (DingTalk, Feishu, etc.) can discover and
   * invoke LobsterAI skills.
   */
  private syncAgentsMd(workspaceDir: string, coworkConfig: CoworkConfig): string | undefined {
    const MARKER = '<!-- LobsterAI managed: do not edit below this line -->';

    try {
      ensureDir(workspaceDir);
      const agentsMdPath = path.join(workspaceDir, 'AGENTS.md');

      // Build the managed section
      const sections: string[] = [];

      // Add system prompt if configured — strip MARKER to prevent content corruption
      const systemPrompt = (coworkConfig.systemPrompt || '').trim().replaceAll(MARKER, '');
      if (systemPrompt) {
        sections.push(`## System Prompt\n\n${systemPrompt}`);
      }

      // Skills are now loaded by OpenClaw natively via skills.load.extraDirs
      // in openclaw.json, so we no longer embed the skills routing prompt here.

      sections.push(MANAGED_WEB_SEARCH_POLICY_PROMPT);
      sections.push(MANAGED_EXEC_SAFETY_PROMPT);
      sections.push(MANAGED_MEMORY_POLICY_PROMPT);
      sections.push(buildManagedSkillCreationPrompt(resolveSkillCreationPath()));

      // Keep scheduled-task policy after skills so native channel sessions
      // treat it as the final app-managed override for reminder handling.
      const scheduledTaskPrompt = buildScheduledTaskEnginePrompt('openclaw').replaceAll(MARKER, '');
      if (scheduledTaskPrompt) {
        sections.push(scheduledTaskPrompt);
      }

      // Read existing file once to avoid TOCTOU issues
      let existingContent = '';
      try {
        existingContent = fs.readFileSync(agentsMdPath, 'utf8');
      } catch {
        // File doesn't exist yet.
      }

      // Extract user content (everything before the marker)
      const markerIdx = existingContent.indexOf(MARKER);
      const userContent =
        markerIdx >= 0 ? existingContent.slice(0, markerIdx).trimEnd() : existingContent.trimEnd();
      const preservedUserContent = userContent || readBundledOpenClawAgentsTemplate();

      if (sections.length === 0) {
        // No managed content — remove the managed section if present,
        // but preserve user content.
        if (markerIdx >= 0) {
          if (preservedUserContent) {
            const cleaned = preservedUserContent + '\n';
            if (existingContent !== cleaned) {
              this.atomicWriteFile(agentsMdPath, cleaned);
            }
          } else {
            try {
              fs.unlinkSync(agentsMdPath);
            } catch {
              /* already gone */
            }
          }
        }
        return;
      }

      const managedContent = `${MARKER}\n\n${sections.join('\n\n')}`;
      const nextContent = preservedUserContent
        ? `${preservedUserContent}\n\n${managedContent}\n`
        : `${managedContent}\n`;

      // Only write if content actually changed
      if (existingContent === nextContent) return;

      this.atomicWriteFile(agentsMdPath, nextContent);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn('[OpenClawConfigSync] Failed to sync AGENTS.md:', msg);
      return msg;
    }
  }

  /**
   * Build the `agents.list` config array for openclaw.json.
   *
   * The main agent uses the user's configured workspace directory (via
   * `agents.defaults.workspace`).  Non-main agents omit `workspace` so
   * OpenClaw falls back to its default: `{STATE_DIR}/workspace-{agentId}/`.
   * This keeps custom agent workspaces under the openclaw state directory
   * rather than coupling them to the user's working directory.
   *
   * Per-agent `identity` (name, emoji) is set from the agent database so
   * OpenClaw picks it up natively.
   */
  private buildAgentsList(defaultPrimaryModel: string, stateDir?: string): { list?: Array<Record<string, unknown>> } {
    const agents = this.getAgents?.() ?? [];
    const mainAgent = agents.find(agent => agent.id === 'main');

    const list: Array<Record<string, unknown>> = [
      mainAgent
        ? buildAgentEntry(mainAgent, defaultPrimaryModel)
        : {
            id: 'main',
            default: true,
            model: {
              primary: defaultPrimaryModel,
            },
          },
      ...buildManagedAgentEntries({
        agents,
        fallbackPrimaryModel: defaultPrimaryModel,
        stateDir,
      }),
    ];

    return list.length > 0 ? { list } : {};
  }

  /**
   * Build the `bindings` config array for openclaw.json.
   *
   * Each IM platform can be independently bound to a different agent via
   * `IMSettings.platformAgentBindings`.  Only channels with an explicit
   * non-main binding produce an entry.
   */
  private buildBindings(): { bindings?: Array<Record<string, unknown>> } {
    const imSettings = this.getIMSettings?.();
    const platformBindings = imSettings?.platformAgentBindings;
    if (!platformBindings || Object.keys(platformBindings).length === 0) return {};

    const agents = this.getAgents?.() ?? [];

    const bindings: Array<Record<string, unknown>> = [];

    // Handle per-instance bindings for multi-instance platforms
    const multiInstanceChannels: Record<string, { channel: string; getInstances: () => Array<{ instanceId: string; enabled: boolean; appKey?: string; account?: string; nimToken?: string }> }> = {
      dingtalk: { channel: DINGTALK_OPENCLAW_CHANNEL, getInstances: () => this.getDingTalkInstances() },
      feishu: { channel: 'feishu', getInstances: () => this.getFeishuInstances() },
      qq: { channel: 'qqbot', getInstances: () => this.getQQInstances() },
      nim: { channel: 'nim', getInstances: () => this.getNimInstances() },
      wecom: { channel: 'wecom', getInstances: () => this.getWecomInstances() },
      telegram: { channel: 'telegram', getInstances: () => this.getTelegramInstances() },
      discord: { channel: 'discord', getInstances: () => this.getDiscordInstances() },
    };

    for (const [platform, { channel, getInstances }] of Object.entries(multiInstanceChannels)) {
      try {
        const instances = getInstances();
        for (const inst of instances) {
          if (!inst.enabled) continue;
          // Check for per-instance binding: `platform:instanceId`
          const bindingKey = `${platform}:${inst.instanceId}`;
          const agentId = platformBindings[bindingKey];
          if (!agentId || agentId === 'main') continue;
          const targetAgent = agents.find(a => a.id === agentId && a.enabled);
          if (!targetAgent) continue;
          const accountId = platform === 'nim'
            ? deriveNimAccountId(inst as NimInstanceConfig)
            : inst.instanceId.slice(0, 8);
          if (!accountId) continue;
          bindings.push({ agentId, match: { channel, accountId } });
        }
        // Also check legacy platform-level binding
        const platformAgentId = platformBindings[platform];
        if (platformAgentId && platformAgentId !== 'main') {
          const targetAgent = agents.find(a => a.id === platformAgentId && a.enabled);
          if (targetAgent && instances.some(i => i.enabled)) {
            bindings.push({ agentId: platformAgentId, match: { channel } });
          }
        }
      } catch {
        // Skip platforms that fail to load config
      }
    }

    // Handle single-instance platforms
    const singleInstanceChannels: Array<{
      getter: () => { enabled: boolean } | null;
      channel: string;
      platform: string;
    }> = [
      { getter: () => this.getPopoConfig(), channel: 'moltbot-popo', platform: 'popo' },
      { getter: () => this.getNeteaseBeeChanConfig(), channel: 'netease-bee', platform: 'netease-bee' },
      { getter: () => this.getWeixinConfig(), channel: 'openclaw-weixin', platform: 'weixin' },
    ];

    for (const { getter, channel, platform } of singleInstanceChannels) {
      const agentId = platformBindings[platform];
      if (!agentId || agentId === 'main') continue;

      const targetAgent = agents.find(a => a.id === agentId && a.enabled);
      if (!targetAgent) continue;

      try {
        const cfg = getter();
        if (cfg?.enabled) {
          bindings.push({ agentId, match: { channel } });
        }
      } catch {
        // Skip channels that fail to load config
      }
    }

    return bindings.length > 0 ? { bindings } : {};
  }

  /**
   * Sync workspace files (SOUL.md, IDENTITY.md, AGENTS.md) for each non-main agent.
   * The main agent's workspace is synced by `syncAgentsMd`. Non-main agents
   * get their own workspace directories under the openclaw state directory.
   */
  private syncPerAgentWorkspaces(_mainWorkspaceDir: string, coworkConfig: CoworkConfig): void {
    const agents = this.getAgents?.() ?? [];
    // Use the openclaw state directory as base, matching OpenClaw's own fallback
    // logic: {STATE_DIR}/workspace-{agentId}/
    const stateDir = this.engineManager.getStateDir();

    for (const agent of agents) {
      if (agent.id === 'main' || !agent.enabled) continue;

      const agentWorkspace = path.join(stateDir, `workspace-${agent.id}`);
      try {
        ensureDir(agentWorkspace);

        // Sync SOUL.md — agent's system prompt
        const soulPath = path.join(agentWorkspace, 'SOUL.md');
        const soulContent = (agent.systemPrompt || '').trim();
        this.syncFileIfChanged(soulPath, soulContent ? `${soulContent}\n` : '');

        // Sync IDENTITY.md — agent's identity description
        const identityPath = path.join(agentWorkspace, 'IDENTITY.md');
        const identityContent = (agent.identity || '').trim();
        this.syncFileIfChanged(identityPath, identityContent ? `${identityContent}\n` : '');

        // Sync AGENTS.md for this agent (reuse same logic as main agent)
        this.syncAgentsMd(agentWorkspace, {
          ...coworkConfig,
          systemPrompt: agent.systemPrompt || '',
        });

        // Ensure memory directory exists
        const memoryDir = path.join(agentWorkspace, 'memory');
        ensureDir(memoryDir);

        // Ensure MEMORY.md exists
        const memoryPath = path.join(agentWorkspace, 'MEMORY.md');
        if (!fs.existsSync(memoryPath)) {
          fs.writeFileSync(memoryPath, '', 'utf8');
        }
      } catch (error) {
        console.warn(
          `[OpenClawConfigSync] Failed to sync workspace for agent ${agent.id}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  /** Write a file only if its content has changed. */
  private syncFileIfChanged(filePath: string, content: string): void {
    try {
      const existing = fs.readFileSync(filePath, 'utf8');
      if (existing === content) return;
    } catch {
      // File doesn't exist yet
    }
    if (content) {
      this.atomicWriteFile(filePath, content);
    } else {
      // Empty content — create empty file if it doesn't exist
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '', 'utf8');
      }
    }
  }

  /** Atomic file write via tmp + rename, consistent with openclaw.json writes. */
  private atomicWriteFile(filePath: string, content: string): void {
    const tmpPath = `${filePath}.tmp-${Date.now()}`;
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * Write a minimal openclaw.json that lets the gateway start without any
   * model/provider configured.  The full config will be synced once the
   * user sets up a model in the UI.
   */
  private writeMinimalConfig(configPath: string, _reason: string): OpenClawConfigSyncResult {
    const baseMinimalConfig: Record<string, unknown> = {
      gateway: {
        mode: 'local',
      },
      // Don't enable plugins in minimal config — plugin loading via jiti happens
      // synchronously BEFORE the HTTP server binds, and can block gateway startup
      // for minutes on a fresh install.  Plugins will be enabled when the user
      // configures an API model and a full config sync runs.
    };

    let currentContent = '';
    try {
      currentContent = fs.readFileSync(configPath, 'utf8');
    } catch {
      currentContent = '';
    }

    // Build the config to write: start from the base minimal config, then
    // selectively preserve non-provider sections from the existing file.
    // Critically, we do NOT preserve existing.models — it may contain
    // ${LOBSTER_APIKEY_X} placeholders for providers that are no longer
    // configured, causing the gateway to fail to start because those env
    // vars are no longer injected.
    let mergedConfig: Record<string, unknown> = { ...baseMinimalConfig };
    if (currentContent) {
      try {
        const existing = JSON.parse(currentContent);
        // Preserve IM channel plugin entries — these reference their own env
        // vars (${LOBSTER_TG_BOT_TOKEN} etc.) that are still injected when
        // the corresponding IM channels remain enabled.
        if (existing.plugins) {
          mergedConfig.plugins = existing.plugins;
        }
        // Preserve non-default gateway settings (e.g. custom port).
        if (existing.gateway && existing.gateway.mode !== 'local') {
          mergedConfig.gateway = existing.gateway;
        }
        // existing.models is intentionally NOT preserved — it references
        // ${LOBSTER_APIKEY_*} env vars that may no longer be set.
      } catch {
        // Malformed JSON — overwrite with base minimal config.
      }
    }

    const nextContent = `${JSON.stringify(mergedConfig, null, 2)}\n`;

    if (currentContent === nextContent) {
      return { ok: true, changed: false, configPath };
    }

    try {
      ensureDir(path.dirname(configPath));
      const tmpPath = `${configPath}.tmp-${Date.now()}`;
      fs.writeFileSync(tmpPath, nextContent, 'utf8');
      fs.renameSync(tmpPath, configPath);
      return { ok: true, changed: true, configPath };
    } catch (error) {
      return {
        ok: false,
        changed: false,
        configPath,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
