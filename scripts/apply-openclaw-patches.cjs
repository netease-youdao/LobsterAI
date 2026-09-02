'use strict';

/**
 * Apply version-specific LobsterAI patches to the openclaw source tree.
 *
 * Patches are organised in scripts/patches/<version>/ directories, where
 * <version> matches the "openclaw.version" field in package.json (e.g.
 * "v2026.3.2").  Only patches for the currently pinned version are applied.
 *
 * Usage:
 *   node scripts/apply-openclaw-patches.cjs [openclaw-src-dir]
 *
 * If openclaw-src-dir is not specified, OPENCLAW_SRC is used when present,
 * otherwise the source defaults to ../openclaw relative to the LobsterAI
 * project root.
 *
 * Safe to run multiple times — already-applied patches are skipped.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const openclawSrc = process.argv[2]
  ? path.resolve(process.argv[2])
  : process.env.OPENCLAW_SRC
    ? path.resolve(process.env.OPENCLAW_SRC)
    : path.resolve(rootDir, '..', 'openclaw');

// Read pinned openclaw version from package.json.
const pkg = require(path.join(rootDir, 'package.json'));
const openclawVersion = pkg.openclaw && pkg.openclaw.version;
if (!openclawVersion) {
  console.error('[apply-openclaw-patches] Missing "openclaw.version" in package.json.');
  process.exit(1);
}

const patchesDir = path.join(rootDir, 'scripts', 'patches', openclawVersion);

if (!fs.existsSync(openclawSrc)) {
  console.error(`[apply-openclaw-patches] openclaw source not found: ${openclawSrc}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(openclawSrc, 'package.json'))) {
  console.error(`[apply-openclaw-patches] Not an openclaw project: ${openclawSrc}`);
  process.exit(1);
}

if (!fs.existsSync(patchesDir)) {
  console.log(`[apply-openclaw-patches] No patches directory for ${openclawVersion}, nothing to do.`);
  process.exit(0);
}

const patchFiles = fs.readdirSync(patchesDir)
  .filter(f => f.endsWith('.patch'))
  .sort();

if (patchFiles.length === 0) {
  console.log(`[apply-openclaw-patches] No patches found for ${openclawVersion}, nothing to do.`);
  process.exit(0);
}

console.log(`[apply-openclaw-patches] Applying patches for openclaw ${openclawVersion} (${patchFiles.length} file(s))`);

const legacyStrongPatchValidators = {
  'openclaw-terminate-run-on-critical-tool-loop.patch': [
    {
      file: 'packages/agent-core/src/agent.ts',
      snippets: [
        'ShouldStopAfterTurnContext',
        'this.shouldStopAfterTurn = options.shouldStopAfterTurn',
        'shouldStopAfterTurn: this.shouldStopAfterTurn',
      ],
    },
    {
      file: 'src/agents/agent-tools.before-tool-call.ts',
      snippets: [
        // zz-openclaw-tool-loop-soft-vetoes.patch rewrites this line to
        // `params.terminateRun ?? deniedReason === "tool-loop"`; validate the
        // stable core expression only.
        'deniedReason === "tool-loop"',
        '...(terminateRun ? { terminate: true } : {})',
      ],
    },
    {
      file: 'src/agents/sessions/sdk.ts',
      snippets: [
        'shouldStopAfterTurn: (context) => {',
        'details?.deniedReason === "tool-loop"',
      ],
    },
    {
      file: 'packages/agent-core/src/agent.critical-tool-loop.test.ts',
      snippets: [
        'stops a mixed parallel batch after normal sibling tools finish',
        'expect(providerTurns).toBe(1)',
        'expect(shouldStopCalls).toBe(1)',
      ],
    },
    {
      file: 'src/agents/agent-tools.before-tool-call.blocked-result.test.ts',
      snippets: [
        // Test name comes from zz-openclaw-tool-loop-soft-vetoes.patch, which
        // rewrites this file after the terminate patch creates it.
        'terminates tool-loop vetoes from legacy callers',
        'keeps %s vetoes non-terminating',
        'expect(result.terminate).toBe(true)',
      ],
    },
  ],
  'zz-openclaw-tool-loop-soft-vetoes.patch': [
    {
      file: 'src/agents/agent-tools.before-tool-call.ts',
      snippets: [
        'TOOL_LOOP_VETO_STREAK_TERMINATE_THRESHOLD',
        'appendLoopWarningToToolResult',
        'evaluateToolLoopGate',
      ],
    },
    {
      file: 'src/agents/tool-loop-detection.ts',
      snippets: [
        'hardStop: true',
        'Repeating the same blocked call will end this run.',
      ],
    },
    {
      file: 'src/agents/sessions/sdk.ts',
      snippets: [
        'details.terminateRun === true',
      ],
    },
    {
      file: 'src/logging/diagnostic-session-state.ts',
      snippets: [
        'toolLoopVetoStreaks',
      ],
    },
  ],
  'openclaw-stop-loop-after-aborted-tool-run.patch': [
    {
      file: 'packages/agent-core/src/agent-loop.ts',
      snippets: [
        'const stopIfAborted = async (): Promise<boolean> => {',
        'signal.reason instanceof Error ? signal.reason : new Error("Agent run aborted")',
        'await emit({ type: "turn_end", message: abortedMessage, toolResults: [] });',
        'if (await stopIfAborted())',
      ],
    },
    {
      file: 'packages/agent-core/src/agent-loop.test.ts',
      snippets: [
        'does not request another model turn after a tool aborts the run',
        'does not request another model turn when an async turn hook aborts the run',
        'expect(streamCalls).toBe(1)',
      ],
    },
  ],
  'openclaw-kimi-k3-support.patch': [
    {
      file: 'src/llm/providers/stream-wrappers/moonshot-thinking.ts',
      snippets: [
        'ensureMoonshotToolCallReasoningContent',
        'export function createMoonshotKimiK3Wrapper',
        'payload.reasoning_effort = "max"',
      ],
    },
    {
      file: 'src/config/zod-schema.core.ts',
      snippets: [
        'thinkingLevelMap: ThinkingLevelMapSchema',
      ],
    },
    {
      file: 'src/agents/sessions/model-registry.ts',
      snippets: [
        'Type.Literal("video")',
        'Type.Literal("audio")',
      ],
    },
    {
      file: 'src/config/zod-schema.models.test.ts',
      snippets: [
        'rejects an invalid thinking-level map: $label',
      ],
    },
    {
      file: 'src/plugin-sdk/provider-stream.test.ts',
      snippets: [
        'reapplies the K3 payload contract after an async caller replacement',
        'expect(callerSawReasoningContent).toBe("")',
      ],
    },
  ],
  'openclaw-lobsterai-model-compat-api.patch': [
    {
      file: 'src/config/types.models.ts',
      snippets: [
        'LOBSTERAI_MODEL_COMPAT_API = "lobsterai-model-compat"',
        'export const MODEL_TRANSPORT_APIS',
        'api?: ModelTransportApi',
      ],
    },
    {
      file: 'src/config/zod-schema.core.ts',
      snippets: [
        'const ModelTransportApiSchema = z.enum(MODEL_TRANSPORT_APIS)',
        'api: ModelTransportApiSchema.optional()',
      ],
    },
    {
      file: 'src/agents/embedded-agent-runner/model.inline-provider.test.ts',
      snippets: [
        'keeps a provider API owner out of model transport resolution',
        'api: "lobsterai-model-compat"',
      ],
    },
    {
      file: 'src/config/zod-schema.model-api-owner.test.ts',
      snippets: [
        'rejects arbitrary provider API owner strings',
        'rejects recursive model-level compatibility ownership',
      ],
    },
  ],
  'openclaw-openai-compatible-replay-errors.patch': [
    {
      file: 'src/llm/utils/provider-error.ts',
      snippets: [
        'export function formatProviderError',
        'const MAX_ERROR_BODY_LENGTH = 4000',
      ],
    },
    {
      file: 'src/llm/providers/transform-messages.null-content.test.ts',
      snippets: [
        'normalizes null or missing content before provider transforms',
      ],
    },
    {
      file: 'src/llm/providers/openai-completions.test.ts',
      snippets: [
        'surfaces HTTP response body text from OpenAI-compatible errors',
      ],
    },
  ],
  'openclaw-repeated-tool-call-id.patch': [
    {
      file: 'src/agents/session-transcript-repair.ts',
      snippets: [
        'type ToolCallOccurrence = {',
        'function buildToolUseFrames',
        'Provider ids are opaque and can legitimately repeat',
      ],
    },
    {
      file: 'src/agents/embedded-agent-runner/replay-history.ts',
      snippets: [
        'sanitizeToolCallIds: false',
        'const pairedToolCalls =',
      ],
    },
    {
      file: 'src/agents/embedded-agent-runner/run/attempt.tool-call-normalization.test.ts',
      snippets: [
        'pairs repeated raw ids before assigning provider-safe occurrence ids',
        'keeps same-turn repeated calls and results aligned after id rewriting',
      ],
    },
    {
      file: 'src/agents/transport-message-transform.test.ts',
      snippets: [
        "does not reassign a dropped errored turn's repeated-id result to an older turn",
      ],
    },
  ],
  'openclaw-dashscope-context-cache.patch': [
    {
      file: 'src/agents/embedded-agent-runner/prompt-cache-retention.ts',
      snippets: [
        'contextCacheProvider === "dashscope"',
        'contextCacheProvider === "anthropic-compatible"',
        'contextCacheMode === "explicit"',
        'explicitContextCacheEligible',
      ],
    },
    {
      file: 'src/llm/providers/openai-completions.ts',
      snippets: [
        'getCompatCacheControl(compat, cacheRetention, options)',
        'options?.contextCacheProvider === "dashscope"',
        'options?.contextCacheProvider === "anthropic-compatible"',
        'options?.contextCacheMode === "explicit"',
        'isOpenAICompatibleExplicitContextCache(options)',
        'EXPLICIT_CONTEXT_CACHE_LOG_PREFIX = "********************"',
        '[ExplicitCachePayload]',
        'hasCacheControl=',
        'cache_control: cacheControl',
        'return { type: "ephemeral", ...(ttl ? { ttl } : {}) };',
      ],
    },
    {
      file: 'src/agents/embedded-agent-runner/extra-params.ts',
      snippets: [
        'contextCacheProvider?: "dashscope" | "anthropic-compatible"',
        'contextCacheMode?: "explicit"',
        'resolveExplicitContextCacheStreamParams',
        'EXPLICIT_CONTEXT_CACHE_LOG_PREFIX = "********************"',
        '[ExplicitCachePassThrough]',
        '...explicitContextCacheParams',
      ],
    },
    {
      file: 'src/agents/openai-transport-stream.ts',
      snippets: [
        'contextCacheProvider?: string',
        'contextCacheMode?: string',
        'isOpenAICompatibleExplicitContextCache',
        'applyOpenAICompletionsExplicitContextCache',
        'EXPLICIT_CONTEXT_CACHE_LOG_PREFIX = "********************"',
        '[ExplicitCachePayload]',
        'cache_control: cacheControl',
      ],
    },
  ],
  'openclaw-user-turn-cache-stability.patch': [
    {
      file: 'src/agents/embedded-agent-runner/run/attempt.llm-boundary.ts',
      snippets: [
        'canonicalizeTextOnlyUserContent',
        'stampUserTextWithMessageTimestamp',
        'currentUserTimestampOverride',
      ],
    },
    {
      file: 'src/gateway/server-methods/agent-timestamp.ts',
      snippets: ['export function buildTimestampPrefix'],
    },
    {
      file: 'src/gateway/server-methods/chat.ts',
      snippets: ['BodyForAgent: messageForAgent'],
    },
    {
      file: 'src/agents/embedded-agent-runner/run/attempt.llm-boundary.cache-stability.test.ts',
      snippets: ['prompt-cache byte-identity', 'turn1AsCurrent', 'turn1AsHistorical'],
    },
  ],
  'openclaw-live-tool-result-cache-stability.patch': [
    {
      file: 'src/agents/embedded-agent-runner/run/attempt.ts',
      snippets: [
        'truncateOversizedToolResultsInMessages(\n            activeSession.messages,',
        'promptToolResultMaxChars,\n            null,',
        'truncateOversizedToolResultsInMessages(\n                    messages,\n                    contextTokenBudget,\n                    promptToolResultMaxChars,\n                    null,',
      ],
      forbiddenSnippets: [
        'promptToolResultMaxChars * PROMPT_TOOL_RESULT_AGGREGATE_CAP_MULTIPLIER',
      ],
    },
    {
      file: 'src/agents/embedded-agent-runner/tool-result-truncation.ts',
      snippets: [
        'aggregateMaxCharsOverride?: number | null',
        'aggregateMaxCharsOverride === null',
        'Number.POSITIVE_INFINITY',
      ],
    },
    {
      file: 'src/agents/embedded-agent-runner/tool-result-truncation.test.ts',
      snippets: ['keeps prompt projections byte-stable as history grows'],
    },
  ],
  'zz-openclaw-task-cwd-system-prompt.patch': [
    {
      file: 'src/agents/system-prompt.ts',
      snippets: [
        'runtimeCwd?: string',
        'const hasSeparateRuntimeCwd =',
        '"## Directory Roles"',
        '`Task working directory: ${sanitizedRuntimeCwd}`',
        '`Agent workspace: ${sanitizedWorkspaceDir}`',
        'MEMORY.md, and memory/**',
        'runtimeCwd: sanitizedRuntimeCwd',
      ],
    },
    {
      file: 'src/agents/embedded-agent-runner/system-prompt.ts',
      snippets: ['runtimeCwd?: string', 'runtimeCwd: params.runtimeCwd'],
    },
    {
      file: 'src/agents/embedded-agent-runner/run/attempt.ts',
      snippets: ['workspaceDir: effectiveWorkspace,\n        runtimeCwd: effectiveCwd,'],
    },
    {
      file: 'src/agents/embedded-agent-runner/compact.ts',
      snippets: ['workspaceDir: effectiveWorkspace,\n        runtimeCwd: effectiveCwd,'],
    },
    {
      file: 'src/agents/system-prompt.test.ts',
      snippets: [
        'separates the task working directory from the persistent agent workspace',
        'preserves workspace guidance when task cwd is not separate',
      ],
    },
    {
      file: 'src/agents/embedded-agent-runner/run/attempt.cwd-split.test.ts',
      snippets: ['expect(promptCall?.runtimeCwd).toBe(taskRepo)'],
    },
  ],
};

const v20260801StrongPatchValidators = {
  'openclaw-aborted-tool-loop-breaker.patch': [
    {
      file: 'src/agents/embedded-agent-runner/replay-history.ts',
      snippets: [
        'MAX_PRESERVED_ABORTED_TOOL_HISTORY_PAIRS = 3',
        'function sanitizeAbortedToolLoopHistory',
        'const sanitizedAbortedToolLoops = sanitizeAbortedToolLoopHistory',
      ],
    },
    {
      file: 'src/agents/tool-loop-detection.ts',
      snippets: [
        'ABORTED_TOOL_LOOP_CRITICAL_THRESHOLD = 8',
        'ABORTED_TOOL_LOOP_TOTAL_THRESHOLD = 20',
        'if (abortedLoop.total >= ABORTED_TOOL_LOOP_TOTAL_THRESHOLD)',
      ],
    },
    {
      file: 'src/agents/tool-loop-detection.test.ts',
      snippets: ['blocks repeated aborted tool results before the generic critical threshold'],
    },
  ],
  'openclaw-browser-blocked-hostnames.patch': [
    {
      file: 'extensions/browser/src/browser/config.ts',
      snippets: ['blockedHostnames: normalizeStringList(rawPolicy?.blockedHostnames)'],
    },
    {
      file: 'src/infra/net/ssrf.ts',
      snippets: [
        'blockedHostnames?: string[]',
        'function isHostnameBlockedByPolicy',
        'Blocked hostname (configured blocklist)',
      ],
    },
    {
      file: 'src/infra/net/ssrf.pinning.test.ts',
      snippets: ['blocks configured hostnames before DNS lookup', 'supports wildcard hostname blocklist patterns'],
    },
  ],
  'openclaw-chat-send-cwd-decoupling.patch': [
    {
      file: 'packages/gateway-protocol/src/schema/logs-chat.ts',
      snippets: ['cwd: Type.Optional(Type.String())'],
    },
    {
      file: 'src/gateway/server-methods/chat-send-agent-dispatch.ts',
      snippets: ['cwd: normalizeOptionalText(p.cwd)'],
    },
    {
      file: 'packages/gateway-protocol/src/index.test.ts',
      snippets: ['cwd: "/tmp/work"'],
    },
  ],
  'openclaw-cli-startup-metadata-windows-timeout.patch': [
    {
      file: 'scripts/write-cli-startup-metadata.ts',
      snippets: [
        'Cold plugin discovery can exceed two minutes when two help renders contend on Windows.',
        'process.platform === "win32" ? 300_000 : 120_000',
      ],
    },
  ],
  'openclaw-cron-skip-missed-jobs.patch': [
    {
      file: 'src/config/types.cron.ts',
      snippets: ['skipMissedJobs?: boolean'],
    },
    {
      file: 'src/cron/service/timer-catchup.ts',
      snippets: [
        'function fastForwardMissedRecurringJobs',
        'state.deps.cronConfig?.skipMissedJobs === true',
      ],
    },
    {
      file: 'src/cron/service/timer.skip-missed-jobs.test.ts',
      snippets: ['fast-forwards missed recurring jobs instead of replaying them'],
    },
  ],
  'openclaw-im-bound-agent-run-cwd.patch': [
    {
      file: 'src/agents/agent-scope-config.ts',
      snippets: ['export function resolveAgentRunCwd', 'cfg.agents?.defaults?.cwd?.trim()'],
    },
    {
      file: 'src/auto-reply/reply/get-reply.ts',
      snippets: [
        'resolveAgentRunCwd(cfg, agentId, optsWithCommandQueueOverride?.cwd) ?? workspaceDir',
        'cwd: runCwd',
      ],
    },
    {
      file: 'src/config/zod-schema.agent-runtime.ts',
      snippets: ['cwd: z.string().optional()'],
    },
  ],
  'openclaw-lancedb-optional-transformers.patch': [
    {
      file: 'pnpm-workspace.yaml',
      snippets: ['"@lancedb/lancedb>@huggingface/transformers": "-"'],
    },
    {
      file: 'pnpm-lock.yaml',
      snippets: ["'@lancedb/lancedb>@huggingface/transformers': '-'"],
      forbiddenSnippets: [
        "'@huggingface/transformers@3.0.2':",
        'onnxruntime-node@1.19.2:',
      ],
    },
  ],
  'openclaw-lobsterai-model-compat-api.patch': [
    {
      file: 'src/config/types.models.ts',
      snippets: [
        'LOBSTERAI_MODEL_COMPAT_API = "lobsterai-model-compat"',
        'export const MODEL_TRANSPORT_APIS',
        'export const MODEL_APIS = [...MODEL_TRANSPORT_APIS, LOBSTERAI_MODEL_COMPAT_API]',
      ],
    },
    {
      file: 'src/agents/embedded-agent-runner/model.inline-provider.ts',
      snippets: ['function resolveInlineProviderTransport'],
    },
    {
      file: 'src/config/zod-schema.model-api-owner.test.ts',
      snippets: [
        'accepts the LobsterAI owner while models keep explicit transports',
        'rejects compatibility ownership at model level',
      ],
    },
  ],
  'openclaw-openai-compatible-cache-control.patch': [
    {
      file: 'packages/ai/src/transports/openai-completions-params.ts',
      snippets: [
        'function resolveAnthropicCacheControl',
        'compat.cacheControlFormat !== "anthropic"',
        'function applyAnthropicCacheControl',
        'preserveSystemPromptCacheBoundary: cacheControl !== undefined',
      ],
    },
    {
      file: 'packages/ai/src/transports/openai-completions-params.cache-and-compat.test.ts',
      snippets: ['adds Anthropic cache-control markers for opted-in compatible providers'],
    },
  ],
  'openclaw-plugin-archive-windows-timeout.patch': [
    {
      file: 'src/plugins/install-package.ts',
      snippets: [
        'Large signed plugin archives can take several minutes to scan and unpack on Windows.',
        'DEFAULT_PLUGIN_ARCHIVE_TIMEOUT_MS = process.platform === "win32" ? 900_000 : 120_000',
        'params.timeoutMs ?? DEFAULT_PLUGIN_ARCHIVE_TIMEOUT_MS',
      ],
    },
  ],
  'openclaw-provider-auth-warm-cooperative-exit.patch': [
    {
      file: 'src/agents/model-provider-auth.ts',
      snippets: [
        'PROVIDER_AUTH_WARM_EXIT_GRACE_MS = 2_000',
        'const terminateFallback = setTimeout',
      ],
    },
    {
      file: 'src/agents/model-provider-auth.worker.ts',
      snippets: ['Avoid an Electron worker-isolate teardown race', 'process.exit(0)'],
    },
  ],
  'openclaw-provider-fetch-transient-retry.patch': [
    {
      file: 'src/agents/provider-transport-fetch.ts',
      snippets: [
        'TRANSIENT_PROVIDER_FETCH_RETRY_DELAY_MS = 750',
        'function isTransientProviderFetchTransportError',
        'function shouldRetryProviderFetch',
        '[model-fetch] transient transport failure; retrying provider=',
      ],
    },
    {
      file: 'src/agents/provider-transport-fetch.test.ts',
      snippets: [
        'retries a replayable request once after a transient transport failure',
        'does not retry a transient failure when the body cannot be replayed',
      ],
    },
  ],
  'openclaw-run-failure-detail.patch': [
    {
      file: 'src/auto-reply/reply/agent-runner-failure-reply.ts',
      snippets: ['text: formatForwardedExternalRunFailureText(normalizedMessage)'],
      forbiddenSnippets: ['options?.includeDetails\n      ? formatForwardedExternalRunFailureText'],
    },
    {
      file: 'src/auto-reply/reply/agent-runner-failure-reply.test.ts',
      snippets: ['forwards sanitized failure detail even when verbose details are not requested'],
    },
  ],
  'openclaw-safe-error-metadata.patch': [
    {
      file: 'src/agents/embedded-agent-subscribe.handlers.lifecycle.ts',
      snippets: ['let lifecycleErrorMetadata', '...lifecycleErrorMetadata'],
    },
    {
      file: 'src/gateway/server-chat.ts',
      snippets: [
        'const SAFE_CHAT_ERROR_METADATA_KEYS = [',
        'function extractSafeChatErrorMetadata',
        'errorMetadata: extractSafeChatErrorMetadata(evt.data)',
      ],
    },
    {
      file: 'src/agents/embedded-agent-subscribe.handlers.lifecycle.test.ts',
      snippets: ['providerRuntimeFailureKind: "timeout"', 'providerErrorType: "overloaded_error"'],
    },
  ],
  'openclaw-session-goal-rpc.patch': [
    {
      file: 'packages/gateway-protocol/src/schema/sessions-goal.ts',
      snippets: ['SessionsGoalCompatParamsSchema', 'Type.Literal("blocked")'],
    },
    {
      file: 'src/gateway/server-methods/sessions-goal.ts',
      snippets: [
        'async function handleSessionGoalCompat',
        'method: "sessions.goal"',
        'createSessionGoal',
        'updateSessionGoalStatus',
      ],
    },
    {
      file: 'src/gateway/server-methods/sessions-goal.test.ts',
      snippets: ['keeps the LobsterAI compatibility RPC as a mutation-only Goal surface'],
    },
  ],
  'openclaw-shell-snapshot-electron-node-env.patch': [
    {
      file: 'src/agents/shell-snapshot.ts',
      snippets: [
        'const IS_ELECTRON_RUNTIME = Boolean(process.versions.electron)',
        'function buildEnvCaptureNodeCommand',
        'ELECTRON_RUN_AS_NODE=1',
      ],
    },
  ],
  'openclaw-skip-disabled-web-search-discovery.patch': [
    {
      file: 'src/secrets/runtime-web-tools.ts',
      snippets: [
        'const searchEnabled = search?.enabled !== false',
        'searchEnabled && hasPluginWebSearchConfig',
        'searchEnabled && (search || hasPluginWebSearchConfig)',
      ],
      forbiddenSnippets: ['if (search || hasPluginWebSearchConfig)'],
    },
    {
      file: 'src/secrets/runtime-fast-path.ts',
      snippets: [
        'const searchExplicitlyDisabled = web?.search?.enabled === false',
        '"search" in webRecord && !searchExplicitlyDisabled',
      ],
    },
    {
      file: 'src/secrets/runtime-web-tools.test.ts',
      snippets: ['skips provider discovery when web search is explicitly disabled'],
    },
    {
      file: 'src/secrets/runtime.fast-path.test.ts',
      snippets: ['uses the fast path when web %s is explicitly disabled'],
    },
  ],
  'openclaw-skip-derive-prompt-segments-deadloop.patch': [
    {
      file: 'src/auto-reply/reply/agent-runner-result-complete.ts',
      snippets: [
        'Prompt segmentation is trace-only',
        'const promptSegments = runResult.meta?.promptSegments',
      ],
      forbiddenSnippets: ['derivePromptSegments(rawUserText)'],
    },
  ],
  'openclaw-subagent-cleanup-finalize-best-effort.patch': [
    {
      file: 'src/agents/subagents/registry/subagent-registry-lifecycle-announce-cleanup.ts',
      snippets: [
        'const emitCompletionEndedHookBestEffort',
        'failed to emit subagent ended hook during cleanup',
        '"announced-cleanup-finalize"',
      ],
    },
    {
      file: 'src/shared/runtime-import.ts',
      snippets: ['GATEWAY_BUNDLE_BASENAME = "gateway-bundle.mjs"', './dist/${joined.slice(2)}'],
    },
    {
      file: 'src/agents/subagents/registry/subagent-registry-lifecycle.test.ts',
      snippets: ['does not reject cleanup after bookkeeping when the ended hook throws'],
    },
  ],
  'openclaw-windows-file-path-redaction.patch': [
    {
      file: 'src/logging/redact-patterns.ts',
      snippets: [
        'const AWS_SECRET_ACCESS_KEY_VALUE_BOUNDARY = String.raw`(^|[^A-Za-z0-9/+=_])(?<!;base64,[A-Za-z0-9+/=]*)(?<![A-Za-z]:)`;',
      ],
    },
    {
      file: 'src/logging/redact.test.ts',
      snippets: ['const windowsPath = "C:/Users/tester/lobsterai/project/chinajoy-ppt/deck.pptx"'],
    },
  ],
  'zz-openclaw-task-cwd-system-prompt.patch': [
    {
      file: 'src/agents/system-prompt.ts',
      snippets: [
        'runtimeCwd?: string',
        'const hasSeparateRuntimeCwd =',
        '"## Directory Roles"',
        '`Task working directory: ${sanitizedRuntimeCwd}`',
      ],
    },
    {
      file: 'src/agents/embedded-agent-runner/run/attempt-system-prompt-prepare.ts',
      snippets: ['runtimeCwd: params.effectiveCwd'],
    },
    {
      file: 'src/agents/embedded-agent-runner/prepared-compaction-runtime.ts',
      snippets: ['runtimeCwd: effectiveCwd'],
    },
    {
      file: 'src/agents/embedded-agent-runner/run/attempt.cwd-split.test.ts',
      snippets: ['expect(promptCall?.runtimeCwd).toBe(taskRepo)'],
    },
  ],
};

const strongPatchValidators = openclawVersion === 'v2026.8.1'
  ? v20260801StrongPatchValidators
  : legacyStrongPatchValidators;

function collectMissingStrongPatchSnippets(patchFile) {
  const validators = strongPatchValidators[patchFile];
  if (!validators) {
    return [];
  }

  const missing = [];
  for (const validator of validators) {
    const targetPath = path.join(openclawSrc, validator.file);
    if (!fs.existsSync(targetPath)) {
      missing.push(`${validator.file}: file not found`);
      continue;
    }

    const source = fs.readFileSync(targetPath, 'utf8');
    for (const snippet of validator.snippets) {
      if (!source.includes(snippet)) {
        missing.push(`${validator.file}: missing ${JSON.stringify(snippet)}`);
      }
    }
    for (const snippet of validator.forbiddenSnippets ?? []) {
      if (source.includes(snippet)) {
        missing.push(`${validator.file}: contains forbidden ${JSON.stringify(snippet)}`);
      }
    }
    let orderedSearchOffset = 0;
    for (const snippet of validator.orderedSnippets ?? []) {
      const index = source.indexOf(snippet, orderedSearchOffset);
      if (index < 0) {
        missing.push(`${validator.file}: missing ordered ${JSON.stringify(snippet)}`);
        break;
      }
      orderedSearchOffset = index + snippet.length;
    }
  }
  return missing;
}

function isStrongPatchApplied(patchFile) {
  return collectMissingStrongPatchSnippets(patchFile).length === 0;
}

function assertStrongPatchApplied(patchFile) {
  const missing = collectMissingStrongPatchSnippets(patchFile);
  if (missing.length === 0) {
    return;
  }

  console.error(`[apply-openclaw-patches] Strong validation failed for ${patchFile}.`);
  console.error('[apply-openclaw-patches] The patch was not applied to the actual OpenClaw source tree:');
  for (const item of missing) {
    console.error(`[apply-openclaw-patches]   - ${item}`);
  }
  process.exit(1);
}

// Reset openclaw source to a clean tag state before applying patches.
// This removes stale patches left by a different LobsterAI branch that may have
// applied different patches for the same openclaw version.
try {
  execFileSync('git', ['reset', 'HEAD', '.'], { cwd: openclawSrc, stdio: 'pipe' });
  execFileSync('git', ['checkout', '.'], { cwd: openclawSrc, stdio: 'pipe' });
  execFileSync('git', ['clean', '-fd'], { cwd: openclawSrc, stdio: 'pipe' });
  console.log('[apply-openclaw-patches] Reset openclaw source to clean state before patching.');
} catch (err) {
  console.warn(`[apply-openclaw-patches] Warning: failed to reset openclaw source: ${err.message}`);
}

let applied = 0;
let skipped = 0;

for (const patchFile of patchFiles) {
  const originalPatchPath = path.join(patchesDir, patchFile);

  // Normalize line endings: strip \r so that CRLF-checked-out patches don't
  // cause "corrupt patch" errors on Windows (git apply rejects \r in diffs).
  const raw = fs.readFileSync(originalPatchPath, 'utf8');
  const needsNormalize = raw.includes('\r');
  let patchPath = originalPatchPath;
  if (needsNormalize) {
    patchPath = path.join(os.tmpdir(), `lobsterai-patch-${patchFile}`);
    fs.writeFileSync(patchPath, raw.replace(/\r/g, ''), 'utf8');
  }

  try {
    // Check if patch is already applied.
    //
    // Strategy:
    //   1. Try `git apply --check --reverse` — if it succeeds the patch is applied.
    //   2. Try `git apply --check` (forward) — if it succeeds the patch is NOT applied.
    //   3. If BOTH fail, the patch is partially/fully applied (e.g. new files already
    //      exist and modified hunks already match).  Treat as already applied.
    //
    // This avoids fragile regex parsing of patch contents and works regardless of
    // line-ending differences (CRLF vs LF).

    let reverseOk = false;
    try {
      execFileSync('git', ['apply', '--check', '--reverse', '--ignore-whitespace', patchPath], {
        cwd: openclawSrc,
        stdio: 'pipe',
      });
      reverseOk = true;
    } catch {
      // reverse check failed — patch may or may not be applied
    }

    if (reverseOk) {
      console.log(`[apply-openclaw-patches] Already applied: ${patchFile}`);
      skipped++;
      continue;
    }

    // Try forward apply check.
    let forwardErr = null;
    try {
      execFileSync('git', ['apply', '--check', '--ignore-whitespace', patchPath], {
        cwd: openclawSrc,
        stdio: 'pipe',
      });
    } catch (err) {
      forwardErr = err;
    }

    if (forwardErr) {
      // Both reverse and forward checks failed.  This typically means the patch
      // is already applied but git can't cleanly reverse it (e.g. new files are
      // untracked, or the working tree has the changes but they aren't committed).
      const stderr = forwardErr.stderr ? forwardErr.stderr.toString() : '';
      const alreadyExists = stderr.includes('already exists in working directory');
      const patchDoesNotApply = stderr.includes('patch does not apply');

      if (alreadyExists || patchDoesNotApply) {
        if (strongPatchValidators[patchFile] && !isStrongPatchApplied(patchFile)) {
          console.error(`[apply-openclaw-patches] Patch check was ambiguous for ${patchFile}, but required source sentinels are missing.`);
          assertStrongPatchApplied(patchFile);
        }
        console.log(`[apply-openclaw-patches] Already applied (forward check confirms): ${patchFile}`);
        skipped++;
        continue;
      }

      // Genuinely cannot apply — report error.
      console.error(`[apply-openclaw-patches] Patch does not apply cleanly: ${patchFile}`);
      console.error(`[apply-openclaw-patches] This usually means the openclaw version has changed.`);
      console.error(`[apply-openclaw-patches] Regenerate patches or update to match the new source.`);
      if (stderr) console.error(stderr);
      process.exit(1);
    }

    // Apply the patch.
    try {
      execFileSync('git', ['apply', '--ignore-whitespace', patchPath], {
        cwd: openclawSrc,
        stdio: 'pipe',
      });
      console.log(`[apply-openclaw-patches] Applied: ${patchFile}`);
      applied++;
    } catch (err) {
      console.error(`[apply-openclaw-patches] Failed to apply: ${patchFile}`);
      const stderr = err.stderr ? err.stderr.toString() : '';
      if (stderr) console.error(stderr);
      process.exit(1);
    }
  } finally {
    // Clean up temporary normalized patch file.
    if (needsNormalize && fs.existsSync(patchPath)) {
      try { fs.unlinkSync(patchPath); } catch {}
    }
  }
}

for (const patchFile of patchFiles) {
  assertStrongPatchApplied(patchFile);
}

console.log(`[apply-openclaw-patches] Done. Applied: ${applied}, Skipped (already applied): ${skipped}`);
