import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';

import {
  expectCurrentOpenClawPatchMissing,
  expectPatchContains,
  getCurrentOpenClawPatchDir,
} from './patchTestUtils';

const RETAINED_PATCHES = [
  'openclaw-aborted-tool-loop-breaker.patch',
  'openclaw-browser-blocked-hostnames.patch',
  'openclaw-chat-send-cwd-decoupling.patch',
  'openclaw-cli-startup-metadata-windows-timeout.patch',
  'openclaw-cron-skip-missed-jobs.patch',
  'openclaw-im-bound-agent-run-cwd.patch',
  'openclaw-lancedb-optional-transformers.patch',
  'openclaw-lobsterai-model-compat-api.patch',
  'openclaw-openai-compatible-cache-control.patch',
  'openclaw-plugin-archive-windows-timeout.patch',
  'openclaw-provider-auth-warm-cooperative-exit.patch',
  'openclaw-provider-fetch-transient-retry.patch',
  'openclaw-run-failure-detail.patch',
  'openclaw-safe-error-metadata.patch',
  'openclaw-session-goal-rpc.patch',
  'openclaw-shell-snapshot-electron-node-env.patch',
  'openclaw-skip-derive-prompt-segments-deadloop.patch',
  'openclaw-subagent-cleanup-finalize-best-effort.patch',
  'openclaw-windows-file-path-redaction.patch',
  'zz-openclaw-task-cwd-system-prompt.patch',
] as const;

const RETIRED_PATCHES = [
  'openclaw-codex-missing-content-type-sse.patch',
  'openclaw-current-model-session-status-prompt.patch',
  'openclaw-empty-sse-data.patch',
  'openclaw-kimi-k3-support.patch',
  'openclaw-live-tool-result-cache-stability.patch',
  'openclaw-mcp-shared-runtime.patch',
  'openclaw-openai-compatible-replay-errors.patch',
  'openclaw-repeated-tool-call-id.patch',
  'openclaw-sessions-queue-steer-rpc.patch',
  'openclaw-stop-loop-after-aborted-tool-run.patch',
  'openclaw-terminate-run-on-critical-tool-loop.patch',
  'openclaw-user-turn-cache-stability.patch',
  'zz-openclaw-tool-loop-soft-vetoes.patch',
] as const;

describe('OpenClaw v2026.8.1 upgrade decisions', () => {
  test('ships exactly the reviewed 20-patch set', () => {
    const patchFiles = fs.readdirSync(getCurrentOpenClawPatchDir())
      .filter((file) => file.endsWith('.patch'))
      .sort();
    expect(patchFiles).toEqual([...RETAINED_PATCHES].sort());
  });

  test.each(RETIRED_PATCHES)('retires %s', (patchFile) => {
    expectCurrentOpenClawPatchMissing(patchFile);
  });

  test('keeps LobsterAI-specific reliability and Goal compatibility surfaces', () => {
    expectPatchContains('openclaw-lancedb-optional-transformers.patch', [
      '"@lancedb/lancedb>@huggingface/transformers": "-"',
      '-  onnxruntime-node@1.19.2:',
    ]);
    expectPatchContains('openclaw-cli-startup-metadata-windows-timeout.patch', [
      'process.platform === "win32" ? 300_000 : 120_000',
    ]);
    expectPatchContains('openclaw-plugin-archive-windows-timeout.patch', [
      'DEFAULT_PLUGIN_ARCHIVE_TIMEOUT_MS',
      'process.platform === "win32" ? 900_000 : 120_000',
      'params.timeoutMs ?? DEFAULT_PLUGIN_ARCHIVE_TIMEOUT_MS',
    ]);
    expectPatchContains('openclaw-provider-auth-warm-cooperative-exit.patch', [
      'PROVIDER_AUTH_WARM_EXIT_GRACE_MS',
    ]);
    expectPatchContains('openclaw-run-failure-detail.patch', [
      'formatForwardedExternalRunFailureText(normalizedMessage)',
    ]);
    expectPatchContains('openclaw-safe-error-metadata.patch', [
      'SAFE_CHAT_ERROR_METADATA_KEYS',
      'providerRuntimeFailureKind',
      'rawErrorHash',
    ]);
    expectPatchContains('openclaw-session-goal-rpc.patch', [
      'SessionsGoalCompatParamsSchema',
      'keeps the LobsterAI compatibility RPC as a mutation-only Goal surface',
    ]);
    expectPatchContains('openclaw-shell-snapshot-electron-node-env.patch', [
      'ELECTRON_RUN_AS_NODE=1',
    ]);
  });

  test('uses native chat.send steering instead of the retired custom RPC', () => {
    const adapter = fs.readFileSync(
      path.resolve('src/main/libs/agentEngine/openclawRuntimeAdapter.ts'),
      'utf8',
    );
    expect(adapter).toContain('OpenClawGatewayMethod.ChatSend');
    expect(adapter).toContain('queueMode: OpenClawChatQueueMode.Steer');
    expect(adapter).not.toContain('sessions.queueSteer');
  });

  test('uses the v2026.8.1 package preparation flow for embedded runtime builds', () => {
    const buildScript = fs.readFileSync(
      path.resolve('scripts/build-openclaw-runtime.sh'),
      'utf8',
    );
    expect(buildScript).toContain(
      'node --import ./scripts/tsx.mjs scripts/write-package-dist-inventory.ts',
    );
    expect(buildScript).toContain(
      'node --import ./scripts/tsx.mjs scripts/test-built-bundled-channel-entry-smoke.mts',
    );
    expect(buildScript).toContain(
      'pnpm --config.ignore-scripts=true pack --pack-destination "$PACK_DIR"',
    );
    expect(buildScript).toContain('MISTRAL_OTEL_API_VERSION="1.9.1"');
    expect(buildScript).toContain(
      'PNPM_FETCH_TIMEOUT_MS="${OPENCLAW_PNPM_FETCH_TIMEOUT_MS:-600000}"',
    );
    expect(buildScript).toContain(
      'if ! pnpm install --frozen-lockfile --fetch-timeout "$PNPM_FETCH_TIMEOUT_MS"',
    );
    expect(buildScript).toContain(
      "grep -Fq 'Broken lockfile: missing snapshot' \"$PNPM_INSTALL_LOG\"",
    );
    expect(buildScript).toContain(
      'rm -f node_modules/.pnpm/lock.yaml node_modules/.modules.yaml',
    );
    expect(buildScript).toContain(
      '"@opentelemetry/api@$MISTRAL_OTEL_API_VERSION"',
    );
    expect(buildScript).not.toContain("import('./src/infra/package-dist-inventory.ts')");
    expect(buildScript).not.toContain('test-built-bundled-channel-entry-smoke.mjs');
    expect(buildScript).not.toContain('npm pack --ignore-scripts');
  });

  test('uses the v2026.8.1 capability-consent flag for pinned runtime plugins', () => {
    const pluginInstaller = fs.readFileSync(
      path.resolve('scripts/ensure-openclaw-plugins.cjs'),
      'utf8',
    );
    expect(pluginInstaller).toContain("'--accept-capabilities'");
    expect(pluginInstaller).toContain(
      'timeout: OPENCLAW_PLUGIN_INSTALL_TIMEOUT_MS',
    );
    expect(pluginInstaller).not.toContain("'--dangerously-force-unsafe-install'");
  });
});
