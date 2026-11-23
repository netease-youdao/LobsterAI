import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { DshOpsAction, DshPermissionPreset } from '../../../shared/dshEngine/hostConstants';
import { DshHostManager } from './dshHostManager';

const ROOT_DIR = process.cwd();
const RUNTIME_DIR = path.join(ROOT_DIR, 'vendor', 'dsh-runtime', 'current');
const HOST_BUNDLE_DIR = path.join(ROOT_DIR, 'dsh-bundles', 'lobsterai-host');
const REPO_WEB_SEARCH_SKILL_MD = path.join(ROOT_DIR, 'SKILLs', 'web-search', 'SKILL.md');
const HAS_DSH_RUNTIME =
  process.platform !== 'win32'
  && fs.existsSync(path.join(RUNTIME_DIR, 'lib', 'bin.js'))
  && fs.existsSync(path.join(HOST_BUNDLE_DIR, 'package.json'));

const tempDirs: string[] = [];
const httpServers: http.Server[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function startServer(handler: http.RequestListener): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer(handler);
  httpServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind ephemeral loopback port');
  }
  return { server, origin: `http://127.0.0.1:${addr.port}` };
}

function sendSseChunks(res: http.ServerResponse, payloads: Array<Record<string, unknown> | '[DONE]'>): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'close',
  });
  for (const payload of payloads) {
    res.write(`data: ${payload === '[DONE]' ? '[DONE]' : JSON.stringify(payload)}\n\n`);
  }
  res.end();
}

function makeToolCallSse(
  callId: string,
  toolName: string,
  argsObj: Record<string, unknown>,
): Array<Record<string, unknown> | '[DONE]'> {
  const base = {
    id: `chatcmpl-${callId}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
  };
  return [
    {
      ...base,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: callId,
            type: 'function',
            function: { name: toolName, arguments: JSON.stringify(argsObj) },
          }],
        },
        finish_reason: null,
      }],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    },
    '[DONE]',
  ];
}

function makeFinalTextSse(text: string): Array<Record<string, unknown> | '[DONE]'> {
  const base = {
    id: `chatcmpl-final-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
  };
  return [
    {
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 15, total_tokens: 135 },
    },
    '[DONE]',
  ];
}

interface CapturedLlmRequest {
  messages: Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
  tools?: Array<{ function?: { name?: string } }>;
}

