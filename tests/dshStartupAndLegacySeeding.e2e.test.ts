import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => os.tmpdir(),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}));

import { DshBootstrap } from '../src/main/libs/dsh/dshBootstrap';
import { DshHostManager, resolveBundledDshPaths } from '../src/main/libs/dsh/dshHostManager';
import { runLegacyOpenClawMigration } from '../src/main/migration/legacyOpenClawMigrator';
import { DSH_SESSION_ID_PREFIX } from '../src/shared/dshEngine/hostConstants';
import { MigrationV2Status } from '../src/shared/migration/constants';
import { OpenClawEnginePhase } from '../src/shared/openclawEngine/constants';

const bundledPaths = resolveBundledDshPaths({
  isPackaged: false,
  appRootDir: process.cwd(),
});
const hasBundledDshRuntime =
  fs.existsSync(path.join(bundledPaths.runtimeDir, 'lib', 'bin.js'))
  && fs.existsSync(path.join(bundledPaths.hostBundleDir, 'package.json'));

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface MockOpenAiServer {
  baseUrl: string;
  capturedRequests: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

async function startMockOpenAiServer(replyText = 'Mock reply: acknowledged'): Promise<MockOpenAiServer> {
  const capturedRequests: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        capturedRequests.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        capturedRequests.push({ raw });
      }

      if (req.url?.includes('/chat/completions')) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const chunk1 = {
          id: `chatcmpl-${randomUUID().slice(0, 8)}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'mock-gpt',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: replyText },
              finish_reason: null,
            },
          ],
        };
        const chunk2 = {
          id: chunk1.id,
          object: 'chat.completion.chunk',
          created: chunk1.created,
          model: 'mock-gpt',
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
        };
        res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
        res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind mock OpenAI server');
  }

  return {
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    capturedRequests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Send a prompt to a real DSH session and collect assistant text until `turn/end`.
 */
async function sendPromptAndCollectReply(params: {
  client: ReturnType<DshHostManager['getClient']>;
  sessionId: string;
  prompt: string;
  timeoutMs?: number;
}): Promise<{ assistantText: string; sawTurnEnd: boolean }> {
  const { client, sessionId, prompt, timeoutMs = 20_000 } = params;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(new Error('Timed out waiting for DSH turn/end')), timeoutMs);

  const stream = client.followSession<Record<string, unknown>>(
    {
      address: { kind: 'session', sessionId },
      assistantStream: true,
      activate: true,
    },
    abortController.signal,
  );

  let assistantText = '';
  let sawTurnEnd = false;
  let promptSent = false;

  const consumePromise = (async () => {
    for await (const frame of stream) {
      if (frame.type !== 'event' || !frame.event || typeof frame.event !== 'object') {
        continue;
      }
      const item = frame.event as Record<string, unknown>;
      const eventType = typeof item.type === 'string' ? item.type : '';
      if (eventType === 'assistant/message') {
        const data = item.data as { message?: { content?: Array<{ type?: string; text?: string }> } } | undefined;
        const blocks = data?.message?.content ?? [];
        for (const block of blocks) {
          if (block.type === 'text' && typeof block.text === 'string') {
            assistantText += block.text;
          }
        }
      } else if (eventType === 'turn/end' && promptSent) {
        sawTurnEnd = true;
        abortController.abort();
        return;
      }
    }
  })().catch((err: unknown) => {
    if (!sawTurnEnd && !abortController.signal.aborted) throw err;
  });

  try {
    // Allow follow stream subscription to settle before submitting prompt.
    await new Promise((r) => setTimeout(r, 150));
    promptSent = true;
    const accepted = await client.promptSession({
      sessionId,
      requestId: randomUUID(),
      content: [{ type: 'text', text: prompt }],
      mode: 'queue',
    });
    expect(accepted.accepted).toBe(true);

    await consumePromise;
  } catch (error) {
    abortController.abort(error);
    await consumePromise.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return { assistantText, sawTurnEnd };
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn().catch(() => undefined);
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe.skipIf(!hasBundledDshRuntime)('Real DSH Runtime E2E: Fresh Startup & Upgrade Legacy Seeding', () => {
  test(
    'Test A (Fresh): deduplicates concurrent DshBootstrap.start(), gates turns on initial config sync, and completes a live turn against mock OpenAI',
    async () => {
      const mockServer = await startMockOpenAiServer('Fresh E2E reply OK');
      cleanups.push(() => mockServer.close());

      const userDataDir = createTempDir('lobsterai-e2e-fresh-');
      const projectDir = path.join(userDataDir, 'workspace');
      fs.mkdirSync(projectDir, { recursive: true });
      const skillsDir = path.join(userDataDir, 'SKILLs');
      fs.mkdirSync(skillsDir, { recursive: true });

      const db = new Database(path.join(userDataDir, 'lobsterai.sqlite'));
      cleanups.push(async () => { db.close(); });

      const bootstrap = new DshBootstrap({
        userDataDir,
        db,
        skillsDir,
        coworkStore: {
          getSession: () => null,
          addMessage: () => ({ id: 'm1', type: 'user', content: '', timestamp: Date.now() }),
          updateMessageContent: () => undefined,
          updateSession: () => undefined,
        },
        getDefaultCwd: () => projectDir,
        runtimePaths: bundledPaths,
        executablePath: process.execPath,
        skipElectronRunAsNode: true,
        bootTimeoutMs: 30_000,
      });
      cleanups.push(() => bootstrap.stop());

      let syncCallCount = 0;
      let sawHostReadyWhileSyncPending = false;
      let readyForTurnsDuringSync: boolean | null = null;
      let enginePhaseDuringSync: OpenClawEnginePhase | null = null;

      const syncInitialConfig = async () => {
        syncCallCount += 1;
        sawHostReadyWhileSyncPending = bootstrap.hostManager.isReady();
        readyForTurnsDuringSync = bootstrap.isReadyForTurns();
        enginePhaseDuringSync = bootstrap.getEngineStatus().phase;
        await new Promise((r) => setTimeout(r, 100));
        return bootstrap.syncAllConfig({
          providers: {
            'mock-openai': {
              enabled: true,
              apiKey: 'sk-mock-fresh',
              baseUrl: mockServer.baseUrl,
              apiFormat: 'openai',
              models: [{ id: 'mock-gpt', name: 'Mock GPT' }],
            },
          },
          mcpServers: [],
          skillsPolicy: { enabledIds: [], disabledIds: [], skillsDir },
          agents: [],
        });
      };

      // Concurrent startup + early message caller share one boot & one config sync.
      const [status1, status2] = await Promise.all([
        bootstrap.start({ syncInitialConfig }),
        bootstrap.start({ syncInitialConfig }),
      ]);

      expect(syncCallCount).toBe(1);
      expect(sawHostReadyWhileSyncPending).toBe(true);
      expect(readyForTurnsDuringSync).toBe(false);
      expect(enginePhaseDuringSync).toBe(OpenClawEnginePhase.Starting);
      expect(status1.phase).toBe(OpenClawEnginePhase.Running);
      expect(status2.phase).toBe(OpenClawEnginePhase.Running);
      expect(bootstrap.isReadyForTurns()).toBe(true);

      // Fresh install never creates a stale `<userData>/openclaw` directory.
      expect(fs.existsSync(path.join(userDataDir, 'openclaw'))).toBe(false);

      // Create a live session, select the synced provider/model, and execute a real turn.
      const client = bootstrap.hostManager.getClient();
      const created = await client.createSession({ cwd: projectDir });
      await client.selectModel({
        sessionId: created.sessionId,
        provider: 'mock-openai',
        model: 'mock-gpt',
      });

      const turnResult = await sendPromptAndCollectReply({
        client,
        sessionId: created.sessionId,
        prompt: 'Hello fresh DSH host!',
      });

      expect(turnResult.sawTurnEnd).toBe(true);
      expect(turnResult.assistantText).toContain('Fresh E2E reply OK');
      expect(mockServer.capturedRequests.length).toBeGreaterThanOrEqual(1);
      const bodyStr = JSON.stringify(mockServer.capturedRequests[0]);
      expect(bodyStr).toContain('Hello fresh DSH host!');
    },
    45_000,
  );

  test(
    'Test B (Upgrade): pre-seeds >10-message legacy session with tool_use/tool_result/thinking/title before DSH boot, then real DSH natively resumes and sends Turn 1 facts + tool results to LLM',
    async () => {
      const mockServer = await startMockOpenAiServer('Confirmed ZEPHYR-7741 and port 9482');
      cleanups.push(() => mockServer.close());

      const userDataDir = createTempDir('lobsterai-e2e-upgrade-');
      const projectDir = path.join(userDataDir, 'workspace');
      const skillsDir = path.join(userDataDir, 'SKILLs');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.mkdirSync(skillsDir, { recursive: true });

      // Seed legacy OpenClaw filesystem + SQLite DB with >10 messages across 6 turns.
      const openclawStateDir = path.join(userDataDir, 'openclaw', 'state');
      fs.mkdirSync(path.join(openclawStateDir, 'workspace-main'), { recursive: true });
      fs.writeFileSync(path.join(openclawStateDir, 'workspace-main', 'SOUL.md'), 'Be precise.\n');

      const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');
      const db = new Database(sqlitePath);
      db.exec(`
        CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
        CREATE TABLE cowork_sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          claude_session_id TEXT,
          cwd TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE cowork_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          metadata TEXT,
          created_at INTEGER NOT NULL,
          sequence INTEGER
        );
      `);
      db.prepare('INSERT INTO kv VALUES (?, ?, ?)').run('cowork.agent_engine', 'openclaw', 1);
      db.prepare('INSERT INTO cowork_sessions VALUES (?, ?, ?, ?, ?, ?)').run(
        'cw-upgrade-1',
        'Apollo Staging Audit',
        'agent:main:legacy-key-1',
        projectDir,
        1_700_000_000_000,
        1_700_000_100_000,
      );

      const insertMsg = db.prepare('INSERT INTO cowork_messages VALUES (?, ?, ?, ?, ?, ?, ?)');
      let seq = 1;
      const baseTs = 1_700_000_001_000;

      // Turn 1: user fact + thinking + tool_use + tool_result + assistant summary.
      insertMsg.run(
        'm1', 'cw-upgrade-1', 'user',
        'We are auditing codename FACT_TURN_1_CODENAME_ZEPHYR_7741. Please inspect staging.env.',
        null, baseTs + 1_000, seq++,
      );
      insertMsg.run(
        'm2', 'cw-upgrade-1', 'assistant',
        'Need to read staging.env to find the active port.',
        JSON.stringify({ isThinking: true, model: 'claude-3-7-sonnet' }),
        baseTs + 2_000, seq++,
      );
      insertMsg.run(
        'm3', 'cw-upgrade-1', 'tool_use',
        'read_file',
        JSON.stringify({
          toolUseId: 'legacy_read_env_1',
          toolName: 'read_file',
          toolInput: { path: 'staging.env' },
        }),
        baseTs + 2_500, seq++,
      );
      insertMsg.run(
        'm4', 'cw-upgrade-1', 'tool_result',
        'SERVICE_PORT=TOOL_RESULT_SECRET_PORT_9482\nREGION=ap-east-1',
        JSON.stringify({ toolUseId: 'legacy_read_env_1', isError: false }),
        baseTs + 3_000, seq++,
      );
      insertMsg.run(
        'm5', 'cw-upgrade-1', 'assistant',
        'Found SERVICE_PORT=TOOL_RESULT_SECRET_PORT_9482 in staging.env.',
        JSON.stringify({ model: 'claude-3-7-sonnet' }),
        baseTs + 4_000, seq++,
      );

      // Turns 2..6: 10 additional messages (total 15 messages > 10) to prove zero truncation.
      for (let t = 2; t <= 6; t += 1) {
        insertMsg.run(
          `m-u-${t}`, 'cw-upgrade-1', 'user',
          `Routine check step ${t}: verify disk quota.`,
          null, baseTs + t * 10_000, seq++,
        );
        insertMsg.run(
          `m-a-${t}`, 'cw-upgrade-1', 'assistant',
          `Disk quota step ${t} looks healthy.`,
          null, baseTs + t * 10_000 + 2_000, seq++,
        );
      }
      db.close();

      // Run offline migration BEFORE booting DSH!
      const migResult = runLegacyOpenClawMigration({
        userDataDir,
        sqlitePath,
        now: () => new Date('2026-11-21T01:00:00.000Z'),
      });
      expect(migResult.status).toBe(MigrationV2Status.Completed);
      expect(migResult.report?.summary.sessionsPreSeeded).toBe(1);
      expect(migResult.report?.summary.sessionsPreservedForLazyBridge).toBe(0);

      // Assert `cowork_sessions.claude_session_id` starts with `dsh:` BEFORE booting DSH!
      const postMigDb = new Database(sqlitePath, { readonly: true });
      const migratedRow = postMigDb
        .prepare('SELECT claude_session_id FROM cowork_sessions WHERE id = ?')
        .get('cw-upgrade-1') as { claude_session_id: string | null };
      postMigDb.close();

      expect(migratedRow.claude_session_id).toBeTruthy();
      expect(migratedRow.claude_session_id!.startsWith(DSH_SESSION_ID_PREFIX)).toBe(true);
      const dshSessionId = migratedRow.claude_session_id!.slice(DSH_SESSION_ID_PREFIX.length);

      // Boot the REAL embedded DshHostManager on the migrated userData!
      const hostManager = new DshHostManager({
        userDataDir,
        runtimeDir: bundledPaths.runtimeDir,
        hostBundleDir: bundledPaths.hostBundleDir,
        channelsBundleDir: bundledPaths.channelsBundleDir,
        skillsDir,
        executablePath: process.execPath,
        skipElectronRunAsNode: true,
        bootTimeoutMs: 30_000,
      });
      cleanups.push(() => hostManager.stop());

      await hostManager.start();
      await hostManager.syncProviders({
        providers: [
          {
            id: 'mock-openai',
            displayName: 'Mock OpenAI',
            api: 'openai-completions',
            baseURL: mockServer.baseUrl,
            apiKey: 'sk-mock-upgrade',
            models: [{ id: 'mock-gpt', name: 'Mock GPT' }],
          },
        ],
      });

      const client = hostManager.getClient();

      // 1) Verify DSH natively loads the pre-seeded session projections!
      const projections = await client.getSessionProjections(dshSessionId);
      expect(projections).not.toBeNull();
      expect(JSON.stringify(projections)).toContain('Apollo Staging Audit');

      // 2) Select model on the pre-seeded session (no createSession!) and send a follow-up turn.
      await client.selectModel({
        sessionId: dshSessionId,
        provider: 'mock-openai',
        model: 'mock-gpt',
      });

      const turnResult = await sendPromptAndCollectReply({
        client,
        sessionId: dshSessionId,
        prompt: 'What codename and port did we discover in turn 1?',
      });

      expect(turnResult.sawTurnEnd).toBe(true);
      expect(turnResult.assistantText).toContain('Confirmed ZEPHYR-7741 and port 9482');
      expect(mockServer.capturedRequests.length).toBeGreaterThanOrEqual(1);

      // 3) Inspect the actual HTTP request body sent by DSH to the LLM!
      const llmRequest = mockServer.capturedRequests[0];
      const llmMessages = Array.isArray(llmRequest.messages)
        ? (llmRequest.messages as Array<Record<string, unknown>>)
        : [];
      const serializedRequest = JSON.stringify(llmRequest);

      // Turn 1 early user fact MUST be present (proves all 6 turns / 15 messages loaded natively!).
      expect(serializedRequest).toContain('FACT_TURN_1_CODENAME_ZEPHYR_7741');
      // Turn 1 tool_result MUST be present as a native tool role message!
      expect(serializedRequest).toContain('TOOL_RESULT_SECRET_PORT_9482');
      expect(llmMessages.some((m) => m.role === 'tool' && JSON.stringify(m).includes('TOOL_RESULT_SECRET_PORT_9482'))).toBe(true);
      // Turn 1 tool_use MUST be present as assistant tool_calls!
      expect(
        llmMessages.some(
          (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && JSON.stringify(m.tool_calls).includes('read_file'),
        ),
      ).toBe(true);
      // Latest follow-up user turn MUST also be present!
      expect(serializedRequest).toContain('What codename and port did we discover in turn 1?');
    },
    45_000,
  );
});
