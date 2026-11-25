import fs from 'node:fs';
import path from 'node:path';

import {
  AGENT_DRAFT_LIMITS,
  AgentDraftErrorCode,
  AgentDraftMode,
  type AgentDraftStreamPreview,
  buildAgentDraftPrompt,
  extractStreamingDraftPreview,
  extractStreamingPolishPreview,
  type GenerateAgentDraftRequest,
  type GenerateAgentDraftResult,
  normalizeAgentSummaryDescription,
  parseAgentDraftResponse,
  parsePolishedDraftOutput,
} from '../../shared/agent';
import { extractApiErrorSnippet } from './coworkModelApi';
import {
  buildOneShotHttpRequest,
  type OneShotPresetResolver,
  OneShotTargetError,
  type OneShotTargetResolution,
  readOneShotStreamEvent,
  resolveOneShotPreset,
  resolveOneShotTarget,
} from './oneShotModelClient';
import { splitSseEvents, type StreamChunk } from './sse';

const MAX_OUTPUT_TOKENS = 4_096;
const SUMMARY_MAX_OUTPUT_TOKENS = 256;
const REQUEST_TIMEOUT_MS = 60_000;
const SUMMARY_REQUEST_TIMEOUT_MS = 20_000;
const FOLDER_GUIDE_FILENAMES = ['AGENTS.md', 'CLAUDE.md', 'README.md'] as const;
const MAX_FOLDER_ENTRIES = 12;
const MAX_GUIDE_SNIPPET_CHARS = 600;

export interface AgentDraftGeneratorDeps {
  getProxyToken?: () => string | null;
  getProxyBaseUrl?: () => string | null;
  resolveModel?: () => OneShotTargetResolution;
  resolvePreset?: OneShotPresetResolver;
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (preview: AgentDraftStreamPreview) => void;
}

/**
 * Peek safely at a bound folder's top-level entries and README/AGENTS guide so
 * AI-generated agent instructions understand project-type workspaces.
 */
export function readFolderContextSnippet(workingDirectory: string | undefined): string {
  const dir = typeof workingDirectory === 'string' ? workingDirectory.trim() : '';
  if (!dir) return '';
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return '';

    const parts: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => !entry.name.startsWith('.'))
      .slice(0, MAX_FOLDER_ENTRIES)
      .map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    if (entries.length > 0) {
      parts.push(`Top-level files: ${entries.join(', ')}`);
    }

    for (const guideFile of FOLDER_GUIDE_FILENAMES) {
      const guidePath = path.join(dir, guideFile);
      try {
        const guideStat = fs.statSync(guidePath);
        if (!guideStat.isFile() || guideStat.size === 0) continue;
        const content = fs.readFileSync(guidePath, 'utf8').trim();
        if (!content) continue;
        const snippet = content.length > MAX_GUIDE_SNIPPET_CHARS
          ? `${content.slice(0, MAX_GUIDE_SNIPPET_CHARS).trimEnd()}...`
          : content;
        parts.push(`${guideFile}:\n${snippet}`);
        break;
      } catch {
        // Ignore unreadable guide files.
      }
    }

    const combined = parts.join('\n\n');
    return combined.length > AGENT_DRAFT_LIMITS.MaxFolderContextChars
      ? combined.slice(0, AGENT_DRAFT_LIMITS.MaxFolderContextChars)
      : combined;
  } catch {
    return '';
  }
}

