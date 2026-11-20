/**
 * @lobsterai/dsh-bundle — Native Host Tools Plugin
 *
 * Registers LobsterAI's native host capabilities directly onto DSH's
 * `ctx.tools` registry (`defineTool`):
 * - Built-in Memory tools (`lobster_memory_search`, `lobster_memory_get`, `lobster_memory_save`)
 * - Dynamically synced host tools from Electron main via `/api/lobsterai/ops`
 *   (`syncHostTools`): Office (Word/Excel/PPT), In-App Browser, Browser
 *   Credentials, Computer Use, Media Generation, and Decision tools.
 *
 * Every execution forwards to Electron main's authenticated local callback
 * bridge with the DSH `AbortSignal` so user cancellation aborts host work.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { callLobsterBridge, getHostState, resolveSessionContext, resolveSessionId } from './shared-state.mjs';

export const name = 'lobster-host-tools';
export const inject = ['tools'];

/**
 * Convert an arbitrary JSON Schema (e.g. from MCP or host tool specs) into
 * DSH `defineTool`'s strict Value Schema DSL (which requires `additionalProperties`
 * on every object node and per-property `required: true`).
 */
function toDshValueSchema(raw) {
  if (!raw || typeof raw !== 'object') return { type: 'json' };
  const desc = typeof raw.description === 'string' ? { description: raw.description } : {};
  const t = raw.type;
  if (t === 'string' || t === 'number' || t === 'integer' || t === 'boolean' || t === 'null') {
    const out = { type: t, ...desc };
    if (Array.isArray(raw.enum) && raw.enum.length > 0) out.enum = raw.enum;
    if (Object.hasOwn(raw, 'const')) out.const = raw.const;
    return out;
  }
  if (t === 'array') {
    return {
      type: 'array',
      ...desc,
      ...(raw.items ? { items: toDshValueSchema(raw.items) } : {}),
    };
  }
  if (t === 'object') {
    const requiredSet = new Set(Array.isArray(raw.required) ? raw.required : []);
    const properties = {};
    if (raw.properties && typeof raw.properties === 'object') {
      for (const [k, v] of Object.entries(raw.properties)) {
        const compiled = toDshValueSchema(v);
        if (requiredSet.has(k)) compiled.required = true;
        properties[k] = compiled;
      }
    }
    return {
      type: 'object',
      ...desc,
      additionalProperties: typeof raw.additionalProperties === 'boolean' ? raw.additionalProperties : true,
      ...(Object.keys(properties).length > 0 ? { properties } : {}),
    };
  }
  return { type: 'json', ...desc };
}

function toDshParameterMap(jsonSchema) {
  if (!jsonSchema || typeof jsonSchema !== 'object' || !jsonSchema.properties) {
    return {};
  }
  const requiredSet = new Set(Array.isArray(jsonSchema.required) ? jsonSchema.required : []);
  const map = {};
  for (const [key, propSchema] of Object.entries(jsonSchema.properties)) {
    const compiled = toDshValueSchema(propSchema);
    if (requiredSet.has(key)) compiled.required = true;
    map[key] = compiled;
  }
  return map;
}

function renderHostToolOutput(_args, value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.text === 'string') {
    return value.text;
  }
  return JSON.stringify(value ?? null, null, 2);
}

const BUILTIN_MEMORY_TOOL_SPECS = [
  {
    name: 'lobster_memory_search',
    description: 'Search the agent workspace long-term memory (MEMORY.md) and daily memory notes using full-text search.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query text (Chinese or English keywords).' },
        limit: { type: 'integer', description: 'Maximum number of matching snippets to return (default 8).' },
      },
      required: ['query'],
    },
    isConcurrencySafe: true,
  },
  {
    name: 'lobster_memory_get',
    description: 'Read a specific memory file or line range from the agent workspace (e.g. MEMORY.md or memory/2026-11-19.md).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path inside the agent workspace (e.g. MEMORY.md).' },
        startLine: { type: 'integer', description: 'Optional 1-based start line number.' },
        endLine: { type: 'integer', description: 'Optional 1-based inclusive end line number.' },
      },
      required: ['path'],
    },
    isConcurrencySafe: true,
  },
  {
    name: 'lobster_memory_save',
    description: 'Save a durable memory entry to MEMORY.md or append a daily note to memory/YYYY-MM-DD.md.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Concise factual memory text to persist.' },
        target: {
          type: 'string',
          enum: ['memory', 'daily'],
          description: 'Target store: "memory" for long-term MEMORY.md, "daily" for today\'s daily log.',
        },
        date: { type: 'string', description: 'Optional YYYY-MM-DD date when target is "daily".' },
      },
      required: ['content'],
    },
    isConcurrencySafe: false,
  },
];

