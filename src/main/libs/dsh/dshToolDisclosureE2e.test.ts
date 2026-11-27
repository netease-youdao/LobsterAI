import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { DshPermissionPreset, DshSearchPolicy } from '../../../shared/dshEngine/hostConstants';
import { DshHostManager } from './dshHostManager';

const ROOT_DIR = process.cwd();
const RUNTIME_DIR = path.join(ROOT_DIR, 'vendor', 'dsh-runtime', 'current');
const HOST_BUNDLE_DIR = path.join(ROOT_DIR, 'dsh-bundles', 'lobsterai-host');
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

afterEach(async () => {
  while (httpServers.length > 0) {
    const srv = httpServers.pop()!;
    srv.closeAllConnections?.();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe.skipIf(!HAS_DSH_RUNTIME)('Real DSH Runtime E2E: lobster_enable_tools', () => {
  test(
    'executes lobster_enable_tools without spill-policy content.some errors and unlocks the requested group on the next step',
    async () => {
      const tempRoot = createTempDir('lobsterai-dsh-disclosure-e2e-');
      const userDataDir = path.join(tempRoot, 'userData');
      const skillsDir = path.join(tempRoot, 'skills');
      const workspaceDir = path.join(tempRoot, 'workspace');
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.mkdirSync(workspaceDir, { recursive: true });

      const capturedRequests: CapturedLlmRequest[] = [];
      let step = 0;

      const mockOpenAi = await startServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CapturedLlmRequest;
          if (!Array.isArray(body.tools) || body.tools.length === 0) {
            sendSseChunks(res, makeFinalTextSse('Disclosure E2E Title'));
            return;
          }
          capturedRequests.push(body);
          const currentStep = step++;
          if (currentStep === 0) {
            sendSseChunks(
              res,
              makeToolCallSse('call-enable-1', 'lobster_enable_tools', {
                capabilities: ['computer-use'],
              }),
            );
            return;
          }
          sendSseChunks(res, makeFinalTextSse('Computer-use tools unlocked cleanly.'));
        });
      });

      const manager = new DshHostManager({
        userDataDir,
        runtimeDir: RUNTIME_DIR,
        hostBundleDir: HOST_BUNDLE_DIR,
        skillsDir,
        executablePath: process.execPath,
        searchPolicy: DshSearchPolicy.DeepSeekNativeOnly,
        skipElectronRunAsNode: true,
        bootTimeoutMs: 30_000,
      });
      manager.setApprovalEvaluator(() => ({ kind: 'allow' }));

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
        await manager.syncHostTools([
          {
            name: 'mcp__computer-use__list_windows',
            description: 'Mock Computer Use list windows tool',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'lobsterai_render_html_to_image',
            description: 'Mock HTML render tool',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'lobsterai_skin_manage',
            description: 'Mock skin manage tool',
            inputSchema: { type: 'object', properties: {} },
          },
        ]);

        const created = await client.createSession({ cwd: workspaceDir, agentPreset: 'lobsterai' });
        await manager.bindSessionContext({
          sessionId: created.sessionId,
          agentId: 'main',
          coworkSessionId: 'cw-disclosure-1',
          userQuestionsDisabled: true,
          executionMode: 'auto',
          permissionPreset: DshPermissionPreset.WorkspaceWrite,
        });
        await client.selectModel({ sessionId: created.sessionId, provider: 'mock-openai', model: 'mock-gpt' });

        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(new Error('DSH disclosure turn timed out')), 25_000);
        const toolResults: Array<{ isError?: boolean; content?: unknown }> = [];
        try {
          const stream = client.followSession<Record<string, unknown>>(
            { address: { kind: 'session', sessionId: created.sessionId }, assistantStream: true, activate: true },
            ac.signal,
          );
          await client.promptSession({
            sessionId: created.sessionId,
            requestId: 'req-disclosure-1',
            content: [{ type: 'text', text: 'Enable computer-use tools' }],
            mode: 'queue',
          });
          for await (const frame of stream) {
            if (frame.type === 'event') {
              const ev = frame.event as { type?: string; data?: { isError?: boolean; content?: unknown } } | undefined;
              if (ev?.type === 'tool/result') {
                toolResults.push({ isError: ev.data?.isError, content: ev.data?.content });
              }
              if (ev?.type === 'turn/end') {
                break;
              }
            }
          }
        } finally {
          clearTimeout(timer);
          ac.abort();
        }

        expect(capturedRequests).toHaveLength(2);
        const firstStepTools = (capturedRequests[0].tools ?? []).map((t) => t.function?.name).filter(Boolean);
        expect(firstStepTools).toContain('lobster_enable_tools');
        expect(firstStepTools).not.toContain('ask_user_question');
        expect(firstStepTools).not.toContain('mcp__computer-use__list_windows');
        expect(firstStepTools).not.toContain('lobsterai_render_html_to_image');
        expect(firstStepTools).not.toContain('lobsterai_skin_manage');
        expect(firstStepTools).not.toContain('subagent_fork');
        expect(firstStepTools).not.toContain('list_subagent_models');
        expect(firstStepTools).not.toContain('create_goal');
        expect(firstStepTools).not.toContain('update_goal');
        expect(firstStepTools).not.toContain('get_goal');

        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].isError).not.toBe(true);
        const secondStepToolResultText = capturedRequests[1].messages
          .filter((m) => m.role === 'tool')
          .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
          .join('\n');
        expect(secondStepToolResultText).toContain('computer-use 已启用');
        expect(secondStepToolResultText).toContain('mcp__computer-use__list_windows');
        expect(secondStepToolResultText).not.toContain('content.some is not a function');

        const secondStepTools = (capturedRequests[1].tools ?? []).map((t) => t.function?.name).filter(Boolean);
        expect(secondStepTools).toContain('mcp__computer-use__list_windows');
        expect(secondStepTools).not.toContain('ask_user_question');
      } finally {
        await manager.stop();
      }
    },
    60_000,
  );
});
