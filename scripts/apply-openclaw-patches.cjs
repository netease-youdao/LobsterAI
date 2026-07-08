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
 * If openclaw-src-dir is not specified, defaults to ../openclaw relative to
 * the LobsterAI project root.
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

const strongPatchValidators = {
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
  'zz-openclaw-deepseek-cache-probe.patch': [
    {
      file: 'src/agents/openai-transport-stream.ts',
      snippets: [
        'DEEPSEEK_CACHE_PROBE_LOG_PREFIX = "[DeepSeekCacheProbe]"',
        'logDeepSeekCacheRequestProbe',
        'logDeepSeekCacheProbeResult',
        'cacheRead / promptTokens',
      ],
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