function extractSystemText(req: CapturedLlmRequest): string {
  return req.messages
    .filter((m) => m.role === 'system' || m.role === 'developer')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

function extractToolResultText(req: CapturedLlmRequest): string {
  return req.messages
    .filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

function extractAdmittedToolNames(req: CapturedLlmRequest): string[] {
  return (req.tools ?? []).map((t) => t.function?.name).filter((n): n is string => typeof n === 'string');
}

afterEach(async () => {
  while (httpServers.length > 0) {
    const srv = httpServers.pop()!;
    srv.closeAllConnections?.();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!HAS_DSH_RUNTIME)('Real DSH Runtime E2E: unified native web_search routing & guards', () => {
  test(
    'routes plan models to in-app browser search, personal DeepSeek to native search with automatic fallback, honors global and per-agent web-search toggles, and enforces web_fetch guards',
    async () => {
      const tempRoot = createTempDir('lobsterai-dsh-web-e2e-');
      const userDataDir = path.join(tempRoot, 'userData');
      const skillsDir = path.join(tempRoot, 'skills');
      const webSearchSkillDir = path.join(skillsDir, 'web-search');
      const docxSkillDir = path.join(skillsDir, 'docx');
      const workspaceDir = path.join(tempRoot, 'workspace');
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.mkdirSync(webSearchSkillDir, { recursive: true });
      fs.mkdirSync(docxSkillDir, { recursive: true });
      fs.mkdirSync(workspaceDir, { recursive: true });

      fs.copyFileSync(REPO_WEB_SEARCH_SKILL_MD, path.join(webSearchSkillDir, 'SKILL.md'));
      fs.writeFileSync(
        path.join(docxSkillDir, 'SKILL.md'),
        '---\nname: docx\ndescription: Word helper\n---\n# Docx\n',
        'utf8',
      );

      // 1. Mock DeepSeek native Anthropic Messages search endpoint
      const deepSeekSearchCalls: Array<{
        apiKey?: string;
        tools?: unknown;
        text?: string;
      }> = [];
      let failDeepSeekNative = false;
      const mockDeepSeekSearch = await startServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            messages?: Array<{ content?: Array<{ text?: string }> }>;
            tools?: unknown;
          };
          deepSeekSearchCalls.push({
            apiKey: typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined,
            tools: parsed.tools,
            text: parsed.messages?.[0]?.content?.[0]?.text,
          });
          res.setHeader('content-type', 'application/json');
          if (failDeepSeekNative) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: { message: 'Model Not Exist' } }));
            return;
          }
          res.end(JSON.stringify({
            id: 'msg_ds_search_1',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'web_search_tool_result',
                tool_use_id: 'srvtoolu_1',
                content: [
                  {
                    type: 'web_search_result',
                    url: 'https://blocked.example.test/must-be-filtered',
                    title: 'Blocked Native Hit',
                    snippet: 'Should not survive blockedHostnames filter.',
                  },
                  {
                    type: 'web_search_result',
                    url: 'https://deepseek-native.example.test/doc',
                    title: 'DeepSeek Native Verified Hit',
                    snippet: 'Served by DeepSeek native web_search_20250305.',
                  },
                ],
              },
            ],
          }));
        });
      });

      // 2. Mock OpenAI Chat Completions server for both `lobsterai-server` (plan) and `deepseek` (personal)
      const capturedRequests: CapturedLlmRequest[] = [];
      let llmPhase:
        | 'plan-search'
        | 'deepseek-native'
        | 'deepseek-fallback'
        | 'expert-restricted'
        | 'global-disabled' = 'plan-search';
      let stepInPhase = 0;

      const mockLlm = await startServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CapturedLlmRequest;
          if (!Array.isArray(body.tools) || body.tools.length === 0) {
            sendSseChunks(res, makeFinalTextSse('E2E Session Title'));
            return;
          }
          capturedRequests.push(body);
          const step = stepInPhase++;

          if (llmPhase === 'plan-search') {
            if (step === 0) {
              sendSseChunks(res, makeToolCallSse('call-plan-search', 'web_search', {
                queries: ['LobsterAI plan model search'],
              }));
              return;
            }
            sendSseChunks(res, makeFinalTextSse('Plan browser search succeeded.'));
            return;
          }

          if (llmPhase === 'deepseek-native') {
            if (step === 0) {
              sendSseChunks(res, makeToolCallSse('call-ds-native', 'web_search', {
                queries: ['DeepSeek native search query'],
              }));
              return;
            }
            sendSseChunks(res, makeFinalTextSse('DeepSeek native search succeeded.'));
            return;
          }

          if (llmPhase === 'deepseek-fallback') {
            if (step === 0) {
              sendSseChunks(res, makeToolCallSse('call-ds-fallback', 'web_search', {
                queries: ['DeepSeek fallback query'],
              }));
              return;
            }
            sendSseChunks(res, makeFinalTextSse('Fallback browser search succeeded.'));
            return;
          }

          if (llmPhase === 'expert-restricted') {
            if (step === 0) {
              sendSseChunks(res, makeToolCallSse('call-blocked-fetch', 'web_fetch', {
                url: 'https://blocked.example.test/private',
              }));
              return;
            }
            sendSseChunks(res, makeFinalTextSse('Blocked fetch rejected as expected.'));
            return;
          }

          if (llmPhase === 'global-disabled') {
            if (step === 0) {
              sendSseChunks(res, makeToolCallSse('call-disabled-fetch', 'web_fetch', {
                url: 'https://allowed.example.test/public',
              }));
              return;
            }
            sendSseChunks(res, makeFinalTextSse('Disabled fetch rejected as expected.'));
          }
        });
      });

      // Inject an ambient DEEPSEEK_API_KEY into parent env to confirm DSH child isolation strips it.
      const prevDeepSeekKey = process.env.DEEPSEEK_API_KEY;
      process.env.DEEPSEEK_API_KEY = 'sk-ambient-must-not-leak';

      const browserBridgeCalls: Array<{ query: string; maxResults?: number }> = [];
      const manager = new DshHostManager({
        userDataDir,
        runtimeDir: RUNTIME_DIR,
        hostBundleDir: HOST_BUNDLE_DIR,
        skillsDir,
        executablePath: process.execPath,
        skipElectronRunAsNode: true,
        bootTimeoutMs: 30_000,
      });
      manager.setApprovalEvaluator(() => ({ kind: 'allow' }));
      manager.setWebSearchHandler(async ({ query, maxResults }) => {
        browserBridgeCalls.push({ query, maxResults });
        return {
          query,
          engine: 'bing',
          duration: 12,
          sources: [
            {
              url: 'https://blocked.example.test/blocked-browser-hit',
              title: 'Blocked Browser Hit',
              snippet: 'Must be filtered out by blockedHostnames.',
            },
            {
              url: 'https://browser-e2e.example.test/article',
              title: 'In-App Browser Verified Hit',
              snippet: `In-app WebSearchHost answered: ${query}`,
            },
          ],
        };
      });

      async function runTurn(sessionId: string, promptText: string): Promise<void> {
        const client = manager.getClient();
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(new Error(`DSH turn timed out for "${promptText}"`)), 25_000);
        try {
          const stream = client.followSession<Record<string, unknown>>(
            { address: { kind: 'session', sessionId }, assistantStream: true, activate: true },
            ac.signal,
          );
          await client.promptSession({
            sessionId,
            requestId: `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            content: [{ type: 'text', text: promptText }],
            mode: 'queue',
          });
          for await (const frame of stream) {
            if (frame.type === 'event') {
              const ev = frame.event as { type?: string } | undefined;
              if (ev?.type === 'turn/end') {
                break;
              }
            }
          }
        } finally {
          clearTimeout(timer);
          ac.abort();
        }
      }

      try {
        await manager.start();
        const client = manager.getClient();

        const health = await client.callOps<{ ok?: boolean; pluginsReady?: Record<string, boolean> }>(
          DshOpsAction.Health,
        );
        expect(health.ok).toBe(true);
        expect(health.pluginsReady?.webSearchBridge).toBe(true);

        await manager.syncProviders({
          providers: [
            {
              id: 'lobsterai-server',
              displayName: 'LobsterAI Plan',
              api: 'openai-completions',
              baseURL: `${mockLlm.origin}/v1`,
              apiKey: 'plan-proxy-key',
              models: [{ id: 'deepseek-chat', name: 'DeepSeek Plan', contextWindow: 64000, maxTokens: 4096 }],
            },
            {
              id: 'deepseek',
              displayName: 'Personal DeepSeek',
              api: 'openai-completions',
              baseURL: `${mockLlm.origin}/v1`,
              apiKey: 'sk-personal-deepseek',
              models: [{ id: 'deepseek-chat', name: 'DeepSeek Personal', contextWindow: 64000, maxTokens: 4096 }],
            },
          ],
        });
        await manager.syncSkillsPolicy({
          enabledIds: ['web-search', 'docx'],
          disabledIds: [],
          skillsDir,
        });
        await manager.syncWebAccessPolicy({
          webFetchEnabled: true,
          browserSearchEnabled: true,
          blockedHostnames: ['blocked.example.test'],
          deepseekSearchBaseUrl: mockDeepSeekSearch.origin,
        });

        // ── Turn 1: LobsterAI plan DeepSeek -> native web_search routes to in-app browser bridge ──
        const sessionPlan = await client.createSession({ cwd: workspaceDir, agentPreset: 'lobsterai' });
        await manager.bindSessionContext({
          sessionId: sessionPlan.sessionId,
          agentId: 'main',
          coworkSessionId: 'cw-e2e-plan',
          executionMode: 'auto',
          permissionPreset: DshPermissionPreset.WorkspaceWrite,
        });
        await client.selectModel({
          sessionId: sessionPlan.sessionId,
          provider: 'lobsterai-server',
          model: 'deepseek-chat',
        });

        llmPhase = 'plan-search';
        stepInPhase = 0;
        await runTurn(sessionPlan.sessionId, 'Search using plan model');

        expect(capturedRequests.length).toBeGreaterThanOrEqual(2);
        const turn1Req0 = capturedRequests[0];
        const turn1Req1 = capturedRequests[1];

        const turn1Tools = extractAdmittedToolNames(turn1Req0);
        expect(turn1Tools).toContain('web_search');
        expect(turn1Tools).toContain('web_fetch');

        const turn1System = extractSystemText(turn1Req0);
        expect(turn1System).toContain('`web_search`');
        expect(turn1System).not.toContain('search.sh');
        // `web-search` is hidden from the model-facing skill catalog while `docx` remains listed.
        expect(turn1System).toContain('docx');
        expect(turn1System).not.toMatch(/<name>\s*web-search\s*<\/name>/);

        expect(deepSeekSearchCalls).toHaveLength(0);
        expect(browserBridgeCalls).toEqual([{ query: 'LobsterAI plan model search', maxResults: 10 }]);

        const planToolOutput = extractToolResultText(turn1Req1);
        expect(planToolOutput).toContain('In-App Browser Verified Hit');
        expect(planToolOutput).toContain('https://browser-e2e.example.test/article');
        expect(planToolOutput).not.toContain('blocked.example.test');

        // ── Turn 2: Personal DeepSeek key -> native DeepSeek web_search_20250305 (zero bridge calls) ──
        const sessionPersonal = await client.createSession({ cwd: workspaceDir, agentPreset: 'lobsterai' });
        await manager.bindSessionContext({
          sessionId: sessionPersonal.sessionId,
          agentId: 'main',
          coworkSessionId: 'cw-e2e-personal',
          executionMode: 'auto',
          permissionPreset: DshPermissionPreset.WorkspaceWrite,
        });
        await client.selectModel({
          sessionId: sessionPersonal.sessionId,
          provider: 'deepseek',
          model: 'deepseek-chat',
        });

        const reqOffset2 = capturedRequests.length;
        llmPhase = 'deepseek-native';
        stepInPhase = 0;
        await runTurn(sessionPersonal.sessionId, 'Search using personal DeepSeek key');

        expect(capturedRequests.length).toBeGreaterThanOrEqual(reqOffset2 + 2);
        expect(deepSeekSearchCalls).toHaveLength(1);
        expect(deepSeekSearchCalls[0].apiKey).toBe('sk-personal-deepseek');
        expect(deepSeekSearchCalls[0].text).toContain('DeepSeek native search query');
        expect(deepSeekSearchCalls[0].tools).toEqual([
          { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
        ]);
        // Browser bridge was NOT called during Turn 2.
        expect(browserBridgeCalls).toHaveLength(1);

        const nativeToolOutput = extractToolResultText(capturedRequests[reqOffset2 + 1]);
        expect(nativeToolOutput).toContain('DeepSeek Native Verified Hit');
        expect(nativeToolOutput).toContain('https://deepseek-native.example.test/doc');
        expect(nativeToolOutput).not.toContain('blocked.example.test');

        // ── Turn 3: Personal DeepSeek native failure -> transparent fallback to in-app browser bridge ──
        failDeepSeekNative = true;
        const reqOffset3 = capturedRequests.length;
        llmPhase = 'deepseek-fallback';
        stepInPhase = 0;
        await runTurn(sessionPersonal.sessionId, 'Search when DeepSeek native fails');

        expect(capturedRequests.length).toBeGreaterThanOrEqual(reqOffset3 + 2);
        expect(deepSeekSearchCalls).toHaveLength(2);
        expect(browserBridgeCalls).toHaveLength(2);
        expect(browserBridgeCalls[1].query).toBe('DeepSeek fallback query');

        const fallbackToolOutput = extractToolResultText(capturedRequests[reqOffset3 + 1]);
        expect(fallbackToolOutput).toContain('In-App Browser Verified Hit');
        expect(fallbackToolOutput).toContain('DeepSeek fallback query');

        // ── Turn 4: Expert with allowedSkillIds excluding `web-search` -> web_search hidden + web_fetch guard active ──
        const sessionExpert = await client.createSession({ cwd: workspaceDir, agentPreset: 'lobsterai' });
        await manager.bindSessionContext({
          sessionId: sessionExpert.sessionId,
          agentId: 'doc-expert',
          coworkSessionId: 'cw-e2e-expert',
          allowedSkillIds: ['docx'],
          executionMode: 'auto',
          permissionPreset: DshPermissionPreset.WorkspaceWrite,
        });
        await client.selectModel({
          sessionId: sessionExpert.sessionId,
          provider: 'lobsterai-server',
          model: 'deepseek-chat',
        });

        const reqOffset4 = capturedRequests.length;
        llmPhase = 'expert-restricted';
        stepInPhase = 0;
        await runTurn(sessionExpert.sessionId, 'Fetch blocked URL in restricted expert');

        expect(capturedRequests.length).toBeGreaterThanOrEqual(reqOffset4 + 2);
        expect(extractAdmittedToolNames(capturedRequests[reqOffset4])).not.toContain('web_search');
        expect(extractSystemText(capturedRequests[reqOffset4])).not.toContain('When you need live web search:');
        const blockedFetchOutput = extractToolResultText(capturedRequests[reqOffset4 + 1]);
        expect(blockedFetchOutput).toContain('blocked.example.test');
        expect(blockedFetchOutput).toContain('blockedHostnames');

        // ── Turn 5: Global web-search disabled + webFetch disabled -> web_search hidden & web_fetch denied ──
        await manager.syncSkillsPolicy({
          enabledIds: ['docx'],
          disabledIds: ['web-search'],
          skillsDir,
        });
        await manager.syncWebAccessPolicy({
          webFetchEnabled: false,
          browserSearchEnabled: true,
          blockedHostnames: [],
        });

        const sessionDisabled = await client.createSession({ cwd: workspaceDir, agentPreset: 'lobsterai' });
        await manager.bindSessionContext({
          sessionId: sessionDisabled.sessionId,
          agentId: 'main',
          coworkSessionId: 'cw-e2e-disabled',
          executionMode: 'auto',
          permissionPreset: DshPermissionPreset.WorkspaceWrite,
        });
        await client.selectModel({
          sessionId: sessionDisabled.sessionId,
          provider: 'lobsterai-server',
          model: 'deepseek-chat',
        });

        const reqOffset5 = capturedRequests.length;
        llmPhase = 'global-disabled';
        stepInPhase = 0;
        await runTurn(sessionDisabled.sessionId, 'Fetch allowed URL when web_fetch is disabled');

        expect(capturedRequests.length).toBeGreaterThanOrEqual(reqOffset5 + 2);
        expect(extractAdmittedToolNames(capturedRequests[reqOffset5])).not.toContain('web_search');
        expect(extractSystemText(capturedRequests[reqOffset5])).not.toContain('When you need live web search:');
        const disabledFetchOutput = extractToolResultText(capturedRequests[reqOffset5 + 1]);
        expect(disabledFetchOutput).toContain('web_fetch is disabled');
      } finally {
        if (prevDeepSeekKey === undefined) {
          delete process.env.DEEPSEEK_API_KEY;
        } else {
          process.env.DEEPSEEK_API_KEY = prevDeepSeekKey;
        }
        await manager.stop();
      }
    },
    60_000,
  );
});
