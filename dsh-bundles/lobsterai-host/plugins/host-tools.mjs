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
import {
  callLobsterBridge,
  getHostState,
  resolveSessionContext,
  resolveSessionId,
  resolveSessionWorkspaceDir,
} from './shared-state.mjs';

export const name = 'lobster-host-tools';
export const inject = ['tools'];

const MEMORY_TOOL_NAMES = new Set([
  'lobster_memory_search',
  'lobster_memory_get',
  'lobster_memory_save',
]);

/**
 * Convert an arbitrary JSON Schema (e.g. from MCP or host tool specs) into
 * DSH `defineTool`'s strict Value Schema DSL (which requires `additionalProperties`
 * on every object node and per-property `required: true`).
 */
function toDshValueSchema(raw) {
  if (!raw || typeof raw !== 'object') return { type: 'json' };
  const desc = typeof raw.description === 'string' ? { description: raw.description } : {};
  const t = raw.type;
  if (!t && Array.isArray(raw.oneOf) && raw.oneOf.length >= 2) {
    return {
      oneOf: raw.oneOf.map((branch) => toDshValueSchema(branch)),
      ...desc,
    };
  }
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
  if (Array.isArray(value?.content) && value.content.every(block => block?.type === 'text' && typeof block.text === 'string')) {
    return value.content;
  }
  const text = typeof value === 'string' ? value
    : typeof value?.text === 'string' ? value.text : JSON.stringify(value ?? null);
  return [{ type: 'text', text }];
}

const BUILTIN_HOST_TOOL_SPECS = [
  {
    name: 'lobster_memory_search',
    description: '全文检索当前智能体的长期记忆（MEMORY.md / USER.md）、每日笔记以及全局用户偏好（自动按当前项目隔离）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词（支持中英文）。' },
        limit: { type: 'integer', description: '最多返回的结果条数（默认 8）。' },
      },
      required: ['query'],
    },
    isConcurrencySafe: true,
  },
  {
    name: 'lobster_memory_get',
    description: '按路径和行号读取智能体工作区内的记忆文件（如 MEMORY.md、USER.md、memory/YYYY-MM-DD.md，或 global/MEMORY.md）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '智能体工作区内的相对路径（如 MEMORY.md 或 global/MEMORY.md）。' },
        startLine: { type: 'integer', description: '可选，起始行号（从 1 开始）。' },
        endLine: { type: 'integer', description: '可选，结束行号（含）。' },
      },
      required: ['path'],
    },
    isConcurrencySafe: true,
  },
  {
    name: 'lobster_memory_save',
    description: '保存一条长期记忆到 MEMORY.md，或追加一条每日记录到 memory/YYYY-MM-DD.md。支持按项目或全局作用域持久化。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '需要持久化的简洁事实内容。' },
        target: {
          type: 'string',
          enum: ['memory', 'daily'],
          description: '写入目标："memory" 写入长期 MEMORY.md，"daily" 追加到当日日志。',
        },
        scope: {
          type: 'string',
          enum: ['global', 'project'],
          description: '记忆作用域："project" 用于当前仓库/项目专属的规范、命令或文件路径；"global" 用于跨项目用户偏好或通用事实（默认）。',
        },
        date: { type: 'string', description: '可选，target 为 "daily" 时的日期（YYYY-MM-DD）。' },
      },
      required: ['content'],
    },
    isConcurrencySafe: false,
  },
  {
    name: 'lobster_schedule',
    description: '管理 LobsterAI 定时任务（查看、创建、修改、启停、删除）。仅在用户明确要求定时提醒或周期任务时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'update', 'toggle', 'delete'],
          description: '操作类型。',
        },
        taskId: { type: 'string', description: '任务 ID（update / toggle / delete 必填）。' },
        name: { type: 'string', description: '任务名称（create 必填）。' },
        prompt: { type: 'string', description: '定时触发时要执行的任务指令（create 必填）。' },
        scheduleKind: {
          type: 'string',
          enum: ['cron', 'every', 'at'],
          description: '调度类型：cron（5段表达式）、every（按分钟间隔）、at（一次性 ISO 时间）。',
        },
        cronExpr: { type: 'string', description: '5段 cron 表达式，如 "0 9 * * *"（scheduleKind="cron" 时必填）。' },
        tz: { type: 'string', description: '可选 IANA 时区（如 "Asia/Shanghai"，默认本地时区）。' },
        everyMinutes: { type: 'number', description: '间隔分钟数，至少 1（scheduleKind="every" 时必填）。' },
        at: { type: 'string', description: '带时区偏移的未来 ISO 时间，如 "2026-11-21T09:00:00+08:00"（scheduleKind="at" 时必填）。' },
        enabled: { type: 'boolean', description: '是否启用（默认 true；toggle 必填）。' },
      },
      required: ['action'],
    },
    isConcurrencySafe: false,
  },
];

function createBridgeTool(ctx, state, spec) {
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
      presentationMeta: (_args, value) => Array.isArray(value?.content)
        ? { lobsterToolResult: { details: value.details ?? null, isError: value.isError === true } }
        : null,
    },
    ...(typeof spec.timeoutMs === 'number' && spec.timeoutMs > 0 ? { timeoutMs: spec.timeoutMs } : {}),
    ...(spec.deferLoading === true ? { deferLoading: true } : {}),
    ...(spec.isConcurrencySafe === true ? { isConcurrencySafe: () => true } : {}),
    async execute(args, exec) {
      const sessionId = resolveSessionId(exec);
      const bound = resolveSessionContext(ctx, state, sessionId);
      const workspaceDir = resolveSessionWorkspaceDir(ctx, state, sessionId, bound, exec.agent);
      if (MEMORY_TOOL_NAMES.has(toolName)) {
        const memoryEnabled = typeof bound?.memoryEnabled === 'boolean'
          ? bound.memoryEnabled
          : state.memoryEnabled !== false;
        if (!memoryEnabled) {
          if (toolName === 'lobster_memory_search') {
            return {
              query: typeof args?.query === 'string' ? args.query : '',
              hits: [],
              disabled: true,
              text: 'Memory is currently disabled in settings.',
            };
          }
          if (toolName === 'lobster_memory_get') {
            return {
              path: typeof args?.path === 'string' ? args.path : 'MEMORY.md',
              text: '',
              disabled: true,
            };
          }
          return {
            ok: false,
            disabled: true,
            text: 'Memory is currently disabled in settings; nothing was saved.',
          };
        }
      }
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
          ...(workspaceDir ? { workspaceDir } : {}),
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

  // Register built-in memory & scheduler host tools immediately.
  for (const spec of BUILTIN_HOST_TOOL_SPECS) {
    const disposer = ctx.tools.register(createBridgeTool(ctx, state, spec));
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
        const dispose = ctx.tools.register(createBridgeTool(ctx, state, spec));
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