export async function generateAgentDraft(
  request: GenerateAgentDraftRequest,
  deps: AgentDraftGeneratorDeps = {},
): Promise<GenerateAgentDraftResult> {
  const name = typeof request?.name === 'string' ? request.name.trim() : '';
  const goal = typeof request?.goal === 'string' ? request.goal.trim() : '';
  const existingInstructions = typeof request?.existingInstructions === 'string'
    ? request.existingInstructions.trim()
    : '';
  const workingDirectory = typeof request?.workingDirectory === 'string'
    ? request.workingDirectory.trim()
    : '';

  if (!name && !goal && !existingInstructions && !workingDirectory) {
    return {
      success: false,
      errorCode: AgentDraftErrorCode.EmptyInput,
      error: 'Please enter a name, goal, or working folder first.',
    };
  }

  const resolution = deps.resolveModel
    ? deps.resolveModel()
    : resolveOneShotTarget({
        getProxyToken: () => deps.getProxyToken?.() ?? null,
        getProxyBaseUrl: () => deps.getProxyBaseUrl?.() ?? null,
      });

  if ('error' in resolution) {
    console.warn(`[AgentDraftGenerator] Model target unavailable (${resolution.error}): ${resolution.detail ?? 'unknown'}`);
    return {
      success: false,
      errorCode: resolution.error === OneShotTargetError.UnsupportedModel
        ? AgentDraftErrorCode.UnsupportedModel
        : AgentDraftErrorCode.NoModel,
      error: resolution.detail || resolution.error,
    };
  }

  const isPolishMode = request.mode === AgentDraftMode.Polish;
  const isSummaryMode = request.mode === AgentDraftMode.Summary;
  const controller = new AbortController();
  const timeoutMs = deps.timeoutMs ?? (isSummaryMode ? SUMMARY_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  if (deps.signal) {
    if (deps.signal.aborted) {
      return {
        success: false,
        errorCode: AgentDraftErrorCode.Cancelled,
        error: 'Cancelled.',
      };
    }
    deps.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const target = await resolveOneShotPreset(resolution.target, deps.resolvePreset, controller.signal);
    controller.signal.throwIfAborted();

    const folderContext = readFolderContextSnippet(workingDirectory);
    const prompt = buildAgentDraftPrompt(
      {
        ...request,
        name,
        goal,
        existingInstructions,
        workingDirectory,
      },
      folderContext,
    );

    const { url, init } = buildOneShotHttpRequest(target, {
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      maxTokens: isSummaryMode ? SUMMARY_MAX_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS,
      lowLatency: true,
    });

    const response = await (deps.fetch ?? fetch)(url, { ...init, signal: controller.signal });
    controller.signal.throwIfAborted();

    if (!response.ok || !response.body) {
      const detail = extractApiErrorSnippet(await response.text().catch(() => '')) || `HTTP ${response.status}`;
      console.warn(`[AgentDraftGenerator] Upstream error (${response.status}): ${detail}`);
      return {
        success: false,
        errorCode: AgentDraftErrorCode.RequestFailed,
        error: detail,
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let collected = '';
    let lastEmittedInstructions: string | undefined;
    let lastEmittedDescription: string | undefined;

    const emitProgress = (): void => {
      if (!deps.onProgress || isSummaryMode) return;
      const preview = isPolishMode
        ? extractStreamingPolishPreview(collected, Boolean(request.includeDescription))
        : extractStreamingDraftPreview(collected);
      if (
        (preview.instructions && preview.instructions !== lastEmittedInstructions)
        || (preview.description && preview.description !== lastEmittedDescription)
      ) {
        lastEmittedInstructions = preview.instructions ?? lastEmittedInstructions;
        lastEmittedDescription = preview.description ?? lastEmittedDescription;
        deps.onProgress(preview);
      }
    };

    for (;;) {
      const { value, done } = await reader.read();
      controller.signal.throwIfAborted();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = splitSseEvents(buffer);
      buffer = rest;
      for (const event of events) {
        const chunk: StreamChunk = readOneShotStreamEvent(target.api, event);
        if (chunk.error) {
          console.warn(`[AgentDraftGenerator] Stream error: ${chunk.error}`);
          return {
            success: false,
            errorCode: AgentDraftErrorCode.RequestFailed,
            error: chunk.error,
          };
        }
        if (chunk.text) {
          collected += chunk.text;
          emitProgress();
        }
      }
    }

    // Flush any remaining trailing SSE event without a final blank line.
    buffer += decoder.decode();
    if (buffer.trim()) {
      const { events } = splitSseEvents(`${buffer}\n\n`);
      for (const event of events) {
        const chunk: StreamChunk = readOneShotStreamEvent(target.api, event);
        if (chunk.text) {
          collected += chunk.text;
          emitProgress();
        }
      }
    }

    if (isSummaryMode) {
      const description = normalizeAgentSummaryDescription(collected);
      if (!description) {
        console.warn('[AgentDraftGenerator] Model returned empty summary description');
        return {
          success: false,
          errorCode: AgentDraftErrorCode.ParseFailed,
          error: 'Failed to generate agent summary description.',
        };
      }
      return {
        success: true,
        draft: {
          name,
          description,
          instructions: existingInstructions,
          recommendedSkillIds: [],
          starterPrompts: [],
        },
      };
    }

    if (isPolishMode) {
      // If a model still wraps output in JSON despite plain-text instructions, unwrap it cleanly.
      const jsonFallback = collected.trim().startsWith('{')
        ? parseAgentDraftResponse(collected, { fallbackName: name })
        : null;
      if (jsonFallback) {
        return { success: true, draft: jsonFallback };
      }
      const parsed = parsePolishedDraftOutput(collected, Boolean(request.includeDescription));
      if (!parsed.instructions) {
        console.warn('[AgentDraftGenerator] Model returned empty polished instructions');
        return {
          success: false,
          errorCode: AgentDraftErrorCode.ParseFailed,
          error: 'Failed to generate polished agent instructions.',
        };
      }
      return {
        success: true,
        draft: {
          name,
          description: parsed.description,
          instructions: parsed.instructions,
          recommendedSkillIds: [],
          starterPrompts: [],
        },
      };
    }

    const allowedSkillIds = Array.isArray(request.skills)
      ? request.skills.map(skill => skill.id)
      : undefined;
    const draft = parseAgentDraftResponse(collected, {
      fallbackName: name,
      allowedSkillIds,
    });

    if (!draft) {
      console.warn('[AgentDraftGenerator] Failed to parse structured JSON from model output');
      return {
        success: false,
        errorCode: AgentDraftErrorCode.ParseFailed,
        error: 'Failed to parse generated agent configuration.',
      };
    }

    return { success: true, draft };
  } catch (error) {
    if (deps.signal?.aborted) {
      return {
        success: false,
        errorCode: AgentDraftErrorCode.Cancelled,
        error: 'Cancelled.',
      };
    }
    if (timedOut || controller.signal.aborted) {
      console.warn('[AgentDraftGenerator] Request timed out');
      return {
        success: false,
        errorCode: AgentDraftErrorCode.Timeout,
        error: 'Request timed out.',
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message === OneShotTargetError.UnsupportedModel) {
      console.warn('[AgentDraftGenerator] Preset model unsupported for draft generation');
      return {
        success: false,
        errorCode: AgentDraftErrorCode.UnsupportedModel,
        error: message,
      };
    }
    console.warn(`[AgentDraftGenerator] Failed to generate agent draft: ${message}`);
    return {
      success: false,
      errorCode: AgentDraftErrorCode.RequestFailed,
      error: message,
    };
  } finally {
    clearTimeout(timeout);
    deps.signal?.removeEventListener('abort', onExternalAbort);
  }
}
