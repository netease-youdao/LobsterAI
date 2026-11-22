import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { DshPermissionPreset, DshSearchPolicy } from '../../../shared/dshEngine/hostConstants';
import { getWebSearchBridgeFilePath, writeWebSearchBridgeFile } from '../webSearchBridgeFile';
import { DshHostManager } from './dshHostManager';

const ROOT_DIR = process.cwd();
const RUNTIME_DIR = path.join(ROOT_DIR, 'vendor', 'dsh-runtime', 'current');
const HOST_BUNDLE_DIR = path.join(ROOT_DIR, 'dsh-bundles', 'lobsterai-host');
const REPO_WEB_SEARCH_DIR = path.join(ROOT_DIR, 'SKILLs', 'web-search');
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

function makeToolCallSse(callId: string, toolName: string, argsObj: Record<string, unknown>): Array<Record<string, unknown> | '[DONE]'> {
  const base = {
    id: `chatcmpl-${callId}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-gpt',
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
    model: 'mock-gpt',
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

afterEach(async () => {
  while (httpServers.length > 0) {
    const srv = httpServers.pop()!;
    srv.closeAllConnections?.();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      const wsDir = path.join(dir, 'skills', 'web-search');
      if (fs.existsSync(wsDir)) fs.chmodSync(wsDir, 0o755);
    } catch {
      // ignore chmod restore errors
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!HAS_DSH_RUNTIME)('Real DSH Runtime E2E: web-search sandbox & web_fetch guard', () => {
  test(
    'runs search.sh under workspace-write sandbox with read-only skillsDir, enforces blockedHostnames/webFetch guard, and strips ambient DEEPSEEK_API_KEY',
    async () => {
      const tempRoot = createTempDir('lobsterai-dsh-web-e2e-');
      const userDataDir = path.join(tempRoot, 'userData');
      const skillsDir = path.join(tempRoot, 'skills');
      const webSearchSkillDir = path.join(skillsDir, 'web-search');
      const workspaceDir = path.join(tempRoot, 'workspace');
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.mkdirSync(path.join(webSearchSkillDir, 'scripts'), { recursive: true });
      fs.mkdirSync(workspaceDir, { recursive: true });

      fs.copyFileSync(path.join(REPO_WEB_SEARCH_DIR, 'SKILL.md'), path.join(webSearchSkillDir, 'SKILL.md'));
      fs.copyFileSync(
        path.join(REPO_WEB_SEARCH_DIR, 'scripts', 'search.sh'),
        path.join(webSearchSkillDir, 'scripts', 'search.sh'),
      );
      fs.chmodSync(path.join(webSearchSkillDir, 'scripts', 'search.sh'), 0o755);
      // Lock skillsDir/web-search strictly read-only to guarantee zero writes to $PROJECT_DIR.
      fs.chmodSync(webSearchSkillDir, 0o555);

      // 1. Local mock WebSearchHost HTTP bridge on 127.0.0.1:<port>/web-search/page
      const bridgeSecret = 'e2e-web-search-secret';
      const bridgeCalls: Array<{ op?: string; query?: string; engine?: string; authOk: boolean }> = [];
      const searchBridge = await startServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const authOk = req.headers['x-mcp-bridge-secret'] === bridgeSecret;
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            op?: string;
            query?: string;
            engine?: string;
          };
          bridgeCalls.push({ op: body.op, query: body.query, engine: body.engine, authOk });
          res.setHeader('content-type', 'application/json');
          if (!authOk) {
            res.statusCode = 401;
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
          }
          if (body.op === 'status') {
            res.end(JSON.stringify({ success: true, data: { active: true } }));
            return;
          }
          if (body.op === 'search') {
            res.end(JSON.stringify({
              success: true,
              data: {
                query: body.query,
                engine: body.engine ?? 'google',
                totalResults: 1,
                duration: 9,
                results: [
                  {
                    title: 'LobsterAI E2E Verified Search Hit',
                    url: 'https://verified-e2e.example.test/article',
                    snippet: 'Real DSH workspace-write sandbox search succeeded via host bridge.',
                  },
                ],
              },
            }));
            return;
          }
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: 'Unsupported op' }));
        });
      });

      const bridgeFilePath = getWebSearchBridgeFilePath(userDataDir);
      writeWebSearchBridgeFile(bridgeFilePath, {
        bridgeUrl: `${searchBridge.origin}/web-search/page`,
        bridgeSecret,
      });

      // 2. Local mock OpenAI Chat Completions HTTP server scripting deterministic tool calls
      const capturedRequests: CapturedLlmRequest[] = [];
      let llmPhase: 'search' | 'blocked-fetch' | 'disabled-fetch' = 'search';
      let stepInPhase = 0;

      const mockOpenAi = await startServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CapturedLlmRequest;
          // Ignore auxiliary tool-less calls (e.g. session title generation).
          if (!Array.isArray(body.tools) || body.tools.length === 0) {
            sendSseChunks(res, makeFinalTextSse('E2E Session Title'));
            return;
          }
          capturedRequests.push(body);
          const step = stepInPhase++;

          if (llmPhase === 'search') {
            if (step === 0) {
              sendSseChunks(
                res,
                makeToolCallSse('call-search-1', 'bash', {
                  description: 'Run LobsterAI web-search script inside DSH workspace-write sandbox',
                  command: 'bash "$SKILLS_ROOT/web-search/scripts/search.sh" "LobsterAI DSH E2E test" 3',
                }),
              );
              return;
            }
            sendSseChunks(res, makeFinalTextSse('Search completed with verified E2E results.'));
            return;
          }

          if (llmPhase === 'blocked-fetch') {
            if (step === 0) {
              sendSseChunks(
                res,
                makeToolCallSse('call-fetch-blocked', 'web_fetch', {
                  url: 'https://blocked.example.test/private',
                }),
              );
              return;
            }
            sendSseChunks(res, makeFinalTextSse('Fetch was blocked as expected.'));
            return;
          }

          if (llmPhase === 'disabled-fetch') {
            if (step === 0) {
              sendSseChunks(
                res,
                makeToolCallSse('call-fetch-disabled', 'web_fetch', {
                  url: 'https://allowed.example.test/public',
                }),
              );
              return;
            }
            sendSseChunks(res, makeFinalTextSse('Fetch disabled as expected.'));
          }
        });
      });

      // Inject an ambient DEEPSEEK_API_KEY into parent env to prove buildIsolatedDshChildEnv strips it!
      const prevDeepSeekKey = process.env.DEEPSEEK_API_KEY;
      process.env.DEEPSEEK_API_KEY = 'sk-ambient-must-not-leak';

      const manager = new DshHostManager({
        userDataDir,
        runtimeDir: RUNTIME_DIR,
        hostBundleDir: HOST_BUNDLE_DIR,
        skillsDir,
        executablePath: process.execPath,
        searchPolicy: DshSearchPolicy.DeepSeekNativeOnly,
        webSearchBridgeFile: bridgeFilePath,
        skipElectronRunAsNode: true,
        bootTimeoutMs: 30_000,
      });
      manager.setApprovalEvaluator(() => ({ kind: 'allow' }));

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

        await manager.syncProviders({
          providers: [
            {
              id: 'mock-openai',
              displayName: 'Mock OpenAI',
              api: 'openai-completions',
              baseURL: `${mockOpenAi.origin}/v1`,
              apiKey: 'mock-key',
              models: [{ id: 'mock-gpt', name: 'Mock GPT', contextWindow: 64000, maxTokens: 4096 }],
            },
          ],
        });
        await manager.syncSkillsPolicy({
          enabledIds: ['web-search'],
          disabledIds: [],
          skillsDir,
        });
        await manager.syncWebAccessPolicy({
          webFetchEnabled: true,
          blockedHostnames: ['blocked.example.test'],
        });

        // ── Turn 1: Run web-search skill inside real DSH workspace-write sandbox ──
        const created1 = await client.createSession({ cwd: workspaceDir, agentPreset: 'lobsterai' });
        await manager.bindSessionContext({
          sessionId: created1.sessionId,
          agentId: 'main',
          coworkSessionId: 'cw-e2e-1',
          executionMode: 'auto',
          permissionPreset: DshPermissionPreset.WorkspaceWrite,
        });
        await client.selectModel({ sessionId: created1.sessionId, provider: 'mock-openai', model: 'mock-gpt' });

        llmPhase = 'search';
        stepInPhase = 0;
        await runTurn(created1.sessionId, 'Search for LobsterAI DSH E2E test');

        expect(capturedRequests.length).toBeGreaterThanOrEqual(2);
        const turn1FirstReq = capturedRequests[0];
        const turn1SecondReq = capturedRequests[1];

        // Ambient DEEPSEEK_API_KEY was stripped -> DSH built-in `web_search` MUST NOT be admitted on non-DeepSeek route.
        const admittedToolNames = (turn1FirstReq.tools ?? []).map((t) => t.function?.name).filter(Boolean);
        expect(admittedToolNames).not.toContain('web_search');
        expect(admittedToolNames).toContain('web_fetch');
        expect(admittedToolNames).toContain('bash');

        // Concise web-search routing guidance MUST be present when web-search skill is enabled.
        expect(extractSystemText(turn1FirstReq)).toContain('$SKILLS_ROOT/web-search/scripts/search.sh');

        // Real search.sh queried the local bridge with valid secret and ZERO sandbox write failures.
        expect(bridgeCalls).toEqual([
          { op: 'status', query: undefined, engine: undefined, authOk: true },
          { op: 'search', query: 'LobsterAI DSH E2E test', engine: 'google', authOk: true },
        ]);
        const searchToolOutput = extractToolResultText(turn1SecondReq);
        expect(searchToolOutput).toContain('LobsterAI E2E Verified Search Hit');
        expect(searchToolOutput).toContain('https://verified-e2e.example.test/article');
        expect(searchToolOutput).not.toMatch(/Operation not permitted|sandbox: file access denied/i);
        expect(fs.existsSync(path.join(webSearchSkillDir, '.connection'))).toBe(false);

        // ── Turn 2: web_fetch to blockedHostnames MUST be rejected by DSH ctx.tools.guard ──
        const reqOffset2 = capturedRequests.length;
        llmPhase = 'blocked-fetch';
        stepInPhase = 0;
        await runTurn(created1.sessionId, 'Fetch https://blocked.example.test/private');

        expect(capturedRequests.length).toBeGreaterThanOrEqual(reqOffset2 + 2);
        const blockedToolOutput = extractToolResultText(capturedRequests[reqOffset2 + 1]);
        expect(blockedToolOutput).toContain('blocked.example.test');
        expect(blockedToolOutput).toContain('blockedHostnames');

        // ── Turn 3: Disable web-search skill & webFetch -> guidance omitted & web_fetch denied ──
        await manager.syncSkillsPolicy({
          enabledIds: [],
          disabledIds: ['web-search'],
          skillsDir,
        });
        await manager.syncWebAccessPolicy({
          webFetchEnabled: false,
          blockedHostnames: [],
        });

        const created2 = await client.createSession({ cwd: workspaceDir, agentPreset: 'lobsterai' });
        await manager.bindSessionContext({
          sessionId: created2.sessionId,
          agentId: 'main',
          coworkSessionId: 'cw-e2e-2',
          executionMode: 'auto',
          permissionPreset: DshPermissionPreset.WorkspaceWrite,
        });
        await client.selectModel({ sessionId: created2.sessionId, provider: 'mock-openai', model: 'mock-gpt' });

        const reqOffset3 = capturedRequests.length;
        llmPhase = 'disabled-fetch';
        stepInPhase = 0;
        await runTurn(created2.sessionId, 'Fetch https://allowed.example.test/public');

        expect(capturedRequests.length).toBeGreaterThanOrEqual(reqOffset3 + 2);
        expect(extractSystemText(capturedRequests[reqOffset3])).not.toContain(
          '$SKILLS_ROOT/web-search/scripts/search.sh',
        );
        const disabledFetchToolOutput = extractToolResultText(capturedRequests[reqOffset3 + 1]);
        expect(disabledFetchToolOutput).toContain('web_fetch is disabled');
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