function createBridgeTool(state, spec) {
  const toolName = String(spec.name || '').trim();
  if (!toolName || toolName === 'run_code') {
    throw new Error(`lobster-host-tools: invalid tool name "${toolName}"`);
  }
  return defineTool({
    name: toolName,
    description: String(spec.description || `LobsterAI host tool: ${toolName}`),
    parameters: toDshParameterMap(spec.inputSchema),
    output: {
      schema: { type: 'json' },
      render: renderHostToolOutput,
    },
    ...(typeof spec.timeoutMs === 'number' && spec.timeoutMs > 0 ? { timeoutMs: spec.timeoutMs } : {}),
    ...(spec.deferLoading === true ? { deferLoading: true } : {}),
    ...(spec.isConcurrencySafe === true ? { isConcurrencySafe: () => true } : {}),
    async execute(args, exec) {
      const sessionId = resolveSessionId(exec);
      const bound = resolveSessionContext(ctx, state, sessionId);
      const result = await callLobsterBridge(
        state,
        '/dsh-bridge/tool-execute',
        {
          toolName,
          args,
          callId: exec.callId,
          sessionId,
          agentId: bound?.agentId ?? 'main',
          coworkSessionId: bound?.coworkSessionId,
        },
        exec.signal,
      );
      if (!result.available) {
        throw new Error(
          `Host tool "${toolName}" requires a live LobsterAI desktop bridge (${result.error})`,
        );
      }
      if (!result.ok) {
        throw new Error(result.error || `Host tool "${toolName}" failed`);
      }
      return result.data ?? { ok: true };
    },
  });
}

export function apply(ctx) {
  const state = getHostState(ctx);
  /** @type {Map<string, () => void>} */
  const builtinDisposers = new Map();
  /** @type {Map<string, () => void>} */
  const dynamicDisposers = new Map();

  // Register built-in memory tools immediately.
  for (const spec of BUILTIN_MEMORY_TOOL_SPECS) {
    const disposer = ctx.tools.register(createBridgeTool(state, spec));
    builtinDisposers.set(spec.name, disposer);
  }

  state.syncHostTools = async (payload) => {
    const body = payload && typeof payload === 'object' ? payload : {};
    const specs = Array.isArray(body.tools) ? body.tools : [];

    // Unregister previous dynamic host tools cleanly.
    for (const dispose of dynamicDisposers.values()) {
      try {
        dispose();
      } catch {
        // ignore disposal errors during hot swap
      }
    }
    dynamicDisposers.clear();

    const registered = [];
    const skipped = [];
    for (const spec of specs) {
      if (!spec || typeof spec !== 'object' || typeof spec.name !== 'string') continue;
      const toolName = spec.name.trim();
      if (!toolName || builtinDisposers.has(toolName) || dynamicDisposers.has(toolName)) {
        skipped.push(toolName);
        continue;
      }
      try {
        const dispose = ctx.tools.register(createBridgeTool(state, spec));
        dynamicDisposers.set(toolName, dispose);
        registered.push(toolName);
      } catch (error) {
        ctx.logger.warn(
          `[LobsterAI:HostTools] skipped tool "${toolName}": ${error instanceof Error ? error.message : String(error)}`,
        );
        skipped.push(toolName);
      }
    }

    return {
      builtinTools: [...builtinDisposers.keys()],
      dynamicTools: registered,
      skipped,
    };
  };

  ctx.effect(() => () => {
    for (const dispose of dynamicDisposers.values()) {
      try {
        dispose();
      } catch {}
    }
    dynamicDisposers.clear();
    for (const dispose of builtinDisposers.values()) {
      try {
        dispose();
      } catch {}
    }
    builtinDisposers.clear();
    state.syncHostTools = null;
    state.pluginsReady.hostTools = false;
  }, 'lobster-host-tools cleanup');

  state.pluginsReady.hostTools = true;
}
